'use strict';

const log = require('./logger')('sportsdb');
const { getJson } = require('./http');
const { formatDateTime } = require('./time');
const config = require('./config');

/**
 * TheSportsDB client — the bot's keyless live sports source.
 *
 * API-Football (utils/sportsApi.js) stays the first choice when SPORTS_API_KEY
 * is set, but its free tier is 100 calls/day and most installs have no key at
 * all. TheSportsDB's test key works without registration and covers standings,
 * fixtures and results for every league we track, so sports data is live out
 * of the box instead of falling back to a stale JSON snapshot.
 *
 * Nothing here throws: every function returns `{ data, live, note }` and logs
 * on failure, because a missing league table must never break a scheduler.
 */

// "3" is TheSportsDB's public test key. SPORTSDB_KEY upgrades to a Patreon key.
const KEY = (process.env.SPORTSDB_KEY || '3').trim();
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;

// League tables change at most once a matchday; fixtures a little more often.
const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

async function cachedGet(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = await getJson(`${BASE}${path}`, { retries: 1, timeout: 15_000 });
  cache.set(path, { at: Date.now(), value });
  return value;
}

/**
 * TheSportsDB uses its own numeric ids, unrelated to API-Football's. They are
 * verified against lookupteam/lookupleague and stored in config.json under
 * `sportsdbId`; these literals are the fallback for a config without them.
 */
const LEAGUE_IDS = {
  premier: 4328,
  laliga: 4335,
  bundesliga: 4331,
  seriea: 4332,
  ucl: 4480,
};

const TEAM_IDS = {
  bayern: 133664,
  barca: 133739,
  realmadrid: 133738,
};

function leagueId(key) {
  return config.sports.leagues?.[key]?.sportsdbId || LEAGUE_IDS[key] || null;
}

function teamId(key) {
  return config.sports.teams?.[key]?.sportsdbId || TEAM_IDS[key] || null;
}

/**
 * The league's own idea of the current season ("2026-2027"), which beats
 * guessing from the calendar around the July/August rollover.
 */
async function currentSeason(key) {
  const id = leagueId(key);
  if (!id) return null;
  try {
    const json = await cachedGet(`/lookupleague.php?id=${id}`);
    return json?.leagues?.[0]?.strCurrentSeason || null;
  } catch {
    return null;
  }
}

/** Step a "2026-2027" season string back one year. */
function previousSeason(season) {
  const m = String(season).match(/^(\d{4})-(\d{4})$/);
  return m ? `${Number(m[1]) - 1}-${Number(m[2]) - 1}` : null;
}

function normalizeRow(r) {
  const num = (v) => Number(v ?? 0) || 0;
  return {
    position: num(r.intRank),
    team: r.strTeam || '—',
    played: num(r.intPlayed),
    won: num(r.intWin),
    drawn: num(r.intDraw),
    lost: num(r.intLoss),
    goalsFor: num(r.intGoalsFor),
    goalsAgainst: num(r.intGoalsAgainst),
    goalDiff: num(r.intGoalDifference),
    points: num(r.intPoints),
  };
}

/**
 * League table.
 * @returns {Promise<{data:Array, live:boolean, note:string|null, season:string|null}>}
 */
async function getStandings(key) {
  const id = leagueId(key);
  if (!id) return { data: [], live: false, note: null, season: null };

  const season = await currentSeason(key);
  const attempts = [season, previousSeason(season)].filter(Boolean);

  for (const [i, s] of attempts.entries()) {
    try {
      const json = await cachedGet(`/lookuptable.php?l=${id}&s=${s}`);
      const table = Array.isArray(json?.table) ? json.table : [];
      // A brand-new season has a stub table for a week or two; fall back to the
      // completed one rather than posting a three-row league.
      if (table.length >= 6 || (table.length && i === attempts.length - 1)) {
        return {
          data: table.map(normalizeRow).sort((a, b) => a.position - b.position),
          live: true,
          note: `via TheSportsDB • ${s}`,
          season: s,
        };
      }
    } catch (err) {
      log.debug(`Standings failed for ${key} ${s}: ${err.message}`);
    }
  }

  return { data: [], live: false, note: null, season: null };
}

/** Codes TheSportsDB uses for "hasn't kicked off yet". */
const NOT_STARTED = new Set(['', 'NS', 'Not Started', 'TBD', 'null']);

function normalizeEvent(e) {
  const home = e.strHomeTeam || '—';
  const away = e.strAwayTeam || '—';
  const hs = e.intHomeScore;
  const as = e.intAwayScore;
  const played = hs !== null && hs !== undefined && hs !== '';
  const raw = String(e.strStatus ?? '').trim();
  const status = played ? 'Finished' : (NOT_STARTED.has(raw) ? 'Scheduled' : raw);

  return {
    home,
    away,
    date: e.strTimestamp ? formatDateTime(e.strTimestamp) : [e.dateEvent, e.strTime].filter(Boolean).join(' '),
    timestamp: e.strTimestamp || (e.dateEvent ? `${e.dateEvent}T${e.strTime || '00:00:00'}` : null),
    competition: e.strLeague || null,
    venue: e.strVenue || null,
    status,
    score: played ? `${hs} : ${as}` : null,
  };
}

/** Next fixtures for a tracked team. */
async function getUpcomingFixtures(key, count = 5) {
  const id = teamId(key);
  if (!id) return { data: [], live: false, note: null };

  try {
    const json = await cachedGet(`/eventsnext.php?id=${id}`);
    const events = (json?.events || []).slice(0, count).map(normalizeEvent);
    return {
      data: events,
      live: events.length > 0,
      note: events.length ? `via TheSportsDB • times in ${config.timezone}` : null,
    };
  } catch (err) {
    log.debug(`Upcoming fixtures failed for ${key}: ${err.message}`);
    return { data: [], live: false, note: null };
  }
}

/** Most recent results for a tracked team. */
async function getRecentResults(key, count = 5) {
  const id = teamId(key);
  if (!id) return { data: [], live: false, note: null };

  try {
    const json = await cachedGet(`/eventslast.php?id=${id}`);
    const events = (json?.results || []).slice(0, count).map(normalizeEvent);
    return {
      data: events,
      live: events.length > 0,
      note: events.length ? 'via TheSportsDB' : null,
    };
  } catch (err) {
    log.debug(`Recent results failed for ${key}: ${err.message}`);
    return { data: [], live: false, note: null };
  }
}

/**
 * Anything involving this team today — kicked off, finished or still to come.
 * Assembled from the next/last endpoints, which between them always bracket
 * today, rather than a separate per-date call.
 */
async function getTodayFixtures(key) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const [next, last] = await Promise.all([getUpcomingFixtures(key, 5), getRecentResults(key, 5)]);
  const data = [...last.data, ...next.data]
    .filter((e) => e.timestamp && String(e.timestamp).slice(0, 10) === today);

  return { data, live: data.length > 0, note: null };
}

module.exports = {
  getStandings,
  getUpcomingFixtures,
  getRecentResults,
  getTodayFixtures,
  currentSeason,
  leagueId,
  teamId,
};
