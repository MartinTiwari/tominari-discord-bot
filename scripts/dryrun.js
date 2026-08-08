'use strict';

require('dotenv').config();

/**
 * Dry run — executes every scheduled job against a mock Discord client and
 * prints what *would* be posted. No token needed, nothing is sent.
 *
 *   node scripts/dryrun.js            # all jobs
 *   node scripts/dryrun.js feed       # only the real-time social feed
 *   node scripts/dryrun.js brief      # only the morning brief
 *   node scripts/dryrun.js recap sports health
 *
 * Use this to sanity-check formatting and channel routing before inviting the
 * bot to a live server.
 */

const config = require('../utils/config');
const db = require('../utils/database');
const ingest = require('../services/newsIngest');

// Pretend every category channel is configured, so nothing is skipped for
// wiring reasons during the preview.
const FAKE_IDS = {};
for (const key of Object.keys(config.channels)) {
  FAKE_IDS[key] = config.channels[key] || `dryrun-${key}`;
  config.channels[key] = FAKE_IDS[key];
}

let messageCounter = 0;
const sentLog = [];

function describeEmbed(embed) {
  const e = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  const lines = [];
  if (e.author?.name) lines.push(`   ${e.author.name}`);
  if (e.title) lines.push(`   ▸ ${e.title}`);
  if (e.description) {
    lines.push(`     ${e.description.replace(/\n+/g, ' ').slice(0, 150)}${e.description.length > 150 ? '…' : ''}`);
  }
  for (const f of e.fields || []) {
    lines.push(`     · ${f.name}: ${String(f.value).replace(/\n+/g, ' ').slice(0, 90)}`);
  }
  if (e.footer?.text) lines.push(`     ⌐ ${e.footer.text}`);
  return lines.join('\n');
}

function makeChannel(name) {
  return {
    id: FAKE_IDS[name],
    name,
    isTextBased: () => true,
    async send(payload) {
      messageCounter++;
      const embeds = payload.embeds || [];
      sentLog.push({ channel: name, embeds: embeds.length });
      console.log(`\n📨 #${name}  (${embeds.length} embed${embeds.length === 1 ? '' : 's'})`);
      if (payload.content) console.log(`   ${payload.content.replace(/\n/g, '\n   ')}`);
      for (const embed of embeds) console.log(describeEmbed(embed));
      return { id: `msg-${messageCounter}`, channelId: FAKE_IDS[name] };
    },
  };
}

const nameById = Object.fromEntries(Object.entries(FAKE_IDS).map(([k, v]) => [v, k]));

const mockClient = {
  channels: {
    async fetch(id) {
      const name = nameById[id];
      if (!name) throw new Error(`Unknown channel ${id}`);
      return makeChannel(name);
    },
  },
  users: {
    async fetch(id) {
      return {
        id,
        username: `user-${id.slice(0, 6)}`,
        async send(payload) {
          messageCounter++;
          console.log(`\n📬 DM → ${id}`);
          if (payload.content) console.log(`   ${payload.content}`);
          for (const embed of payload.embeds || []) console.log(describeEmbed(embed));
          return { id: `dm-${messageCounter}` };
        },
      };
    },
  },
};

async function main() {
  const requested = process.argv.slice(2).map((a) => a.toLowerCase());
  const wants = (name) => requested.length === 0 || requested.includes(name);

  console.log('\n🇳🇵 Tominari dry run — nothing is actually sent to Discord\n');

  ingest.seedSources();
  console.log('Fetching live sources…');
  const result = await ingest.refreshAll();
  console.log(`Collected ${result.socialStored} new social posts (${result.socialSeen} seen), `
    + `${result.apiStored} NewsAPI articles.`);
  if (result.errors.length) console.log(`⚠️  Sources that failed: ${result.errors.join(', ')}`);

  if (wants('feed')) {
    console.log('\n══════ Real-time social feed ══════');
    const r = await require('../schedulers/realtimeSocialFeed').run(mockClient);
    console.log(`\n→ would post ${r.posted} items`);
  }

  if (wants('brief')) {
    console.log('\n══════ Morning news brief (6:00 AM) ══════');
    const r = await require('../schedulers/morningNewsBrief').run(mockClient);
    console.log(`\n→ ${r.posted} stories across ${r.categories} categories`);
  }

  if (wants('recap')) {
    console.log('\n══════ Evening news recap (10:00 PM) ══════');
    const r = await require('../schedulers/eveningNewsRecap').run(mockClient);
    console.log(`\n→ ${r.posted} stories across ${r.categories} categories`);
  }

  if (wants('sports')) {
    console.log('\n══════ Sports pulse ══════');
    const r = await require('../schedulers/sportsPulse').run(mockClient, 'evening');
    console.log(`\n→ ${r.posted} embeds`);
  }

  if (wants('health')) {
    console.log('\n══════ Health reminder ══════');
    const TEST_ID = 'dryrun-user-0001';
    db.ensureUser(TEST_ID);
    db.updateUser(TEST_ID, { remind_every_30min: 1, reminders_enabled: 1 });
    db.setStreakStart(TEST_ID, new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '));

    const health = require('../schedulers/healthReminder');

    // Show one message per tone/language combination rather than 48 identical DMs.
    for (const tone of ['tikho', 'soft']) {
      for (const language of ['nepali', 'english']) {
        db.updateUser(TEST_ID, { reminder_tone: tone, reminder_language: language });
        console.log(`\n--- ${language} / ${tone} ---`);
        await health.runPeriodic(mockClient);
      }
    }

    // And the milestone card, by parking the streak exactly on 30 days.
    db.updateUser(TEST_ID, { reminder_tone: 'tikho', reminder_language: 'nepali' });
    db.setStreakStart(TEST_ID, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '));
    db.setBadgeLevel(TEST_ID, 0);
    console.log('\n--- 30-day milestone card ---');
    await health.runPeriodic(mockClient);

    db.db.prepare('DELETE FROM users WHERE discord_id = ?').run(TEST_ID);
  }

  const byChannel = sentLog.reduce((acc, s) => {
    acc[s.channel] = (acc[s.channel] || 0) + s.embeds;
    return acc;
  }, {});

  console.log('\n══════ Summary ══════');
  console.log(`${messageCounter} messages that would be sent.`);
  for (const [channel, n] of Object.entries(byChannel)) console.log(`  #${channel}: ${n} embeds`);
  console.log('');

  db.db.close();
}

/**
 * Release every pooled socket. Without this the script sits idle for the
 * keep-alive timeout after printing its summary — undici's pool for our own
 * fetch calls, and the node:http agents that rss-parser uses.
 */
async function releaseSockets() {
  await require('../utils/http').shutdown();
  require('node:http').globalAgent.destroy();
  require('node:https').globalAgent.destroy();
}

main()
  .then(releaseSockets)
  .catch(async (err) => {
    console.error('\n💥 Dry run failed:', err.stack || err.message);
    await releaseSockets().catch(() => {});
    process.exit(1);
  });
