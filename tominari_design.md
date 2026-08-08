# Tominari Discord Bot - Design Specification

## Overview
**Tominari** is a multi-purpose Discord bot focused on:
1. Daily Nepal news digest
2. Sports tracking (Bayern Munich, Barcelona, Real Madrid, top leagues)
3. Health reminders (anti-smoking motivation)

---

## Architecture

### Tech Stack
- **Runtime:** Node.js + discord.js v14
- **Database:** SQLite (local) / PostgreSQL (cloud)
- **Scheduling:** node-cron
- **APIs:**
  - NewsAPI (global news + Nepal-specific)
  - ESPN/RapidAPI (sports scores, standings)
  - OpenWeather (optional: weather with reminders)
- **Hosting:** Railway, Render, or self-hosted

### Core Modules
```
tominari/
├── commands/
│   ├── news.js              (Nepal news digest)
│   ├── sports.js            (League standings)
│   ├── health.js            (Reminders)
│   └── social.js            (Manual social feed check)
├── schedulers/
│   ├── realtimeSocialFeed.js (Every 30-60 mins - social media scraping)
│   ├── morningNewsBrief.js   (6:00 AM - detailed news)
│   ├── eveningNewsBrief.js   (10:00 PM - day recap)
│   ├── sportsPulse.js        (Match days, 2x daily)
│   └── healthReminder.js     (Randomized throughout day)
├── scrapers/
│   ├── facebookScraper.js    (Facebook pages + Graph API)
│   ├── instagramScraper.js   (Instagram pages)
│   ├── newsScraper.js        (RSS feeds + NewsAPI)
│   └── rssParser.js          (RSS feed parsing)
├── utils/
│   ├── newsApi.js
│   ├── sportsApi.js
│   ├── database.js
│   ├── embedFormatter.js     (Format different embed types)
│   └── deduplicator.js       (Prevent duplicate posts)
├── data/
│   ├── socialSources.json    (List of Nepali sources to track)
│   └── newsCategories.json   (Category mappings)
├── config.json
└── bot.js
```

---

## Features

### 1. **Multi-Channel Nepal News System** 📰

#### **News Channels by Category:**
```
#📰 politics          → Political news
#💼 business         → Business & economy
#🏆 sports           → Sports updates
#💻 tech             → Technology & startups
#🎬 entertainment    → Entertainment & culture
#🌍 world            → International
#📢 social-feed      → Real-time social media posts
```

#### **Real-Time Social Media Integration:**

**Integrated Sources (Polling every 30-60 mins):**
- RONB (Instagram/Facebook)
- Kathmandu Post (Facebook)
- The Himalayan Times (Facebook)
- eKantipur (Facebook)
- Setopati (Facebook)
- Nepal24Hours (Facebook)
- My Republica (Facebook)

**Implementation:**
- Use Puppeteer/Cheerio for Facebook scraping (or Meta Graph API)
- Instagram scraping via instagrapi library (Python wrapper or Node adapter)
- Track post IDs to avoid duplicates
- Store last checked timestamp per source

