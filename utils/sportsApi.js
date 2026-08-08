'use strict';

const log = require('../utils/logger')('sports');
const { getJson } = require('./http');
const { formatDateTime } = require('./time');
const config = require('./config');
const fallback = require('../data/sportsFallback.json');

/**
 * API-Football (RapidAPI) client with a bundled static fallback.
 *
 * Every public function returns `{ data, live, note }` so callers can label
 * clearly whether the numbers came off the wire or out of the snapshot file.
 * Nothing here ever throws — sports data is nice-to-have, not critical.
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
    championsleague: 'ucl', champions: 'ucl',
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

  const snapshot = fallback.standings[league.key] || [];
  return {
    data: snapshot,
    live: false,
    note: snapshot.length
      ? `⚠️ Offline snapshot from ${fallback.snapshotDate} — set SPORTS_API_KEY for live data`
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

  return {
    data: [],
    live: false,
    note: `⚠️ Fixtures need SPORTS_API_KEY (API-Football via RapidAPI). Add it to .env to enable live schedules for ${team.name}.`,
  };
}

/** Matches played or in progress today for a team. */
async function getTodayFixtures(teamKey) {
  const team = resolveTeam(teamKey);
  if (!team || !isConfigured()) return { data: [], live: false, note: null };

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
    return { data: [], live: false, note: null };
  }
}

module.exports = {
  getStandings,
  getUpcomingFixtures,
  getTodayFixtures,
  resolveTeam,
  resolveLeague,
  isConfigured,
  currentSeason,
};
