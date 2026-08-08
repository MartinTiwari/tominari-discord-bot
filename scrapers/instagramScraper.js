'use strict';

const log = require('../utils/logger')('instagram');
const { getJson } = require('../utils/http');
const { stripHtml, summarize } = require('../utils/text');
const { toSqlTimestamp } = require('../utils/time');
const classifier = require('../utils/categoryClassifier');
const config = require('../utils/config');

/**
 * Instagram reader for sources such as RONB.
 *
 * Uses the official Instagram Graph API when IG_USER_ID + FB_PAGE_ACCESS_TOKEN
 * are configured (only possible for accounts you own or have been granted
 * access to). Unauthenticated scraping of instagram.com is not implemented —
 * it requires logged-in sessions, breaks weekly, and violates Meta's terms.
 *
 * When unavailable, realtimeSocialFeed falls back to the source's RSS feed
 * (RONB mirrors its posts on routineofnepalbanda.com).
 */

const GRAPH_VERSION = 'v21.0';

function isAvailable() {
  return Boolean(process.env.FB_PAGE_ACCESS_TOKEN && process.env.IG_USER_ID);
}

async function fetchProfile(source, limit = 10) {
  if (!isAvailable()) {
    log.debug('Instagram Graph API not configured — using RSS fallback');
    return [];
  }

  const fields = 'id,caption,media_url,permalink,timestamp,like_count,comments_count,media_type';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.IG_USER_ID}/media`
    + `?fields=${encodeURIComponent(fields)}&limit=${limit}`
    + `&access_token=${encodeURIComponent(process.env.FB_PAGE_ACCESS_TOKEN)}`;

  try {
    const data = await getJson(url, { retries: 1 });
    return (data.data || []).map((m) => normalizeMedia(m, source)).filter(Boolean);
  } catch (err) {
    log.warn(`${source.source_name}: Instagram Graph failed (${err.message}) — falling back to RSS`);
    return [];
  }
}

function normalizeMedia(m, source) {
  const caption = stripHtml(m.caption || '');
  if (!caption) return null;

  const title = caption.split('\n')[0].slice(0, 240);
  return {
    external_post_id: `ig:${m.id}`,
    source_id: source.id ?? null,
    source_name: source.source_name || source.name,
    title,
    content: caption,
    summary: summarize(caption, config.news.socialSummaryLength),
    url: m.permalink || source.page_url || null,
    image_url: m.media_type === 'VIDEO' ? null : m.media_url || null,
    category: classifier.classify({ title, content: caption, url: m.permalink }),
    priority: classifier.priorityFor({ title, content: caption, sourcePriority: source.priority }),
    posted_at: toSqlTimestamp(m.timestamp),
    likes: m.like_count || 0,
    comments: m.comments_count || 0,
  };
}

module.exports = { fetchProfile, isAvailable, normalizeMedia };
