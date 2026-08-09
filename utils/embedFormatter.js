'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const { truncate, summarize, pick } = require('./text');
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

const PLATFORM_BADGE = {
  facebook: '📘 Facebook',
  instagram: '📸 Instagram',
  twitter: '𝕏',
  web: '🌐',
};

/** Where a summary came from, shown so nobody mistakes a teaser for the story. */
function originNote(origin) {
  if (origin === 'body') return '📖 full story';
  if (origin === 'feed') return '📰 from the feed';
  return null;
}

/** Compact embed for the real-time social feed. */
function socialPostEmbed(post, sourceName) {
  const platform = PLATFORM_BADGE[post.platform] || null;
  const author = [`📱 ${sourceName || post.source_name || 'Nepal Feed'}`, platform]
    .filter(Boolean).join('  •  ');

  const embed = new EmbedBuilder()
    .setColor(config.colorFor('social'))
    .setAuthor({ name: author })
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
  const origin = originNote(post.summary_origin);
  if (origin) engagement.push(origin);

  const cat = classifier.meta(post.category || 'world');
  embed.setFooter({ text: `${cat.emoji} ${cat.label}  •  ${engagement.join('  •  ')}` });

  return embed;
}

/**
 * The reaction to a post that turned out to be a birthday wish, a sponsor plug
 * or festival filler rather than news.
 *
 * It still links the original and quotes a line of it, so anyone who does care
 * can go look — the joke is about the post not being news, and hiding it
 * entirely would just look like the feed was broken.
 */
function roastEmbed(post, roasts) {
  const kind = post.post_kind || 'promo';
  const opener = pick(roasts.openers[kind] || roasts.openers.promo);
  const closer = Math.random() < 0.5 ? `\n\n_${pick(roasts.closers)}_` : '';
  const quoted = truncate(post.title || post.content || '', 180);

  const embed = new EmbedBuilder()
    .setColor(config.colorFor('social'))
    .setAuthor({ name: `📱 ${post.source_name || 'RONB'}  •  ${PLATFORM_BADGE[post.platform] || 'post'}` })
    .setTitle(roasts.titles[kind] || '🙄 News hoina')
    .setDescription(`${opener}${closer}`)
    .setFooter({ text: `🗑️ filler • ${relativeTime(post.posted_at || post.fetched_at)}` })
    .setTimestamp(post.posted_at ? new Date(`${String(post.posted_at).replace(' ', 'T')}Z`) : new Date());

  if (quoted) embed.addFields({ name: 'Unle lekheko', value: `> ${quoted}` });

  const url = safeUrl(post.url);
  if (url) embed.setURL(url);
  if (safeUrl(post.image_url)) embed.setThumbnail(post.image_url);

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

/**
 * Recent results for a team. Same shape as `fixtureEmbed`, but the score leads
 * — that is the part anyone reading an evening post actually wants.
 */
function resultsEmbed(team, results, { note = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(config.colorFor('sports'))
    .setTitle(`📋 ${team} — Latest results`)
    .setTimestamp();

  if (!results.length) {
    embed.setDescription('_No recent results found._');
  } else {
    for (const r of results.slice(0, 5)) {
      embed.addFields({
        name: `${r.home}  ${r.score || 'vs'}  ${r.away}`,
        value: [
          `📅 ${r.date}`,
          r.competition ? `🏆 ${r.competition}` : null,
        ].filter(Boolean).join('\n'),
      });
    }
  }
  if (note) embed.setFooter({ text: note });
  return embed;
}

/** `Arsenal 2 : 1 Chelsea` with the scoreline emphasised, or `vs` before kick-off. */
function scoreLine(m) {
  const home = truncate(m.home, 20);
  const away = truncate(m.away, 20);
  return m.score ? `**${home}  ${m.score}  ${away}**` : `${home} vs ${away}`;
}

/** Group matches by competition, preserving the order they arrived in. */
function groupByCompetition(matches) {
  const groups = new Map();
  for (const m of matches) {
    const label = `${m.emoji || '⚽'} ${m.competition || 'Football'}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(m);
  }
  return groups;
}

/**
 * Live scoreboard — every tracked match currently being played, grouped by
 * competition with the clock next to each score.
 */
function liveScoreEmbed(matches, { note = null, title = '🔴 Live now' } = {}) {
  const embed = new EmbedBuilder()
    .setColor(config.colorFor('sports'))
    .setTitle(title)
    .setTimestamp();

  if (!matches.length) {
    embed.setDescription('_Nothing kicking off right now in the tracked competitions._');
    if (note) embed.setFooter({ text: note });
    return embed;
  }

  for (const [label, group] of groupByCompetition(matches)) {
    const lines = group.map((m) => {
      const clock = m.minute ? ` \`${m.minute}\`` : (m.status ? ` \`${m.status}\`` : '');
      return `${scoreLine(m)}${clock}`;
    });
    embed.addFields({ name: label, value: truncate(lines.join('\n'), 1000) });
  }

  if (note) embed.setFooter({ text: note });
  return embed;
}

/**
 * A day's card across competitions: results where they exist, kick-off times
 * where they do not.
 */
function matchdayEmbed(matches, { title = "⚽ Today's matches", note = null, perCompetition = 6 } = {}) {
  const embed = new EmbedBuilder()
    .setColor(config.colorFor('sports'))
    .setTitle(title)
    .setTimestamp();

  if (!matches.length) {
    embed.setDescription('_No matches in the tracked competitions today._');
    if (note) embed.setFooter({ text: note });
    return embed;
  }

  // Discord allows 25 fields; one per competition keeps us far inside that.
  for (const [label, group] of [...groupByCompetition(matches)].slice(0, 20)) {
    const lines = group.slice(0, perCompetition).map((m) => {
      const when = m.state === 'live'
        ? (m.minute ? `\`${m.minute}\`` : '`LIVE`')
        : (m.state === 'finished' ? '`FT`' : `🕐 ${kickoffTime(m)}`);
      return `${scoreLine(m)} ${when}`;
    });
    if (group.length > perCompetition) lines.push(`_+${group.length - perCompetition} more_`);
    embed.addFields({ name: label, value: truncate(lines.join('\n'), 1000) });
  }

  if (note) embed.setFooter({ text: note });
  return embed;
}

/** Kick-off in Kathmandu time — the audience is in Nepal, not in the league's country. */
function kickoffTime(m) {
  if (!m.timestamp) return m.date || 'TBD';
  const d = new Date(m.timestamp);
  if (Number.isNaN(d.getTime())) return m.date || 'TBD';
  return d.toLocaleTimeString('en-GB', {
    timeZone: config.timezone, hour: '2-digit', minute: '2-digit',
  });
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
  roastEmbed,
  newsArticleEmbed,
  briefHeaderEmbed,
  streakEmbed,
  motivationEmbed,
  standingsEmbed,
  fixtureEmbed,
  resultsEmbed,
  liveScoreEmbed,
  matchdayEmbed,
  errorEmbed,
  progressBar,
  formatCount,
};
