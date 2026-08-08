'use strict';

require('dotenv').config();

/**
 * Fire the scheduled jobs immediately, for real — posts land in Discord.
 *
 *   node scripts/postnow.js              # feed + brief + sports
 *   node scripts/postnow.js feed         # only the real-time social feed
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
  const wants = (name) => (requested.length ? requested.includes(name) : ['feed', 'brief', 'sports'].includes(name));

  const missing = [...config.categories, 'social-feed'].filter((c) => !config.channelFor(c));
  if (missing.length) log.warn(`No channel configured for: ${missing.join(', ')} — skipping those.`);

  log.info('Refreshing sources before posting…');
  const result = await ingest.refreshAll();
  log.info(`${result.socialStored} new social posts, ${result.apiStored} API articles`);

  let total = 0;

  if (wants('feed')) {
    const r = await require('../schedulers/realtimeSocialFeed').run(client);
    log.info(`social feed → ${r.posted} posts`);
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
    const r = await require('../schedulers/sportsPulse').run(client, 'evening');
    log.info(`sports pulse → ${r.posted} embeds`);
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
