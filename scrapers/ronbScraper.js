'use strict';

const Parser = require('rss-parser');
const log = require('../utils/logger')('ronb');
const { getJson, getText } = require('../utils/http');
const { stripHtml, summarize, hash, firstImage } = require('../utils/text');
const { toSqlTimestamp } = require('../utils/time');
const classifier = require('../utils/categoryClassifier');
const { classifyKind } = require('../utils/postClassifier');
const config = require('../utils/config');

/**
 * Routine of Nepal Banda (RONB) reader.
 *
 *   Facebook  — https://www.facebook.com/officialroutineofnepalbanda
 *   Instagram — https://www.instagram.com/routineofnepalbanda/
 *
 * Neither platform serves posts to an unauthenticated server: Facebook returns
 * a login wall and Instagram's web endpoints reject requests without a session.
 * Scraping around that would breach Meta's terms and break within weeks, so
 * this module reads RONB through whichever *sanctioned* route is configured,
 * in descending order of reliability:
 *
 *   1. Meta Graph API      — FB_PAGE_ACCESS_TOKEN (+ RONB_FB_PAGE_ID / IG_USER_ID)
 *   2. An RSS bridge       — RONB_FB_FEED / RONB_IG_FEED, any feed URL you own
 *                            (rss.app, fetchrss.com, a self-hosted RSSHub…)
 *   3. RONB's own site     — routineofnepalbanda.com/feed, when it is up
 *
 * Every provider yields the same normalised post shape, each tagged with the
 * `kind` from postClassifier so the feed knows whether to summarise it or roast
 * it. When none is configured the module reports `configured: false` and the
 * social feed simply runs on the newspaper sources instead.
 */

const GRAPH_VERSION = 'v21.0';
const MIRROR_FEED = 'https://routineofnepalbanda.com/feed/';

/**
 * X/Twitter's public embed timeline. Other RONB bots (Routiney, ronbupdates)
 * are built on @RONBupdates, so we read it too — but that account has not
 * posted since September 2025, so in practice the freshness filter drops
 * everything it returns. It stays wired up, unrequested and free, so the day
 * RONB posts there again the feed picks it up with no code change.
 */
const X_HANDLE = 'RONBupdates';
const SYNDICATION = 'https://syndication.twitter.com/srv/timeline-profile/screen-name';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const parser = new Parser({
  timeout: 20_000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  },
  customFields: { item: [['content:encoded', 'contentEncoded'], ['media:content', 'mediaContent']] },
});

const env = (name) => (process.env[name] || '').trim();

/** Which routes are usable right now, cheapest check first. */
function providers() {
  const token = env('FB_PAGE_ACCESS_TOKEN');
  return {
    graphFacebook: Boolean(token && env('RONB_FB_PAGE_ID')),
    graphInstagram: Boolean(token && env('IG_USER_ID')),
    bridgeFacebook: /^https?:\/\//i.test(env('RONB_FB_FEED')),
    bridgeInstagram: /^https?:\/\//i.test(env('RONB_IG_FEED')),
    mirror: env('RONB_DISABLE_MIRROR') !== 'true',
    twitter: env('RONB_DISABLE_X') !== 'true',
  };
}

function isConfigured() {
  return Object.values(providers()).some(Boolean);
}

/** Human-readable list of the routes in play, for /sources and /health. */
function activeRoutes() {
  const p = providers();
  const routes = [];
  if (p.graphFacebook) routes.push('Facebook Graph API');
  if (p.graphInstagram) routes.push('Instagram Graph API');
  if (p.bridgeFacebook) routes.push('Facebook RSS bridge');
  if (p.bridgeInstagram) routes.push('Instagram RSS bridge');
  if (p.mirror) routes.push('routineofnepalbanda.com');
  if (p.twitter) routes.push(`@${X_HANDLE} (X)`);
  return routes;
}

// ------------------------------------------------------------ normalising ---

const PAGE_URL = {
  facebook: 'https://www.facebook.com/officialroutineofnepalbanda',
  instagram: 'https://www.instagram.com/routineofnepalbanda/',
  web: 'https://routineofnepalbanda.com/',
};

/**
 * RONB writes one long caption, not a headline plus body. The first line is
 * the closest thing to a headline; the rest is the story.
 */
