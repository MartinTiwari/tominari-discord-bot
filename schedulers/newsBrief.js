'use strict';

const log = require('../utils/logger')('brief');
const config = require('../utils/config');
const db = require('../utils/database');
const ingest = require('../services/newsIngest');
const publisher = require('../services/publisher');
const embeds = require('../utils/embedFormatter');
const classifier = require('../utils/categoryClassifier');
const { formatDateTime } = require('../utils/time');
const { sleep } = require('../utils/http');

/**
 * Shared engine behind the 6 AM brief and the 10 PM recap — the two jobs differ
 * only in wording and in whether they append a trending round-up, so the
 * publishing logic lives here once.
 */

/**
 * @param {import('discord.js').Client} client
 * @param {{kind:'morning'|'evening', title:string, subtitle:string, includeTrending:boolean}} opts
 * @returns {Promise<{posted:number, categories:number, skipped:string[]}>}
 */
async function publishBrief(client, opts) {
  await ingest.refreshAll();

  const perCategory = config.news.storiesPerCategory;
  const skipped = [];
  let posted = 0;
  let categories = 0;

  for (const category of classifier.CATEGORY_KEYS) {
    if (!config.channelFor(category)) {
      skipped.push(category);
      continue;
    }

    const stories = ingest.selectForBrief(category, perCategory);
    if (!stories.length) {
      log.debug(`No stories for ${category}`);
      continue;
    }

    const header = embeds.briefHeaderEmbed(category, {
      title: `${opts.title} — ${classifier.meta(category).label}`,
      subtitle: opts.subtitle,
      count: stories.length,
    });

    const cards = stories.map((s, i) => embeds.newsArticleEmbed(s, { rank: i + 1 }));
    const messages = await publisher.sendToCategory(client, category, [header, ...cards]);

    if (messages.length) {
      const messageId = messages[0].id;
      for (const s of stories) {
        if (s.id) db.markArticleSent(s.id, messageId);
      }
      posted += stories.length;
      categories++;
    }
    await sleep(1000);                       // gentle pacing across channels
  }

  if (opts.includeTrending && config.channelFor('social-feed')) {
    const trending = db.getTopSocialPosts(config.news.maxAgeHours, 5);
    if (trending.length) {
      const header = embeds.briefHeaderEmbed('world', {
        title: opts.kind === 'evening' ? 'What you missed today' : 'Trending in the last 24h',
        subtitle: opts.kind === 'evening'
          ? 'Highest-engagement posts across every tracked Nepali source.'
          : 'Most-engaged posts collected overnight.',
        count: trending.length,
      });
      await publisher.sendToCategory(client, 'social-feed', [
        header,
        ...trending.map((p) => embeds.socialPostEmbed(p, p.source_name)),
      ]);
      posted += trending.length;
    }
  }

  // Housekeeping: only the evening job prunes, so it runs once per day.
  if (opts.kind === 'evening') db.pruneOldRows(30);

  log.info(`${opts.kind} brief: ${posted} stories across ${categories} categories`
    + (skipped.length ? ` (skipped unconfigured: ${skipped.join(', ')})` : ''));
  return { posted, categories, skipped };
}

/** Human-readable date used in brief headers. */
function todayLabel() {
  return formatDateTime(new Date()).split(',')[0];
}

module.exports = { publishBrief, todayLabel };
