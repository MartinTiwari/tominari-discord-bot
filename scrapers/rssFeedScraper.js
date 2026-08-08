'use strict';

const Parser = require('rss-parser');
const log = require('../utils/logger')('rss');
const { getText } = require('../utils/http');
const { stripHtml, summarize, hash, firstImage } = require('../utils/text');
const { toSqlTimestamp } = require('../utils/time');
const classifier = require('../utils/categoryClassifier');
const config = require('../utils/config');

/**
 * RSS is the primary transport for every Nepali outlet we track. It is public,
 * stable, ToS-clean and needs no API approval — unlike Facebook/Instagram
 * scraping, which the optional scrapers in this folder handle when configured.
 */

// Several Nepali outlets sit behind CDNs that 403 anything that looks like a
// bot, so we present a normal browser User-Agent.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const parser = new Parser({
  timeout: 20_000,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

/** Best-effort image extraction across the many ways feeds attach one. */
function extractImage(item) {
  if (item.enclosure?.url && /^https?:/i.test(item.enclosure.url)) return item.enclosure.url;

  const media = Array.isArray(item.mediaContent) ? item.mediaContent : [item.mediaContent];
  for (const m of media) {
    const url = m?.$?.url || m?.url;
    if (url) return url;
  }
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;

  return firstImage(item.contentEncoded) || firstImage(item.content) || null;
}

/** Normalise an rss-parser item into the shape the rest of the bot expects. */
function normalizeItem(item, source) {
  const title = stripHtml(item.title || '').trim();
  if (!title) return null;

  const content = stripHtml(item.contentEncoded || item.content || item.contentSnippet || item.summary || '');
  const url = item.link || item.guid || null;
  const publishedAt = item.isoDate || item.pubDate || null;

  const feedCategory = Array.isArray(item.categories) ? item.categories[0] : item.categories;
  const category = classifier.classify({
    title,
    content,
    url,
    sourceCategory: feedCategory,
  });

  return {
    external_post_id: `${source.source_name || source.name}:${hash(item.guid || url || title)}`,
    source_id: source.id ?? null,
    source_name: source.source_name || source.name,
    title,
    content: content || title,
    summary: summarize(content || title, config.news.socialSummaryLength),
    url,
    image_url: extractImage(item),
    category,
    priority: classifier.priorityFor({ title, content, sourcePriority: source.priority }),
    posted_at: toSqlTimestamp(publishedAt),
    likes: 0,
    comments: 0,
  };
}

/**
 * Repair the two things that most often make a publisher's XML unparseable:
 * a bare `&` (usually inside an inline tracking script) and a leading BOM or
 * stray whitespace before the XML declaration.
 */
function sanitizeXml(xml) {
  return xml
    .replace(/^﻿/, '')
    .replace(/^\s+(?=<\?xml|<rss|<feed)/, '')
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;');
}

/**
 * Second attempt for feeds that fail strict parsing: fetch the body ourselves,
 * sanitize it, and parse from the string.
 */
async function parseWithRepair(feedUrl) {
  const xml = await getText(feedUrl, {
    retries: 1,
    timeout: 20_000,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });

  if (!/<(?:rss|feed|rdf:RDF)[\s>]/i.test(xml)) {
    throw new Error('response is not an RSS/Atom document (likely an HTML page)');
  }
  return parser.parseString(sanitizeXml(xml));
}

/**
 * Fetch and normalise one feed.
 * @param {object} source row from social_sources (or a plain {name, feed} object)
 * @param {number} limit  max items to return, newest first
 * @returns {Promise<Array>} normalised posts, newest first
 * @throws when the feed is unreachable or not parseable even after repair
 */
async function fetchFeed(source, limit = 15) {
  const feedUrl = source.feed_url || source.feed;
  const name = source.source_name || source.name;

  if (!feedUrl) {
    log.debug(`${name} has no feed URL — skipping`);
    return [];
  }

  try {
    let feed;
    try {
      feed = await parser.parseURL(feedUrl);
    } catch (err) {
      log.debug(`${name}: strict parse failed (${err.message}) — retrying with repair`);
      feed = await parseWithRepair(feedUrl);
    }

    const items = (feed.items || [])
      .map((item) => normalizeItem(item, source))
      .filter(Boolean);

    // Newest first; feeds are usually ordered already but not guaranteed.
    items.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
    log.debug(`${name}: ${items.length} items`);
    return items.slice(0, limit);
  } catch (err) {
    // Collapse the multi-line sax-js parse errors into one readable line.
    const message = err.message.split('\n')[0];
    log.warn(`${name} feed failed: ${message}`);
    throw new Error(message);         // caller records last_error on the source
  }
}

/** Fetch several feeds concurrently; individual failures do not reject. */
async function fetchAll(sources, limitPerSource = 15) {
  const results = await Promise.allSettled(
    sources.map((s) => fetchFeed(s, limitPerSource)),
  );
  return results.map((r, i) => ({
    source: sources[i],
    posts: r.status === 'fulfilled' ? r.value : [],
    error: r.status === 'rejected' ? r.reason.message : null,
  }));
}

module.exports = { fetchFeed, fetchAll, normalizeItem, sanitizeXml };
