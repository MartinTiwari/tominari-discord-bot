'use strict';

const cheerio = require('cheerio');
const log = require('../utils/logger')('summarizer');
const { getText } = require('../utils/http');
const { stripHtml, truncate } = require('../utils/text');

/**
 * Turns a headline into something you can actually understand without opening
 * the link.
 *
 * Most Nepali outlets put only a teaser (often just the headline again) in
 * their RSS `description`, so a feed-only summary tells you nothing. This
 * module fetches the article page, pulls the real body text out of it, and
 * builds an extractive summary — the few sentences that carry the story.
 *
 * Extractive, not generative: no API key, no hallucinated facts, and every
 * sentence in the output is one the outlet actually published.
 */

// Cheap in-process cache — the same URL shows up in the social feed, the
// morning brief and /news within the same hour.
const cache = new Map();
const CACHE_MAX = 500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Feed text shorter than this is a teaser, not a story — go fetch the page. */
const THIN_FEED_CHARS = 700;

/**
 * WordPress feeds (OnlineKhabar, Ratopati, Nepal Minute…) append a syndication
 * footer to every item and cut the body off with an ellipsis marker. Both are
 * noise, and the marker means the text is a teaser however long it looks.
 */
const FEED_FOOTER = /\s*(?:The post\s.+?\sappeared first on\s.+?\.?|Continue reading\s.*)$/i;
const TEASER_MARKER = /\[(?:…|\.\.\.|&#8230;)\]/;

/** Clean a feed `description` down to the part the outlet actually wrote. */
function cleanFeedText(text) {
  return stripHtml(text).replace(FEED_FOOTER, '').replace(TEASER_MARKER, '').trim();
}

const BODY_SELECTORS = [
  'article',
  '[itemprop="articleBody"]',
  '.article-content', '.article__content', '.article-body',
  '.entry-content', '.post-content', '.news-content', '.story-content',
  '#newsContent', '.editor-box', '.description__content',
  'main',
];

/** Always noise, wherever they appear. */
const STRIP_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'form', 'nav',
  'figure', 'figcaption', 'table',
  '.related', '.related-news', '.recommended', '.advertisement', '.ad',
  '.share', '.social', '.newsletter', '.comments', '.tags', '.breadcrumb',
].join(', ');

/**
 * Usually chrome, but not always: Setopati wraps the whole article in
 * `<aside class="left-side">`, so these are dropped only when they do not
 * themselves contain prose.
 */
const MAYBE_CHROME = 'aside, header, footer';

// Boilerplate lines that survive extraction on Nepali news sites.
const JUNK_LINE = new RegExp([
  '^(?:advertisement|sponsored|read also|also read|related news|you may also like)\\b',
  '^(?:published|updated|last updated)\\s*[:(]',
  '^(?:share|tweet|whatsapp|viber|facebook)\\b',
  '^(?:kathmandu|pokhara|biratnagar)\\s*[,:]?\\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\b.{0,20}$',
  '^\\s*(?:©|copyright)',
  'सम्बन्धित\\s*समाचार|प्रकाशित\\s*मिति',
].join('|'), 'i');

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

/**
 * Pull the article body out of a news page.
 * @returns {string} plain text, or '' when nothing usable was found
 */
function extractBody(html) {
  const $ = cheerio.load(html);
  $(STRIP_SELECTORS).remove();

  $(MAYBE_CHROME).each((_, el) => {
    const prose = $(el).find('p').toArray().filter((p) => $(p).text().trim().length > 40);
    if (prose.length < 2) $(el).remove();
  });

  let best = '';
  for (const selector of BODY_SELECTORS) {
    $(selector).each((_, el) => {
      const paragraphs = $(el).find('p').toArray()
        .map((p) => stripHtml($(p).text()))
        .filter((t) => t.length > 40 && !JUNK_LINE.test(t));
      const text = paragraphs.join('\n');
      if (text.length > best.length) best = text;
    });
    // A well-marked container beats a longer but noisier one, so stop as soon
    // as a selector yields a plausible article.
    if (best.length > 600) break;
  }

  // Last resort: every paragraph on the page, which is noisy but beats nothing.
  if (best.length < 200) {
    const all = $('p').toArray()
      .map((p) => stripHtml($(p).text()))
      .filter((t) => t.length > 60 && !JUNK_LINE.test(t));
    if (all.join('\n').length > best.length) best = all.join('\n');
  }

  return best;
}

/** Split into sentences, handling the Nepali danda alongside Latin stops. */
function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && !JUNK_LINE.test(s));
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'that', 'this', 'it', 'its', 'he', 'she', 'they', 'we', 'said',
  'will', 'would', 'can', 'could', 'also', 'after', 'before', 'over', 'into',
]);

