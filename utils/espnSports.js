'use strict';

const log = require('./logger')('espn');
const { getJson } = require('./http');
const { formatDateTime } = require('./time');
const config = require('./config');

/**
 * ESPN's public sports API — the bot's primary scoreboard.
 *
 * It replaces TheSportsDB, which needed a Patreon key to be useful: on the free
 * key every list came back truncated to about five rows, so a "league table" was
 * the top five and a matchday was whatever fitted. ESPN asks for no key at all,
 * serves complete tables, carries the match clock, and — the reason for the
 * switch — speaks more than one sport, so basketball and cricket sit next to the
 * football on the same board.
 *
 * Competitions come from `config.sports.competitions`, which is deliberately a
 * short list of the ones people actually follow. Anything not on it is ignored,
 * including from the live feed, so the post never fills up with third divisions.
 *
 * Nothing here throws: sport is nice-to-have and must never take a scheduler
 * down. Every function resolves to `{ data, live, note }`.
 */

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://site.api.espn.com/apis/v2/sports';
const HEADER = 'https://site.web.api.espn.com/apis/v2/scoreboard/header';

// Scoreboards move; tables barely do. Both are cheap, but a pulse asks about
// twenty competitions at once and users can fire /live in a burst.
const cache = new Map();
const SCORE_TTL_MS = 60 * 1000;
const TABLE_TTL_MS = 30 * 60 * 1000;

/** ESPN is happy with parallel reads, but not with twenty at once. */
const MAX_CONCURRENT = 6;

async function cachedGet(url, ttl) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  const value = await getJson(url, { retries: 1, timeout: 12_000 });
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** Run `fn` over `items`, at most MAX_CONCURRENT in flight, never rejecting. */
async function mapLimit(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
    const chunk = items.slice(i, i + MAX_CONCURRENT);
    const settled = await Promise.allSettled(chunk.map(fn));
    for (const [j, r] of settled.entries()) {
      if (r.status === 'fulfilled') out.push(r.value);
      else log.debug(`${describe(chunk[j])} failed: ${r.reason?.message || r.reason}`);
    }
  }
  return out;
}

function describe(item) {
  return item?.name || item?.path || String(item);
}

// ------------------------------------------------------------ competitions --

/** Sport-level presentation, used when a competition does not override it. */
const SPORTS = {
  soccer: { label: 'Football', emoji: '⚽', table: 'soccer' },
  basketball: { label: 'Basketball', emoji: '🏀', table: 'record' },
  cricket: { label: 'Cricket', emoji: '🏏', table: null },
};

/**
 * Every competition we track, biggest first.
 * @param {{sport?: string, maxTier?: number}} [opts]
 */
function competitions({ sport = null, maxTier = 99 } = {}) {
  return Object.entries(config.sports.competitions || {})
    .map(([key, c]) => ({
      key,
      tier: c.tier ?? 2,
      sport: c.sport || 'soccer',
      emoji: c.emoji || SPORTS[c.sport || 'soccer']?.emoji || '🏅',
      ...c,
    }))
    .filter((c) => (!sport || c.sport === sport) && c.tier <= maxTier)
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}

