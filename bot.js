'use strict';

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, Events, ActivityType, MessageFlags, Status,
} = require('discord.js');

const log = require('./utils/logger')('bot');
const config = require('./utils/config');
const db = require('./utils/database');
const embeds = require('./utils/embedFormatter');
const { loadCommands } = require('./commands');
const schedulers = require('./schedulers');
const ingest = require('./services/newsIngest');

/**
 * Tominari — Nepal news, sports tracking and tikho anti-smoking reminders.
 * Entry point: wires up the client, commands and cron jobs, then logs in.
 */

if (!process.env.DISCORD_TOKEN) {
  log.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  // Needed so DM channels resolve without a prior message from the user.
  partials: [Partials.Channel],
});

const commands = loadCommands();
client.commands = commands;

let tasks = [];

// ------------------------------------------------------------------ ready ----

/**
 * Presence is not always restored after the gateway drops and resumes, which
 * is the usual reason a bot that is running still shows as offline. It is
 * cheap to re-apply, so every path back to READY calls this.
 */
function applyPresence(user) {
  user.setPresence({
    status: 'online',
    activities: [{ name: 'Nepal news & churot-free streaks 🇳🇵', type: ActivityType.Watching }],
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  log.info(`Logged in as ${readyClient.user.tag}`);

  applyPresence(readyClient.user);

  // Load the tracked source list into SQLite (idempotent).
  ingest.seedSources();

  // Warm the cache so /nepal-news answers immediately after a cold start.
  try {
    const result = await ingest.refreshAll();
    log.info(`Initial ingest: ${result.socialStored} social + ${result.apiStored} API articles`);
  } catch (err) {
    log.warn(`Initial ingest failed (will retry on schedule): ${err.message}`);
  }

  tasks = schedulers.startAll(readyClient);

  const unconfigured = [...config.categories, 'social-feed'].filter((c) => !config.channelFor(c));
  if (unconfigured.length) {
    log.warn(`No channel configured for: ${unconfigured.join(', ')} — those posts will be skipped. `
      + 'Set them in config.json or via *_CHANNEL_ID in .env.');
  }

  log.info('Tominari is ready. 🇳🇵');
});

// ----------------------------------------------------------- interactions ----

client.on(Events.InteractionCreate, async (interaction) => {
  // Autocomplete handlers reply on a different channel and must not be wrapped
  // in the deferReply error path below.
  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      log.warn(`Autocomplete for /${interaction.commandName} failed: ${err.message}`);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) {
    log.warn(`Unknown command /${interaction.commandName}`);
    return;
  }

  // Make sure a user row exists before any command touches preferences.
  db.ensureUser(interaction.user.id);

  try {
    await command.execute(interaction);
    log.debug(`/${interaction.commandName} by ${interaction.user.tag}`);
  } catch (err) {
    log.error(`/${interaction.commandName} failed: ${err.stack || err.message}`);

    const payload = {
      embeds: [embeds.errorEmbed('Command failed', err.message)],
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      // The interaction token expired (>15 min) — nothing more we can do.
    }
  }
});

// ------------------------------------------------------------- resilience ----

client.on(Events.Error, (err) => log.error(`Client error: ${err.message}`));
client.on(Events.Warn, (msg) => log.warn(msg));
client.on(Events.ShardDisconnect, (event, id) => {
  log.warn(`Shard ${id} disconnected (code ${event?.code ?? '?'})`);
});
client.on(Events.ShardReconnecting, (id) => log.info(`Shard ${id} reconnecting…`));

// After a resume the session is new, so re-assert presence — otherwise the bot
// is connected and working but still greyed out in the member list.
client.on(Events.ShardResume, (id) => {
  log.info(`Shard ${id} resumed`);
  if (client.user) applyPresence(client.user);
});

/**
 * Gateway watchdog.
 *
 * discord.js reconnects on its own, but a shard can end up permanently stuck
 * (an unresumable session, a half-open socket) with the process still alive
 * and every cron job still firing into the void. That is exactly the state
 * where the bot "is running" but shows offline, and nothing restarts it
 * because nothing crashed.
 *
 * So: if the gateway has not been READY for this long, exit non-zero and let
 * the supervisor (scripts/run-forever.ps1, Docker's restart policy, or the
 * systemd unit) bring up a clean process.
 */
const OFFLINE_GRACE_MS = Number(process.env.GATEWAY_GRACE_MS || 5 * 60 * 1000);
let lastReadyAt = Date.now();

const watchdog = setInterval(() => {
  if (client.ws.status === Status.Ready) {
    lastReadyAt = Date.now();
    return;
  }

  const downFor = Math.round((Date.now() - lastReadyAt) / 1000);
  if (Date.now() - lastReadyAt < OFFLINE_GRACE_MS) {
    log.warn(`Gateway not ready (status ${client.ws.status}) for ${downFor}s — waiting for reconnect`);
    return;
  }

  log.error(`Gateway stuck for ${downFor}s — exiting so the supervisor restarts a clean process`);
  clearInterval(watchdog);
  try {
    client.destroy();
  } catch { /* nothing to clean up */ }
  process.exit(1);
}, 60_000);

// Never hold the event loop open on the watchdog alone.
watchdog.unref();

// A rejected promise somewhere in a scheduler must not kill the process.
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.stack || err.message}`);
});

function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  clearInterval(watchdog);
  schedulers.stopAll(tasks);
  try {
    db.db.close();
  } catch { /* already closed */ }
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ----------------------------------------------------------------- login ----

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  log.error(`Login failed: ${err.message}`);
  process.exit(1);
});
