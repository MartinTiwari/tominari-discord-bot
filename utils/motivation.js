'use strict';

const quotes = require('../data/nepaliQuotes.json');
const config = require('./config');
const { pick } = require('./text');
const { timeOfDay } = require('./time');

/**
 * Picks the right anti-smoking line for a user, honouring their language
 * (nepali/english) and tone (tikho/soft) preferences, and fills in {days}.
 *
 * The tikho pool is deliberately crude street Nepali — that is the requested
 * voice: it reads like a friend yelling at you, not a health pamphlet.
 */

const BADGES = [
  { days: 7,   name: '🏅 One Week Champion',  nepali: '७ दिनको च्याम्पियन' },
  { days: 30,  name: '🏆 One Month Warrior',  nepali: '१ महिनाको योद्धा' },
  { days: 60,  name: '👑 Two Months Strong',  nepali: '२ महिनाको राजा' },
  { days: 90,  name: '💎 Three Months Legend', nepali: '३ महिनाको डायमण्ड' },
  { days: 365, name: '🌟 One Year Legend',    nepali: '१ वर्षको लेजेन्ड' },
];

// English equivalents so `/reminder-language english` is not just transliterated
// Nepali. Same energy, readable to a non-Nepali speaker in the server.
const ENGLISH = {
  tikho: [
    "Don't you dare light that up. {days} days of work on the line!",
    'You made it {days} days. One cigarette and you throw it all away?',
    'Craving is temporary. Quitting twice is worse. Put it down.',
    "You're not weak. Prove it right now — no cigarette today.",
    'That craving passes in 10 minutes. Your {days}-day streak does not come back.',
    'Nobody became a hero by smoking. You become one by stopping.',
    'Stressed? Walk, drink water, call someone. Anything but that cigarette.',
    '{days} days clean. Today is not the day you break it.',
    'One puff is how it always starts again. Not today.',
    'Your lungs are still repairing. Do not undo it for 5 minutes of nothing.',
  ],
  soft: [
    "You've got this — {days} days strong already. 💪",
    "{days} days without a cigarette is real progress. Keep going!",
    'One day at a time. Cravings come and go, you stay. 🔥',
    'Proud of you for {days} days. Today counts too.',
    'Every cigarette not smoked is a win. Add one more today. 💯',
  ],
};

function fill(template, days) {
  return String(template).replace(/\{days\}/g, days);
}

/**
 * @param {{days:number, language?:string, tone?:string}} opts
 * @returns {string} a ready-to-send motivational line
 */
function getMessage({ days = 0, language, tone } = {}) {
  const lang = language || config.health.defaultLanguage;
  const style = tone || config.health.defaultTone;

  if (lang === 'english') {
    return fill(pick(ENGLISH[style === 'soft' ? 'soft' : 'tikho']), days);
  }

  const pool = style === 'soft' ? quotes.softQuotes : quotes.tikhoQuotes;
  return fill(pick(pool), days);
}

/** Context-aware Nepali nudge tied to the time of day. */
function getTimeBasedNudge(timeZone) {
  const bucket = timeOfDay(timeZone);
  return quotes.encouragementPhrases[bucket] || quotes.encouragementPhrases.morning;
}

/** A relapse-prevention line, used when a user is close to a milestone. */
function getFailurePrevention(days = 0) {
  return fill(pick(quotes.failurePrevention), days);
}

/** A longer motivational story, used by /motivation --long style requests. */
function getStory(days = 0) {
  return fill(pick(quotes.motivationalStories), days);
}

/** Highest badge earned at `days`, or null. */
function badgeFor(days) {
  let earned = null;
  for (const b of BADGES) if (days >= b.days) earned = b;
  return earned;
}

/** The next badge above `days`, or null when everything is unlocked. */
function nextBadgeFor(days) {
  return BADGES.find((b) => b.days > days) || null;
}

/** 0→1 progress from the previous badge to the next one. */
function badgeProgress(days) {
  const next = nextBadgeFor(days);
  if (!next) return 1;
  const prev = badgeFor(days);
  const floor = prev ? prev.days : 0;
  return Math.max(0, Math.min(1, (days - floor) / (next.days - floor)));
}

/** Celebration text when `days` lands exactly on a milestone, else null. */
function milestoneMessage(days) {
  const key = String(days);
  return quotes.streakMilestones[key] || quotes.badgeMessages[key] || null;
}

/** Index of the earned badge (0 = none), stored on the streak row. */
function badgeLevelFor(days) {
  return BADGES.filter((b) => days >= b.days).length;
}

module.exports = {
  getMessage,
  getTimeBasedNudge,
  getFailurePrevention,
  getStory,
  badgeFor,
  nextBadgeFor,
  badgeProgress,
  milestoneMessage,
  badgeLevelFor,
  BADGES,
};
