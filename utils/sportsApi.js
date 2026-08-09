'use strict';

const log = require('../utils/logger')('sports');
const { getJson } = require('./http');
const { formatDateTime } = require('./time');
const config = require('./config');
const sportsDb = require('./sportsDb');
const fallback = require('../data/sportsFallback.json');

/**
 * Football data, from the best source available, in this order:
 *
 *   1. API-Football (RapidAPI)  — full tables and rich fixture detail, but
 *      needs SPORTS_API_KEY and allows only 100 calls/day on the free tier.
 *   2. TheSportsDB              — no key required, so this is what actually
 *      runs on most installs. Live, if a little sparser.
 *   3. data/sportsFallback.json — a dated snapshot, clearly labelled as such.
 *
 * Every public function returns `{ data, live, note }` so callers can say
 * plainly where the numbers came from. Nothing here throws: sports data is
 * nice-to-have and must never take a scheduler down.
 */

const HOST = 'api-football-v1.p.rapidapi.com';
const BASE = `https://${HOST}/v3`;

// One shared in-memory cache: the free RapidAPI tier is 100 calls/day and the
// scheduler plus user commands would otherwise burn through it quickly.
const cache = new Map();
const TTL_MS = 15 * 60 * 1000;

function isConfigured() {
  return Boolean(process.env.SPORTS_API_KEY);
}

function headers() {
  return {
    'x-rapidapi-key': process.env.SPORTS_API_KEY,
    'x-rapidapi-host': HOST,
  };
}

