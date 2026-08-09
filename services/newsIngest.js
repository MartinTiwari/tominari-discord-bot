'use strict';

const log = require('../utils/logger')('ingest');
const db = require('../utils/database');
const config = require('../utils/config');
const rss = require('../scrapers/rssFeedScraper');
const facebook = require('../scrapers/facebookScraper');
const instagram = require('../scrapers/instagramScraper');
const ronb = require('../scrapers/ronbScraper');
const dedup = require('../scrapers/deduplicator');
const newsApi = require('../utils/newsApi');
const summarizer = require('./summarizer');
const { classifyKind } = require('../utils/postClassifier');
const { hash } = require('../utils/text');

/**
 * Collection layer: pulls from every configured source, deduplicates, and
 * writes to SQLite. It never talks to Discord — publishing is the schedulers'
 * job — so both commands and cron jobs can safely call `refreshAll()`.
 */

// Guards against two schedulers (or a user command) ingesting concurrently.
let inFlight = null;

/**
 * Pick the best transport for a source: official API when credentials exist,
 * otherwise the outlet's public RSS feed.
 */
async function fetchSource(source) {
  const platform = (source.platform || 'rss').toLowerCase();

  // RONB is its own reader: it merges the Facebook page and the Instagram
  // profile, and tags each post as news or filler.
  if (platform === 'ronb') {
    const { posts } = await ronb.fetchAll(config.ronb?.pollLimit ?? 12);
    return posts.map((p) => ({ ...p, source_id: source.id ?? null }));
  }

  if (platform === 'facebook' && facebook.isAvailable()) {
    const posts = await facebook.fetchPage(source);
    if (posts.length) return posts;
  }
  if (platform === 'instagram' && instagram.isAvailable()) {
    const posts = await instagram.fetchProfile(source);
    if (posts.length) return posts;
  }
  return rss.fetchFeed(source);
}

/** Classification fields for a post that did not arrive pre-classified. */
function kindFields(post) {
  const kind = classifyKind(post);
  return { post_kind: kind.kind, is_news: kind.isNews, kind_evidence: kind.evidence };
}

/**
 * Poll every active source once.
 * @returns {Promise<{stored: Array, seen: number, errors: string[]}>}
 *   `stored` holds the freshly inserted posts (with their new row ids).
 */
async function ingestSocial() {
  const sources = db.getActiveSources();
  const errors = [];
  let seen = 0;

  const batches = await Promise.allSettled(
    sources.map(async (source) => {
      const posts = await fetchSource(source);
      db.touchSource(source.id, null);
      return { source, posts };
    }),
  );

  const candidates = [];
  batches.forEach((result, i) => {
    const source = sources[i];
    if (result.status === 'rejected') {
      const msg = result.reason?.message || 'unknown error';
      db.touchSource(source.id, msg.slice(0, 200));
      errors.push(source.source_name);
      return;
    }
    seen += result.value.posts.length;
    candidates.push(...result.value.posts);
  });

  // Newest first so that, when two outlets carry the same story, the fresher
  // one survives deduplication.
  candidates.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));

  const fresh = dedup.filterNew(candidates);

  // Two passes over the fresh batch before anything is stored:
  //   1. decide news vs filler (RONB posts arrive already classified)
  //   2. read the article page so the feed carries the story, not a teaser
  const classified = fresh.map((post) => (
    post.post_kind ? post : { ...post, ...kindFields(post) }
  ));

  // Filler is never fetched — nobody needs the full text of a birthday wish.
  const news = classified.filter((p) => p.post_kind === 'news');
  const filler = classified.filter((p) => p.post_kind !== 'news');

  // Reading article pages costs a request each, and a first run can turn up a
  // hundred stories at once. Only the newest — the ones the feed will actually
  // post this cycle — are worth fetching; the rest keep their feed summary and
  // get read properly if they later surface in a brief.
  const budget = (config.news.maxSocialPostsPerCycle ?? 8) * 2;
  const toRead = news.slice(0, budget);
  const rest = news.slice(budget);

  const enriched = config.news.fetchArticleBodies
    ? await summarizer.enrich(toRead, { maxChars: config.news.summaryMaxChars ?? 700, concurrency: 4 })
    : toRead;

  const readable = [...enriched, ...rest, ...filler]
    .sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));

  const stored = [];

  for (const post of readable) {
    const id = db.insertSocialPost(post);
    if (!id) continue;
    stored.push({ ...post, id });

    // Filler never becomes an article — the live feed roasts it and that's it.
    if (post.post_kind !== 'news') continue;

    // Social posts double as news articles so the briefs have material even
    // when NewsAPI is not configured. `content` holds the summarised story
    // when we managed to read the article body, since that is what the brief
    // embeds render.
    db.insertArticle({
      external_id: `social:${hash(post.external_post_id)}`,
      title: post.title,
      content: post.summary_origin === 'body' ? post.summary : post.content,
      source: post.source_name,
      category: post.category,
      url: post.url,
      image_url: post.image_url,
      published_at: post.posted_at,
      priority: post.priority || 'MEDIUM',
    });
  }

  const fillerCount = stored.filter((p) => p.post_kind !== 'news').length;
  const bodyRead = stored.filter((p) => p.summary_origin === 'body').length;
  log.info(`Social: ${stored.length} new of ${seen} seen across ${sources.length} sources`
    + ` (${bodyRead} summarised from the article page, ${fillerCount} filler)`
    + (errors.length ? ` — failed: ${errors.join(', ')}` : ''));
  return { stored, seen, errors };
}

