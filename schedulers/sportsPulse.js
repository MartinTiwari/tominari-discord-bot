'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('sports-pulse');
const config = require('../utils/config');
const sportsApi = require('../utils/sportsApi');
const publisher = require('../services/publisher');
const embeds = require('../utils/embedFormatter');

/**
 * Twice-daily sports post, built around the competitions rather than around a
 * short list of clubs:
 *
 *   1. anything being played right now, worldwide, with the clock
 *   2. the day's card across every tracked competition
 *   3. the favourite clubs' own fixtures and results
 *   4. a league table in the evening
 *
 * Competitions come from `config.sports.leagues` — the big five, the European
 * cups, the World Cup and Euros, and the leading leagues from the Americas and
 * Asia. Sections that have nothing to say are dropped rather than posted empty.
 */

/**
 * @param {'morning'|'evening'|'manual'} slot
 * @returns {Promise<{posted:number}>}
 */
async function run(client, slot = 'morning') {
  if (!config.channelFor('sports')) {
    log.debug('No sports channel configured — skipping');
    return { posted: 0 };
  }

  const cards = [];

  // 1. Live scoreboard. This is the only rich source available without an API
  //    key, so it leads whenever anything is actually in play.
  const live = await sportsApi.getLiveMatches();
  if (live.data.length) {
    cards.push(embeds.liveScoreEmbed(live.data.slice(0, config.sports.maxLiveMatches ?? 12), {
      note: live.note,
    }));
  }

  // 2. The whole day's card. Matches already played show their score, the rest
  //    show kick-off in Kathmandu time.
  const today = await sportsApi.getMatchesForDate();
  if (today.data.length) {
    cards.push(embeds.matchdayEmbed(today.data, {
      title: slot === 'evening' ? "⚽ Today's results" : "⚽ Today's matches",
      perCompetition: config.sports.maxMatchesPerCompetition ?? 6,
      note: today.partial
        ? `${today.note} — add SPORTS_API_KEY for the full worldwide card`
        : today.note,
    }));
  }

  // 3. The clubs the server actually follows, so the regulars still get their
  //    own card even on a quiet matchday.
  for (const key of Object.keys(config.sports.teams)) {
    const team = sportsApi.resolveTeam(key);

    if (slot === 'evening') {
      const results = await sportsApi.getRecentResults(key, 3);
      if (results.data.length) {
        cards.push(embeds.resultsEmbed(team.name, results.data, { note: results.note }));
        continue;
      }
      // Nothing played recently — fall through and show what is coming up.
    }

    const { data, note } = await sportsApi.getUpcomingFixtures(key, 3);
    if (data.length) cards.push(embeds.fixtureEmbed(team.name, data, { note }));
  }

  // 4. Evening slot closes with a table, rotating through the top divisions so
  //    it is not the same league every night.
  if (slot !== 'morning') {
    const league = pickTableLeague();
    if (league) {
      const { data, note } = await sportsApi.getStandings(league.key);
      if (data.length) {
        cards.push(embeds.standingsEmbed(league.name, data.slice(0, 10), {
          emoji: league.emoji, note,
        }));
      }
    }
  }

  if (!cards.length) {
    log.debug('Nothing to post this slot');
    return { posted: 0 };
  }

  const header = slot === 'evening' ? '## ⚽ Evening Sports Pulse' : '## ⚽ Morning Sports Pulse';
  // Ten embeds per message is Discord's ceiling; publisher chunks past that.
  await publisher.sendToCategory(client, 'sports', cards.slice(0, 10), { content: header });

  log.info(`${slot} pulse: ${cards.length} embeds posted`
    + ` (${live.data.length} live, ${today.data.length} today)`);
  return { posted: cards.length };
}

/**
 * One of the domestic top divisions, chosen from the date so the table rotates
 * daily. Continental and international competitions are skipped — a group-stage
 * table is meaningless for most of the year.
 */
function pickTableLeague() {
  const DOMESTIC = ['premier', 'laliga', 'bundesliga', 'seriea', 'ligue1'];
  const leagues = sportsApi.trackedLeagues({ maxTier: 1 })
    .filter((l) => DOMESTIC.includes(l.key));
  if (!leagues.length) return null;

  const dayOfYear = Math.floor(
    (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86_400_000,
  );
  return leagues[dayOfYear % leagues.length];
}

function start(client) {
  const tasks = [];

  for (const [slot, expr] of [
    ['morning', config.schedules.sportsMorning],
    ['evening', config.schedules.sportsEvening],
  ]) {
    if (!cron.validate(expr)) {
      log.error(`Invalid cron expression "${expr}" — ${slot} sports pulse disabled`);
      continue;
    }
    tasks.push(cron.schedule(expr, async () => {
      try {
        await run(client, slot);
      } catch (err) {
        log.error(`${slot} pulse failed: ${err.message}`);
      }
    }, { timezone: config.timezone }));
    log.info(`Scheduled ${slot} pulse (${expr}, ${config.timezone})`);
  }

  return tasks;
}

module.exports = { start, run };
