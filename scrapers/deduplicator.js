'use strict';

const db = require('../utils/database');
const { stripHtml } = require('../utils/text');

/**
 * Two layers of duplicate protection:
 *
 *  1. Hard: `external_post_id` has a UNIQUE constraint, so the same feed item
 *     can never be stored twice even across restarts.
 *  2. Soft: near-identical headlines from different outlets covering the same
 *     story get collapsed within a single cycle, so the channel does not show
 *     seven versions of one press release.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are',
  'was', 'were', 'be', 'as', 'by', 'with', 'from', 'that', 'this', 'it', 'its',
  'has', 'have', 'will', 'says', 'said', 'after', 'over', 'new', 'nepal',
]);

/** Normalise a headline into a comparable set of significant words. */
function tokenize(title) {
  return new Set(
    stripHtml(title)
      .toLowerCase()
      .replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard overlap of two token sets: 0 (unrelated) → 1 (identical). */
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** True when this exact item was already stored (checked against the DB). */
function isKnown(post) {
  return db.socialPostExists(post.external_post_id);
}

/**
 * Filter a batch down to genuinely new, mutually distinct posts.
 * @param {Array} posts normalised posts, any order
 * @param {number} threshold similarity above which two headlines are "the same story"
 */
function filterNew(posts, threshold = 0.6) {
  const accepted = [];
  const seenTokens = [];

  for (const post of posts) {
    if (!post?.title || isKnown(post)) continue;

    const tokens = tokenize(post.title);
    const clash = seenTokens.some((t) => similarity(tokens, t) >= threshold);
    if (clash) continue;

    seenTokens.push(tokens);
    accepted.push(post);
  }
  return accepted;
}

/** Collapse near-duplicate articles inside an already-selected list. */
function dedupeArticles(articles, threshold = 0.6) {
  const out = [];
  const seen = [];
  for (const a of articles) {
    const tokens = tokenize(a.title || '');
    if (seen.some((t) => similarity(tokens, t) >= threshold)) continue;
    seen.push(tokens);
    out.push(a);
  }
  return out;
}

module.exports = { filterNew, dedupeArticles, isKnown, similarity, tokenize };
