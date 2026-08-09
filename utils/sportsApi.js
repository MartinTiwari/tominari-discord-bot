'use strict';

const log = require('./logger')('sports');
const config = require('./config');
const espn = require('./espnSports');
const { getJson } = require('./http');
const { formatDateTime } = require('./time');

/**
 * The bot's sports surface — one provider, ESPN, behind the shapes the
 * schedulers and commands already speak.
 *
 * Previously this file fanned out across three sources: API-Football (100 calls
 * a day, and only with a RapidAPI key), TheSportsDB (keyless but truncated to
 * five rows per list), and a checked-in JSON snapshot for when both failed. The
 * result was a football-only post that was usually reading from the thinnest of
 * the three. ESPN needs no key, returns complete tables, and covers basketball
 * and cricket alongside the football, so the fallbacks are gone and with them
 * the "⚠️ offline snapshot" footers.
 *
 * Every function resolves to `{ data, live, note }` and none of them throw.
 */

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

/** Retained so `/health` can say where sport comes from. Never gated on a key. */
function isConfigured() {
  return true;
}

function sourceName() {
  return 'ESPN (no key required)';
}

// ------------------------------------------------------------ competitions --

/** Resolve a user-typed competition, or a team name, to a competition entry. */
function resolveLeague(input) {
  const direct = espn.resolveCompetition(input);
  if (direct) return direct;

  // "/standings bayern" should answer with the Bundesliga.
  const team = resolveTeam(input);
  return team?.competition ? espn.resolveCompetition(team.competition) : null;
}

/** Resolve a user-typed team name to a config entry, or null. */
function resolveTeam(input) {
  if (!input) return null;
  const key = String(input).toLowerCase().replace(/[^a-z]/g, '');
  const teams = config.sports.teams || {};

  if (teams[key]) return { key, ...teams[key] };

  const aliases = {
    bayernmunich: 'bayern', fcbayern: 'bayern', fcb: 'bayern',
    fcbarcelona: 'barca', barcelona: 'barca',
    real: 'realmadrid', madrid: 'realmadrid', rma: 'realmadrid',
  };
  if (aliases[key]) return { key: aliases[key], ...teams[aliases[key]] };

  const partial = Object.entries(teams).find(([k, t]) => k.includes(key)
    || t.name.toLowerCase().replace(/[^a-z]/g, '').includes(key));
  return partial ? { key: partial[0], ...partial[1] } : null;
}

/** Every tracked competition, biggest first. @param {{maxTier?:number, sport?:string}} [o] */
function trackedLeagues(opts) {
  return espn.competitions(opts);
}

/** The sports we cover, in the order they should be presented. */
function trackedSports() {
  const present = new Set(espn.competitions().map((c) => c.sport));
  return Object.entries(espn.SPORTS)
    .filter(([key]) => present.has(key))
    .map(([key, meta]) => ({ key, ...meta }));
}

// -------------------------------------------------------------- scoreboards --

/**
 * Matches in play right now across every tracked competition and sport.
 *
 * The old `{ all: true }` option — "show me everything worldwide, not just the
 * tracked leagues" — is gone: ESPN is queried per competition, so there is no
 * worldwide firehose to widen to, and the whole point of the current config is
 * that a third division never appears.
 */
async function getLiveMatches({ sport = null } = {}) {
  try {
    return await espn.getLiveMatches({ sport });
  } catch (err) {
    log.warn(`Live scores failed: ${err.message}`);
    return { data: [], live: false, note: null, totalToday: 0 };
  }
}

/** The day's card across tracked competitions. */
async function getMatchesForDate(date, opts) {
  try {
    return await espn.getMatchesForDate(date, opts);
  } catch (err) {
    log.warn(`Day card failed: ${err.message}`);
    return { data: [], live: false, note: null, partial: false };
  }
}

