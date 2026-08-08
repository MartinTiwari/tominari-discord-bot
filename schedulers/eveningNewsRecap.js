'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('evening-recap');
const config = require('../utils/config');
const { publishBrief, todayLabel } = require('./newsBrief');

/** 10:00 PM recap: the day's top stories plus a "what you missed" round-up. */
async function run(client) {
  return publishBrief(client, {
    kind: 'evening',
    title: `Evening Recap · ${todayLabel()}`,
    subtitle: 'Everything that mattered today, in one pass.',
    includeTrending: true,
  });
}

function start(client) {
  const expr = config.schedules.eveningRecap;
  if (!cron.validate(expr)) {
    log.error(`Invalid cron expression "${expr}" — evening recap disabled`);
    return null;
  }

  const task = cron.schedule(expr, async () => {
    try {
      await run(client);
    } catch (err) {
      log.error(`Evening recap failed: ${err.message}`);
    }
  }, { timezone: config.timezone });

  log.info(`Scheduled (${expr}, ${config.timezone})`);
  return task;
}

module.exports = { start, run };
