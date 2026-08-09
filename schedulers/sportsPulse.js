'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('sports-pulse');
const config = require('../utils/config');
const sportsApi = require('../utils/sportsApi');
const publisher = require('../services/publisher');
const embeds = require('../utils/embedFormatter');

/**
 * Twice-daily sports post, built sport by sport rather than club by club:
 *
 *   1. anything in play right now, worldwide, with the clock
 *   2. the day's card — one section per sport, each grouped by competition
 *   3. a league table in the evening, rotating between the big divisions
 *
 * Competitions come from `config.sports.competitions`: the World Cup and the
 * Euros, the Champions League and the big five, the NBA, and the ICC events and
 * major franchise leagues in cricket. Nothing below that is asked about, so a
 * quiet day reads as a short post rather than as a wall of third divisions.
 *
 * Sections with nothing to say are dropped rather than posted empty.
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

  // 1. Live scoreboard leads whenever anything is actually being played, since
  //    it is the only part of the post that is worth reading twice.
  const live = await sportsApi.getLiveMatches();
  if (live.data.length) {
    cards.push(embeds.liveScoreEmbed(live.data.slice(0, config.sports.maxLiveMatches ?? 12), {
      note: live.note,
    }));
  }

  // 2. The day's card, split by sport so the football does not bury the cricket.
  //    Matches already played show their score, the rest show the local start
  //    time; a sport with nothing on today simply has no card.
  const today = await sportsApi.getMatchesForDate();
  for (const sport of sportsApi.trackedSports()) {
    const matches = today.data.filter((m) => m.sport === sport.key);
    if (!matches.length) continue;

    cards.push(embeds.matchdayEmbed(matches, {
      title: slot === 'evening'
        ? `${sport.emoji} ${sport.label} — today's results`
        : `${sport.emoji} ${sport.label} — today`,
      perCompetition: config.sports.maxMatchesPerCompetition ?? 6,
      note: today.note,
    }));
  }

  // 3. Evening slot closes with a table, rotating through the divisions so it is
  //    not the same league every night.
  if (slot !== 'morning') {
    const table = await pickTable();
    if (table) cards.push(table);
  }

  if (!cards.length) {
    log.debug('Nothing to post this slot');
    return { posted: 0 };
  }

  const header = slot === 'evening' ? '## 🏟️ Evening Sports Pulse' : '## 🏟️ Morning Sports Pulse';
  // Ten embeds per message is Discord's ceiling; publisher chunks past that.
  await publisher.sendToCategory(client, 'sports', cards.slice(0, 10), { content: header });

  log.info(`${slot} pulse: ${cards.length} embeds posted`
    + ` (${live.data.length} live, ${today.data.length} on today's card)`);
  return { posted: cards.length };
}

/**
 * One league table, as an embed, or null when no league has one worth showing.
 *
 * The starting league rotates with the date so it is not the same one every
 * night. Cup competitions are never candidates — a group-stage table is
 * meaningless for most of the year — and a league whose season has not kicked
 * off is skipped rather than printed, since in August that is most of Europe
 * and the card would be twenty teams on nought points. The rotation walks on to
 * the next candidate instead, which in practice means the NBA covers the
 * European summer and the European leagues cover the NBA's.
 */
async function pickTable() {
  const TABLES = ['premier', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'nba'];
  const leagues = sportsApi.trackedLeagues().filter((l) => TABLES.includes(l.key));
  if (!leagues.length) return null;

  const dayOfYear = Math.floor(
    (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86_400_000,
  );

  for (let i = 0; i < leagues.length; i++) {
    const league = leagues[(dayOfYear + i) % leagues.length];
    const { data, note, format, grouped, started } = await sportsApi.getStandings(league.key);
    if (!data.length || !started) continue;

    return embeds.standingsEmbed(league.name, data, {
      emoji: league.emoji, note, format, grouped,
    });
  }

  return null;
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
