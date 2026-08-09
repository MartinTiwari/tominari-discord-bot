'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/database');
const sportsApi = require('../utils/sportsApi');
const embeds = require('../utils/embedFormatter');
const config = require('../utils/config');

// Discord allows at most 25 choices per option and we track more competitions
// than that, so the picker shows the biggest ones — `resolveLeague` still
// accepts anything typed by hand, including team names.
const LEAGUE_CHOICES = Object.entries(config.sports.leagues)
  .sort(([, a], [, b]) => (a.tier ?? 2) - (b.tier ?? 2) || a.name.localeCompare(b.name))
  .slice(0, 25)
  .map(([value, l]) => ({ name: `${l.emoji} ${l.name}`, value }));

const TEAM_CHOICES = Object.entries(config.sports.teams)
  .map(([value, t]) => ({ name: t.name, value }));

const standings = {
  data: new SlashCommandBuilder()
    .setName('standings')
    .setDescription('Show a league table')
    .addStringOption((o) => o
      .setName('league')
      .setDescription('League (or a team name — I will find its league)')
      .setRequired(true)
      .addChoices(...LEAGUE_CHOICES)),
  async execute(interaction) {
    await interaction.deferReply();
    const input = interaction.options.getString('league');
    const league = sportsApi.resolveLeague(input);

    if (!league) {
      return interaction.editReply({
        embeds: [embeds.errorEmbed('Unknown league', `I don't track \`${input}\`. Try premier, laliga, bundesliga, seriea, ligue1 or ucl.`)],
      });
    }

    const { data, note } = await sportsApi.getStandings(league.key);
    if (!data.length) {
      return interaction.editReply({ embeds: [embeds.errorEmbed('No standings', note || 'No data available.')] });
    }

    await interaction.editReply({
      embeds: [embeds.standingsEmbed(league.name, data, { emoji: league.emoji, note })],
    });
  },
};

const nextMatch = {
  data: new SlashCommandBuilder()
    .setName('next-match')
    .setDescription('Upcoming fixtures for a team')
    .addStringOption((o) => o
      .setName('team')
      .setDescription('Team to look up')
      .setRequired(true)
      .setAutocomplete(true)),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = TEAM_CHOICES.filter((c) => c.name.toLowerCase().includes(focused));
    await interaction.respond(choices.slice(0, 25));
  },
  async execute(interaction) {
    await interaction.deferReply();
    const input = interaction.options.getString('team');
    const team = sportsApi.resolveTeam(input);

    if (!team) {
      return interaction.editReply({
        embeds: [embeds.errorEmbed(
          'Unknown team',
          `I don't track \`${input}\`. Tracked: ${Object.values(config.sports.teams).map((t) => t.name).join(', ')}.`,
        )],
      });
    }

    const { data, note } = await sportsApi.getUpcomingFixtures(team.key, 5);
    await interaction.editReply({ embeds: [embeds.fixtureEmbed(team.name, data, { note })] });
  },
};