/** Pull from NewsAPI when a key is configured. */
async function ingestNewsApi() {
  if (!newsApi.isConfigured()) return { stored: 0, seen: 0 };

  const [nepal, world] = await Promise.all([
    newsApi.fetchNepalNews(),
    newsApi.fetchWorldHeadlines({ pageSize: 15 }),
  ]);

  const all = dedup.dedupeArticles([...nepal, ...world]);
  let stored = 0;
  for (const article of all) {
    if (db.insertArticle(article)) stored++;
  }

  log.info(`NewsAPI: ${stored} new of ${nepal.length + world.length} seen`);
  return { stored, seen: nepal.length + world.length };
}

/**
 * Run both collectors. Concurrent callers share the same in-flight promise
 * instead of hammering the sources twice.
 */
function refreshAll() {
  if (inFlight) {
    log.debug('Refresh already running — joining in-flight request');
    return inFlight;
  }

  inFlight = (async () => {
    const social = await ingestSocial();
    const api = await ingestNewsApi();
    return {
      newPosts: social.stored,
      socialStored: social.stored.length,
      socialSeen: social.seen,
      apiStored: api.stored,
      apiSeen: api.seen,
      errors: social.errors,
    };
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/**
 * Load data/socialSources.json into the database (idempotent).
 *
 * Sources dropped from the file are deactivated rather than deleted, so their
 * stored posts keep their attribution and /toggle-source can bring one back.
 * Without this, an outlet removed from the file would keep being polled from
 * whatever row an older version of the bot left behind.
 */
function seedSources() {
  const { sources } = require('../data/socialSources.json');
  const wanted = new Set(sources.map((s) => s.name));

  for (const s of sources) db.upsertSource(s);

  const rows = db.getAllSources();
  const retired = [];
  const revived = [];

  for (const row of rows) {
    if (row.manual_override) continue;                 // a person chose this — leave it
    const listed = wanted.has(row.source_name);
    const shouldBeActive = listed && sources.find((s) => s.name === row.source_name).active !== false;

    if (row.is_active && !shouldBeActive) {
      db.setSourceActive(row.source_name, false);
      retired.push(row.source_name);
    } else if (!row.is_active && shouldBeActive) {
      // Previously paused (a dead feed, an older build) but back in the file.
      db.setSourceActive(row.source_name, true);
      revived.push(row.source_name);
    }
  }

  log.info(`Seeded ${sources.length} sources`
    + (revived.length ? ` — enabled ${revived.join(', ')}` : '')
    + (retired.length ? ` — retired ${retired.join(', ')}` : ''));
  return sources.length;
}

/**
 * Best `limit` unsent stories for a category, deduplicated against each other.
 * Falls back to the highest-engagement social posts when the article table is
 * thin (typical on a fresh install without a NewsAPI key).
 */
function selectForBrief(category, limit = config.news.storiesPerCategory) {
  const articles = dedup.dedupeArticles(
    db.getUnsentArticles(category, limit * 3, config.news.maxAgeHours),
  ).slice(0, limit);

  if (articles.length >= limit) return articles;

  const social = db.getTopSocialPosts(config.news.maxAgeHours, limit * 2, category)
    .filter((p) => !articles.some((a) => a.url && a.url === p.url))
    .map((p) => ({
      id: null,
      title: p.title,
      content: p.content,
      source: p.source_name,
      category: p.category,
      url: p.url,
      image_url: p.image_url,
      published_at: p.posted_at,
      priority: 'MEDIUM',
    }));

  return dedup.dedupeArticles([...articles, ...social]).slice(0, limit);
}

module.exports = { refreshAll, ingestSocial, ingestNewsApi, seedSources, selectForBrief };
