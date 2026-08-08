'use strict';

const cron = require('node-cron');
const log = require('../utils/logger')('health');
const config = require('../utils/config');
const db = require('../utils/database');
const motivation = require('../utils/motivation');
const publisher = require('../services/publisher');
const embeds = require('../utils/embedFormatter');
const { nowInZone, inQuietHours } = require('../utils/time');
const { sleep } = require('../utils/http');

/**
 * Three reminder mechanisms share one 30-minute tick:
 *
 *  0. The channel blast — posted to #churot-free with no opt-in at all, so the
 *     nagging shows up whether or not anyone has touched a command. This is the
 *     one most people actually want; the DM paths below are for per-user tuning.
 *  1. The periodic blast — users who ran `/reminder-toggle true` get a DM every
 *     30 minutes, suppressed during their local quiet hours so the bot does not
 *     wake them at 3 AM. (The spec asks for 24/7; quiet hours are the one
 *     concession, and they are configurable in config.json.)
 *  2. Fixed-time reminders — users who set `/set-reminder 08:30` get exactly one
 *     DM when their local clock reaches that time, guarded by `last_sent_on`
 *     so a restart cannot double-send.
 */

/** Build the DM payload for a user, celebrating milestones when they land. */
function buildPayload(user) {
  const streak = db.getStreak(user.discord_id);
  const days = streak.days;

  const level = motivation.badgeLevelFor(days);
  const isNewBadge = level > streak.badge_level;
  if (isNewBadge) db.setBadgeLevel(user.discord_id, level);

  const milestone = motivation.milestoneMessage(days);

  // A freshly earned badge or an exact milestone day gets the full streak card;
  // otherwise keep it to a short blast so 48 DMs a day stay tolerable.
  if (isNewBadge || milestone) {
    const badge = motivation.badgeFor(days);
    return {
      content: milestone ? `## ${milestone}` : undefined,
      embeds: [embeds.streakEmbed({
        days,
        bestDays: streak.best_days,
        badge: badge ? `${badge.name} (${badge.nepali})` : null,
        nextBadge: motivation.nextBadgeFor(days),
        progress: motivation.badgeProgress(days),
        message: motivation.getMessage({
          days,
          language: user.reminder_language,
          tone: user.reminder_tone,
        }),
      })],
    };
  }

  return {
    embeds: [embeds.motivationEmbed({
      days,
      tone: user.reminder_tone,
      message: motivation.getMessage({
        days,
        language: user.reminder_language,
        tone: user.reminder_tone,
      }),
    })],
  };
}

/** Every-30-minutes blast for opted-in users. */
async function runPeriodic(client) {
  const users = db.getUsersForPeriodicReminder();
  let sent = 0;
  let quiet = 0;

  for (const user of users) {
    if (inQuietHours(user.timezone)) {
      quiet++;
      continue;
    }
    if (await publisher.dmUser(client, user.discord_id, buildPayload(user))) sent++;
    await sleep(300);                        // stay well inside DM rate limits
  }

  if (users.length) {
    log.info(`Periodic blast: ${sent} sent, ${quiet} skipped (quiet hours), ${users.length} subscribed`);
  }
  return { sent, quiet, total: users.length };
}

/**
 * Channel-wide blast: the same tikho message, posted to #churot-free every tick
 * so it shows up without anyone having to opt in or run a command. Quiet hours
 * still apply, using the bot's configured timezone rather than a user's.
 *
 * When HEALTH_MENTION_USER_ID is set the post @mentions that person and uses
 * their streak and language/tone preferences; otherwise it is a generic blast.
 */
async function runChannelBlast(client) {
  const channelId = config.channelFor('health');
  if (!channelId) return { sent: 0, reason: 'no health channel configured' };

  if (inQuietHours(config.timezone)) return { sent: 0, reason: 'quiet hours' };

  const mentionId = config.health.mentionUserId;
  // The row may not exist yet if they have never run a command — create it so
  // the post carries a real streak instead of falling back to the generic copy.
  if (mentionId) db.ensureUser(mentionId);
  const user = mentionId ? db.getUser(mentionId) : null;

  const payload = user
    ? buildPayload(user)
    : {
      embeds: [embeds.motivationEmbed({
        days: 0,
        tone: config.health.defaultTone,
        message: motivation.getMessage({
          days: 0,
          language: config.health.defaultLanguage,
          tone: config.health.defaultTone,
        }),
      })],
    };

  if (mentionId) {
    payload.content = `${payload.content ? `${payload.content}\n` : ''}<@${mentionId}>`;
  }

  const sent = await publisher.sendToCategory(client, 'health', payload.embeds, {
    content: payload.content,
  });
  return { sent: sent.length };
}

/** Fixed-time reminders whose local HH:MM matches the current tick. */
async function runFixedTime(client) {
  const reminders = db.getDueReminders();
  let sent = 0;

  for (const reminder of reminders) {
    const local = nowInZone(reminder.timezone);
    if (local.hhmm !== reminder.reminder_time) continue;
    if (reminder.last_sent_on === local.dateKey) continue;      // already fired today

    const user = db.getUser(reminder.discord_id);
    if (!user) continue;

    const ok = await publisher.dmUser(client, reminder.discord_id, buildPayload(user));
    db.markReminderSent(reminder.id, local.dateKey);            // mark either way, avoids retry storms
    if (ok) sent++;
    await sleep(300);
  }

  if (sent) log.info(`Fixed-time reminders: ${sent} sent`);
  return { sent };
}

async function run(client) {
  const [periodic, fixed, channel] = await Promise.all([
    runPeriodic(client),
    runFixedTime(client),
    runChannelBlast(client),
  ]);
  return { periodic, fixed, channel };
}

function start(client) {
  const expr = config.schedules.healthReminder;
  if (!cron.validate(expr)) {
    log.error(`Invalid cron expression "${expr}" — health reminders disabled`);
    return null;
  }

  const task = cron.schedule(expr, async () => {
    // The channel blast and the DM blast fail independently — a user with
    // closed DMs must not stop the channel post, and vice versa.
    try {
      await runPeriodic(client);
    } catch (err) {
      log.error(`Reminder tick failed: ${err.message}`);
    }
    try {
      const { sent } = await runChannelBlast(client);
      if (sent) log.info(`Channel blast: posted to #churot-free`);
    } catch (err) {
      log.error(`Channel blast failed: ${err.message}`);
    }
  }, { timezone: config.timezone });

  // Fixed-time reminders need a finer tick than 30 minutes to catch times like
  // 08:15 — check every minute, which is cheap (a single indexed query).
  const minuteTask = cron.schedule('* * * * *', async () => {
    try {
      await runFixedTime(client);
    } catch (err) {
      log.error(`Fixed-time tick failed: ${err.message}`);
    }
  }, { timezone: config.timezone });

  log.info(`Scheduled periodic blast (${expr}) + per-minute fixed-time check`);
  return [task, minuteTask];
}

module.exports = { start, run, runPeriodic, runFixedTime, runChannelBlast };
