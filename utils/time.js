'use strict';

const config = require('./config');

/**
 * Timezone helpers built on Intl, so we never hand-roll the UTC+05:45 offset
 * that Nepal uses (and that breaks naive minute-based arithmetic).
 */

/** Current wall-clock hour/minute/date in the given IANA timezone. */
function nowInZone(timeZone = config.timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());

  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = Number(get('hour')) % 24; // Intl can emit "24" at midnight
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: Number(get('minute')),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hhmm: `${String(hour).padStart(2, '0')}:${get('minute')}`,
  };
}

/** Human-friendly date/time stamp, e.g. "8 Aug 2026, 06:00". */
function formatDateTime(date = new Date(), timeZone = config.timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date instanceof Date ? date : new Date(date));
}

/** "3h ago" / "just now" style relative label. */
function relativeTime(isoLike) {
  if (!isoLike) return 'unknown time';
  const then = new Date(String(isoLike).includes('T') ? isoLike : `${isoLike.replace(' ', 'T')}Z`);
  if (Number.isNaN(then.getTime())) return 'unknown time';
  const mins = Math.round((Date.now() - then.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Which greeting bucket the current local hour falls into. */
function timeOfDay(timeZone = config.timezone) {
  const { hour } = nowInZone(timeZone);
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

/**
 * True when the local hour is inside the configured quiet window.
 * Handles windows that wrap past midnight (e.g. 23 → 6).
 */
function inQuietHours(timeZone = config.timezone, quiet = config.health.quietHours) {
  if (!quiet) return false;
  const { hour } = nowInZone(timeZone);
  const { start, end } = quiet;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** SQLite-friendly UTC timestamp: 'YYYY-MM-DD HH:MM:SS'. */
function toSqlTimestamp(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = {
  nowInZone, formatDateTime, relativeTime, timeOfDay, inQuietHours, toSqlTimestamp,
};