async function cachedGet(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = await getJson(url, { headers: headers(), retries: 1 });
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** Current season year — football seasons start in August. */
function currentSeason() {
  const now = new Date();
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/** Resolve a user-typed team name to a config entry, or null. */
function resolveTeam(input) {
  if (!input) return null;
  const key = input.toLowerCase().replace(/[^a-z]/g, '');
  const teams = config.sports.teams;

  if (teams[key]) return { key, ...teams[key] };

  const aliases = {
    bayernmunich: 'bayern', fcbayern: 'bayern', fcb: 'bayern',
    fcbarcelona: 'barca', barcelona: 'barca',
    real: 'realmadrid', madrid: 'realmadrid', rma: 'realmadrid',
  };
  if (aliases[key]) return { key: aliases[key], ...teams[aliases[key]] };

  const partial = Object.entries(teams)
    .find(([k, t]) => k.includes(key) || t.name.toLowerCase().replace(/[^a-z]/g, '').includes(key));
  return partial ? { key: partial[0], ...partial[1] } : null;
}

/** Resolve a user-typed league name to a config entry, or null. */
function resolveLeague(input) {
  if (!input) return null;
  const key = input.toLowerCase().replace(/[^a-z]/g, '');
  const leagues = config.sports.leagues;
  if (leagues[key]) return { key, ...leagues[key] };

  const aliases = {
    epl: 'premier', premierleague: 'premier', england: 'premier',
    la: 'laliga', spain: 'laliga', liga: 'laliga',
    germany: 'bundesliga', bundes: 'bundesliga',
    italy: 'seriea', serie: 'seriea',
    france: 'ligue1', ligueone: 'ligue1', frenchleague: 'ligue1',
    championsleague: 'ucl', champions: 'ucl', cl: 'ucl',
    europaleague: 'uel', europa: 'uel',
    conferenceleague: 'uecl', conference: 'uecl',
    fifaworldcup: 'worldcup', wc: 'worldcup', world: 'worldcup',
    eurocup: 'euro', euros: 'euro', europeanchampionship: 'euro',
    copa: 'copaamerica', america: 'copaamerica',
    netherlands: 'eredivisie', holland: 'eredivisie', dutch: 'eredivisie',
    portugal: 'primeira', portuguese: 'primeira',
    turkey: 'superlig', turkish: 'superlig',
    belgium: 'proleague', belgian: 'proleague',
    scotland: 'scottish',
    usa: 'mls', america_us: 'mls',
    mexico: 'ligamx',
    brazil: 'brasileirao', brasil: 'brasileirao',
    japan: 'jleague', j1: 'jleague',
    korea: 'kleague',
    saudiproleague: 'saudi',
  };
  if (aliases[key]) return { key: aliases[key], ...leagues[aliases[key]] };

  // A team name should also work: /standings bayern → Bundesliga
  const team = resolveTeam(input);
  if (team?.league && leagues[team.league]) return { key: team.league, ...leagues[team.league] };

  return null;
}

/**
 * League table.
 * @returns {Promise<{data: Array, live: boolean, note: string|null}>}
 */
async function getStandings(leagueKey) {
  const league = resolveLeague(leagueKey);
  if (!league) return { data: [], live: false, note: `Unknown league "${leagueKey}".` };

  if (isConfigured()) {
    try {
      const url = `${BASE}/standings?league=${league.apiId}&season=${currentSeason()}`;
      const json = await cachedGet(url);
      const table = json?.response?.[0]?.league?.standings?.[0];
      if (Array.isArray(table) && table.length) {
        return {
          data: table.map((r) => ({
            position: r.rank,
            team: r.team?.name || '—',
            played: r.all?.played ?? 0,
            won: r.all?.win ?? 0,
            drawn: r.all?.draw ?? 0,
            lost: r.all?.lose ?? 0,
            goalsFor: r.all?.goals?.for ?? 0,
            goalsAgainst: r.all?.goals?.against ?? 0,
            goalDiff: r.goalsDiff ?? 0,
            points: r.points ?? 0,
          })),
          live: true,
          note: `${league.name} • live via API-Football`,
        };
      }
      log.warn(`No live standings returned for ${league.name}`);
    } catch (err) {
      log.warn(`Live standings failed for ${league.name}: ${err.message}`);
    }
  }

  // No key, or the key returned nothing — try the keyless provider.
  const live = await sportsDb.getStandings(league.key);
  if (live.data.length) {
    return {
      data: live.data,
      live: true,
      note: `${league.name} • ${live.note}`
        + (live.data.length <= 5 ? ' (top 5 — add SPORTS_API_KEY for the full table)' : ''),
    };
  }

  const snapshot = fallback.standings[league.key] || [];
  return {
    data: snapshot,
    live: false,
    note: snapshot.length
      ? `⚠️ Offline snapshot from ${fallback.snapshotDate} — live sources unreachable`
      : 'No data available for this league.',
  };
}

/**
 * Upcoming fixtures for a team.
 * @returns {Promise<{data: Array, live: boolean, note: string|null}>}
 */
async function getUpcomingFixtures(teamKey, count = 5) {
  const team = resolveTeam(teamKey);
  if (!team) return { data: [], live: false, note: `Unknown team "${teamKey}".` };

  if (isConfigured()) {
    try {
      const url = `${BASE}/fixtures?team=${team.apiId}&next=${count}`;
      const json = await cachedGet(url);
      const rows = json?.response || [];
      if (rows.length) {
        return {
          data: rows.map((f) => ({
            home: f.teams?.home?.name || '—',
            away: f.teams?.away?.name || '—',
            date: formatDateTime(f.fixture?.date),
            competition: f.league?.name || null,
            venue: f.fixture?.venue?.name || null,
            status: f.fixture?.status?.short || null,
          })),
          live: true,
          note: `${team.name} • live via API-Football • times in ${config.timezone}`,
        };
      }
    } catch (err) {
      log.warn(`Live fixtures failed for ${team.name}: ${err.message}`);
    }
  }

  const live = await sportsDb.getUpcomingFixtures(team.key, count);
  if (live.data.length) return { data: live.data, live: true, note: `${team.name} • ${live.note}` };

  return {
    data: [],
    live: false,
    note: `No upcoming fixtures listed for ${team.name} right now — probably an international break or the off-season.`,
  };
}

/**
 * Most recent results for a team. Only TheSportsDB serves these today;
 * API-Football's equivalent would cost an extra call per team per run.
 */
async function getRecentResults(teamKey, count = 5) {
  const team = resolveTeam(teamKey);
  if (!team) return { data: [], live: false, note: `Unknown team "${teamKey}".` };

  const live = await sportsDb.getRecentResults(team.key, count);
  return {
    data: live.data,
    live: live.live,
    note: live.data.length ? `${team.name} • ${live.note}` : `No recent results for ${team.name}.`,
  };
}

/**
 * Every competition in `config.sports.leagues`, biggest first.
 * @param {{maxTier?: number}} [opts]
 */
function trackedLeagues({ maxTier = 99 } = {}) {
  return Object.entries(config.sports.leagues || {})
    .map(([key, league]) => ({ key, tier: league.tier ?? 2, ...league }))
    .filter((l) => l.tier <= maxTier)
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}

/** Reverse index from API-Football's league id to our own key. */
function leagueByApiId() {
  const byId = new Map();
  for (const l of trackedLeagues()) if (l.apiId) byId.set(l.apiId, l);
  return byId;
}

/** Shared match shape, so the scoreboard renders the same from either source. */
function fromApiFootball(f, league) {
  const short = f.fixture?.status?.short || null;
  const elapsed = f.fixture?.status?.elapsed ?? null;
  const finished = ['FT', 'AET', 'PEN'].includes(short);
  const live = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(short);
  const scored = f.goals?.home !== null && f.goals?.home !== undefined;

  return {
    home: f.teams?.home?.name || '—',
    away: f.teams?.away?.name || '—',
    homeScore: f.goals?.home ?? 0,
    awayScore: f.goals?.away ?? 0,
    score: scored ? `${f.goals.home} : ${f.goals.away}` : null,
    minute: live && elapsed ? `${elapsed}'` : null,
    status: short === 'HT' ? 'Half time' : (f.fixture?.status?.long || short || ''),
    state: finished ? 'finished' : (live ? 'live' : 'scheduled'),
    competition: league?.name || f.league?.name || null,
    leagueKey: league?.key || null,
    tier: league?.tier ?? 99,
    emoji: league?.emoji || '⚽',
    venue: f.fixture?.venue?.name || null,
    timestamp: f.fixture?.date || null,
    date: f.fixture?.date ? formatDateTime(f.fixture.date) : null,
  };
}

/**
 * Matches in progress right now across every tracked competition.
 *
 * API-Football answers this in one call when a key is present; otherwise
 * TheSportsDB's live endpoint carries it, which is the only rich thing the
 * keyless tier gives us.
 */
async function getLiveMatches({ all = false } = {}) {
  if (isConfigured()) {
    try {
      const json = await cachedGet(`${BASE}/fixtures?live=all`);
      const byId = leagueByApiId();
      const rows = (json?.response || [])
        .map((f) => fromApiFootball(f, byId.get(f.league?.id)))
        .filter((m) => all || m.leagueKey);

      rows.sort((a, b) => a.tier - b.tier
        || (parseInt(b.minute, 10) || 0) - (parseInt(a.minute, 10) || 0));

      if (rows.length) {
        return { data: rows, live: true, note: 'live via API-Football', totalWorldwide: rows.length };
      }
    } catch (err) {
      log.warn(`Live scores failed via API-Football: ${err.message}`);
    }
  }

  return sportsDb.getLiveMatches({ all });
}

/**
 * The whole day's card across tracked competitions — kicked off, in progress or
 * still to come.
 *
 * With a key this is one `fixtures?date=` call for the entire world, filtered
 * down to our leagues. Without one, TheSportsDB's per-league endpoints are
 * capped at a handful of rows each, so the keyless answer is thin by nature and
 * says so in `note`.
 *
 * @param {string} [date] ISO `YYYY-MM-DD`; defaults to today in config.timezone.
 */
async function getMatchesForDate(date) {
  const day = date || new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  if (isConfigured()) {
    try {
      const json = await cachedGet(`${BASE}/fixtures?date=${day}`);
      const byId = leagueByApiId();
      const rows = (json?.response || [])
        .filter((f) => byId.has(f.league?.id))
        .map((f) => fromApiFootball(f, byId.get(f.league.id)));

      if (rows.length) {
        rows.sort((a, b) => a.tier - b.tier
          || String(a.timestamp).localeCompare(String(b.timestamp)));
        return { data: rows, live: true, note: `${day} • live via API-Football`, partial: false };
      }
      return { data: [], live: true, note: `No matches scheduled in tracked competitions on ${day}.`, partial: false };
    } catch (err) {
      log.warn(`Fixtures for ${day} failed via API-Football: ${err.message}`);
    }
  }

  // Keyless: ask each competition separately and keep what lands on the day.
  // Every league costs two rate-limited requests, so the fan-out is capped —
  // but not tightly, because the leagues playing through a European summer are
  // the second-tier ones and slicing to the elite few empties the card in
  // exactly the weeks it is most needed.
  const leagues = trackedLeagues()
    .filter((l) => l.sportsdbId)
    .slice(0, config.sports.maxKeylessLeagues ?? 18);
  const batches = await Promise.all(leagues.map(async (league) => {
    const [next, past] = await Promise.all([
      sportsDb.getLeagueUpcoming(league.key, 5),
      sportsDb.getLeagueResults(league.key, 5),
    ]);
    return [...past.data, ...next.data]
      .filter((e) => e.timestamp && String(e.timestamp).slice(0, 10) === day)
      .map((e) => ({
        ...e,
        state: e.score ? 'finished' : 'scheduled',
        minute: null,
        leagueKey: league.key,
        tier: league.tier ?? 2,
        emoji: league.emoji || '⚽',
        // Our own name, not the provider's ("J1 League", not "Japanese J1
        // League"), so a competition reads the same in every section.
        competition: league.name,
      }));
  }));

  // The archive endpoint lists a match as soon as it kicks off, score and all,
  // which would print a 0:0 seven minutes in as though it had finished. The
  // live board is the authority on anything still being played, so it wins.
  const rows = await withLiveState(batches.flat())
    .then((list) => list.sort((a, b) => a.tier - b.tier
      || String(a.timestamp).localeCompare(String(b.timestamp))));

  return {
    data: rows,
    live: rows.length > 0,
    note: `${day} • via TheSportsDB`,
    partial: true,
  };
}

/** Overlay the live scoreboard onto a day's card, matched on the two teams. */
async function withLiveState(matches) {
  if (!matches.length) return matches;

  const live = await sportsDb.getLiveMatches({ all: true });
  if (!live.data.length) return matches;

  const key = (m) => `${m.home}|${m.away}`.toLowerCase();
  const inPlay = new Map(live.data.map((m) => [key(m), m]));

  return matches.map((m) => {
    const now = inPlay.get(key(m));
    if (!now) return m;
    return { ...m, score: now.score, minute: now.minute, status: now.status, state: 'live' };
  });
}

/** Matches played or in progress today for a team. */
async function getTodayFixtures(teamKey) {
  const team = resolveTeam(teamKey);
  if (!team) return { data: [], live: false, note: null };
  if (!isConfigured()) return sportsDb.getTodayFixtures(team.key);

  const today = new Date().toISOString().slice(0, 10);
  try {
    const url = `${BASE}/fixtures?team=${team.apiId}&date=${today}`;
    const json = await cachedGet(url);
    return {
      data: (json?.response || []).map((f) => ({
        home: f.teams?.home?.name || '—',
        away: f.teams?.away?.name || '—',
        date: formatDateTime(f.fixture?.date),
        competition: f.league?.name || null,
        venue: f.fixture?.venue?.name || null,
        status: f.fixture?.status?.long || null,
        score: f.goals ? `${f.goals.home ?? '-'} : ${f.goals.away ?? '-'}` : null,
      })),
      live: true,
      note: null,
    };
  } catch (err) {
    log.warn(`Today fixtures failed for ${team.name}: ${err.message}`);
    return sportsDb.getTodayFixtures(team.key);
  }
}

module.exports = {
  getStandings,
  getUpcomingFixtures,
  getRecentResults,
  getTodayFixtures,
  getLiveMatches,
  getMatchesForDate,
  trackedLeagues,
  resolveTeam,
  resolveLeague,
  isConfigured,
  currentSeason,
};
