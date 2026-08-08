'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const { truncate, summarize } = require('./text');
const { relativeTime, formatDateTime } = require('./time');
const classifier = require('./categoryClassifier');

/**
 * Every embed the bot sends is built here, so colours, footers and truncation
 * rules stay consistent across schedulers and commands.
 *
 * Discord hard limits we respect: title 256, description 4096, field value 1024,
 * footer 2048, 25 fields, 6000 chars total per embed.
 */

const PRIORITY_BADGE = { HIGH: '🔴 HIGH', MEDIUM: '🟡 MEDIUM', LOW: '🟢 LOW' };

function safeUrl(url) {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Compact embed for the real-time social feed. */
function socialPostEmbed(post, sourceName) {
  const embed = new EmbedBuilder()
    .setColor(config.colorFor('social'))
    .setAuthor({ name: `📱 ${sourceName || post.source_name || 'Nepal Feed'}` })
    .setTitle(truncate(post.title || 'Untitled post', 250))
    .setDescription(summarize(post.summary || post.content || '', config.news.socialSummaryLength))
    .setTimestamp(post.posted_at ? new Date(`${String(post.posted_at).replace(' ', 'T')}Z`) : new Date());

  const url = safeUrl(post.url);
  if (url) embed.setURL(url);
  if (safeUrl(post.image_url)) embed.setThumbnail(post.image_url);

  const engagement = [];
  if (post.likes) engagement.push(`👍 ${formatCount(post.likes)}`);
  if (post.comments) engagement.push(`💬 ${formatCount(post.comments)}`);
  engagement.push(`🕐 ${relativeTime(post.posted_at || post.fetched_at)}`);

  const cat = classifier.meta(post.category || 'world');
  embed.setFooter({ text: `${cat.emoji} ${cat.label}  •  ${engagement.join('  •  ')}` });

  return embed;
}

/** Full-size embed used by the morning brief and evening recap. */
function newsArticleEmbed(article, { rank = null, headerLabel = null } = {}) {
  const category = article.category || 'world';
  const cat = classifier.meta(category);
  const priority = article.priority || 'MEDIUM';

  const embed = new EmbedBuilder()
    .setColor(config.colorFor(category))
    .setTitle(truncate(`${rank ? `${rank}. ` : ''}${article.title}`, 250))
    .setDescription(
      summarize(article.content || article.summary || article.title, config.news.briefSummaryLength)
      || '_No summary available._',
    )
    .addFields(
      { name: 'Source', value: article.source || 'Unknown', inline: true },
      { name: 'Category', value: `${cat.emoji} ${cat.label}`, inline: true },
      { name: 'Priority', value: PRIORITY_BADGE[priority] || priority, inline: true },
    );

  if (headerLabel) embed.setAuthor({ name: headerLabel });
  const url = safeUrl(article.url);
  if (url) embed.setURL(url);
  if (safeUrl(article.image_url)) embed.setImage(article.image_url);

  const published = article.published_at
    ? formatDateTime(new Date(`${String(article.published_at).replace(' ', 'T')}Z`))
    : formatDateTime(new Date());
  embed.setFooter({ text: `🇳🇵 Tominari  •  ${published}` });

  return embed;
}

/** Section header posted above a batch of brief embeds. */
function briefHeaderEmbed(category, { title, subtitle, count }) {
  const cat = classifier.meta(category);
  return new EmbedBuilder()
    .setColor(config.colorFor(category))
    .setTitle(`${cat.emoji} ${title}`)
    .setDescription(subtitle)
    .setFooter({ text: `${count} ${count === 1 ? 'story' : 'stories'}  •  ${formatDateTime()}` });
}

/** Streak card for /streak and scheduled health reminders. */
function streakEmbed({ days, bestDays, message, badge, nextBadge, progress, username }) {
  const bar = progressBar(progress);
  const embed = new EmbedBuilder()
    .setColor(config.colorFor('health'))
    .setTitle('💪 Churot-Free Streak')
    .setDescription(`## 🔥 ${days} ${days === 1 ? 'din' : 'din'} strong!\n\n> ${message}`)
    .addFields(
      { name: 'Current badge', value: badge || '— (no badge yet)', inline: true },
      { name: 'Personal best', value: `${bestDays} din`, inline: true },
    );

  if (nextBadge) {
    embed.addFields({
      name: `Next badge — ${nextBadge.days} din`,
      value: `${bar}  **${Math.round(progress * 100)}%**\n${nextBadge.days - days} din baaki cha!`,
    });
  } else {
    embed.addFields({ name: 'Status', value: '👑 Sabai badge jitis! Legend!' });
  }

  embed.setFooter({ text: username ? `${username} • Tominari` : 'Tominari' }).setTimestamp();
  return embed;
}

/** Short motivational card used by /motivation and the 30-minute blast. */
function motivationEmbed({ message, days, tone }) {
  return new EmbedBuilder()
    .setColor(config.colorFor('health'))
    .setTitle(tone === 'tikho' ? '🚬❌ Oe suna!' : '💪 Motivation')
    .setDescription(`## ${message}`)
    .setFooter({ text: `🔥 ${days} din churot-free  •  Tominari` })
    .setTimestamp();
}

/** League table. `rows` are already sorted by position. */
function standingsEmbed(leagueName, rows, { emoji = '⚽', note = null } = {}) {
  const lines = rows.slice(0, 20).map((r) => {
    const pos = String(r.position).padStart(2, ' ');
    const name = truncate(r.team, 18).padEnd(18, ' ');
    return `\`${pos} ${name} ${String(r.played).padStart(2)} ${String(r.goalDiff > 0 ? `+${r.goalDiff}` : r.goalDiff).padStart(3)} ${String(r.points).padStart(3)}\``;
  });

  const embed = new EmbedBuilder()
    .setColor(config.colorFor('sports'))
    .setTitle(`${emoji} ${leagueName} — Standings`)
    .setDescription(
      `\`\`\`\n #  TEAM                P  GD  PTS\n\`\`\`\n${lines.join('\n') || '_No data._'}`,
    )
    .setTimestamp();

  if (note) embed.setFooter({ text: note });
  return embed;
}

/** Upcoming fixture card. */
function fixtureEmbed(team, fixtures, { note = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(config.colorFor('sports'))
    .setTitle(`⚽ ${team} — Upcoming fixtures`)
    .setTimestamp();

  if (!fixtures.length) {
    embed.setDescription('_No upcoming fixtures found._');
  } else {
    for (const f of fixtures.slice(0, 5)) {
      embed.addFields({
        name: `${f.home} vs ${f.away}`,
        value: [
          `📅 ${f.date}`,
          f.competition ? `🏆 ${f.competition}` : null,
          f.venue ? `🏟️ ${f.venue}` : null,
          f.status && f.status !== 'NS' ? `📊 ${f.status}` : null,
        ].filter(Boolean).join('\n'),
      });
    }
  }
  if (note) embed.setFooter({ text: note });
  return embed;
}

/** Consistent red error card so failures never look like a crash to users. */
function errorEmbed(title, detail) {
  return new EmbedBuilder()
    .setColor(config.colorFor('error'))
    .setTitle(`⚠️ ${title}`)
    .setDescription(truncate(detail || 'Something went wrong. Please try again shortly.', 500));
}

// ------------------------------------------------------------- internals ----

function progressBar(fraction, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function formatCount(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

module.exports = {
  socialPostEmbed,
  newsArticleEmbed,
  briefHeaderEmbed,
  streakEmbed,
  motivationEmbed,
  standingsEmbed,
  fixtureEmbed,
  errorEmbed,
  progressBar,
  formatCount,
};
