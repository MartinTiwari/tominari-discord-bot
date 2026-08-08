# Tominari 🇳🇵

A Discord bot for Nepal news, football tracking, and *tikho* anti-smoking reminders.

- **Real-time social feed** — polls 14 Nepali outlets every 30 minutes and posts anything new
- **Morning brief (6:00) & evening recap (22:00)** — detailed stories across 6 category channels
- **Sports** — standings, fixtures and favourites for Bayern, Barça, Real Madrid and the top 5 leagues
- **Health** — streak tracking with brutal Nepali motivation every 30 minutes

All times are Nepal time (`Asia/Kathmandu`, UTC+05:45).

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

Node 20+ is required.

### 2. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**
2. **Bot** tab → **Reset Token** → copy into `DISCORD_TOKEN`
3. **General Information** → copy the Application ID into `DISCORD_CLIENT_ID`
4. Invite the bot with the `bot` and `applications.commands` scopes and the
   *Send Messages* / *Embed Links* permissions

No privileged intents are needed — the bot only uses slash commands and DMs.

### 3. Create the channels

Make one channel per category and copy the IDs (right-click → *Copy Channel ID*
with Developer Mode on) into `config.json` → `channels`, or into `.env`:

| Category | `.env` variable |
| --- | --- |
| politics | `POLITICS_CHANNEL_ID` |
| business | `BUSINESS_CHANNEL_ID` |
| sports | `SPORTS_CHANNEL_ID` |
| tech | `TECH_CHANNEL_ID` |
| entertainment | `ENTERTAINMENT_CHANNEL_ID` |
| world | `WORLD_CHANNEL_ID` |
| social-feed | `SOCIAL_FEED_CHANNEL_ID` |

Env vars win over `config.json`. Any category left blank is simply skipped
(the bot logs a warning at startup rather than failing).

### 4. API keys (both optional)

- `NEWSAPI_KEY` — <https://newsapi.org>, free tier 100 req/day. Without it the
  bot runs on RSS feeds alone.