const addFavorite = {
  data: new SlashCommandBuilder()
    .setName('add-favorite')
    .setDescription('Track a team so it shows up in your sports pulse')
    .addStringOption((o) => o
      .setName('team')
      .setDescription('Team to follow')
      .setRequired(true)
      .addChoices(...TEAM_CHOICES)),
  async execute(interaction) {
    const key = interaction.options.getString('team');
    const team = sportsApi.resolveTeam(key);
    if (!team) {
      return interaction.reply({
        embeds: [embeds.errorEmbed('Unknown team', `\`${key}\` is not tracked.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const added = db.addFavorite(interaction.user.id, team.key, team.name, team.league);
    await interaction.reply({
      content: added
        ? `⭐ Added **${team.name}** to your favourites.`
        : `**${team.name}** is already in your favourites.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const removeFavorite = {
  data: new SlashCommandBuilder()
    .setName('remove-favorite')
    .setDescription('Stop tracking a team')
    .addStringOption((o) => o
      .setName('team')
      .setDescription('Team to unfollow')
      .setRequired(true)
      .addChoices(...TEAM_CHOICES)),
  async execute(interaction) {
    const key = interaction.options.getString('team');
    const removed = db.removeFavorite(interaction.user.id, key);
    await interaction.reply({
      content: removed ? `🗑️ Removed from your favourites.` : 'That team was not in your favourites.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

const myFavorites = {
  data: new SlashCommandBuilder()
    .setName('my-favorites')
    .setDescription('Show the teams you follow'),
  async execute(interaction) {
    const rows = db.getFavorites(interaction.user.id);
    if (!rows.length) {
      return interaction.reply({
        content: 'You are not following any teams yet. Use `/add-favorite`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const lines = rows.map((f) => {
      const league = config.sports.leagues[f.league];
      return `⭐ **${f.team_name}** ${league ? `— ${league.emoji} ${league.name}` : ''}`;
    });
    await interaction.reply({
      content: `## Your teams\n${lines.join('\n')}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const today = {
  data: new SlashCommandBuilder()
    .setName('today-matches')
    .setDescription("Today's matches for your favourite teams"),
  async execute(interaction) {
    await interaction.deferReply();
    const favorites = db.getFavorites(interaction.user.id);
    const teams = favorites.length
      ? favorites.map((f) => f.team_key)
      : Object.keys(config.sports.teams);

    const results = await Promise.all(teams.map((t) => sportsApi.getTodayFixtures(t)));
    const fixtures = results.flatMap((r) => r.data);

    if (!fixtures.length) {
      return interaction.editReply(
        sportsApi.isConfigured()
          ? '📭 No matches today for your teams.'
          : '⚠️ Live fixtures need `SPORTS_API_KEY` in `.env` (API-Football via RapidAPI).',
      );
    }

    const lines = fixtures.map((f) => {
      const score = f.score && f.score !== '- : -' ? ` — **${f.score}**` : '';
      return `⚽ **${f.home} vs ${f.away}**${score}\n📅 ${f.date}${f.competition ? ` • 🏆 ${f.competition}` : ''}${f.status ? ` • ${f.status}` : ''}`;
    });
    await interaction.editReply(`## ⚽ Today's matches\n\n${lines.join('\n\n')}`);
  },
};

const live = {
  data: new SlashCommandBuilder()
    .setName('live')
    .setDescription('Live scores from the top leagues right now')
    .addBooleanOption((o) => o
      .setName('worldwide')
      .setDescription('Include every competition, not just the tracked ones')
      .setRequired(false)),
  async execute(interaction) {
    await interaction.deferReply();
    const all = interaction.options.getBoolean('worldwide') ?? false;
    const { data, note, totalWorldwide } = await sportsApi.getLiveMatches({ all });

    if (!data.length) {
      const extra = totalWorldwide
        ? ` ${totalWorldwide} match${totalWorldwide === 1 ? ' is' : 'es are'} live elsewhere — try \`/live worldwide:true\`.`
        : '';
      return interaction.editReply(`📭 Nothing in play in the tracked competitions right now.${extra}`);
    }

    await interaction.editReply({
      embeds: [embeds.liveScoreEmbed(data.slice(0, 20), {
        note,
        title: all ? '🔴 Live now — worldwide' : '🔴 Live now',
      })],
    });
  },
};

const matches = {
  data: new SlashCommandBuilder()
    .setName('matches')
    .setDescription("Today's card across the top leagues")
    .addStringOption((o) => o
      .setName('date')
      .setDescription('YYYY-MM-DD (defaults to today)')
      .setRequired(false)),
  async execute(interaction) {
    await interaction.deferReply();
    const date = interaction.options.getString('date');

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return interaction.editReply({
        embeds: [embeds.errorEmbed('Bad date', 'Use `YYYY-MM-DD`, for example `2026-08-22`.')],
      });
    }

    const { data, note, partial } = await sportsApi.getMatchesForDate(date);
    if (!data.length) {
      return interaction.editReply(`📭 No matches in the tracked competitions${date ? ` on ${date}` : ' today'}.`);
    }

    await interaction.editReply({
      embeds: [embeds.matchdayEmbed(data, {
        title: date ? `⚽ Matches on ${date}` : "⚽ Today's matches",
        note: partial ? `${note} — add SPORTS_API_KEY for the full worldwide card` : note,
      })],
    });
  },
};

module.exports = [standings, nextMatch, addFavorite, removeFavorite, myFavorites, today, live, matches];
