'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/database');
const embeds = require('../utils/embedFormatter');
const classifier = require('../utils/categoryClassifier');
const config = require('../utils/config');
const { relativeTime } = require('../utils/time');
const ingest = require('../services/newsIngest');

const CATEGORY_CHOICES = classifier.CATEGORY_KEYS.map((k) => ({
  name: `${classifier.meta(k).emoji} ${classifier.meta(k).label}`,
  value: k,
}));

const nepalNews = {
  data: new SlashCommandBuilder()
    .setName('nepal-news')
    .setDescription('Latest Nepal headlines')
    .addStringOption((o) => o
      .setName('category')
      .setDescription('Filter by category')
      .addChoices(...CATEGORY_CHOICES))
    .addIntegerOption((o) => o
      .setName('count')
      .setDescription('How many stories (1-5, default 3)')
      .setMinValue(1)
      .setMaxValue(5)),
  async execute(interaction) {
    await interaction.deferReply();
    const category = interaction.options.getString('category');
    const count = interaction.options.getInteger('count') || 3;

    let articles = db.getRecentArticles(category, count);

    // Cold start / stale DB: pull fresh material before answering.
    if (articles.length < count) {
      await ingest.refreshAll();
      articles = db.getRecentArticles(category, count);
    }

    if (!articles.length) {
      return interaction.editReply({
        embeds: [embeds.errorEmbed(
          'No stories yet',
          'No articles are cached. Check that the RSS sources are reachable (`/sources`), or wait for the next feed cycle.',
        )],
      });
    }

    const label = category ? classifier.meta(category).label : 'Nepal';
    await interaction.editReply({
      content: `## 🇳🇵 ${label} — latest`,
      embeds: articles.map((a, i) => embeds.newsArticleEmbed(a, { rank: i + 1 })),
    });
  },
};

const trending = {
  data: new SlashCommandBuilder()
    .setName('trending')
    .setDescription("Today's most-engaged posts from the social feed")
    .addIntegerOption((o) => o
      .setName('hours')
      .setDescription('Look-back window in hours (default 24)')
      .setMinValue(1)
      .setMaxValue(72)),
  async execute(interaction) {
    await interaction.deferReply();
    const hours = interaction.options.getInteger('hours') || 24;
    const posts = db.getTopSocialPosts(hours, 5);

    if (!posts.length) {
      return interaction.editReply({
        embeds: [embeds.errorEmbed('Nothing trending', `No social posts collected in the last ${hours}h yet.`)],
      });
    }

    await interaction.editReply({
      content: `## 🔥 Trending — last ${hours}h  (${db.countSocialPosts(hours)} posts scanned)`,
      embeds: posts.map((p) => embeds.socialPostEmbed(p, p.source_name)),
    });
  },
};

