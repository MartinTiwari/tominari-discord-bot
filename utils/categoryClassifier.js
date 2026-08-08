'use strict';

const categoriesData = require('../data/newsCategories.json');
const { stripHtml } = require('./text');

/**
 * Keyword/URL based classifier that tags an article or social post with one of
 * the seven Discord channel categories. Deliberately simple and dependency-free
 * — it only has to be right often enough to route a headline to a channel.
 */

const CATEGORIES = categoriesData.categories;
const DEFAULT_CATEGORY = categoriesData.default || 'world';

// Pre-compile matchers once at load.
//
// English terms use word boundaries so "app" does not match "happy". Devanagari
// cannot: JS `\b` is defined against [A-Za-z0-9_], so a boundary next to a
// Nepali character never matches. Nepali terms therefore use substring search,
// which is safe because they are long, distinctive words.
const compiled = Object.entries(CATEGORIES).map(([key, def]) => ({
  key,
  urlHints: def.urlHints || [],
  matchers: (def.keywords || []).map((kw) => ({
    kw,
    re: new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  })),
  nepali: def.nepali || [],
}));

/**
 * @param {{title?: string, content?: string, url?: string, sourceCategory?: string}} item
 * @returns {string} category key
 */
function classify(item = {}) {
  const title = stripHtml(item.title || '');
  const body = stripHtml(item.content || '').slice(0, 1200);
  const url = (item.url || '').toLowerCase();

  // A category supplied by the feed itself (RSS <category>, NewsAPI section)
  // wins outright when it maps to one of ours.
  if (item.sourceCategory) {
    const direct = normalizeCategory(item.sourceCategory);
    if (direct) return direct;
  }

  const scores = new Map();
  for (const cat of compiled) {
    let score = 0;

    // URL path is the strongest signal — outlets already file stories by desk.
    for (const hint of cat.urlHints) {
      if (url.includes(hint)) score += 8;
    }
    for (const { re } of cat.matchers) {
      if (re.test(title)) score += 3;      // headline hits count triple
      else if (re.test(body)) score += 1;
    }
    for (const kw of cat.nepali) {
      if (title.includes(kw)) score += 3;
      else if (body.includes(kw)) score += 1;
    }
    if (score > 0) scores.set(cat.key, score);
  }

  if (!scores.size) return DEFAULT_CATEGORY;
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Map an arbitrary label ("Sport", "money", "national") onto a known category. */
function normalizeCategory(label) {
  if (!label) return null;
  const l = String(label).toLowerCase().trim();
  if (CATEGORIES[l]) return l;

  const aliases = {
    sport: 'sports', khelkud: 'sports', football: 'sports', cricket: 'sports',
    money: 'business', economy: 'business', market: 'business', finance: 'business',
    national: 'politics', nation: 'politics', government: 'politics', rajniti: 'politics',
    technology: 'tech', science: 'tech', digital: 'tech',
    lifestyle: 'entertainment', art: 'entertainment', culture: 'entertainment',
    movies: 'entertainment', music: 'entertainment', showbiz: 'entertainment',
    international: 'world', global: 'world', general: 'world',
  };
  return aliases[l] || null;
}

/** HIGH/MEDIUM/LOW flag shown on brief embeds. */
function priorityFor(item = {}) {
  const text = `${item.title || ''} ${item.content || ''}`.toLowerCase();
  const urgent = [
    'breaking', 'urgent', 'killed', 'dead', 'earthquake', 'crash', 'emergency',
    'resign', 'arrested', 'landslide', 'flood', 'fire', 'blast', 'verdict', 'banda',
    // Nepali equivalents — matched as substrings, see the note above.
    'मृत्यु', 'भूकम्प', 'दुर्घटना', 'बन्द', 'राजीनामा', 'गिरफ्तार',
    'पहिरो', 'बाढी', 'आगलागी', 'विस्फोट', 'फैसला',
  ];
  const notable = [
    'announce', 'launch', 'approve', 'record', 'win', 'sign', 'report',
    'घोषणा', 'सुरु', 'स्वीकृत', 'सम्झौता', 'प्रतिवेदन',
  ];

  if (urgent.some((w) => text.includes(w))) return 'HIGH';
  if (item.sourcePriority === 'HIGH' || notable.some((w) => text.includes(w))) return 'MEDIUM';
  return 'LOW';
}

/** Display metadata (emoji + label) for a category key. */
function meta(category) {
  const def = CATEGORIES[category] || CATEGORIES[DEFAULT_CATEGORY];
  return { emoji: def.emoji, label: def.label, key: category };
}

module.exports = {
  classify,
  normalizeCategory,
  priorityFor,
  meta,
  CATEGORY_KEYS: Object.keys(CATEGORIES),
};
