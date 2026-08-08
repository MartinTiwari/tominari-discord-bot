'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Loads config.json and layers environment variables on top of it, so a
 * deployment can override channel IDs without editing the checked-in config.
 */

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const CHANNEL_ENV = {
  politics: 'POLITICS_CHANNEL_ID',
  business: 'BUSINESS_CHANNEL_ID',
  sports: 'SPORTS_CHANNEL_ID',
  tech: 'TECH_CHANNEL_ID',
  entertainment: 'ENTERTAINMENT_CHANNEL_ID',
  world: 'WORLD_CHANNEL_ID',
  'social-feed': 'SOCIAL_FEED_CHANNEL_ID',
  health: 'HEALTH_CHANNEL_ID',
};

/** Channels that carry something other than news stories. */
const NON_NEWS = new Set(['social-feed', 'health']);

for (const [key, envName] of Object.entries(CHANNEL_ENV)) {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) raw.channels[key] = fromEnv.trim();
}

/** Category keys that map to a Discord channel. */
raw.categories = Object.keys(CHANNEL_ENV).filter((c) => !NON_NEWS.has(c));

/**
 * Who the channel-wide reminders nag, so the post can @mention them.
 * Env wins, then config.json — a Discord user id is not a secret, so keeping it
 * in config.json means a CI deploy needs only DISCORD_TOKEN as a secret.
 */
raw.health.mentionUserId = (process.env.HEALTH_MENTION_USER_ID || '').trim()
  || (raw.health.mentionUserId || '').trim()
  || null;

/** Resolve a channel ID for a category, or null when it has not been configured. */
raw.channelFor = function channelFor(category) {
  const id = this.channels[category];
  return id && id.trim() ? id.trim() : null;
};

/** Colour for an embed category, falling back to a neutral blurple. */
raw.colorFor = function colorFor(category) {
  return this.colors[category] ?? 5793266;
};

module.exports = raw;
