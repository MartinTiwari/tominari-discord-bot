'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/database');
const motivation = require('../utils/motivation');
const embeds = require('../utils/embedFormatter');
const config = require('../utils/config');

/**
 * Anti-smoking streak + reminder commands (tikho Nepali edition).
 * Every command is exported as its own {data, execute} pair.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function streakPayload(user, discordId, username) {
  const streak = db.getStreak(discordId);
  const badge = motivation.badgeFor(streak.days);
  const nextBadge = motivation.nextBadgeFor(streak.days);

  // Keep the persisted badge level in sync so we can detect new unlocks later.
  const level = motivation.badgeLevelFor(streak.days);
  if (level !== streak.badge_level) db.setBadgeLevel(discordId, level);

  return embeds.streakEmbed({
    days: streak.days,
    bestDays: streak.best_days,
    username,
    badge: badge ? `${badge.name} (${badge.nepali})` : null,
    nextBadge,
    progress: motivation.badgeProgress(streak.days),
    message: motivation.getMessage({
      days: streak.days,
      language: user.reminder_language,
      tone: user.reminder_tone,
    }),
  });
}

const streak = {
  data: new SlashCommandBuilder()
    .setName('streak')
    .setDescription('Show your churot-free streak, badge and progress'),
  async execute(interaction) {
    const user = db.ensureUser(interaction.user.id);
    await interaction.reply({
      embeds: [streakPayload(user, interaction.user.id, interaction.user.username)],
    });
  },
};

const motivationCmd = {
  data: new SlashCommandBuilder()
    .setName('motivation')
    .setDescription('Get a motivational blast to not smoke')
    .addStringOption((o) => o
      .setName('style')
      .setDescription('Which kind of message you want')
      .addChoices(
        { name: 'Quote (default)', value: 'quote' },
        { name: 'Story', value: 'story' },
        { name: 'Anti-relapse warning', value: 'prevention' },
        { name: 'Time-of-day nudge', value: 'nudge' },
      )),
  async execute(interaction) {
    const user = db.ensureUser(interaction.user.id);
    const { days } = db.getStreak(interaction.user.id);
    const style = interaction.options.getString('style') || 'quote';

    const message = style === 'story' ? motivation.getStory(days)
      : style === 'prevention' ? motivation.getFailurePrevention(days)
      : style === 'nudge' ? motivation.getTimeBasedNudge(user.timezone)
      : motivation.getMessage({ days, language: user.reminder_language, tone: user.reminder_tone });

    await interaction.reply({
      embeds: [embeds.motivationEmbed({ message, days, tone: user.reminder_tone })],
    });
  },
};

const setReminder = {
  data: new SlashCommandBuilder()
    .setName('set-reminder')
    .setDescription('Set a personal daily reminder time (24h HH:MM, your timezone)')
    .addStringOption((o) => o
      .setName('time')
      .setDescription('Time in HH:MM 24-hour format, e.g. 08:30')
      .setRequired(true)),
  async execute(interaction) {
    const time = interaction.options.getString('time').trim();
    if (!TIME_RE.test(time)) {
      return interaction.reply({
        embeds: [embeds.errorEmbed('Invalid time', 'Use 24-hour `HH:MM` format, e.g. `06:30` or `21:00`.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const user = db.ensureUser(interaction.user.id);
    db.setReminderTime(interaction.user.id, time);
    const all = db.getReminders(interaction.user.id).map((r) => `\`${r.reminder_time}\``).join(', ');

    await interaction.reply({
      content: `⏰ Reminder set for **${time}** (${user.timezone}).\nYour reminders: ${all}\n_I'll DM you — make sure DMs from server members are enabled._`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const removeReminder = {
  data: new SlashCommandBuilder()
    .setName('remove-reminder')
    .setDescription('Delete one of your daily reminder times')
    .addStringOption((o) => o
      .setName('time')
      .setDescription('The HH:MM time to remove')
      .setRequired(true)),
  async execute(interaction) {
    const time = interaction.options.getString('time').trim();
    const removed = db.removeReminder(interaction.user.id, time);
    await interaction.reply({
      content: removed
        ? `🗑️ Removed the **${time}** reminder.`
        : `No reminder found at **${time}**. Use \`/my-reminders\` to see what you have.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const myReminders = {
  data: new SlashCommandBuilder()
    .setName('my-reminders')
    .setDescription('Show your reminder settings'),
  async execute(interaction) {
    const user = db.ensureUser(interaction.user.id);
    const list = db.getReminders(interaction.user.id);
    const lines = [
      `**Periodic blast (every 30 min):** ${user.remind_every_30min ? '✅ on' : '❌ off'}`,
      `**Reminders enabled:** ${user.reminders_enabled ? '✅ yes' : '❌ no'}`,
      `**Language:** ${user.reminder_language}`,
      `**Tone:** ${user.reminder_tone}`,
      `**Timezone:** ${user.timezone}`,
      `**Quiet hours:** ${config.health.quietHours.start}:00 → ${config.health.quietHours.end}:00 (no messages)`,
      '',
      list.length
        ? `**Fixed times:** ${list.map((r) => `\`${r.reminder_time}\``).join(', ')}`
        : '**Fixed times:** none set — use `/set-reminder`',
    ];
    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  },
};

const resetStreak = {
  data: new SlashCommandBuilder()
    .setName('reset-streak')
    .setDescription('Reset your churot-free counter back to zero'),
  async execute(interaction) {
    const user = db.ensureUser(interaction.user.id);
    const lost = db.resetStreak(interaction.user.id);
    const message = motivation.getFailurePrevention(lost);

    await interaction.reply({
      content: `🔄 Streak reset. You had **${lost} din**.\n\n> ${message}\n\nNaya suru aajai bata. Ek din ekchoti. 💪`,
      flags: MessageFlags.Ephemeral,
    });
    void user;
  },
};

const startStreak = {
  data: new SlashCommandBuilder()
    .setName('start-streak')
    .setDescription('Backdate your quit date if you stopped before finding this bot')
    .addStringOption((o) => o
      .setName('date')
      .setDescription('Quit date in YYYY-MM-DD format')
      .setRequired(true)),
  async execute(interaction) {
    const raw = interaction.options.getString('date').trim();
    const date = new Date(`${raw}T00:00:00Z`);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(date.getTime())) {
      return interaction.reply({
        embeds: [embeds.errorEmbed('Invalid date', 'Use `YYYY-MM-DD`, e.g. `2026-06-01`.')],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (date.getTime() > Date.now()) {
      return interaction.reply({
        embeds: [embeds.errorEmbed('Future date', 'Your quit date cannot be in the future.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    db.ensureUser(interaction.user.id);
    const streakRow = db.setStreakStart(interaction.user.id, `${raw} 00:00:00`);
    await interaction.reply({
      content: `✅ Quit date set to **${raw}** — that's **${streakRow.days} din** churot-free. 🔥`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const reminderLanguage = {
  data: new SlashCommandBuilder()
    .setName('reminder-language')
    .setDescription('Choose the language for your reminders')
    .addStringOption((o) => o
      .setName('language')
      .setDescription('nepali or english')
      .setRequired(true)
      .addChoices(
        { name: 'Nepali', value: 'nepali' },
        { name: 'English', value: 'english' },
      )),
  async execute(interaction) {
    const language = interaction.options.getString('language');
    db.updateUser(interaction.user.id, { reminder_language: language });
    await interaction.reply({
      content: `🗣️ Reminder language set to **${language}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const reminderTone = {
  data: new SlashCommandBuilder()
    .setName('reminder-tone')
    .setDescription('Choose how harsh your reminders are')
    .addStringOption((o) => o
      .setName('tone')
      .setDescription('tikho (harsh street style) or soft (supportive)')
      .setRequired(true)
      .addChoices(
        { name: 'Tikho — harsh, street style', value: 'tikho' },
        { name: 'Soft — supportive', value: 'soft' },
      )),
  async execute(interaction) {
    const tone = interaction.options.getString('tone');
    db.updateUser(interaction.user.id, { reminder_tone: tone });
    await interaction.reply({
      content: tone === 'tikho'
        ? '🔥 Tone set to **tikho**. Aba naramro sunnu parcha, muji!'
        : '💙 Tone set to **soft**. Supportive messages only.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

const reminderToggle = {
  data: new SlashCommandBuilder()
    .setName('reminder-toggle')
    .setDescription('Turn the every-30-minutes motivation blast on or off')
    .addBooleanOption((o) => o
      .setName('enabled')
      .setDescription('true = DM me every 30 minutes, false = stop')
      .setRequired(true)),
  async execute(interaction) {
    const enabled = interaction.options.getBoolean('enabled');
    db.updateUser(interaction.user.id, {
      remind_every_30min: enabled ? 1 : 0,
      reminders_enabled: enabled ? 1 : 0,
    });
    const q = config.health.quietHours;
    await interaction.reply({
      content: enabled
        ? `🔔 Every-30-minute blast **enabled**. Quiet between ${q.start}:00 and ${q.end}:00 so you can sleep.\n_Make sure DMs from server members are on._`
        : '🔕 Every-30-minute blast **disabled**. Fixed-time reminders (if any) still run.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

const timezoneCmd = {
  data: new SlashCommandBuilder()
    .setName('set-timezone')
    .setDescription('Set your timezone so reminders fire at the right local time')
    .addStringOption((o) => o
      .setName('timezone')
      .setDescription('IANA name, e.g. Asia/Kathmandu, Europe/Berlin')
      .setRequired(true)),
  async execute(interaction) {
    const tz = interaction.options.getString('timezone').trim();
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });          // throws if invalid
    } catch {
      return interaction.reply({
        embeds: [embeds.errorEmbed('Unknown timezone', `\`${tz}\` is not a valid IANA timezone. Try \`Asia/Kathmandu\`.`)],
        flags: MessageFlags.Ephemeral,
      });
    }
    db.updateUser(interaction.user.id, { timezone: tz });
    await interaction.reply({ content: `🌏 Timezone set to **${tz}**.`, flags: MessageFlags.Ephemeral });
  },
};

const leaderboard = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top churot-free streaks in this server'),
  async execute(interaction) {
    await interaction.deferReply();
    const rows = db.getLeaderboard(10);
    if (!rows.length) {
      return interaction.editReply('No streaks tracked yet. Run `/streak` to join!');
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = await Promise.all(rows.map(async (r, i) => {
      const tag = await interaction.client.users.fetch(r.discord_id)
        .then((u) => u.username)
        .catch(() => `User ${r.discord_id.slice(0, 6)}`);
      return `${medals[i] || `**${i + 1}.**`} ${tag} — **${r.days} din** 🔥`;
    }));

    await interaction.editReply(`## 🏆 Churot-Free Leaderboard\n\n${lines.join('\n')}`);
  },
};

module.exports = [
  streak, motivationCmd, setReminder, removeReminder, myReminders,
  resetStreak, startStreak, reminderLanguage, reminderTone, reminderToggle,
  timezoneCmd, leaderboard,
];
