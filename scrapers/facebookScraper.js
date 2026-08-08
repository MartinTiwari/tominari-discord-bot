'use strict';

const log = require('../utils/logger')('facebook');
const { getJson } = require('../utils/http');
const { stripHtml, summarize, hash } = require('../utils/text');
const { toSqlTimestamp } = require('../utils/time');
const classifier = require('../utils/categoryClassifier');
const config = require('../utils/config');

/**
 * Facebook page reader.
 *
 * Only the official Graph API path is implemented. It activates when
 * FB_PAGE_ACCESS_TOKEN is set and the source carries a numeric `page_id`
 * (put it in the `page_url` field as `fb:<page_id>` or a plain numeric id).
 *
 * HTML scraping of facebook.com is intentionally NOT implemented: it violates
 * Meta's terms, breaks constantly, and gets IPs blocked. When no token is
 * present this module reports unavailability and realtimeSocialFeed falls back
 * to the outlet's public RSS feed, which carries the same headlines.
 */

const GRAPH_VERSION = 'v21.0';

function isAvailable() {
  return Boolean(process.env.FB_PAGE_ACCESS_TOKEN);
}

/** Pull the page id out of `page_url`, supporting "fb:123", a bare id, or a URL. */
function resolvePageId(source) {
  const raw = source.page_id || source.page_url || '';
  const tagged = String(raw).match(/^fb:(\d+)$/);
  if (tagged) return tagged[1];
  if (/^\d+$/.test(String(raw).trim())) return String(raw).trim();
  // Vanity URLs cannot be resolved to an id without an extra approved call.
  return null;
}

/**
 * @returns {Promise<Array>} normalised posts, or [] when Graph access is not
 *   configured for this source (caller should fall back to RSS).
 */
async function fetchPage(source, limit = 10) {
  if (!isAvailable()) {
    log.debug('FB_PAGE_ACCESS_TOKEN not set — Graph API disabled');
    return [];
  }

  const pageId = resolvePageId(source);
  if (!pageId) {
    log.debug(`${source.source_name}: no numeric page id configured — using RSS instead`);
    return [];
  }

  const fields = [
    'id', 'message', 'created_time', 'permalink_url', 'full_picture',
    'reactions.summary(total_count).limit(0)',
    'comments.summary(total_count).limit(0)',
  ].join(',');

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/posts`
    + `?fields=${encodeURIComponent(fields)}&limit=${limit}`
    + `&access_token=${encodeURIComponent(process.env.FB_PAGE_ACCESS_TOKEN)}`;

  try {
    const data = await getJson(url, { retries: 1 });
    const posts = (data.data || [])
      .map((p) => normalizePost(p, source))
      .filter(Boolean);
    log.debug(`${source.source_name}: ${posts.length} Graph posts`);
    return posts;
  } catch (err) {
    log.warn(`${source.source_name}: Graph API failed (${err.message}) — falling back to RSS`);
    return [];
  }
}

function normalizePost(p, source) {
  const message = stripHtml(p.message || '');
  if (!message) return null;                       // photo-only posts carry no headline

  const title = message.split('\n')[0].slice(0, 240) || 'Facebook post';
  return {
    external_post_id: `fb:${p.id || hash(message)}`,
    source_id: source.id ?? null,
    source_name: source.source_name || source.name,
    title,
    content: message,
    summary: summarize(message, config.news.socialSummaryLength),
    url: p.permalink_url || source.page_url || null,
    image_url: p.full_picture || null,
    category: classifier.classify({ title, content: message, url: p.permalink_url }),
    priority: classifier.priorityFor({ title, content: message, sourcePriority: source.priority }),
    posted_at: toSqlTimestamp(p.created_time),
    likes: p.reactions?.summary?.total_count || 0,
    comments: p.comments?.summary?.total_count || 0,
  };
}

module.exports = { fetchPage, isAvailable, normalizePost };