**Real-Time Behavior:**
- Every 30-60 mins: Check for new posts
- If new post found: Extract content
- Post to relevant channel (#📢 social-feed)
- Format: Thumbnail + headline + 150-char summary + source link

**Example Real-Time Post:**
```
📱 RONB posted just now:

"Nepal's new startup ecosystem gaining momentum in 2026..."

Summary: A brief 150-character summary of the full post...

🔗 Read full post | 👍 23K likes | 💬 156 comments | 🕐 2 mins ago
```

#### **Scheduled Detailed News (6 AM & 10 PM):**

**6:00 AM IST** - Morning Brief:
- Post to #📰 politics, #💼 business, #🏆 sports, #💻 tech
- Format: **Detailed embeds** with:
  - Full headline + summary (300+ chars)
  - Source attribution
  - Category + priority flag
  - Link to full article
- Top 3 stories per category

**10:00 PM IST** - Evening Recap:
- Same format as morning
- Day's top stories across all categories
- Trending topics summary
- "What you missed today" format

**Example Detailed Post:**
```
📌 Top Story

🇳🇵 "Nepal Infrastructure Ministry Launches Smart City Initiative"

Source: Kathmandu Post | Business | Priority: HIGH

Full Summary:
The Ministry of Infrastructure announced a comprehensive smart city 
development plan covering Kathmandu, Pokhara, and Birgunj. The initiative 
aims to integrate IoT, renewable energy, and digital governance...

🔗 Read Full Article: [link]
📊 Related: Urban Development | Government Policy
💬 Discussion Thread: [open-thread]
```

#### **Data Sources:**

**Primary:**
1. Facebook Graph API (Meta - requires business approval)
2. RSS Feeds (Kathmandu Post, eKantipur, MyRepublica)
3. NewsAPI.org (Nepal-specific queries)

**Secondary (Web Scraping):**
- Puppeteer + Cheerio for Facebook (if API unavailable)
- Instagram scraping (instagrapi or similar)

**Database Tracking:**
```sql
CREATE TABLE social_sources (
  id INTEGER PRIMARY KEY,
  source_name VARCHAR(100),
  platform VARCHAR(20), -- facebook, instagram
  page_url TEXT,
  last_checked TIMESTAMP,
  post_count_today INTEGER
);

CREATE TABLE social_posts (
  id INTEGER PRIMARY KEY,
  source_id INTEGER,
  external_post_id TEXT UNIQUE,
  title TEXT,
  content TEXT,
  summary TEXT,
  image_url TEXT,
  posted_at TIMESTAMP,
  fetched_at TIMESTAMP,
  channel_id TEXT,
  discord_message_id TEXT,
  likes INTEGER,
  comments INTEGER,
  FOREIGN KEY(source_id) REFERENCES social_sources(id)
);

CREATE TABLE news_articles (
  id INTEGER PRIMARY KEY,
  title TEXT,
  content TEXT,
  source VARCHAR(100),
  category VARCHAR(50),
  url TEXT,
  image_url TEXT,
  published_at TIMESTAMP,
  fetch_time TIMESTAMP,
  priority VARCHAR(10), -- HIGH, MEDIUM, LOW
  sent_to_discord BOOLEAN DEFAULT 0,
  message_id TEXT
);
```

---

### 2. **Sports Tracking** ⚽
**Commands:**
- `/league standings <bayern|barca|realmadrid|premier|laliga|serie-a|bundesliga>`
- `/next-match <team>`
- `/league-table <competition>`

**Scheduled:** Match days (12 PM & 8 PM IST)
- Next fixtures with dates/times
- Live score alerts during matches
- Top scorers in league
- Weekly standings snapshot

**Supported Leagues:**
- Bundesliga (Bayern Munich)
- La Liga (Barcelona, Real Madrid)
- Premier League
- Serie A
- Champions League

---

### 3. **Health Reminders** 💪 (Tikho Nepali Edition)
**Commands:**
- `/set-reminder <time>` (personal reminder time)
- `/streak` (check smoking-free streak)
- `/motivation` (get motivation quote)
- `/reminder-language <nepali|english>` (toggle language)
- `/reminder-tone <soft|tikho>` (toggle tone)

**Scheduled:** **Every 30 minutes** (24/7)
- Anti-smoking motivation in **Nepali with tikho/harsh language**
- Uses Nepali slang: "muji", "baun", "churot", "dhoti", "gadha", etc.
- Personalized streaks tracked per user
- Quote variation with attitude
- Funny, street-style motivation

**Nepali Tikho Language Style Examples:**
- "Yo churot nakhaa, muji! Tapailai shakti cha!" (Don't smoke, bro! You got this!)
- "Baun! 32 din ho! Terai dhoti ho na?" (Dude! 32 days! You're not gonna waste it now?)
- "Gadha haina na tu! Churot nakhaa, bhaiyaa" (You're not an idiot! Don't smoke, brother)
- "Muji, ek din aile cha! Shakti dekhaa!" (Bro, one more day! Show some strength!)

**Persistence:**
- User streak stored in DB
- Resets if `/reset-streak` called
- Monthly badges system
- Language preference saved per user

---

## Database Schema

```sql
-- Users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  discord_id TEXT UNIQUE,
  timezone VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reminders
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  reminder_time VARCHAR(5),
  enabled BOOLEAN DEFAULT 1,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Streaks
CREATE TABLE streaks (
  id INTEGER PRIMARY KEY,
  user_id TEXT UNIQUE,
  days_count INTEGER DEFAULT 0,
  last_reset TIMESTAMP,
  badge_level INTEGER DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Favorites
CREATE TABLE favorites (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  team_name VARCHAR(50),
  league VARCHAR(50),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
```

---

## Command Reference

### News Commands
| Command | Description |
|---------|-------------|
| `/nepal-news` | Get latest Nepal headlines |
| `/nepal-news-category <category>` | Filter by category (politics, business, tech, sports, entertainment) |
| `/schedule-news <time>` | Set daily digest time |
| `/social-feed-refresh` | Force immediate social media feed check |
| `/trending` | Show today's trending topics from social feed |
| `/add-source <name> <platform> <url>` | Add new social media source to track |
| `/sources` | List all tracked social media sources |

### Sports Commands
| Command | Description |
|---------|-------------|
| `/standings <league>` | League table |
| `/next-match <team>` | Upcoming fixtures |
| `/add-favorite <team>` | Track favorite team |
| `/my-favorites` | Show tracked teams |
| `/match-alert <team>` | Enable match notifications |

### Health Commands
| Command | Description |
|---------|-------------|
| `/streak` | Check smoking-free days |
| `/motivation` | Get daily motivation |
| `/set-reminder <time>` | Personal reminder time |
| `/reset-streak` | Reset counter |

---

## Scheduled Tasks

### Real-Time Social Media Feed (Every 30-60 mins)
```
Timing: 24/7, every 30-60 minutes
Sources Polled: RONB, Kathmandu Post, Himalayan Times, eKantipur, etc.
Channel: #📢 social-feed
Format: Quick embed with:
  - Source name + timestamp
  - Headline (1-2 lines)
  - Summary (150 chars)
  - Thumbnail image
  - Source link
  - Engagement (likes, comments)
Action: If new post detected → immediately post to Discord
Dedup: Check external_post_id to prevent re-posts
```

### Morning News Brief (6:00 AM IST)
```
Timing: 6:00 AM IST
Channels: 
  - #📰 politics (top 3 political stories)
  - #💼 business (top 3 business stories)
  - #🏆 sports (top 3 sports stories)
  - #💻 tech (top 3 tech stories)
Format: **Detailed embeds** with:
  - Full headline
  - 300+ char summary
  - Source attribution
  - Category + priority flag
  - Read more link
Sources: NewsAPI, RSS feeds, curated from 24h social feed
```

### Evening News Recap (10:00 PM IST)
```
Timing: 10:00 PM IST
Channel: #📢 social-feed (or dedicated #📌 top-stories)
Format: Same as morning - detailed embeds
Content: Day's top stories + trending topics
Summary: "What you missed today" compilation
Focus: Consolidate best posts from social monitoring
```

### Sports Pulse (2x on match days)
```
Morning (9:00 AM): Fixtures for today
Evening (7:00 PM): Results + standings update
Channels: #🏆 sports
```

### Health Reminder (Random daily)
```
Time: Between 9 AM - 9 PM
Target: Users with enabled reminders
Format: Embed with quote + streak counter
```

---

## Data Sources & APIs

### Social Media Sources (Default Tracked)
```json
{
  "sources": [
    { "name": "RONB", "platform": "instagram", "url": "https://www.instagram.com/ronb.nepal/", "priority": "HIGH" },
    { "name": "Kathmandu Post", "platform": "facebook", "url": "https://www.facebook.com/kathmandupost", "priority": "HIGH" },
    { "name": "The Himalayan Times", "platform": "facebook", "url": "https://www.facebook.com/thehimalayantimes", "priority": "HIGH" },
    { "name": "eKantipur", "platform": "facebook", "url": "https://www.facebook.com/ekantipur", "priority": "HIGH" },
    { "name": "Setopati", "platform": "facebook", "url": "https://www.facebook.com/setopati", "priority": "MEDIUM" },
    { "name": "Nepal24Hours", "platform": "facebook", "url": "https://www.facebook.com/nepal24hours", "priority": "MEDIUM" },
    { "name": "My Republica", "platform": "facebook", "url": "https://www.facebook.com/myrepublicaonline", "priority": "MEDIUM" }
  ]
}
```

### News APIs
1. **NewsAPI.org** (Free tier)
   - 100 requests/day
   - Country filtering for Nepal
   - Use for morning/evening briefs
   
2. **RSS Feeds** (High Priority)
   - Kathmandu Post
   - eKantipur
   - setopati.net
   - My Republica
   - Himalayan Times

3. **Social Media Scraping**
   - Facebook Graph API (requires Business Account approval)
   - Puppeteer + Cheerio (web scraping fallback)
   - instagrapi (Instagram scraping)

### Sports APIs
1. **RapidAPI - Football/Soccer** or **ESPN API**
   - Live scores
   - Standings
   - Player stats

2. **Fallback:** ESPN web scraping (if needed)

---

## User Preferences (Per-Server)

- Preferred news time
- Favorite teams (2-3 max)
- Match alerts (on/off)
- Health reminder enabled
- Timezone

---

## Embeds & UI Examples

### News Embed
```
🇳🇵 Nepal Daily News | 6 Aug 2026

📌 Title: "Major Infrastructure Project Approved"
Source: Kathmandu Post
Category: Business
Link: [Read more]

📌 Title 2: "Bayern Munich Star Talks Nepal Visit"
...
```

### Sports Embed
```
⚽ Bayern Munich vs FC Köln
📅 Aug 10, 2026 | 3:30 PM CEST
🏟️ Allianz Arena

Recent Form: Bayern W-W-W-D-W
Top Scorer: Leroy Sané (12 goals)

[Live Score] [Lineup] [Stats]
```

### Streak Embed
```
💪 Your Smoking-Free Streak
📈 32 Days Strong! 🔥
🏆 Badge: Silver (30+ days)

Next badge at: 60 days
Keep going! Every cigarette NOT smoked = Victory
```

---

## Future Enhancements

1. **Gaming Integration** (Clash Royale stats)
2. **Fitness Logging** (Workout tracking)
3. **Weather Alerts** (Kathmandu weather + exercise tips)
4. **Leaderboard** (Streaks + server rankings)
5. **Custom Notifications** (Match analysis, injury alerts)

---

## Error Handling & Edge Cases

- No internet: Show cached data or "Service unavailable"
- API rate limits: Queue requests, show next update time
- Timezone issues: Store as UTC, convert per user
- Missing data: Graceful fallbacks with timestamps

---

## Deployment Checklist

- [ ] API keys stored in `.env`
- [ ] Database initialized
- [ ] Commands registered globally
- [ ] Schedulers tested
- [ ] Error logging setup
- [ ] Privacy policy (GDPR - data collection)
- [ ] Bot token secured

---

## Support & Monitoring

- Error logs: Console + file
- Uptime tracking: Healthcheck endpoint
- Command usage stats: Optional analytics
- User feedback channel: `/feedback` command
