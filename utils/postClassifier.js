'use strict';

/**
 * Tells apart the two kinds of thing a page like RONB posts:
 *
 *   - actual news  → worth a summary and a proper embed
 *   - everything else (birthday wishes, sponsor plugs, giveaways, festival
 *     greetings, "tag a friend" bait) → worth a roast, not a headline
 *
 * The signal is keyword-based rather than model-based on purpose: RONB writes
 * in a mix of English, Nepali and romanised Nepali, and a short keyword list
 * that we can read and tune beats an opaque classifier for this.
 *
 * `classifyKind()` returns one of the KINDS below plus the matched evidence,
 * so /why-roast and the logs can explain any decision.
 */

const KINDS = {
  NEWS: 'news',
  BIRTHDAY: 'birthday',
  SPONSORED: 'sponsored',
  PROMO: 'promo',
  GREETING: 'greeting',
  ENGAGEMENT: 'engagement',
};

/** Non-news signals. Each entry: [kind, weight, pattern]. */
const NOISE_PATTERNS = [
  // ---- birthdays / anniversaries / condolences-as-tribute posts ----
  [KINDS.BIRTHDAY, 4, /\bhappy\s+(?:\d+(?:st|nd|rd|th)\s+)?birthday\b/i],
  [KINDS.BIRTHDAY, 4, /\bbirthday\s+(?:wishes|greetings|shubhakamana)\b/i],
  [KINDS.BIRTHDAY, 3, /\b(?:janmadin|janma\s?din|janmotsav)\b/i],
  [KINDS.BIRTHDAY, 3, /\bशुभ\s*जन्मदिन|जन्मदिनको\s*शुभकामना/],
  [KINDS.BIRTHDAY, 3, /\bwishing\s+(?:him|her|them|you)\s+a\s+(?:very\s+)?happy\b/i],
  [KINDS.BIRTHDAY, 2, /\bturns?\s+\d{1,3}\s+today\b/i],
  [KINDS.BIRTHDAY, 2, /\bhappy\s+(?:\d+(?:st|nd|rd|th)\s+)?anniversary\b/i],

  // ---- sponsorship / paid partnership ----
  [KINDS.SPONSORED, 5, /\b(?:paid\s+partnership|sponsored\s+(?:post|content|by)|#ad\b|#sponsored)/i],
  [KINDS.SPONSORED, 4, /\bin\s+association\s+with\b/i],
  [KINDS.SPONSORED, 4, /\bbrought\s+to\s+you\s+by\b/i],
  [KINDS.SPONSORED, 3, /\bpowered\s+by\b/i],
  [KINDS.SPONSORED, 3, /\bpartnered\s+with\b/i],
  [KINDS.SPONSORED, 3, /\bofficial\s+(?:partner|sponsor)\b/i],

  // ---- product pushes, offers, giveaways, hiring ----
  [KINDS.PROMO, 4, /\bgiveaway\b|\bलक्की\s*ड्र|\blucky\s+draw\b/i],
  [KINDS.PROMO, 4, /\buse\s+(?:the\s+)?(?:coupon|promo)\s+code\b|\bcoupon\s+code\b/i],
  [KINDS.PROMO, 3, /\b(?:download|install)\s+(?:the\s+)?app\s+(?:now|today)\b/i],
  [KINDS.PROMO, 3, /\b(?:\d{1,3}\s*%\s*(?:off|discount))|\bdiscount\s+offer\b/i],
  [KINDS.PROMO, 3, /\blimited\s+(?:time\s+)?offer\b|\bhurry\s+up\b/i],
  [KINDS.PROMO, 3, /\bbook\s+now\b|\border\s+now\b|\bshop\s+now\b|\bbuy\s+now\b/i],
  [KINDS.PROMO, 3, /\bwe\s+are\s+hiring\b|\bjob\s+vacancy\b|\bapply\s+(?:now|before)\b/i],
  [KINDS.PROMO, 2, /\bregister\s+(?:now|today)\b|\bearly\s+bird\s+(?:offer|price)\b/i],

  // ---- festival / holiday greetings ----
  [KINDS.GREETING, 4, /\bhappy\s+(?:dashain|tihar|new\s+year|holi|teej|losar|lhosar|eid|christmas|nepali\s+new\s+year)\b/i],
  [KINDS.GREETING, 3, /\b(?:shubha?\s*)?(?:dashain|tihar|deepawali|chhath)\s+(?:ko\s+)?shubhakamana\b/i],
  [KINDS.GREETING, 3, /शुभकामना|मंगलमय/],
  [KINDS.GREETING, 3, /\bgreetings\s+(?:to\s+)?all\b|\bwarm\s+wishes\b/i],
  [KINDS.GREETING, 2, /\brest\s+in\s+(?:peace|power)\b|\bRIP\b/],

  // ---- pure engagement bait ----
  [KINDS.ENGAGEMENT, 4, /\btag\s+(?:a|your)\s+(?:friend|frd|साथी)/i],
  [KINDS.ENGAGEMENT, 3, /\bdouble\s+tap\b|\blike\s+and\s+share\b|\bshare\s+garnus\b/i],
  [KINDS.ENGAGEMENT, 3, /\bcomment\s+(?:below|your)\b.*\?$/i],
  [KINDS.ENGAGEMENT, 3, /\bfollow\s+(?:us|@)\b.*\bfor\s+more\b/i],
  [KINDS.ENGAGEMENT, 2, /\bwhat\s+do\s+you\s+think\s*\?/i],
];

/**
 * News signals. These both rescue a post that merely mentions a noise word
 * ("Ncell announces…" is news, not an ad) and confirm genuine reporting.
 */
const NEWS_PATTERNS = [
  [5, /\b(?:banda|bandh)\b|\bबन्द\b/i],                    // RONB's core beat
  [4, /\b(?:chakka\s*jam|strike|protest|curfew|nakabandi)\b/i],
  [4, /\bearthquake\b|\bflood(?:ing|s)?\b|\blandslide\b|\bभूकम्प\b|\bबाढी\b|\bपहिरो\b/i],
  [3, /\b(?:killed|injured|dead|death\s+toll|casualt(?:y|ies))\b/i],
  [3, /\b(?:arrested|detained|charged|sentenced|verdict|court)\b/i],
  [3, /\b(?:govt|government|ministry|minister|parliament|cabinet|supreme\s+court)\b/i],
  [3, /\b(?:announced|announces|issued|declares?|declared)\b/i],
  [3, /\b(?:road|highway|flight|airport)\s+(?:closed|blocked|obstructed|cancell?ed|diverted)\b/i],
  [3, /\baccording\s+to\b|\bसूत्रका\s*अनुसार\b/i],
  [2, /\b(?:police|traffic\s+office|district\s+administration)\b/i],
  [2, /\b(?:price|fare|tariff)\s+(?:hike|increase|revised|cut)\b/i],
  [2, /\bbreaking\b|\bupdate\b|\bजरुरी\s*सूचना\b/i],
  [2, /\btoday|tomorrow|yesterday\b.*\b(?:from|until|till)\s+\d/i],
];

const NEWSY_SOURCE_HINT = /(post|times|khabar|pati|news|republica|kantipur|express|nepal\s?minute)/i;

/**
 * Decide what a social post actually is.
 *
 * @param {{title?:string, content?:string, summary?:string, source_name?:string}} post
 * @returns {{kind:string, isNews:boolean, confidence:number, evidence:string[]}}
 */
function classifyKind(post = {}) {
  const text = [post.title, post.content || post.summary].filter(Boolean).join('\n');
  if (!text.trim()) {
    return { kind: KINDS.NEWS, isNews: true, confidence: 0, evidence: [] };
  }

  const evidence = [];
  const scores = {};
  for (const [kind, weight, pattern] of NOISE_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    scores[kind] = (scores[kind] || 0) + weight;
    evidence.push(`${kind}: “${String(m[0]).trim().slice(0, 40)}”`);
  }

  let newsScore = 0;
  for (const [weight, pattern] of NEWS_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    newsScore += weight;
    if (evidence.length < 8) evidence.push(`news: “${String(m[0]).trim().slice(0, 40)}”`);
  }

  // A wire service posting under its own byline is reporting until proven
  // otherwise; a page like RONB mixes news and filler in the same stream.
  if (NEWSY_SOURCE_HINT.test(post.source_name || '')) newsScore += 2;

  const [topKind, topScore] = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])[0] || [null, 0];

  // Noise has to clear a floor *and* beat the news signal, so "Ncell announces
  // free data after the quake" stays news even though it names a brand.
  const isNoise = topScore >= 3 && topScore > newsScore;

  return {
    kind: isNoise ? topKind : KINDS.NEWS,
    isNews: !isNoise,
    confidence: isNoise ? Math.min(1, topScore / 8) : Math.min(1, Math.max(newsScore, 1) / 8),
    evidence: evidence.slice(0, 6),
  };
}

module.exports = { classifyKind, KINDS };
