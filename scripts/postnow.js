'use strict';

require('dotenv').config();

/**
 * Fire the scheduled jobs immediately, for real — posts land in Discord.
 *
 *   node scripts/postnow.js              # feed + news + brief + sports
 *   node scripts/postnow.js feed         # only the real-time social feed
 *   node scripts/postnow.js news         # only the per-category news channels
 *   node scripts/postnow.js brief recap  # any combination
 *
 * Unlike `npm start` this talks to Discord over plain REST instead of opening a
 * gateway connection, so it is safe to run while the long-lived bot is up: no
 * second session, no duplicated schedulers. Use it to seed the channels right
 * after setup rather than waiting for the next cron tick.
 *
 * Contrast with scripts/dryrun.js, which prints instead of sending.
 */

const log = require('../utils/logger')('postnow');
const config = require('../utils/config');
const db = require('../utils/database');
const ingest = require('../services/newsIngest');
const http = require('../utils/http');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  log.error('DISCORD_TOKEN missing — nothing to post with.');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';

/** POST one message, returning the shape the schedulers expect back. */
async function sendMessage(channelId, payload) {
  const body = {
    content: payload.content,
    embeds: (payload.embeds || []).map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e)),
  };

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const { retry_after: retryAfter = 1 } = await res.json().catch(() => ({}));
    log.warn(`rate limited — waiting ${retryAfter}s`);
    await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
    return sendMessage(channelId, payload);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`send to ${channelId} failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const msg = await res.json();
  return { id: msg.id, channelId: msg.channel_id };
}

/**
 * Minimal stand-in for a discord.js Client — just the two surfaces the
 * schedulers actually touch.
 */
const client = {
  channels: {
    async fetch(id) {
      return {
        id,
        isTextBased: () => true,
        // Discord rejects bursts; a small gap keeps us under the limit.
        async send(payload) {
          const result = await sendMessage(id, payload);
          await new Promise((r) => setTimeout(r, 700));
          return result;
        },
      };
    },
  },
  users: {
    async fetch(id) {
      return {
        id,
        async send() {
          throw new Error('DMs are not sent by postnow — the running bot handles reminders');
        },
      };
    },
  },
};

async function main() {
  const requested = process.argv.slice(2).map((a) => a.toLowerCase());
  const wants = (name) => (requested.length ? requested.includes(name) : ['feed', 'news', 'brief', 'sports'].includes(name));

  const missing = [...config.categories, 'social-feed'].filter((c) => !config.channelFor(c));
  if (missing.length) log.warn(`No channel configured for: ${missing.join(', ')} — skipping those.`);

  // The long-running bot seeds on ready, but this script has no ready event,
  // and in CI the database starts empty on the very first run. Without this
  // there are no rows in social_sources, so refreshAll() polls nothing and the
  // news jobs post nothing — silently, with a successful exit code.
  ingest.seedSources();

  // Deliberately NO refreshAll() here. The feed and brief jobs each refresh as
  // their first step and post whatever that refresh returned as new. A refresh
  // at this point would claim every pending story as "already stored", leaving
  // the job's own refresh with only the handful that arrived in the seconds
  // in between — so the run would quietly post three stories and swallow the
  // other fifty-five. Jobs that need fresh data fetch it themselves.

  let total = 0;

  if (wants('feed')) {
    const r = await require('../schedulers/realtimeSocialFeed').run(client);
    log.info(`social feed → ${r.posted} posts`);
    total += r.posted;
  }
  // Routes whatever the feed just stored into #politics, #business and the rest.
  // It must come after `feed`, which is the job that actually polls the sources
  // — on its own it would have nothing new to route.
  if (wants('news')) {
    const r = await require('../schedulers/categoryFeed').run(client, {
      // On its own there is no feed cycle ahead of it to have filled the table.
      refresh: !wants('feed'),
    });
    log.info(`category feed → ${r.posted} stories across ${r.categories} categories`);
    total += r.posted;
  }
  if (wants('brief')) {
    const r = await require('../schedulers/morningNewsBrief').run(client);
    log.info(`news brief → ${r.posted} stories across ${r.categories} categories`);
    total += r.posted;
  }
  if (wants('recap')) {
    const r = await require('../schedulers/eveningNewsRecap').run(client);
    log.info(`evening recap → ${r.posted} stories across ${r.categories} categories`);
    total += r.posted;
  }
  if (wants('sports')) {
    // The 09:00 NPT run should look ahead to today's fixtures; the 19:00 one
    // should report results. CI has no idea which cron fired it, so decide
    // from the Kathmandu wall clock.
    const hour = Number(new Date().toLocaleString('en-GB', {
      timeZone: config.timezone, hour: '2-digit', hour12: false,
    }));
    const slot = hour < 12 ? 'morning' : 'evening';

    const r = await require('../schedulers/sportsPulse').run(client, slot);
    log.info(`sports pulse (${slot}) → ${r.posted} embeds`);
    total += r.posted;
  }
  if (wants('health')) {
    const r = await require('../schedulers/healthReminder').runChannelBlast(client);
    log.info(`churot-free blast → ${r.sent} posted${r.reason ? ` (${r.reason})` : ''}`);
    total += r.sent;
  }

  log.info(`Done — ${total} messages posted to Discord.`);
  db.db.close();
}

async function releaseSockets() {
  await http.shutdown();
  require('node:http').globalAgent.destroy();
  require('node:https').globalAgent.destroy();
}

main()
  .then(releaseSockets)
  .catch(async (err) => {
    log.error(err.stack || err.message);
    await releaseSockets().catch(() => {});
    process.exit(1);
  });
