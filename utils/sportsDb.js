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

// A scoreboard that is half an hour stale is not a scoreboard, so the live
// endpoint gets its own short window.
const LIVE_TTL_MS = 60 * 1000;

/**
 * The public key rate-limits hard — roughly half a dozen calls a second earns a
 * 429 for the next few minutes, and the day card asks one question per
 * competition. Requests are therefore serialised with a gap between them;
 * cache hits skip the queue entirely.
 */
// The documented ceiling on the public key is 30 requests a minute, and going
// over earns a 429 for several minutes — long enough to empty a whole post.
const MIN_INTERVAL_MS = 2_200;
let queue = Promise.resolve();
let lastCallAt = 0;

function paced(fn) {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // Keep the chain alive even when one call rejects.
  queue = run.catch(() => {});
  return run;
}

async function cachedGet(path, ttl = TTL_MS) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  const value = await paced(() => getJson(`${BASE}${path}`, { retries: 1, timeout: 15_000 }))
    .catch((err) => {
      // Callers swallow their own errors, so without this the whole sports post
      // would quietly come back empty with nothing in the log to explain it.
      if (/\b429\b|too many/i.test(err.message)) {
        log.warn('Rate limited by TheSportsDB — sports sections will be thin for a few minutes');
      }
      throw err;
    });

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
      // A season that has not kicked off yet still answers with a full table of
      // zeroes. Row count cannot tell that apart from a real one — the public
      // key truncates every list to five rows either way — so the test is
      // whether anyone has actually played, and if not we show last season.
      const played = table.some((r) => (Number(r.intPlayed) || 0) > 0);
      if ((table.length && played) || (table.length && i === attempts.length - 1)) {
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
 * Reverse index from TheSportsDB's league id to our own key, so a match that
 * arrives from the worldwide live feed can be recognised as one of the
 * competitions we track. Rebuilt on demand — config is read from disk once.
 */
function trackedLeaguesById() {
  const byId = new Map();
  for (const [key, league] of Object.entries(config.sports.leagues || {})) {
    const id = league.sportsdbId || LEAGUE_IDS[key];
    if (id) byId.set(String(id), { key, ...league });
  }
  return byId;
}

/** Codes that mean the ball is currently rolling. */
const IN_PLAY = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'PEN', 'LIVE']);

/**
 * Every match kicking about right now, worldwide, narrowed to the competitions
 * in `config.sports.leagues`.
 *
 * This is the one list TheSportsDB serves in full without a key — every other
 * endpoint truncates to about five rows on the public test key — so the live
 * scoreboard is the part of the sports post that works out of the box.
 *
 * @param {{all?: boolean}} [opts] `all: true` skips the tracked-league filter.
 * @returns {Promise<{data:Array, live:boolean, note:string|null, totalWorldwide:number}>}
 */
async function getLiveMatches({ all = false } = {}) {
  try {
    const json = await cachedGet('/livescore.php?s=Soccer', LIVE_TTL_MS);
    const rows = json?.events || json?.livescore || [];
    const byId = trackedLeaguesById();

    const matches = rows.map((e) => {
      const league = byId.get(String(e.idLeague));
      const raw = String(e.strStatus ?? '').trim().toUpperCase();
      const minute = String(e.strProgress ?? '').trim();

      return {
        home: e.strHomeTeam || '—',
        away: e.strAwayTeam || '—',
        homeScore: Number(e.intHomeScore ?? 0) || 0,
        awayScore: Number(e.intAwayScore ?? 0) || 0,
        score: `${e.intHomeScore ?? 0} : ${e.intAwayScore ?? 0}`,
        minute: minute && minute !== '0' ? `${minute}'` : null,
        status: raw === 'HT' ? 'Half time' : (raw || 'Live'),
        state: raw === 'FT' ? 'finished' : 'live',
        competition: league?.name || e.strLeague || null,
        leagueKey: league?.key || null,
        tier: league?.tier ?? 99,
        emoji: league?.emoji || '⚽',
        timestamp: e.strTimestamp || null,
        date: e.strTimestamp ? formatDateTime(e.strTimestamp) : (e.strEventTime || null),
      };
    }).filter((m) => IN_PLAY.has(String(m.status).toUpperCase()) || m.state === 'live');

    const tracked = all ? matches : matches.filter((m) => m.leagueKey);

    // Biggest competition first, then whoever is furthest into the match.
    tracked.sort((a, b) => a.tier - b.tier
      || (parseInt(b.minute, 10) || 0) - (parseInt(a.minute, 10) || 0));

    return {
      data: tracked,
      live: tracked.length > 0,
      note: tracked.length ? 'live via TheSportsDB' : null,
      totalWorldwide: matches.length,
    };
  } catch (err) {
    log.debug(`Live scores failed: ${err.message}`);
    return { data: [], live: false, note: null, totalWorldwide: 0 };
  }
}

/**
 * Next fixtures in a competition. The public key truncates this hard (often to
 * a single row), so treat whatever comes back as a taster, not a full matchday.
 */
async function getLeagueUpcoming(key, count = 5) {
  const id = leagueId(key);
  if (!id) return { data: [], live: false, note: null };

  try {
    const json = await cachedGet(`/eventsnextleague.php?id=${id}`);
    const events = (json?.events || []).slice(0, count).map(normalizeEvent);
    return { data: events, live: events.length > 0, note: events.length ? 'via TheSportsDB' : null };
  } catch (err) {
    log.debug(`League fixtures failed for ${key}: ${err.message}`);
    return { data: [], live: false, note: null };
  }
}

/** Most recent results in a competition. Same truncation caveat as above. */
async function getLeagueResults(key, count = 5) {
  const id = leagueId(key);
  if (!id) return { data: [], live: false, note: null };

  try {
    const json = await cachedGet(`/eventspastleague.php?id=${id}`);
    const events = (json?.events || []).slice(0, count).map(normalizeEvent);
    return { data: events, live: events.length > 0, note: events.length ? 'via TheSportsDB' : null };
  } catch (err) {
    log.debug(`League results failed for ${key}: ${err.message}`);
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
  getLiveMatches,
  getLeagueUpcoming,
  getLeagueResults,
  currentSeason,
  leagueId,
  teamId,
};
