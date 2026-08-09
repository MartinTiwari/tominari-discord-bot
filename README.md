# Tominari 🇳🇵

A Discord bot for Nepal news, football tracking, and *tikho* anti-smoking reminders.

- **Real-time social feed** — RONB plus five established Nepali newsrooms, polled every
  30 minutes. Each story is **summarised from the article page**, not just headlined, so
  you get the gist without opening the link. Birthday wishes and sponsor plugs get
  [roasted instead of reported](#news-vs-filler).
- **Morning brief (6:00) & evening recap (22:00)** — detailed stories across 6 category channels
- **Sports** — live standings, fixtures and results for Bayern, Barça, Real Madrid and the
  top 5 leagues. **No API key needed.**
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

### 4. API keys (all optional)

Nothing here is required — news and sports are both live out of the box.

- `NEWSAPI_KEY` — <https://newsapi.org>, free tier 100 req/day. Without it the
  bot runs on RSS feeds alone.
- `SPORTS_API_KEY` — RapidAPI [API-Football](https://rapidapi.com/api-sports/api/api-football).
  Sports already run live through TheSportsDB, which needs no key; add this one
  only if you want full 18/20-team tables instead of the top 5.
- **RONB access** — see [Reading RONB](#reading-ronb) below.

### Reading RONB

[Routine of Nepal Banda](https://www.facebook.com/officialroutineofnepalbanda) is the
fastest source in Nepal for bandas, chakka jams and road closures, so it drives the
social feed. Neither Facebook nor Instagram will serve its posts to a server without
credentials, so pick one route in `.env`:

| Route | What it needs | Notes |
|---|---|---|
| Meta Graph API | `FB_PAGE_ACCESS_TOKEN` + `RONB_FB_PAGE_ID` / `IG_USER_ID` | Best quality. Meta grants tokens only for accounts you control. |
| RSS bridge | `RONB_FB_FEED` / `RONB_IG_FEED` | Easiest. Make a feed at rss.app, fetchrss.com or your own RSSHub and paste the URL. |
| X embed timeline | nothing — on by default | Reads [@RONBupdates](https://x.com/RONBupdates). Dormant since Sept 2025, so it usually returns nothing. Disable with `RONB_DISABLE_X=true`. |
| Their own site | nothing — on by default | `routineofnepalbanda.com` is currently HTTP 522. Left enabled so it resumes on its own. |

With none of them working the feed still runs on the newspapers; you just lose the
banda alerts. Every route is polled, deduplicated against the others, and anything
older than `news.maxAgeHours` is dropped so a route coming back online can't dump
its archive into the channel.

### News vs filler

RONB posts birthday wishes and sponsored plugs alongside real news.
`utils/postClassifier.js` sorts them by keyword (English, Nepali and romanised), and
the feed treats them differently:

- **News** → summarised properly and posted as a story.
- **Filler** → a one-line roast from `data/ronbRoasts.json`, capped at
  `ronb.maxRoastsPerCycle` per cycle, and never promoted into a brief.

A post that merely mentions a brand or a festival still counts as news — "Ncell
announces free data after the quake" is reporting, not an ad. Turn roasting off with
`ronb.roastNonNews: false` in `config.json`.

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
always-on; a laptop that sleeps or shuts down is not.

### Why it can show offline even when the process is running

`discord.js` reconnects on its own, but a shard can end up permanently stuck —
an unresumable session, or a half-open socket. The process stays alive, every
cron keeps firing into the void, and nothing restarts it because nothing
crashed. So `bot.js` runs a watchdog: if the gateway has not been READY for
`GATEWAY_GRACE_MS` (default 5 minutes) it exits non-zero and lets the
supervisor start a clean process. Presence is also re-applied on
`ShardResume`, since a resumed session otherwise leaves the bot connected and
working but greyed out in the member list.

### Deploying to Fly.io

For real 24/7 the bot has to live off your PC. `fly.toml` is set up for it —
a worker with no HTTP port, one machine, and a volume so the SQLite database
survives redeploys.

```bash
# One-time: install flyctl, then sign in (opens a browser)
fly auth login

fly launch --no-deploy --copy-config          # claims the app name
fly volumes create tominari_data --size 1 --region sin
fly secrets set DISCORD_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_GUILD_ID=...
fly deploy

fly logs                                       # follow it
fly apps restart tominari-bot
```

Channel IDs live in `config.json`, so `DISCORD_TOKEN` is the only secret that
actually has to be set. Add `NEWSAPI_KEY`, `SPORTS_API_KEY` or any `RONB_*`
route the same way.

Two things that will bite if changed: do not add an `[http_service]` block —
Fly would health-check a port the bot never opens and kill the machine on a
loop — and do not scale past one machine, because each instance runs its own
cron and they share no lock, so every brief would post twice.

Once Fly is live, stop the local copy or it will double-post:

```powershell
Stop-ScheduledTask -TaskName "Tominari Bot"
Disable-ScheduledTask -TaskName "Tominari Bot"
Get-Process node | Stop-Process -Force
```

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
scrapers/              RSS, RONB (multi-route), Facebook, Instagram, deduplicator
services/              newsIngest (fetch → classify → summarise → store),
                       summarizer (article body → extractive summary),
                       publisher (send → record)
utils/                 database, config, embeds, http, time, text, logger,
                       categoryClassifier (which channel), postClassifier (news vs filler),
                       sportsApi (API-Football) + sportsDb (TheSportsDB, keyless)
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
