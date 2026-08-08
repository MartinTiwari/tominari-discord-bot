'use strict';

const log = require('../utils/logger')('newsapi');
const { getJson } = require('./http');
const { stripHtml, summarize, hash } = require('./text');
const { toSqlTimestamp } = require('./time');
const classifier = require('./categoryClassifier');
const config = require('./config');

/**
 * NewsAPI.org client. Optional — when NEWSAPI_KEY is absent every function
 * returns an empty list and the briefs fall back to the RSS/social corpus we
 * already collected, so the bot still works on a free setup.
 *
 * Free tier is 100 requests/day, so we make at most a handful of calls per
 * brief and cache nothing beyond what lands in the database.
 */

const BASE = 'https://newsapi.org/v2';

function isConfigured() {
  return Boolean(process.env.NEWSAPI_KEY);
}

function headers() {
  return { 'X-Api-Key': process.env.NEWSAPI_KEY };
}

function normalizeArticle(a, forcedCategory = null) {
  const title = stripHtml(a.title || '');
  if (!title || title === '[Removed]') return null;

  const content = stripHtml(a.content || a.description || '');
  const category = forcedCategory
    || classifier.classify({ title, content, url: a.url });

  return {
    external_id: `newsapi:${hash(a.url || title)}`,
    title,
    content: content || title,
    summary: summarize(content || title, config.news.briefSummaryLength),
    source: a.source?.name || 'NewsAPI',
    category,
    url: a.url || null,
    image_url: a.urlToImage || null,
    published_at: toSqlTimestamp(a.publishedAt),
    priority: classifier.priorityFor({ title, content }),
  };
}

/**
 * Nepal-focused headlines. NewsAPI has no `country=np` on the free plan, so we
 * use the /everything endpoint with a Nepal query instead.
 */
async function fetchNepalNews({ pageSize = 40, extraQuery = null } = {}) {
  if (!isConfigured()) {
    log.debug('NEWSAPI_KEY not set — skipping NewsAPI');
    return [];
  }

  const q = extraQuery ? `Nepal AND (${extraQuery})` : 'Nepal OR Kathmandu OR Nepali';
  const from = new Date(Date.now() - config.news.maxAgeHours * 3600_000)
    .toISOString().slice(0, 10);
  const url = `${BASE}/everything?q=${encodeURIComponent(q)}`
    + `&language=en&sortBy=publishedAt&pageSize=${pageSize}&from=${from}`;

  try {
    const data = await getJson(url, { headers: headers(), retries: 1 });
    if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI returned an error');
    const articles = (data.articles || []).map((a) => normalizeArticle(a)).filter(Boolean);
    log.info(`Fetched ${articles.length} Nepal articles`);
    return articles;
  } catch (err) {
    log.warn(`Nepal fetch failed: ${err.message}`);
    return [];
  }
}

/** Top international headlines, used to keep #world stocked. */
async function fetchWorldHeadlines({ pageSize = 20 } = {}) {
  if (!isConfigured()) return [];

  const url = `${BASE}/top-headlines?language=en&category=general&pageSize=${pageSize}`;
  try {
    const data = await getJson(url, { headers: headers(), retries: 1 });
    if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI returned an error');
    return (data.articles || []).map((a) => normalizeArticle(a, 'world')).filter(Boolean);
  } catch (err) {
    log.warn(`World headlines failed: ${err.message}`);
    return [];
  }
}

module.exports = { fetchNepalNews, fetchWorldHeadlines, isConfigured, normalizeArticle };
