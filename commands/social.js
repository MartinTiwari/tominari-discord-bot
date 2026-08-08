'use strict';

const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const embeds = require('../utils/embedFormatter');
const realtimeSocialFeed = require('../schedulers/realtimeSocialFeed');
const morningNewsBrief = require('../schedulers/morningNewsBrief');
const eveningNewsRecap = require('../schedulers/eveningNewsRecap');
const sportsPulse = require('../schedulers/sportsPulse');

/**
 * Manual triggers for the scheduled jobs. Restricted to members with
 * Manage Server so a stray command cannot spam every channel.
 */

const refreshFeed = {
  data: new SlashCommandBuilder()
    .setName('social-feed-refresh')
    .setDescription('Run the real-time social feed cycle right now')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await realtimeSocialFeed.run(interaction.client);
      await interaction.editReply(
        `📡 Feed cycle complete — **${result.posted}** posted, ${result.stored} new stored, ${result.seen} items seen.`
        + (result.errors.length ? `\n⚠️ Failed sources: ${result.errors.join(', ')}` : ''),
      );
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.errorEmbed('Feed refresh failed', err.message)] });
    }
  },
};

const runBrief = {
  data: new SlashCommandBuilder()
    .setName('run-brief')
    .setDescription('Manually publish a news brief to the category channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o
      .setName('which')
      .setDescription('Which brief to run')
      .setRequired(true)
      .addChoices(
        { name: 'Morning brief', value: 'morning' },
        { name: 'Evening recap', value: 'evening' },
      )),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const which = interaction.options.getString('which');
    try {
      const job = which === 'morning' ? morningNewsBrief : eveningNewsRecap;
      const result = await job.run(interaction.client);
      await interaction.editReply(
        `📰 ${which === 'morning' ? 'Morning brief' : 'Evening recap'} published — `
        + `**${result.posted}** stories across ${result.categories} categories.`
        + (result.skipped.length ? `\nSkipped (no channel): ${result.skipped.join(', ')}` : ''),
      );
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.errorEmbed('Brief failed', err.message)] });
    }
  },
};

const runSportsPulse = {
  data: new SlashCommandBuilder()
    .setName('run-sports-pulse')
    .setDescription('Manually publish the sports pulse to the sports channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await sportsPulse.run(interaction.client, 'manual');
      await interaction.editReply(`⚽ Sports pulse published — ${result.posted} embeds.`);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.errorEmbed('Sports pulse failed', err.message)] });
    }
  },
};

const help = {
  data: new SlashCommandBuilder()
    .setName('tominari-help')
    .setDescription('What Tominari can do'),
  async execute(interaction) {
    await interaction.reply({
      content: [
        '# 🇳🇵 Tominari',
        '',
        '**📰 News**',
        '`/nepal-news` latest headlines · `/trending` top social posts · `/sources` tracked outlets',
        '`/add-source` `/toggle-source` `/refresh-news` `/news-status`',
        '',
        '**⚽ Sports**',
        '`/standings` league table · `/next-match` fixtures · `/today-matches`',
        '`/add-favorite` `/remove-favorite` `/my-favorites`',
        '',
        '**💪 Health (churot-free)**',
        '`/streak` your streak · `/motivation` a blast · `/leaderboard` server ranking',
        '`/start-streak` backdate quit date · `/reset-streak` start over',
        '`/set-reminder` `/remove-reminder` `/my-reminders` `/reminder-toggle`',
        '`/reminder-language` `/reminder-tone` `/set-timezone`',
        '',
        '**🛠️ Admin** (Manage Server)',
        '`/social-feed-refresh` `/run-brief` `/run-sports-pulse`',
        '',
        '_Scheduled: social feed every 30 min · brief 6:00 AM · recap 10:00 PM · sports pulse 9 AM & 7 PM (Asia/Kathmandu)._',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};

module.exports = [refreshFeed, runBrief, runSportsPulse, help];