const sources = {
  data: new SlashCommandBuilder()
    .setName('sources')
    .setDescription('List the Nepali sources being tracked'),
  async execute(interaction) {
    const rows = db.getAllSources();
    if (!rows.length) {
      return interaction.reply({ content: 'No sources registered yet.', flags: MessageFlags.Ephemeral });
    }

    const lines = rows.map((s) => {
      const status = s.is_active ? '🟢' : '⚪';
      const checked = s.last_checked ? relativeTime(s.last_checked) : 'never';
      const err = s.last_error ? ` — ⚠️ ${s.last_error.slice(0, 60)}` : '';
      return `${status} **${s.source_name}** \`${s.platform}\` • checked ${checked}${err}`;
    });

    await interaction.reply({
      content: `## 📡 Tracked sources (${rows.length})\n${lines.join('\n')}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const addSource = {
  data: new SlashCommandBuilder()
    .setName('add-source')
    .setDescription('Add a new source to the real-time feed (RSS URL required)')
    .addStringOption((o) => o.setName('name').setDescription('Display name').setRequired(true))
    .addStringOption((o) => o.setName('feed').setDescription('RSS/Atom feed URL').setRequired(true))
    .addStringOption((o) => o
      .setName('platform')
      .setDescription('Where the source lives')
      .addChoices(
        { name: 'RSS', value: 'rss' },
        { name: 'Facebook', value: 'facebook' },
        { name: 'Instagram', value: 'instagram' },
      ))
    .addStringOption((o) => o.setName('page_url').setDescription('Social page URL (optional)'))
    .addStringOption((o) => o
      .setName('priority')
      .setDescription('How prominently to treat this source')
      .addChoices(
        { name: 'HIGH', value: 'HIGH' },
        { name: 'MEDIUM', value: 'MEDIUM' },
        { name: 'LOW', value: 'LOW' },
      )),
  async execute(interaction) {
    const feed = interaction.options.getString('feed').trim();
    if (!/^https?:\/\//i.test(feed)) {
      return interaction.reply({
        embeds: [embeds.errorEmbed('Invalid feed URL', 'The feed must be a full `http(s)://` URL.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const source = db.upsertSource({
      name: interaction.options.getString('name').trim(),
      platform: interaction.options.getString('platform') || 'rss',
      url: interaction.options.getString('page_url'),
      feed,
      priority: interaction.options.getString('priority') || 'MEDIUM',
    });

    await interaction.reply({
      content: `✅ Tracking **${source.source_name}** (${source.platform}). It will be polled on the next feed cycle.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const toggleSource = {
  data: new SlashCommandBuilder()
    .setName('toggle-source')
    .setDescription('Enable or disable a tracked source')
    .addStringOption((o) => o.setName('name').setDescription('Exact source name').setRequired(true))
    .addBooleanOption((o) => o.setName('active').setDescription('true = poll it, false = pause').setRequired(true)),
  async execute(interaction) {
    const name = interaction.options.getString('name').trim();
    const active = interaction.options.getBoolean('active');
    const changed = db.setSourceActive(name, active, { manual: true });

    await interaction.reply({
      content: changed
        ? `${active ? '🟢 Enabled' : '⚪ Paused'} **${name}**.`
        : `No source named **${name}**. Check \`/sources\`.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const refreshNews = {
  data: new SlashCommandBuilder()
    .setName('refresh-news')
    .setDescription('Force an immediate fetch from all news sources'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await ingest.refreshAll();
      await interaction.editReply(
        `🔄 Refresh done.\n`
        + `• RSS/social: **${result.socialStored}** new of ${result.socialSeen} seen\n`
        + `• NewsAPI: **${result.apiStored}** new of ${result.apiSeen} seen\n`
        + `• Sources with errors: ${result.errors.length ? result.errors.join(', ') : 'none'}`,
      );
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.errorEmbed('Refresh failed', err.message)] });
    }
  },
};

const newsStatus = {
  data: new SlashCommandBuilder()
    .setName('news-status')
    .setDescription('Show feed health and channel wiring'),
  async execute(interaction) {
    const wiring = [...classifier.CATEGORY_KEYS, 'social-feed'].map((c) => {
      const id = config.channelFor(c);
      return `${classifier.meta(c === 'social-feed' ? 'world' : c).emoji} \`${c}\` → ${id ? `<#${id}>` : '❌ not configured'}`;
    });

    await interaction.reply({
      content: [
        `## 📊 Tominari status`,
        `**Posts collected (24h):** ${db.countSocialPosts(24)}`,
        `**Active sources:** ${db.getActiveSources().length} / ${db.getAllSources().length}`,
        `**NewsAPI:** ${require('../utils/newsApi').isConfigured() ? '✅ configured' : '⚪ not configured (RSS only)'}`,
        `**Sports API:** ${require('../utils/sportsApi').isConfigured() ? '✅ configured' : '⚪ not configured (fallback data)'}`,
        `**Timezone:** ${config.timezone}`,
        '',
        '**Channel wiring:**',
        ...wiring,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};

module.exports = [nepalNews, trending, sources, addSource, toggleSource, refreshNews, newsStatus];
