'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('social-feed');
const config = require('../utils/config');
const db = require('../utils/database');
const ingest = require('../services/newsIngest');
const publisher = require('../services/publisher');
const embeds = require('../utils/embedFormatter');
const roasts = require('../data/ronbRoasts.json');
const { sleep } = require('../utils/http');

/**
 * Real-time feed: polls every source on a 30-minute cadence and pushes new
 * items to #social-feed the moment they appear.
 *
 * Two throttles keep the channel readable and stay inside Discord's rate
 * limits: at most `maxSocialPostsPerCycle` posts per cycle, and a short pause
 * between sends.
 */

/**
 * @returns {Promise<{seen:number, stored:number, posted:number, errors:string[]}>}
 */
async function run(client) {
  const result = await ingest.refreshAll();
  const channelId = config.channelFor('social-feed');

  if (!channelId) {
    log.warn('No social-feed channel configured — collected posts but posted nothing');
    return { seen: result.socialSeen, stored: result.socialStored, posted: 0, errors: result.errors };
  }

  // Filler gets roasted, not reported — but a page having a birthday-heavy day
  // must not crowd real news out of the cycle, so roasts are capped separately.
  const news = result.newPosts.filter((p) => p.post_kind === 'news');
  const filler = config.ronb?.roastNonNews === false
    ? []
    : result.newPosts
      .filter((p) => p.post_kind !== 'news')
      .slice(0, config.ronb?.maxRoastsPerCycle ?? 3);

  // Newest last so the channel reads chronologically top-to-bottom.
  const batch = [...news.slice(0, config.news.maxSocialPostsPerCycle), ...filler]
    .sort((a, b) => String(a.posted_at || '').localeCompare(String(b.posted_at || '')));

  let posted = 0;
  let roasted = 0;
  for (const post of batch) {
    const isFiller = post.post_kind !== 'news';
    const embed = isFiller
      ? embeds.roastEmbed(post, roasts)
      : embeds.socialPostEmbed(post, post.source_name);

    const message = await publisher.sendOne(client, 'social-feed', embed);
    if (!message) break;                       // channel unreachable — stop early
    db.markSocialPostSent(post.id, message.channelId, message.id);
    posted++;
    if (isFiller) roasted++;
    await sleep(750);
  }

  log.info(`Cycle done: ${result.socialSeen} seen, ${result.socialStored} new,`
    + ` ${posted} posted (${roasted} roasted)`);
  return {
    seen: result.socialSeen, stored: result.socialStored, posted, roasted, errors: result.errors,
  };
}

function start(client) {
  const expr = config.schedules.socialFeed;
  if (!cron.validate(expr)) {
    log.error(`Invalid cron expression "${expr}" — social feed disabled`);
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
