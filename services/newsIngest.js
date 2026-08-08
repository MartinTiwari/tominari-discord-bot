'use strict';

const log = require('../utils/logger')('ingest');
const db = require('../utils/database');
const config = require('../utils/config');
const rss = require('../scrapers/rssFeedScraper');
const facebook = require('../scrapers/facebookScraper');
const instagram = require('../scrapers/instagramScraper');
const dedup = require('../scrapers/deduplicator');
const newsApi = require('../utils/newsApi');
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
  const stored = [];

  for (const post of fresh) {
    const id = db.insertSocialPost(post);
    if (!id) continue;
    stored.push({ ...post, id });

    // Social posts double as news articles so the briefs have material even
    // when NewsAPI is not configured.
    db.insertArticle({
      external_id: `social:${hash(post.external_post_id)}`,
      title: post.title,
      content: post.content,
      source: post.source_name,
      category: post.category,
      url: post.url,
      image_url: post.image_url,
      published_at: post.posted_at,
      priority: post.priority || 'MEDIUM',
    });
  }

  log.info(`Social: ${stored.length} new of ${seen} seen across ${sources.length} sources`
    + (errors.length ? ` (failed: ${errors.join(', ')})` : ''));
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

/** Load data/socialSources.json into the database (idempotent). */
function seedSources() {
  const { sources } = require('../data/socialSources.json');
  let n = 0;
  for (const s of sources) {
    db.upsertSource(s);
    n++;
  }
  log.info(`Seeded ${n} sources`);
  return n;
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
