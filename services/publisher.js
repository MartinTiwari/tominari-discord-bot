'use strict';

const log = require('../utils/logger')('publisher');
const config = require('../utils/config');

/**
 * Thin wrapper over Discord sends. Centralises channel resolution, permission
 * checks, embed batching (Discord allows max 10 embeds per message) and the
 * "channel not configured" case, so no scheduler needs try/catch around every
 * send.
 */

const MAX_EMBEDS_PER_MESSAGE = 10;

/** Resolve a configured category channel, or null with a warning logged once. */
async function resolveChannel(client, category) {
  const id = config.channelFor(category);
  if (!id) {
    log.debug(`No channel configured for "${category}" — skipping`);
    return null;
  }

  try {
    const channel = await client.channels.fetch(id);
    if (!channel?.isTextBased()) {
      log.warn(`Channel ${id} for "${category}" is not a text channel`);
      return null;
    }
    return channel;
  } catch (err) {
    log.warn(`Cannot access channel ${id} for "${category}": ${err.message}`);
    return null;
  }
}

/**
 * Send embeds to a category channel, chunked to Discord's limits.
 * @returns {Promise<Array>} the sent Message objects (empty when unroutable)
 */
async function sendToCategory(client, category, embeds, { content = null } = {}) {
  if (!embeds?.length) return [];

  const channel = await resolveChannel(client, category);
  if (!channel) return [];

  const sent = [];
  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const chunk = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    try {
      const message = await channel.send({
        content: i === 0 ? content ?? undefined : undefined,
        embeds: chunk,
      });
      sent.push(message);
    } catch (err) {
      log.error(`Failed to post to #${channel.name}: ${err.message}`);
      break;                             // usually a permission problem; stop retrying
    }
  }
  return sent;
}

/**
 * Send one embed and return the message, or null.
 * Useful when the caller needs the message id (e.g. to record it on a row).
 */
async function sendOne(client, category, embed, options = {}) {
  const [message] = await sendToCategory(client, category, [embed], options);
  return message || null;
}

/**
 * DM a user. Returns false when their DMs are closed — that is expected and
 * must not be treated as an error.
 */
async function dmUser(client, discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send(payload);
    return true;
  } catch (err) {
    // 50007 = "Cannot send messages to this user"
    if (err.code === 50007) log.debug(`DMs closed for ${discordId}`);
    else log.warn(`DM to ${discordId} failed: ${err.message}`);
    return false;
  }
}

module.exports = { sendToCategory, sendOne, dmUser, resolveChannel };