- `SPORTS_API_KEY` — RapidAPI [API-Football](https://rapidapi.com/api-sports/api/api-football).
  Without it `/standings` and `/next-match` serve the bundled offline snapshot
  and label it as such.

### 5. Register commands and run

```bash
npm run deploy   # push slash commands to Discord
npm start        # run the bot
```

Set `DISCORD_GUILD_ID` in `.env` while developing — guild commands appear
instantly, global ones take up to an hour.

---

## Commands

### News
| Command | What it does |
| --- | --- |
| `/nepal-news [category] [count]` | Latest stories, optionally filtered |
| `/trending [hours]` | Most-covered stories in a window |
| `/sources` | Tracked outlets and when each was last checked |
| `/add-source <name> <feed> …` | Track a new RSS/social source |
| `/toggle-source <name> <active>` | Pause or resume a source |
| `/refresh-news` | Force an ingest cycle |
| `/news-status` | Article counts, last fetch, API key status |

### Sports
| Command | What it does |
| --- | --- |
| `/standings <league>` | League table |
| `/next-match <team>` | Upcoming fixtures |
| `/add-favorite <team>` / `/remove-favorite <team>` | Manage your teams |
| `/my-favorites` | Your tracked teams |
| `/today-matches` | Everything kicking off today |

### Health
| Command | What it does |
| --- | --- |
| `/streak` | Days churot-free, next badge, progress |
| `/motivation [style]` | One-off motivational blast |
| `/start-streak [date]` | Begin (or backdate) your streak |
| `/reset-streak` | Back to zero |
| `/set-reminder <time>` / `/remove-reminder <time>` / `/my-reminders` | Fixed-time DM reminders |
| `/reminder-language <nepali\|english>` | Language |
| `/reminder-tone <soft\|tikho>` | Politeness, or lack of it |
| `/reminder-toggle <enabled>` | Mute everything |
| `/set-timezone <timezone>` | Your own timezone |
| `/leaderboard` | Longest streaks in the server |

### Admin / misc
`/social-feed-refresh`, `/run-brief <which>`, `/run-sports-pulse`, `/tominari-help`

Badges land at 7, 30, 60, 90 and 365 days. Reminders respect quiet hours
(23:00–06:00 by default, `config.json` → `health.quietHours`).

### Reminders without opting in

Every 30 minutes the bot posts a tikho blast to **#churot-free** (`HEALTH_CHANNEL_ID`)
regardless of whether anyone has run a command. Set `HEALTH_MENTION_USER_ID` and
the post `@mentions` that person and uses their streak, language and tone; leave
it blank for a generic message with no ping.

The DM paths are the opt-in layer on top: `/reminder-toggle true` for 30-minute
DMs, `/set-reminder 08:30` for fixed times. Run `/start-streak` so the day count
is real rather than 0.

---

## Running it 24/7

`scripts/run-forever.ps1` supervises the bot: if `node bot.js` exits it starts
again, backing off only when the bot dies immediately (a crash loop) and
resetting once it has stayed up a minute. Output goes to `logs/tominari-<date>.log`,
pruned after 14 days.

A Windows scheduled task named **Tominari Bot** runs that supervisor at logon:

```powershell
Get-ScheduledTask -TaskName "Tominari Bot"      # Ready / Running
Start-ScheduledTask -TaskName "Tominari Bot"
Stop-ScheduledTask  -TaskName "Tominari Bot"    # also kill node: Get-Process node | Stop-Process
Get-Content logs\tominari-*.log -Tail 30 -Wait  # follow the log
```

It runs as your user at logon rather than as a service, because a service that
starts before login needs your account password stored in Task Scheduler. The
practical limit: **the bot is up only while the machine is on and you're logged
in.** Sleep-on-AC is already disabled, so a plugged-in desktop is effectively
always-on; a laptop that sleeps or shuts down is not. For genuine 24/7,
deploy to a host (Railway, Fly, a VPS) — the code needs no changes, just the
same `.env`.

### Posting on demand

`scripts/postnow.js` fires the scheduled jobs immediately, for real, over plain
REST — no gateway session, so it is safe to run while the bot is up:

```bash
node scripts/postnow.js                    # feed + brief + sports
node scripts/postnow.js brief              # one job
node scripts/postnow.js feed recap health  # any combination
```

Useful to seed the channels right after setup instead of waiting for a cron tick.

## Testing without Discord

```bash
npm run selftest             # 49 offline unit checks
npm run selftest -- --network  # also hits the live feeds
npm run dryrun               # run every scheduled job against a mock client
npm run dryrun -- brief      # just the morning brief (feed|brief|recap|sports|health)
```

`dryrun` prints exactly what would be posted, to which channel, and sends
nothing — no token required.

---

## Configuration

`config.json` holds everything that isn't a secret:

- `schedules` — cron expressions for all six jobs (Nepal time)
- `news` — stories per category, summary lengths, max article age
- `health` — default language/tone, quiet hours, badge milestones
- `sports` — leagues, teams and their API IDs
- `colors` — per-category embed colours

`data/socialSources.json` is the source list, seeded into SQLite on first run;
after that, edit sources with `/add-source` and `/toggle-source`.

`data/nepaliQuotes.json` holds the reminder lines — four sets (nepali/english ×
soft/tikho) plus milestone messages. `{days}` in a quote is replaced with the
current streak.

## Layout

```
bot.js                 client, interaction router, graceful shutdown
deploy-commands.js     slash-command registration
commands/              news, sports, health, social
schedulers/            six cron jobs (social feed, brief, recap, sports ×2, health)
scrapers/              RSS, Facebook, Instagram, deduplicator
services/              newsIngest (fetch → classify → store), publisher (send → record)
utils/                 database, config, embeds, http, classifier, time, text, logger
data/                  sources, categories, quotes, offline sports data, SQLite file
scripts/               selftest.js, dryrun.js
```

Fetching never blocks posting: every source is tried independently, failures are
logged and the cycle continues with whatever came back. Sports falls back to
`data/sportsFallback.json`, news falls back to RSS, and reminders work fully
offline.

## Notes

- Facebook and Instagram have no usable public API without business approval, so
  those sources resolve to each outlet's RSS feed. Set `FB_PAGE_ACCESS_TOKEN`
  for Graph API access, or `ENABLE_PUPPETEER_SCRAPER=true` for the experimental
  headless fallback (`puppeteer` is an optional dependency).
- SQLite lives at `DB_PATH` (`./data/tominari.db`) — back that file up to keep
  streaks and dedupe history.
- Deduplication is two-layer: a `UNIQUE` external post ID, plus title similarity
  so the same story from five outlets posts once.
