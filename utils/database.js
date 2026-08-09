'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const log = require('./logger')('db');

/**
 * SQLite persistence layer. Every query the bot needs lives here so schedulers
 * and commands never touch SQL directly.
 *
 * better-sqlite3 is synchronous, which is what we want: all of these queries are
 * sub-millisecond local reads and the async ceremony would only add bug surface.
 */

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tominari.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------- schema ----

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  discord_id           TEXT PRIMARY KEY,
  timezone             TEXT    NOT NULL DEFAULT 'Asia/Kathmandu',
  reminder_language    TEXT    NOT NULL DEFAULT 'nepali',
  reminder_tone        TEXT    NOT NULL DEFAULT 'tikho',
  remind_every_30min   INTEGER NOT NULL DEFAULT 0,
  reminders_enabled    INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id    TEXT    NOT NULL,
  reminder_time TEXT    NOT NULL,           -- 'HH:MM' in the user's timezone
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sent_on  TEXT,                       -- 'YYYY-MM-DD', guards against double sends
  UNIQUE(discord_id, reminder_time),
  FOREIGN KEY(discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS streaks (
  discord_id   TEXT PRIMARY KEY,
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_reset   TEXT,
  badge_level  INTEGER NOT NULL DEFAULT 0,
  best_days    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  team_key   TEXT NOT NULL,
  team_name  TEXT NOT NULL,
  league     TEXT,
  UNIQUE(discord_id, team_key),
  FOREIGN KEY(discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS social_sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name  TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL,               -- facebook | instagram | rss
  page_url     TEXT,
  feed_url     TEXT,
  priority     TEXT NOT NULL DEFAULT 'MEDIUM',
  is_active    INTEGER NOT NULL DEFAULT 1,
  last_checked TEXT,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS social_posts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id          INTEGER,
  external_post_id   TEXT NOT NULL UNIQUE,
  title              TEXT,
  content            TEXT,
  summary            TEXT,
  url                TEXT,
  image_url          TEXT,
  category           TEXT,
  posted_at          TEXT,
  fetched_at         TEXT NOT NULL DEFAULT (datetime('now')),
  channel_id         TEXT,
  discord_message_id TEXT,
  likes              INTEGER DEFAULT 0,
  comments           INTEGER DEFAULT 0,
  FOREIGN KEY(source_id) REFERENCES social_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS news_articles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id      TEXT UNIQUE,
  title            TEXT NOT NULL,
  content          TEXT,
  source           TEXT,
  category         TEXT,
  url              TEXT,
  image_url        TEXT,
  published_at     TEXT,
  fetch_time       TEXT NOT NULL DEFAULT (datetime('now')),
  priority         TEXT DEFAULT 'MEDIUM',
  sent_to_discord  INTEGER NOT NULL DEFAULT 0,
  message_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_social_posts_fetched ON social_posts(fetched_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_source  ON social_posts(source_id);
CREATE INDEX IF NOT EXISTS idx_news_category        ON news_articles(category, sent_to_discord);
CREATE INDEX IF NOT EXISTS idx_news_published       ON news_articles(published_at);
`);

/**
 * Additive migrations for databases created by an earlier version. SQLite has
 * no "ADD COLUMN IF NOT EXISTS", so we check the table info first.
 */
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (exists) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info(`Migrated: ${table}.${column} added`);
}

// What kind of post this is — 'news' or a filler kind from postClassifier.
addColumn('social_posts', 'post_kind', `TEXT NOT NULL DEFAULT 'news'`);
// Which platform a RONB post came from, so the embed can label it FB vs IG.
addColumn('social_posts', 'platform', 'TEXT');
// Where the summary text came from: 'body' (article page), 'feed' or 'title'.
addColumn('social_posts', 'summary_origin', 'TEXT');
// Set when a person toggled this source by hand, so seeding leaves it alone.
addColumn('social_sources', 'manual_override', 'INTEGER NOT NULL DEFAULT 0');

// ----------------------------------------------------------------- users ----

const stmts = {
  insertUser: db.prepare(`
    INSERT INTO users (discord_id) VALUES (?)
    ON CONFLICT(discord_id) DO NOTHING`),
  getUser: db.prepare(`SELECT * FROM users WHERE discord_id = ?`),
  allReminderUsers: db.prepare(`
    SELECT * FROM users WHERE reminders_enabled = 1 AND remind_every_30min = 1`),
};

/** Create the user row if it does not exist yet, then return it. */
function ensureUser(discordId) {
  stmts.insertUser.run(discordId);
  const user = stmts.getUser.get(discordId);
  ensureStreak(discordId);
  return user;
}

function getUser(discordId) {
  return stmts.getUser.get(discordId) || null;
}

const ALLOWED_USER_FIELDS = new Set([
  'timezone',
  'reminder_language',
  'reminder_tone',
  'remind_every_30min',
  'reminders_enabled',
]);

/** Patch one or more user preference columns. Unknown keys are rejected. */
function updateUser(discordId, patch) {
  ensureUser(discordId);
  const keys = Object.keys(patch).filter((k) => ALLOWED_USER_FIELDS.has(k));
  if (!keys.length) return getUser(discordId);
  const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${setSql} WHERE discord_id = @discord_id`)
    .run({ ...patch, discord_id: discordId });
  return getUser(discordId);
}

/** Users opted into the recurring (every-30-min) reminder blast. */
function getUsersForPeriodicReminder() {
  return stmts.allReminderUsers.all();
}

// --------------------------------------------------------------- streaks ----

function ensureStreak(discordId) {
  db.prepare(`
    INSERT INTO streaks (discord_id, started_at) VALUES (?, datetime('now'))
    ON CONFLICT(discord_id) DO NOTHING`).run(discordId);
}

/** Streak row plus a derived `days` count (whole days since started_at). */
function getStreak(discordId) {
  ensureUser(discordId);
  const row = db.prepare(`SELECT * FROM streaks WHERE discord_id = ?`).get(discordId);
  if (!row) return null;
  const started = new Date(`${row.started_at.replace(' ', 'T')}Z`);
  const days = Math.max(0, Math.floor((Date.now() - started.getTime()) / 86_400_000));
  if (days > row.best_days) {
    db.prepare(`UPDATE streaks SET best_days = ? WHERE discord_id = ?`).run(days, discordId);
    row.best_days = days;
  }
  return { ...row, days };
}

/** Restart the clock at zero. Returns the streak length that was lost. */
function resetStreak(discordId) {
  const previous = getStreak(discordId);
  db.prepare(`
    UPDATE streaks
       SET started_at = datetime('now'), last_reset = datetime('now'), badge_level = 0
     WHERE discord_id = ?`).run(discordId);
  return previous ? previous.days : 0;
}

/** Backdate the streak start, for users who quit before they found the bot. */
function setStreakStart(discordId, isoDate) {
  ensureUser(discordId);
  db.prepare(`UPDATE streaks SET started_at = ? WHERE discord_id = ?`)
    .run(isoDate, discordId);
  return getStreak(discordId);
}

function setBadgeLevel(discordId, level) {
  db.prepare(`UPDATE streaks SET badge_level = ? WHERE discord_id = ?`).run(level, discordId);
}

/** Top streaks across the server, for the leaderboard command. */
function getLeaderboard(limit = 10) {
  return db.prepare(`
    SELECT discord_id, started_at,
           CAST((julianday('now') - julianday(started_at)) AS INTEGER) AS days
      FROM streaks
     ORDER BY days DESC
     LIMIT ?`).all(limit);
}

// ------------------------------------------------------------- reminders ----

function setReminderTime(discordId, time) {
  ensureUser(discordId);
  db.prepare(`
    INSERT INTO reminders (discord_id, reminder_time, enabled) VALUES (?, ?, 1)
    ON CONFLICT(discord_id, reminder_time) DO UPDATE SET enabled = 1`)
    .run(discordId, time);
  updateUser(discordId, { reminders_enabled: 1 });
}

function getReminders(discordId) {
  return db.prepare(`SELECT * FROM reminders WHERE discord_id = ? ORDER BY reminder_time`)
    .all(discordId);
}

function removeReminder(discordId, time) {
  return db.prepare(`DELETE FROM reminders WHERE discord_id = ? AND reminder_time = ?`)
    .run(discordId, time).changes;
}

/** Enabled fixed-time reminders joined with the owning user's preferences. */
function getDueReminders() {
  return db.prepare(`
    SELECT r.*, u.timezone, u.reminder_language, u.reminder_tone
      FROM reminders r
      JOIN users u ON u.discord_id = r.discord_id
     WHERE r.enabled = 1`).all();
}

function markReminderSent(id, dateKey) {
  db.prepare(`UPDATE reminders SET last_sent_on = ? WHERE id = ?`).run(dateKey, id);
}

// ------------------------------------------------------------- favorites ----

function addFavorite(discordId, teamKey, teamName, league) {
  ensureUser(discordId);
  return db.prepare(`
    INSERT INTO favorites (discord_id, team_key, team_name, league) VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id, team_key) DO NOTHING`)
    .run(discordId, teamKey, teamName, league).changes > 0;
}

function removeFavorite(discordId, teamKey) {
  return db.prepare(`DELETE FROM favorites WHERE discord_id = ? AND team_key = ?`)
    .run(discordId, teamKey).changes;
}

function getFavorites(discordId) {
  return db.prepare(`SELECT * FROM favorites WHERE discord_id = ?`).all(discordId);
}

// -------------------------------------------------------- social sources ----

/**
 * Insert-or-update a source definition from data/socialSources.json.
 * `is_active` is set only on insert, so a later `/toggle-source` choice is not
 * overwritten every time the bot restarts and re-seeds.
 */
function upsertSource(source) {
  db.prepare(`
    INSERT INTO social_sources (source_name, platform, page_url, feed_url, priority, is_active)
    VALUES (@name, @platform, @url, @feed, @priority, @active)
    ON CONFLICT(source_name) DO UPDATE SET
      platform = excluded.platform,
      page_url = excluded.page_url,
      feed_url = excluded.feed_url,
      priority = excluded.priority`)
    .run({
      name: source.name,
      platform: source.platform,
      url: source.url || null,
      feed: source.feed || null,
      priority: source.priority || 'MEDIUM',
      active: source.active === false ? 0 : 1,
    });
  return db.prepare(`SELECT * FROM social_sources WHERE source_name = ?`).get(source.name);
}

function getActiveSources() {
  return db.prepare(`SELECT * FROM social_sources WHERE is_active = 1 ORDER BY priority, id`).all();
}

function getAllSources() {
  return db.prepare(`SELECT * FROM social_sources ORDER BY id`).all();
}

/**
 * Enable or disable a source.
 *
 * `manual` marks the row as deliberately set by a person via /toggle-source,
 * which stops the seeder from flipping it back on the next restart. Seeding and
 * other automatic paths leave the flag alone.
 */
function setSourceActive(name, active, { manual = false } = {}) {
  const sql = manual
    ? `UPDATE social_sources SET is_active = ?, manual_override = 1 WHERE source_name = ?`
    : `UPDATE social_sources SET is_active = ? WHERE source_name = ?`;
  return db.prepare(sql).run(active ? 1 : 0, name).changes;
}

function touchSource(id, errorMessage = null) {
  db.prepare(`UPDATE social_sources SET last_checked = datetime('now'), last_error = ? WHERE id = ?`)
    .run(errorMessage, id);
}

// ---------------------------------------------------------- social posts ----

function socialPostExists(externalId) {
  return !!db.prepare(`SELECT 1 FROM social_posts WHERE external_post_id = ?`).get(externalId);
}

/** Returns the new row id, or null when the post was already stored. */
function insertSocialPost(post) {
  const info = db.prepare(`
    INSERT INTO social_posts
      (source_id, external_post_id, title, content, summary, url, image_url,
       category, posted_at, likes, comments, post_kind, platform, summary_origin)
    VALUES
      (@source_id, @external_post_id, @title, @content, @summary, @url, @image_url,
       @category, @posted_at, @likes, @comments, @post_kind, @platform, @summary_origin)
    ON CONFLICT(external_post_id) DO NOTHING`)
    .run({
      source_id: post.source_id ?? null,
      external_post_id: post.external_post_id,
      title: post.title ?? null,
      content: post.content ?? null,
      summary: post.summary ?? null,
      url: post.url ?? null,
      image_url: post.image_url ?? null,
      category: post.category ?? 'world',
      posted_at: post.posted_at ?? null,
      likes: post.likes ?? 0,
      comments: post.comments ?? 0,
      post_kind: post.post_kind ?? 'news',
      platform: post.platform ?? null,
      summary_origin: post.summary_origin ?? null,
    });
  return info.changes ? info.lastInsertRowid : null;
}

function markSocialPostSent(id, channelId, messageId) {
  db.prepare(`UPDATE social_posts SET channel_id = ?, discord_message_id = ? WHERE id = ?`)
    .run(channelId, messageId, id);
}

/**
 * Highest-engagement posts from the last N hours, newest first on ties.
 * Filler (birthday wishes, sponsor plugs) is excluded — it gets roasted in the
 * live feed and must never be promoted into a news brief.
 */
function getTopSocialPosts(hours = 24, limit = 10, category = null) {
  const where = category ? `AND category = @category` : '';
  return db.prepare(`
    SELECT sp.*, ss.source_name
      FROM social_posts sp
      LEFT JOIN social_sources ss ON ss.id = sp.source_id
     WHERE sp.fetched_at >= datetime('now', @window)
       AND sp.post_kind = 'news' ${where}
     ORDER BY (sp.likes + sp.comments * 2) DESC, sp.posted_at DESC
     LIMIT @limit`)
    .all({ window: `-${hours} hours`, limit, category });
}

function countSocialPosts(hours = 24) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM social_posts WHERE fetched_at >= datetime('now', ?)`)
    .get(`-${hours} hours`).n;
}

// --------------------------------------------------------- news articles ----

/** Returns the new row id, or null when the article was already stored. */
function insertArticle(article) {
  const info = db.prepare(`
    INSERT INTO news_articles
      (external_id, title, content, source, category, url, image_url, published_at, priority)
    VALUES
      (@external_id, @title, @content, @source, @category, @url, @image_url, @published_at, @priority)
    ON CONFLICT(external_id) DO NOTHING`)
    .run({
      external_id: article.external_id,
      title: article.title,
      content: article.content ?? null,
      source: article.source ?? null,
      category: article.category ?? 'world',
      url: article.url ?? null,
      image_url: article.image_url ?? null,
      published_at: article.published_at ?? null,
      priority: article.priority ?? 'MEDIUM',
    });
  return info.changes ? info.lastInsertRowid : null;
}

/** Unsent articles for a category, best-priority and newest first. */
function getUnsentArticles(category, limit = 3, maxAgeHours = 24) {
  return db.prepare(`
    SELECT * FROM news_articles
     WHERE category = @category
       AND sent_to_discord = 0
       AND (published_at IS NULL OR published_at >= datetime('now', @window))
     ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
              COALESCE(published_at, fetch_time) DESC
     LIMIT @limit`)
    .all({ category, limit, window: `-${maxAgeHours} hours` });
}

/** Recent articles regardless of send state — used by /nepal-news. */
function getRecentArticles(category = null, limit = 5, maxAgeHours = 48) {
  const where = category ? `AND category = @category` : '';
  return db.prepare(`
    SELECT * FROM news_articles
     WHERE (published_at IS NULL OR published_at >= datetime('now', @window)) ${where}
     ORDER BY COALESCE(published_at, fetch_time) DESC
     LIMIT @limit`)
    .all({ category, limit, window: `-${maxAgeHours} hours` });
}

function markArticleSent(id, messageId) {
  db.prepare(`UPDATE news_articles SET sent_to_discord = 1, message_id = ? WHERE id = ?`)
    .run(messageId, id);
}

/** Drop rows older than the retention window so the file stays small. */
function pruneOldRows(days = 30) {
  const a = db.prepare(`DELETE FROM news_articles WHERE fetch_time < datetime('now', ?)`)
    .run(`-${days} days`).changes;
  const b = db.prepare(`DELETE FROM social_posts WHERE fetched_at < datetime('now', ?)`)
    .run(`-${days} days`).changes;
  if (a || b) log.info(`Pruned ${a} articles and ${b} social posts older than ${days} days`);
  return a + b;
}

log.info(`SQLite ready at ${DB_PATH}`);

module.exports = {
  db,
  ensureUser, getUser, updateUser, getUsersForPeriodicReminder,
  getStreak, resetStreak, setStreakStart, setBadgeLevel, getLeaderboard,
  setReminderTime, getReminders, removeReminder, getDueReminders, markReminderSent,
  addFavorite, removeFavorite, getFavorites,
  upsertSource, getActiveSources, getAllSources, setSourceActive, touchSource,
  socialPostExists, insertSocialPost, markSocialPostSent, getTopSocialPosts, countSocialPosts,
  insertArticle, getUnsentArticles, getRecentArticles, markArticleSent,
  pruneOldRows,
};
