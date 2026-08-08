'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('morning-brief');
const config = require('../utils/config');
const { publishBrief, todayLabel } = require('./newsBrief');

/** 6:00 AM detailed brief across every category channel. */
async function run(client) {
  return publishBrief(client, {
    kind: 'morning',
    title: `Morning Brief · ${todayLabel()}`,
    subtitle: 'Top stories to start your day, pulled from Nepal’s major outlets.',
    includeTrending: true,
  });
}

function start(client) {
  const expr = config.schedules.morningBrief;
  if (!cron.validate(expr)) {
    log.error(`Invalid cron expression "${expr}" — morning brief disabled`);
    return null;
  }

  const task = cron.schedule(expr, async () => {
    try {
      await run(client);
    } catch (err) {
      log.error(`Morning brief failed: ${err.message}`);
    }
  }, { timezone: config.timezone });

  log.info(`Scheduled (${expr}, ${config.timezone})`);
  return task;
}

module.exports = { start, run };
