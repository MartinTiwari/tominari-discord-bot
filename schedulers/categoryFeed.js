'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('category-feed');
const config = require('../utils/config');
const db = require('../utils/database');
const ingest = require('../services/newsIngest');
const publisher = require('../services/publisher');
const embeds = require('../utils/embedFormatter');
const classifier = require('../utils/categoryClassifier');
const { sleep } = require('../utils/http');

/**
 * Routes stored news into its own channel — #politics, #business, #tech,
 * #entertainment, #world — on the same half-hourly cadence as the social feed.
 *
 * Without this the category channels only ever heard from the 6 AM brief and
 * the 10 PM recap, so #social-feed filled up all day while the rest of the
 * server sat empty. The collection layer already tags every story with a
 * category and the database already tracks what has been sent, so the work here
 * is only the routing: take what is unsent, post it where it belongs, mark it.
 *
 * By default it fetches nothing: `realtimeSocialFeed` refreshes the sources at
 * the top of the same cycle and both jobs read the same tables, so a second
 * refresh would only re-ask the same feeds a few minutes apart. Pass
 * `refresh: true` when this job runs on its own and there is no feed cycle
 * ahead of it to have filled the table.
 */

/**
 * @param {import('discord.js').Client} client
 * @param {{perCategory?:number, refresh?:boolean}} [opts]
 * @returns {Promise<{posted:number, categories:number, skipped:string[]}>}
 */
async function run(client, {
  perCategory = config.news.maxPerCategoryPerCycle ?? 3,
  refresh = false,
} = {}) {
  if (refresh) await ingest.refreshAll();

  const skipped = [];
  let posted = 0;
  let categories = 0;

  for (const category of classifier.CATEGORY_KEYS) {
    if (!config.channelFor(category)) {
      skipped.push(category);
      continue;
    }

    const stories = db.getUnsentArticles(category, perCategory, config.news.maxAgeHours);
    if (!stories.length) continue;

    // Oldest first, so a channel read top to bottom runs forwards in time.
    stories.reverse();

    let sentHere = 0;
    for (const story of stories) {
      const message = await publisher.sendOne(
        client, category, embeds.newsArticleEmbed(story),
      );
      if (!message) break;                     // channel unreachable — stop early
      db.markArticleSent(story.id, message.id);
      sentHere++;
      await sleep(750);
    }

    if (sentHere) {
      posted += sentHere;
      categories++;
    }
  }

  log.info(`Cycle done: ${posted} stories across ${categories} categories`
    + (skipped.length ? ` (skipped unconfigured: ${skipped.join(', ')})` : ''));
  return { posted, categories, skipped };
}

function start(client) {
  const expr = config.schedules.categoryFeed || config.schedules.socialFeed;
  if (!cron.validate(expr)) {
    log.error(`Invalid cron expression "${expr}" — category feed disabled`);
    return null;
  }

  const task = cron.schedule(expr, async () => {
    try {
      await run(client);
    } catch (err) {
      log.error(`Cycle failed: ${err.message}`);
    }
  }, { timezone: config.timezone });

  log.info(`Scheduled (${expr}, ${config.timezone})`);
  return task;
}

module.exports = { start, run };