function headlineOf(caption) {
  const firstLine = String(caption).split('\n').map((l) => l.trim()).find(Boolean) || '';
  // A first line that is only a hashtag pile or an emoji is no headline at all.
  const usable = firstLine.replace(/[#@]\S+/g, '').replace(/[^\p{L}\p{N}]/gu, '').length > 8;
  return (usable ? firstLine : summarize(caption, 120)).slice(0, 240) || 'RONB post';
}

function buildPost({ id, platform, caption, url, image, postedAt, likes = 0, comments = 0 }) {
  const content = stripHtml(caption || '');
  if (!content) return null;                       // image-only post, nothing to say

  const title = headlineOf(content);
  const kind = classifyKind({ title, content, source_name: 'RONB' });

  return {
    external_post_id: id,
    source_id: null,
    source_name: 'RONB',
    platform,
    title,
    content,
    summary: summarize(content, config.news.socialSummaryLength),
    url: url || PAGE_URL[platform] || PAGE_URL.web,
    image_url: image || null,
    category: classifier.classify({ title, content, url }),
    priority: classifier.priorityFor({ title, content, sourcePriority: 'HIGH' }),
    posted_at: toSqlTimestamp(postedAt),
    likes,
    comments,
    post_kind: kind.kind,
    is_news: kind.isNews,
    kind_evidence: kind.evidence,
  };
}

// --------------------------------------------------------------- providers ---

async function fromGraphFacebook(limit) {
  const fields = [
    'id', 'message', 'created_time', 'permalink_url', 'full_picture',
    'reactions.summary(total_count).limit(0)',
    'comments.summary(total_count).limit(0)',
  ].join(',');

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env('RONB_FB_PAGE_ID')}/posts`
    + `?fields=${encodeURIComponent(fields)}&limit=${limit}`
    + `&access_token=${encodeURIComponent(env('FB_PAGE_ACCESS_TOKEN'))}`;

  const data = await getJson(url, { retries: 1 });
  return (data.data || []).map((p) => buildPost({
    id: `ronb-fb:${p.id}`,
    platform: 'facebook',
    caption: p.message,
    url: p.permalink_url,
    image: p.full_picture,
    postedAt: p.created_time,
    likes: p.reactions?.summary?.total_count || 0,
    comments: p.comments?.summary?.total_count || 0,
  })).filter(Boolean);
}

async function fromGraphInstagram(limit) {
  const fields = 'id,caption,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,media_type';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env('IG_USER_ID')}/media`
    + `?fields=${encodeURIComponent(fields)}&limit=${limit}`
    + `&access_token=${encodeURIComponent(env('FB_PAGE_ACCESS_TOKEN'))}`;

  const data = await getJson(url, { retries: 1 });
  return (data.data || []).map((m) => buildPost({
    id: `ronb-ig:${m.id}`,
    platform: 'instagram',
    caption: m.caption,
    url: m.permalink,
    image: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url,
    postedAt: m.timestamp,
    likes: m.like_count || 0,
    comments: m.comments_count || 0,
  })).filter(Boolean);
}

/**
 * Read @RONBupdates through X's public embed timeline — the same JSON that
 * powers an embedded profile widget, so no key and no scraping of x.com.
 *
 * The endpoint rate-limits shared IPs hard, so a 429 is logged at debug and
 * treated as "nothing new this cycle" rather than an error.
 */
async function fromTwitter(limit) {
  const html = await getText(`${SYNDICATION}/${X_HANDLE}?showReplies=false`, {
    retries: 1,
    timeout: 20_000,
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
  });

  const payload = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!payload) throw new Error('embed timeline returned no data block');

  const entries = JSON.parse(payload[1])?.props?.pageProps?.timeline?.entries || [];

  return entries
    .map((e) => e?.content?.tweet)
    .filter((t) => t && !t.retweeted_status && !t.in_reply_to_screen_name)
    .slice(0, limit)
    .map((t) => buildPost({
      id: `ronb-x:${t.id_str}`,
      platform: 'twitter',
      // t.co shorteners at the end of a tweet are the media link, not content.
      caption: String(t.full_text || t.text || '').replace(/\s*https:\/\/t\.co\/\w+\s*$/, ''),
      url: `https://x.com/${X_HANDLE}/status/${t.id_str}`,
      image: t.photos?.[0]?.url || t.video?.poster || null,
      postedAt: t.created_at,
      likes: t.favorite_count || 0,
      comments: t.reply_count || 0,
    }))
    .filter(Boolean);
}

