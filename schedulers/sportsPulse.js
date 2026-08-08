'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('sports-pulse');
const config = require('../utils/config');
const sportsApi = require('../utils/sportsApi');
const publisher = require('../services/publisher');
const embeds = require('../utils/embedFormatter');
const { formatDateTime } = require('../utils/time');

/**
 * Twice-daily sports post: fixtures in the morning, results plus a standings
 * snapshot in the evening. Runs against the configured default teams
 * (Bayern / Barça / Real Madrid) — user favourites are served by /today-matches.
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

  const teamKeys = Object.keys(config.sports.teams);
  const cards = [];

  // Today's matches (kick-off times in the morning, scores in the evening).
  const todayResults = await Promise.all(teamKeys.map((k) => sportsApi.getTodayFixtures(k)));
  const todayFixtures = todayResults.flatMap((r) => r.data);

  if (todayFixtures.length) {
    const lines = todayFixtures.map((f) => {
      const score = f.score && !f.score.includes('-') ? ` **${f.score}**` : '';
      return { name: `${f.home} vs ${f.away}${score}`, value: `📅 ${f.date}${f.competition ? `\n🏆 ${f.competition}` : ''}${f.status ? `\n📊 ${f.status}` : ''}` };
    });
    const { EmbedBuilder } = require('discord.js');
    cards.push(new EmbedBuilder()
      .setColor(config.colorFor('sports'))
      .setTitle(slot === 'evening' ? '⚽ Today’s results' : '⚽ Today’s fixtures')
      .addFields(lines.slice(0, 10))
      .setFooter({ text: `Tominari • ${formatDateTime()}` }));
  }

  // Upcoming fixtures per tracked team.
  for (const key of teamKeys) {
    const team = sportsApi.resolveTeam(key);
    const { data, note } = await sportsApi.getUpcomingFixtures(key, 3);
    if (data.length) cards.push(embeds.fixtureEmbed(team.name, data, { note }));
  }

  // Evening slot also drops a league table.
  if (slot !== 'morning') {
    const league = sportsApi.resolveLeague('bundesliga');
    const { data, note } = await sportsApi.getStandings('bundesliga');
    if (data.length) {
      cards.push(embeds.standingsEmbed(league.name, data.slice(0, 10), { emoji: league.emoji, note }));
    }
  }

  if (!cards.length) {
    log.debug('Nothing to post this slot');
    return { posted: 0 };
  }

  const header = slot === 'evening' ? '## ⚽ Evening Sports Pulse' : '## ⚽ Morning Sports Pulse';
  await publisher.sendToCategory(client, 'sports', cards, { content: header });

  log.info(`${slot} pulse: ${cards.length} embeds posted`);
  return { posted: cards.length };
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