/** Resolve a user-typed competition name to a config entry, or null. */
function resolveCompetition(input) {
  if (!input) return null;
  const key = String(input).toLowerCase().replace(/[^a-z0-9]/g, '');
  const all = competitions();

  const exact = all.find((c) => c.key === key);
  if (exact) return exact;

  const aliases = {
    epl: 'premier', premierleague: 'premier', england: 'premier', english: 'premier',
    la: 'laliga', spain: 'laliga', spanish: 'laliga', liga: 'laliga',
    germany: 'bundesliga', german: 'bundesliga', bundes: 'bundesliga',
    italy: 'seriea', italian: 'seriea', serie: 'seriea',
    france: 'ligue1', french: 'ligue1', ligueone: 'ligue1',
    championsleague: 'ucl', champions: 'ucl', cl: 'ucl',
    europaleague: 'uel', europa: 'uel',
    fifaworldcup: 'worldcup', wc: 'worldcup', world: 'worldcup',
    eurocup: 'euro', euros: 'euro', europeanchampionship: 'euro',
    copa: 'copaamerica', copaamerica: 'copaamerica',
    nationsleague: 'nations',
    clubworldcup: 'clubwc',
    nationalbasketballassociation: 'nba',
    indianpremierleague: 'ipl',
    bigbash: 'bbl', bigbashleague: 'bbl',
    cricketworldcup: 'cricketwc', iccworldcup: 'cricketwc',
    testchampionship: 'wtc', worldtestchampionship: 'wtc',
    thehundred: 'hundred',
  };
  if (aliases[key]) return all.find((c) => c.key === aliases[key]) || null;

  return all.find((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(key)) || null;
}

// -------------------------------------------------------------- normalising --

/** ESPN's `status.type.state`: 'pre' before, 'in' during, 'post' after. */
function stateOf(type) {
  if (type?.state === 'in') return 'live';
  if (type?.state === 'post') return 'finished';
  return 'scheduled';
}

/**
 * One side's score.
 *
 * Cricket arrives as `"130/6 (20 ov, target 202)"`; the parenthetical is useful
 * on ESPN's own site, where there is room for it, but in a Discord field it
 * pushes the runs off the end of the line. A side that has not batted yet
 * arrives as a bare `"0"` — printing that would claim they were bowled out for
 * nothing, so it becomes a dash instead.
 */
function sideScore(side, sport) {
  const raw = String(side.score ?? '').replace(/\s*\(.*$/, '').trim();
  if (raw === '') return '—';
  if (sport === 'cricket' && !/\d+\/\d+|\d+\s*&|^\d{2,}$/.test(raw)) return '—';
  return raw;
}

/**
 * The club, without the disambiguation ESPN adds for competitions that run a
 * men's and a women's draw under one name ("Welsh Fire (Men)"). The competition
 * heading already says which one this is.
 */
function teamName(side, sport) {
  const name = side.team?.displayName || side.team?.name || '—';
  return sport === 'cricket' ? name.replace(/\s*\((?:Men|Women)\)\s*$/i, '') : name;
}

/**
 * The clock, as a competition would say it: minutes in football, quarter and
 * time remaining in basketball, overs in cricket.
 */
function clockOf(comp, event, sport) {
  const type = event.status?.type;
  if (stateOf(type) !== 'live') return null;

  if (sport === 'soccer') {
    const clock = event.status?.displayClock;
    return clock && clock !== "0'" ? clock : (type?.shortDetail || null);
  }
  if (sport === 'basketball') {
    const period = event.status?.period;
    const clock = event.status?.displayClock;
    return period && clock ? `Q${period} ${clock}` : (type?.shortDetail || null);
  }
  // Cricket has no clock — the over count is the closest thing to one.
  const batting = (comp.competitors || [])
    .flatMap((c) => c.linescores || [])
    .find((l) => l.isBatting);
  return batting?.overs ? `${batting.overs} ov` : (type?.shortDetail || null);
}

/** One ESPN event, in the shape every embed in this bot renders. */
function normalize(event, competition) {
  const comp = event.competitions?.[0] || {};
  const sport = competition.sport || 'soccer';
  const type = event.status?.type;
  const state = stateOf(type);

  const sides = comp.competitors || [];
  const home = sides.find((c) => c.homeAway === 'home') || sides[0] || {};
  const away = sides.find((c) => c.homeAway === 'away') || sides[1] || {};

  const homeText = sideScore(home, sport);
  const awayText = sideScore(away, sport);
  // Before the toss or kick-off both sides read "0"; printing "0 : 0" would
  // announce a goalless draw hours before anyone takes the field.
  const scored = state !== 'scheduled' && (homeText !== '—' || awayText !== '—');

  return {
    home: teamName(home, sport),
    away: teamName(away, sport),
    homeScore: Number(home.score) || 0,
    awayScore: Number(away.score) || 0,
    score: scored ? `${homeText} : ${awayText}` : null,
    minute: clockOf(comp, event, sport),
    // `status.summary` is cricket's "won by 71 runs"; everywhere else the
    // description ("Full Time", "Halftime") is the useful line.
    status: event.status?.summary || type?.description || type?.shortDetail || '',
    detail: type?.detail || null,
    state,
    competition: competition.name,
    leagueKey: competition.key,
    sport,
    tier: competition.tier ?? 2,
    emoji: competition.emoji,
    venue: comp.venue?.fullName || event.venue?.fullName || null,
    timestamp: event.date || null,
    date: event.date ? formatDateTime(event.date) : null,
  };
}

/** Biggest competition first; inside one, whoever is furthest along. */
function byImportance(a, b) {
  return a.tier - b.tier
    || String(a.timestamp).localeCompare(String(b.timestamp));
}

// ------------------------------------------------------------- scoreboards --

/**
 * One competition's card for a day.
 * @param {object} competition entry from `competitions()`
 * @param {string} [date] ISO `YYYY-MM-DD`; omitted means ESPN's current slate.
 */
async function scoreboard(competition, date) {
  const query = date ? `?dates=${date.replace(/-/g, '')}` : '';
  const json = await cachedGet(`${SITE}/${competition.path}/scoreboard${query}`, SCORE_TTL_MS);
  return (json?.events || []).map((e) => normalize(e, competition));
}

/**
 * Every tracked match being played right now, across every sport.
 *
 * ESPN has no "all live worldwide" endpoint, so this is one scoreboard call per
 * competition — which is also what keeps small leagues out: a competition not in
 * the config is never asked about in the first place.
 *
 * @param {{sport?: string}} [opts]
 * @returns {Promise<{data:Array, live:boolean, note:string|null, totalToday:number}>}
 */
async function getLiveMatches({ sport = null } = {}) {
  const all = (await mapLimit(await slate(sport), (c) => scoreboard(c))).flat();
  const live = all.filter((m) => m.state === 'live').sort(byImportance);

  return {
    data: live,
    live: live.length > 0,
    note: live.length ? 'live via ESPN' : null,
    totalToday: all.length,
  };
}

/**
 * The whole day's card across tracked competitions — played, in progress, or
 * still to come.
 *
 * @param {string} [date] ISO `YYYY-MM-DD`; defaults to today in config.timezone.
 * @param {{sport?: string}} [opts]
 */
async function getMatchesForDate(date, { sport = null } = {}) {
  const day = date || new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const rows = (await mapLimit(await slate(sport), (c) => scoreboard(c, day))).flat()
    // ESPN answers a date query with the nearest slate when the day itself is
    // empty, so a quiet Tuesday would otherwise show Saturday's fixtures.
    .filter((m) => !m.timestamp || localDay(m.timestamp) === day)
    .sort(byImportance);

  return {
    data: rows,
    live: rows.length > 0,
    note: `${day} • via ESPN`,
    partial: false,
  };
}

/** The calendar day a kick-off falls on for the audience, not for ESPN. */
function localDay(timestamp) {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-CA', { timeZone: config.timezone });
}

/**
 * The competitions worth asking about right now: the configured list, plus any
 * major cricket currently in season.
 */
async function slate(sport) {
  const fixed = competitions({ sport });
  if (sport && sport !== 'cricket') return fixed;

  const extra = await discoverCricket();
  const known = new Set(fixed.map((c) => c.path));
  return [...fixed, ...extra.filter((c) => !known.has(c.path))];
}

// ---------------------------------------------------------------- cricket --

/**
 * Cricket does not have a stable set of competitions the way football does:
 * outside the ICC events and the franchise leagues, most of the calendar is
 * bilateral tours whose ESPN id is minted per series and retired afterwards. A
 * fixed config list would therefore miss every England–India summer.
 *
 * So the in-season list is read from ESPN's own header feed and filtered down to
 * what counts as big: ICC events, the major franchise leagues, and men's senior
 * tours between full-member nations.
 */
const MAJOR_CRICKET = /\b(ICC|World Cup|World Test Championship|Champions Trophy|Ashes|Indian Premier League|Big Bash|The Hundred|Pakistan Super League|Caribbean Premier League|SA20|T20 Blast|Vitality Blast)\b/i;

const FULL_MEMBERS = /\b(India|Australia|England|Pakistan|South Africa|New Zealand|Sri Lanka|Bangladesh|West Indies|Afghanistan|Ireland|Zimbabwe)\b/;

// Age-group, second-string and development cricket carries the same country
// names as the senior game, so the nations test alone would let it all through.
const MINOR_CRICKET = /\b(Women|Emerging|Academy|U19|Under-19|A tour|XI|Development|Challenge League|League 2|Qualifier|Provincial|Invitational)\b/i;

let cricketCache = { at: 0, value: [] };
const CRICKET_TTL_MS = 60 * 60 * 1000;

/** In-season cricket that clears the "big" bar, as competition entries. */
async function discoverCricket() {
  if (Date.now() - cricketCache.at < CRICKET_TTL_MS) return cricketCache.value;

  let leagues = [];
  try {
    const json = await cachedGet(`${HEADER}?sport=cricket&lang=en&region=us`, CRICKET_TTL_MS);
    leagues = json?.sports?.[0]?.leagues || [];
  } catch (err) {
    log.debug(`Cricket discovery failed: ${err.message}`);
    return cricketCache.value;
  }

  const found = leagues
    .filter((l) => l.name && !MINOR_CRICKET.test(l.name))
    .filter((l) => MAJOR_CRICKET.test(l.name)
      // "India tour of Sri Lanka 2026" — two full members, so a real series.
      || (/tour of/i.test(l.name) && (l.name.match(FULL_MEMBERS) || []).length > 0
          && FULL_MEMBERS.test(l.name.split(/tour of/i)[0] || '')
          && FULL_MEMBERS.test(l.name.split(/tour of/i)[1] || '')))
    .map((l) => ({
      key: `cricket-${l.id}`,
      name: l.name.replace(/\s+\d{4}$/, ''),   // the year is already on the post
      sport: 'cricket',
      path: `cricket/${l.id}`,
      emoji: '🏏',
      tier: MAJOR_CRICKET.test(l.name) ? 1 : 2,
    }));

  cricketCache = { at: Date.now(), value: found };
  if (found.length) log.debug(`Cricket in season: ${found.map((c) => c.name).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------- standings --

/** Numeric stat from an ESPN standings entry, by name. */
function stat(entry, name) {
  const s = (entry.stats || []).find((x) => x.name === name);
  return s ? (s.value ?? Number(s.displayValue) ?? 0) : 0;
}

function statText(entry, name) {
  const s = (entry.stats || []).find((x) => x.name === name);
  return s?.displayValue ?? null;
}

/**
 * League table.
 *
 * ESPN groups by conference for the American leagues and returns one flat table
 * for the European ones; both arrive as `children[].standings.entries`, so the
 * groups are flattened and re-ranked into a single table.
 *
 * @returns {Promise<{data:Array, live:boolean, note:string|null, format:string}>}
 */
async function getStandings(key) {
  const comp = resolveCompetition(key);
  if (!comp) return { data: [], live: false, note: `Unknown competition "${key}".`, format: 'soccer' };

  const format = SPORTS[comp.sport]?.table;
  if (!format) {
    return { data: [], live: false, note: `${comp.name} does not have a league table.`, format: 'soccer' };
  }

  let json;
  try {
    json = await cachedGet(`${CORE}/${comp.path}/standings`, TABLE_TTL_MS);
  } catch (err) {
    log.warn(`Standings failed for ${comp.name}: ${err.message}`);
    return { data: [], live: false, note: `No table available for ${comp.name} right now.`, format };
  }

  const groups = json?.children?.length
    ? json.children.map((c) => ({ name: c.name, entries: c.standings?.entries || [] }))
    : [{ name: null, entries: json?.standings?.entries || [] }];

  const rows = groups.flatMap((g) => g.entries.map((e) => (
    format === 'record' ? recordRow(e, g.name) : soccerRow(e, g.name)
  )));

  if (!rows.length) {
    return { data: [], live: false, note: `No table published for ${comp.name} yet.`, format };
  }

  // A table published before a ball is bowled is twenty teams on nought points,
  // ranked alphabetically. Callers that rotate between leagues use `started` to
  // skip past one; callers that were asked for this league by name still get it,
  // labelled for what it is.
  const started = rows.some((r) => r.played > 0);
  rows.sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.position - b.position);

  return {
    data: rows,
    live: true,
    started,
    note: `${comp.name} • via ESPN${started ? '' : ' • season has not started'}`,
    format,
    grouped: groups.length > 1,
  };
}

/** Points-table row: football and anything else scored the same way. */
function soccerRow(entry, group) {
  return {
    group,
    position: stat(entry, 'rank'),
    team: entry.team?.shortDisplayName || entry.team?.displayName || '—',
    played: stat(entry, 'gamesPlayed'),
    won: stat(entry, 'wins'),
    drawn: stat(entry, 'ties'),
    lost: stat(entry, 'losses'),
    goalsFor: stat(entry, 'pointsFor'),
    goalsAgainst: stat(entry, 'pointsAgainst'),
    goalDiff: stat(entry, 'pointDifferential'),
    points: stat(entry, 'points'),
  };
}

/** Win–loss row: basketball and the other North American formats. */
function recordRow(entry, group) {
  const wins = stat(entry, 'wins');
  const losses = stat(entry, 'losses');
  return {
    group,
    position: stat(entry, 'playoffSeed') || 0,
    team: entry.team?.shortDisplayName || entry.team?.displayName || '—',
    played: wins + losses,
    won: wins,
    lost: losses,
    record: `${wins}-${losses}`,
    percent: statText(entry, 'winPercent') || '—',
    gamesBehind: statText(entry, 'gamesBehind') || '—',
    streak: statText(entry, 'streak') || '',
  };
}

// -------------------------------------------------------------------- teams --

/**
 * Matches involving one team, from the competitions it plays in. ESPN keys
 * fixtures by competition rather than by club on this endpoint, so a team's card
 * is filtered out of its own leagues' slates.
 *
 * @param {{name:string, competitions?:string[]}} team
 * @param {{days?:number, past?:boolean}} [opts]
 */
async function getTeamMatches(team, { days = 14, past = false } = {}) {
  const keys = team.competitions?.length ? team.competitions : null;
  const list = keys
    ? competitions().filter((c) => keys.includes(c.key))
    : competitions({ sport: 'soccer', maxTier: 1 });

  const today = new Date();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() + (past ? -1 : 1) * i * 86_400_000);
    dates.push(d.toLocaleDateString('en-CA', { timeZone: config.timezone }));
  }

  const wanted = team.name.toLowerCase();
  const jobs = list.flatMap((c) => dates.map((d) => ({ ...c, _date: d })));
  const rows = (await mapLimit(jobs, (c) => scoreboard(c, c._date))).flat()
    .filter((m) => m.home.toLowerCase().includes(wanted) || m.away.toLowerCase().includes(wanted));

  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return { data: past ? rows.reverse() : rows, live: rows.length > 0, note: 'via ESPN' };
}

module.exports = {
  competitions,
  resolveCompetition,
  getLiveMatches,
  getMatchesForDate,
  getStandings,
  getTeamMatches,
  scoreboard,
  SPORTS,
};