/** Any RSS/Atom feed that mirrors RONB — bridge services or their own site. */
async function fromFeed(feedUrl, platform, limit) {
  const feed = await parser.parseURL(feedUrl);
  return (feed.items || []).slice(0, limit).map((item) => {
    const body = item.contentEncoded || item.content || item.contentSnippet || item.summary || '';
    // Bridges put the caption in the title when there is no separate body.
    const caption = stripHtml(body).length > 40
      ? `${stripHtml(item.title || '')}\n${stripHtml(body)}`.trim()
      : stripHtml(item.title || body);

    return buildPost({
      id: `ronb-${platform}:${hash(item.guid || item.link || caption)}`,
      platform,
      caption,
      url: String(item.link || '').trim() || null,
      image: item.enclosure?.url || item.mediaContent?.$?.url || firstImage(body),
      postedAt: item.isoDate || item.pubDate,
    });
  }).filter(Boolean);
}

/**
 * Read RONB through every configured route and merge the results.
 *
 * Facebook and Instagram carry near-identical captions, so the same story
 * arriving on both collapses to one post — first one wins, and Graph results
 * are collected before bridges so the richer record survives.
 *
 * @returns {Promise<{posts:Array, routes:string[], configured:boolean, errors:string[]}>}
 */
async function fetchAll(limit = 12) {
  const p = providers();
  const jobs = [];

  if (p.graphFacebook) jobs.push(['Facebook Graph', () => fromGraphFacebook(limit)]);
  if (p.graphInstagram) jobs.push(['Instagram Graph', () => fromGraphInstagram(limit)]);
  if (p.bridgeFacebook) jobs.push(['Facebook bridge', () => fromFeed(env('RONB_FB_FEED'), 'facebook', limit)]);
  if (p.bridgeInstagram) jobs.push(['Instagram bridge', () => fromFeed(env('RONB_IG_FEED'), 'instagram', limit)]);
  if (p.mirror) jobs.push(['ronb site', () => fromFeed(MIRROR_FEED, 'web', limit)]);
  if (p.twitter) jobs.push([`@${X_HANDLE}`, () => fromTwitter(limit)]);

  if (!jobs.length) {
    log.debug('No RONB route configured — social feed runs on newspapers only');
    return { posts: [], routes: [], configured: false, errors: [] };
  }

  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  const posts = [];
  const routes = [];
  const errors = [];
  const seen = new Set();
  let stale = 0;

  // Archive guard. Several routes hand back a page's whole history, not just
  // what is new — the X embed timeline goes back to 2020. Without this the
  // first successful poll would dump years of posts into the channel.
  const oldest = Date.now() - (config.news.maxAgeHours ?? 24) * 3600 * 1000;

  settled.forEach((result, i) => {
    const name = jobs[i][0];
    if (result.status === 'rejected') {
      errors.push(`${name}: ${result.reason?.message || 'failed'}`);
      log.debug(`${name} unavailable: ${result.reason?.message}`);
      return;
    }
    let kept = 0;
    for (const post of result.value) {
      const at = Date.parse(`${String(post.posted_at || '').replace(' ', 'T')}Z`);
      if (Number.isFinite(at) && at < oldest) { stale++; continue; }
      // Same caption cross-posted to FB and IG — keep one.
      const fingerprint = hash(post.content.slice(0, 180).toLowerCase().replace(/\s+/g, ''));
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      posts.push(post);
      kept++;
    }
    if (result.value.length) routes.push(`${name} (${kept})`);
  });

  if (posts.length) {
    const noise = posts.filter((x) => !x.is_news).length;
    log.info(`RONB: ${posts.length} fresh posts via ${routes.join(', ')}`
      + ` — ${posts.length - noise} news, ${noise} filler`
      + (stale ? ` (${stale} older than ${config.news.maxAgeHours}h ignored)` : ''));
  } else if (errors.length) {
    log.debug(`RONB routes all quiet: ${errors.join(' | ')}`);
  } else if (stale) {
    log.debug(`RONB: nothing new — ${stale} posts seen but all older than ${config.news.maxAgeHours}h`);
  }

  return { posts, routes, configured: true, errors, stale };
}

module.exports = { fetchAll, isConfigured, activeRoutes, providers, buildPost, headlineOf, PAGE_URL };