function keywords(text) {
  return new Set(
    String(text).toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Score sentences and keep the best ones, in the order the outlet wrote them.
 *
 * News is written inverted-pyramid, so position matters most: the first two
 * sentences almost always carry who/what/where. Title overlap and concrete
 * detail (numbers, attribution) break the ties after that.
 */
function extractive(body, title, maxChars) {
  const sentences = splitSentences(body);
  if (!sentences.length) return '';

  const titleWords = keywords(title || '');
  const scored = sentences.slice(0, 25).map((sentence, i) => {
    const words = keywords(sentence);
    let overlap = 0;
    for (const w of words) if (titleWords.has(w)) overlap++;

    let score = 0;
    score += Math.max(0, 6 - i * 1.5);                    // inverted pyramid
    score += overlap * 1.5;                               // on-topic
    if (/\d/.test(sentence)) score += 1.2;                // figures, dates, counts
    if (/\b(?:said|according to|announced|confirmed|अनुसार|भने)\b/i.test(sentence)) score += 1;
    if (sentence.length < 45) score -= 1.5;               // stubs
    if (sentence.length > 320) score -= 1;                // walls of text
    return { sentence, score, i };
  });

  const picked = [];
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (used + item.sentence.length + 1 > maxChars) continue;
    picked.push(item);
    used += item.sentence.length + 1;
    if (picked.length >= 4) break;
  }
  if (!picked.length) return truncate(sentences[0], maxChars);

  return picked.sort((a, b) => a.i - b.i).map((p) => p.sentence).join(' ');
}

/**
 * Best available summary for an article.
 *
 * @param {{url?:string, title?:string, content?:string, summary?:string}} article
 * @param {{maxChars?:number, fetch?:boolean}} [options]
 *   `fetch: false` keeps it offline and summarises whatever text we already have.
 * @returns {Promise<{text:string, origin:'body'|'feed'|'title', chars:number}>}
 */
async function summarizeArticle(article = {}, { maxChars = 600, fetchPage = true } = {}) {
  const title = stripHtml(article.title || '');
  const rawFeed = String(article.content || article.summary || '');
  const feedText = cleanFeedText(rawFeed);
  // Feed links routinely carry stray whitespace/newlines around the URL.
  const href = String(article.url || '').trim();
  const url = /^https?:\/\//i.test(href) ? href : null;

  // A "[…]" cut-off means the feed is a teaser no matter how long it reads.
  const isTeaser = TEASER_MARKER.test(rawFeed);

  // Feed already carries the story — no need to hit the site.
  if (!isTeaser && feedText.length >= THIN_FEED_CHARS) {
    return { text: extractive(feedText, title, maxChars), origin: 'feed', chars: feedText.length };
  }

  if (url && fetchPage) {
    const cached = cacheGet(url);
    if (cached !== null) {
      return cached
        ? { text: extractive(cached, title, maxChars), origin: 'body', chars: cached.length }
        : fallbackSummary(feedText, title, maxChars);
    }

    try {
      const html = await getText(url, { timeout: 12_000, retries: 1 });
      const body = extractBody(html);
      cacheSet(url, body);
      if (body.length > Math.max(feedText.length, 200)) {
        return { text: extractive(body, title, maxChars), origin: 'body', chars: body.length };
      }
    } catch (err) {
      cacheSet(url, '');                     // don't retry a dead page all cycle
      log.debug(`Body fetch failed for ${url}: ${err.message}`);
    }
  }

  return fallbackSummary(feedText, title, maxChars);
}

function fallbackSummary(feedText, title, maxChars) {
  if (feedText && feedText.length > title.length + 20) {
    return { text: extractive(feedText, title, maxChars) || truncate(feedText, maxChars), origin: 'feed', chars: feedText.length };
  }
  return { text: '', origin: 'title', chars: 0 };
}

/**
 * Summarise many articles with bounded concurrency, mutating nothing.
 * @returns {Promise<Array>} the same articles with `summary` / `summary_origin` set
 */
async function enrich(articles, { maxChars = 600, concurrency = 4, fetchPage = true } = {}) {
  const out = [...articles];
  let cursor = 0;

  async function worker() {
    while (cursor < out.length) {
      const i = cursor++;
      try {
        const { text, origin } = await summarizeArticle(out[i], { maxChars, fetchPage });
        if (text) out[i] = { ...out[i], summary: text, summary_origin: origin };
      } catch (err) {
        log.debug(`Enrich failed for "${out[i]?.title}": ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, out.length) }, worker));
  return out;
}

module.exports = { summarizeArticle, enrich, extractBody, extractive, splitSentences };