/** League table. Football gets a points table, basketball a win–loss one. */
async function getStandings(leagueKey) {
  const league = resolveLeague(leagueKey);
  if (!league) return { data: [], live: false, note: `Unknown competition "${leagueKey}".`, format: 'soccer' };

  try {
    return await espn.getStandings(league.key);
  } catch (err) {
    log.warn(`Standings failed for ${league.name}: ${err.message}`);
    return { data: [], live: false, note: `No table available for ${league.name} right now.`, format: 'soccer' };
  }
}

// -------------------------------------------------------------------- teams --

/**
 * A tracked team's season, newest first. ESPN keys this by club rather than by
 * competition, so one call covers every tournament the team is in.
 */
async function getTeamSchedule(team) {
  const comp = espn.resolveCompetition(team.competition);
  if (!comp || !team.espnId) return [];

  const url = `${SITE}/${comp.path}/teams/${team.espnId}/schedule`;
  const json = await getJson(url, { retries: 1, timeout: 12_000 });

  return (json?.events || []).map((e) => {
    const c = e.competitions?.[0] || {};
    const sides = c.competitors || [];
    const home = sides.find((s) => s.homeAway === 'home') || sides[0] || {};
    const away = sides.find((s) => s.homeAway === 'away') || sides[1] || {};
    const type = c.status?.type || e.status?.type;
    const played = type?.state === 'post';

    return {
      home: home.team?.displayName || '—',
      away: away.team?.displayName || '—',
      date: e.date ? formatDateTime(e.date) : null,
      timestamp: e.date || null,
      competition: e.league?.name || e.seasonType?.name || comp.name,
      venue: c.venue?.fullName || null,
      status: type?.description || null,
      score: played ? `${home.score?.displayValue ?? home.score ?? 0} : ${away.score?.displayValue ?? away.score ?? 0}` : null,
      state: played ? 'finished' : (type?.state === 'in' ? 'live' : 'scheduled'),
    };
  });
}

/** Next fixtures for a team. */
async function getUpcomingFixtures(teamKey, count = 5) {
  const team = resolveTeam(teamKey);
  if (!team) return { data: [], live: false, note: `Unknown team "${teamKey}".` };

  try {
    const now = Date.now();
    const data = (await getTeamSchedule(team))
      .filter((m) => m.state !== 'finished' && (!m.timestamp || new Date(m.timestamp) >= now))
      .slice(0, count);

    return {
      data,
      live: data.length > 0,
      note: data.length
        ? `${team.name} • via ESPN • times in ${config.timezone}`
        : `No upcoming fixtures listed for ${team.name} — probably an international break or the off-season.`,
    };
  } catch (err) {
    log.warn(`Fixtures failed for ${team.name}: ${err.message}`);
    return { data: [], live: false, note: `Could not reach the fixture list for ${team.name}.` };
  }
}

/** Most recent results for a team, newest first. */
async function getRecentResults(teamKey, count = 5) {
  const team = resolveTeam(teamKey);
  if (!team) return { data: [], live: false, note: `Unknown team "${teamKey}".` };

  try {
    const data = (await getTeamSchedule(team))
      .filter((m) => m.state === 'finished')
      .reverse()
      .slice(0, count);

    return {
      data,
      live: data.length > 0,
      note: data.length ? `${team.name} • via ESPN` : `No recent results for ${team.name}.`,
    };
  } catch (err) {
    log.warn(`Results failed for ${team.name}: ${err.message}`);
    return { data: [], live: false, note: `Could not reach the results for ${team.name}.` };
  }
}

/** Anything involving this team today. */
async function getTodayFixtures(teamKey) {
  const team = resolveTeam(teamKey);
  if (!team) return { data: [], live: false, note: null };

  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  try {
    const data = (await getTeamSchedule(team)).filter((m) => m.timestamp
      && new Date(m.timestamp).toLocaleDateString('en-CA', { timeZone: config.timezone }) === today);
    return { data, live: data.length > 0, note: null };
  } catch (err) {
    log.debug(`Today fixtures failed for ${team.name}: ${err.message}`);
    return { data: [], live: false, note: null };
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
  trackedSports,
  resolveTeam,
  resolveLeague,
  isConfigured,
  sourceName,
};
