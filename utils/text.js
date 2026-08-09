'use strict';

/** Small text helpers shared by scrapers and embed formatting. */

/** Strip HTML tags and collapse whitespace/entities into plain readable text. */
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Numeric entities carry the curly quotes and dashes WordPress feeds are full
 * of (&#8217;, &#8230;). Out-of-range values are dropped rather than thrown on.
 */
function safeCodePoint(code) {
  if (!Number.isInteger(code) || code < 32 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/**
 * Trim to `max` characters without cutting a word in half.
 * Adds an ellipsis when anything was removed.
 */
function truncate(text, max) {
  const clean = stripHtml(text);
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/**
 * Build a summary of at most `max` chars by taking whole sentences while they
 * fit, then falling back to a word-boundary truncation.
 */
function summarize(text, max = 150) {
  const clean = stripHtml(text);
  if (!clean) return '';
  if (clean.length <= max) return clean;

  const sentences = clean.match(/[^.!?।]+[.!?।]+/g);
  if (sentences) {
    let out = '';
    for (const s of sentences) {
      if ((out + s).trim().length > max) break;
      out += s;
    }
    out = out.trim();
    if (out.length >= Math.min(60, max * 0.4)) return out;
  }
  return truncate(clean, max);
}

/** Deterministic hash used to build stable IDs for feed items lacking a GUID. */
function hash(input) {
  let h = 5381;
  const str = String(input);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Pick a random element. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Pull the first <img src> out of an HTML blob, if any. */
function firstImage(html) {
  if (!html) return null;
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

module.exports = { stripHtml, truncate, summarize, hash, pick, firstImage };
