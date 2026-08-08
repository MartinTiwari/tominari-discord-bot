'use strict';

const log = require('../utils/logger')('schedulers');

const realtimeSocialFeed = require('./realtimeSocialFeed');
const morningNewsBrief = require('./morningNewsBrief');
const eveningNewsRecap = require('./eveningNewsRecap');
const sportsPulse = require('./sportsPulse');
const healthReminder = require('./healthReminder');

const JOBS = [
  ['realtime social feed', realtimeSocialFeed],
  ['morning news brief', morningNewsBrief],
  ['evening news recap', eveningNewsRecap],
  ['sports pulse', sportsPulse],
  ['health reminders', healthReminder],
];

/**
 * Start every cron job. A job that fails to start is logged and skipped — one
 * broken schedule must never prevent the bot from coming up.
 * @returns {Array} flat list of started node-cron tasks (for graceful shutdown)
 */
function startAll(client) {
  const tasks = [];
  for (const [name, job] of JOBS) {
    try {
      const started = job.start(client);
      if (Array.isArray(started)) tasks.push(...started.filter(Boolean));
      else if (started) tasks.push(started);
    } catch (err) {
      log.error(`Failed to start "${name}": ${err.message}`);
    }
  }
  log.info(`${tasks.length} scheduled tasks running`);
  return tasks;
}

function stopAll(tasks = []) {
  for (const task of tasks) {
    try {
      task.stop();
    } catch { /* already stopped */ }
  }
  log.info('All scheduled tasks stopped');
}

module.exports = {
  startAll,
  stopAll,
  realtimeSocialFeed,
  morningNewsBrief,
  eveningNewsRecap,
  sportsPulse,
  healthReminder,
};
