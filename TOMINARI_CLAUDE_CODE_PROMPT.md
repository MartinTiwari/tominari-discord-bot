# Tominari Discord Bot - Enhanced Claude Code Prompt

Copy this prompt into Claude Code and run it. The bot will:
1. **Real-time social media monitoring** - Check Nepali news sources every 30-60 mins and auto-post summaries
2. **Detailed news briefs** - 6 AM & 10 PM with full stories across 7 categories
3. **Sports tracking** - Bayern, Barca, Real Madrid, top leagues
4. **Anti-smoking reminders** - Personalized health motivation

---

## PASTE THIS INTO CLAUDE CODE:

```
Create a production-ready Discord bot named "Tominari" using discord.js v14, Node.js, and SQLite with REAL-TIME SOCIAL MEDIA MONITORING.

## Requirements:

### 1. Multi-Channel Nepal News System

#### A. REAL-TIME Social Media Feed (Every 30-60 mins)
- Poll 7 Nepali news sources every 30-60 minutes:
  * RONB (Instagram)
  * Kathmandu Post (Facebook)
  * The Himalayan Times (Facebook)
  * eKantipur (Facebook)
  * Setopati (Facebook)
  * Nepal24Hours (Facebook)
  * My Republica (Facebook)

- When new post detected:
  * Extract: title, content, image, timestamp, engagement (likes, comments)
  * Generate: 150-character summary of the post
  * Post to Discord #📢 social-feed channel IMMEDIATELY
  * Format: Quick embed with source, headline, summary, link

- Deduplication: Track external_post_id to prevent re-posting same article

- Implementation:
  * Use Puppeteer + Cheerio for Facebook page scraping (if API unavailable)
  * OR use Meta Graph API (requires business approval)
  * Use instagrapi for Instagram scraping
  * Parse RSS feeds as fallback (Kathmandu Post, eKantipur)
  * Store posts in database with: source_id, external_post_id, title, summary, image_url, posted_at, likes, comments

#### B. Morning News Brief (6:00 AM IST)
- Post detailed stories to 7 channels:
  * #📰 politics (top 3 political stories - DETAILED)
  * #💼 business (top 3 business stories - DETAILED)
  * #🏆 sports (top 3 sports stories - DETAILED)
  * #💻 tech (top 3 tech stories - DETAILED)
  * #🎬 entertainment (top 3 entertainment stories - DETAILED)
  * #🌍 world (top 3 international stories - DETAILED)
  * #📢 social-feed (trending from previous 24h)

- Format: **Detailed Embeds** with:
  * Full headline
  * 300+ character summary
  * Source name + category + priority flag (HIGH/MEDIUM/LOW)
  * Thumbnail image (if available)
  * Link to full article
  * Color-coding: different color per category

- Sources: Top articles from NewsAPI + curated from 24h social feed + RSS feeds
- Logic: Use database to select highest-engagement posts from past 24h social monitoring

#### C. Evening News Recap (10:00 PM IST)
- Same format as morning (detailed embeds)
- Post to relevant category channels + #📢 social-feed
- Content: Day's top stories + trending topics compilation
- Summary: "What you missed today" compilation from all sources

### 2. Sports Tracking Feature
- Commands:
  * /standings <team> - Show league table for Bayern Munich, Barcelona, Real Madrid, Premier League, La Liga, Bundesliga, Serie A
  * /next-match <team> - Show upcoming fixtures
  * /add-favorite <team> - Add to user's favorite teams
  * /my-favorites - Show tracked teams
- Scheduled: Match days at 12 PM and 8 PM IST with:
  * Next fixtures for today
  * Live match scores (if available)
  * League standings snapshot
- Use ESPN API or RapidAPI Football API for live scores
- Fallback: Manual fixture data (hardcoded for popular teams)
- Display as embeds with team logos, match times, and standings

### 3. Health Reminders Feature - TIKHO NEPALI EDITION 🇳🇵
- Commands:
  * /streak - Show user's smoking-free streak
  * /motivation - Get motivation quote
  * /set-reminder <time> - Set personal reminder time (HH:MM format)
  * /reset-streak - Reset counter to 0
  * /reminder-language <nepali|english> - Toggle language
  * /reminder-tone <soft|tikho> - Toggle tone (soft vs harsh/tikho)

- Scheduled: **EVERY 30 MINUTES** (24/7, not just random daily times!)
  * Send reminder to user DM or notification
  * Interrupts what they're doing with motivation blast

- Messages: Nepali language with TIKHO/HARSH tone
  * Use Nepali slang: "muji", "baun", "churot", "dhoti", "gadha", "bhaiyaa"
  * Street-style motivation (not formal/polite)
  * Funny, crude, but motivational
  * Examples:
    - "Yo churot nakhaa, muji! Tapailai shakti cha!"
    - "Baun! 32 din ho! Terai dhoti ho na?"
    - "Gadha haina na tu! Churot nakhaa, bhaiyaa"
    - "Muji, ek din aile cha! Shakti dekhaa!"
    - "Churot ta gais, baun? Feri gais?"
    - "Yo muji yo! Taile shakti dekhaa, na?"

- Rotate through 30+ unique tikho Nepali quotes/messages
- Track user streaks in database
- Award badges at 7, 30, 60, 90, 365 days
- Display as embeds showing:
  * Current streak days
  * Next badge milestone
  * Tikho Nepali motivational message
  * Progress percentage to next badge
- Store language preference (nepali/english) and tone (soft/tikho) per user

## Technical Requirements:

### Database (SQLite):
- users table: id, discord_id, timezone, created_at, reminder_language (nepali/english), reminder_tone (soft/tikho), remind_every_30min (boolean)
- reminders table: id, user_id, reminder_time, enabled
- streaks table: id, user_id, days_count, last_reset, badge_level
- favorites table: id, user_id, team_name, league
- social_sources table: id, source_name, platform (facebook/instagram), page_url, last_checked, is_active
- social_posts table: id, source_id, external_post_id (UNIQUE), title, content, summary, image_url, posted_at, fetched_at, channel_id, discord_message_id, likes, comments
- news_articles table: id, title, content, source, category (politics/business/sports/tech/entertainment/world), url, image_url, published_at, fetch_time, priority (HIGH/MEDIUM/LOW), sent_to_discord, message_id

### Project Structure:
- bot.js (main entry point, load commands & schedulers)
- commands/ folder:
  * news.js (/nepal-news, /trending, /sources)
  * sports.js (/standings, /next-match, /add-favorite)
  * health.js (/streak, /motivation, /set-reminder)
  * social.js (/social-feed-refresh, /add-source)
- schedulers/ folder:
  * realtimeSocialFeed.js (runs every 30-60 mins)
  * morningNewsBrief.js (6:00 AM IST)
  * eveningNewsRecap.js (10:00 PM IST)
  * sportsPulse.js (match days)
  * healthReminder.js (random daily)
- scrapers/ folder:
  * facebookScraper.js (Puppeteer/Graph API)
  * instagramScraper.js (instagrapi or scraping)
  * rssFeedScraper.js (Parse RSS feeds)
  * deduplicator.js (Check for duplicate posts)
- utils/ folder:
  * newsApi.js (NewsAPI.org queries)
  * sportsApi.js (Sports data)
  * database.js (SQLite operations)
  * embedFormatter.js (Format embeds by category/type)
  * categoryClassifier.js (Auto-tag posts to categories)
- data/ folder:
  * socialSources.json (List of sources to track)
  * newsCategories.json (Category mappings)
- config.json (API keys, channel IDs, timezones)

### Environment Variables (.env):
- DISCORD_TOKEN=your_bot_token
- NEWSAPI_KEY=your_newsapi_key
- SPORTS_API_KEY=your_sports_api_key (optional, use fallback)
- DB_PATH=./data/tominari.db
- NEWS_CHANNEL_ID=channel_id
- SPORTS_CHANNEL_ID=channel_id

### Dependencies:
- discord.js@14
- node-cron (for scheduling - must support 30-minute intervals like "*/30 * * * *")
- sqlite3 (database)
- axios (HTTP requests)
- dotenv (environment variables)
- puppeteer (Facebook scraping, optional)
- instagrapi (Instagram scraping, optional)

### Features:
1. Error handling for API failures (graceful degradation)
2. Rate limiting for API calls
3. Timezone support (default IST for Nepal)
4. Proper embeds with colors (blue for news, green for sports, purple for health)
5. Responsive commands with followups
6. Logging to console
7. Streak persistence across bot restarts

### Tone & Style:
- Health reminders: **TIKHO NEPALI** - Harsh, crude, street-style but motivational
  * Use Nepali slang: "muji", "baun", "churot", "dhoti", "gadha", "bhaiyaa"
  * Examples: "Yo churot nakhaa, muji!", "Baun! 32 din ho!", "Gadha haina na tu!"
  * NOT formal or polite - funny and brutal motivation
  * Should feel like a Nepali friend yelling at you to quit smoking
- News: Factual, concise, professional
- Sports: Enthusiastic, include emojis (⚽🏆)

Build this as production-ready, well-commented code. Use MVC pattern if possible. Include error boundaries and fallback data sources.
```

---

## Setup Instructions:

1. **Create Discord Bot:**
   - Go to discord.com/developers
   - Create new application
   - Enable "Message Content Intent" & "Server Members Intent"
   - Copy token → save as `DISCORD_TOKEN` in `.env`

2. **Get API Keys:**
   - NewsAPI.org (free): newsapi.org
   - Optional Sports API: rapidapi.com/api-sports/api (football data)

3. **Prepare Server:**
   - Create channels: #nepal-news, #sports, #health
   - Get channel IDs → add to config.json

4. **Install & Run:**
   ```bash
   npm install discord.js node-cron sqlite3 axios dotenv
   node bot.js
   ```

5. **Test:**
   - Type `/nepal-news` in Discord
   - Type `/standings bayern` 
   - Type `/motivation`
   - Check if scheduled tasks run at correct times

---

## Customization Tips:

- **Change news time:** Edit `schedulers/dailyNews.js` → `0 6 * * *` (6 AM IST)
- **Add more teams:** Add to `config.json` → teams array
- **Edit reminders:** `schedulers/healthReminder.js` → update quotes array
- **Change timezone:** Modify `utils/database.js` → default timezone

---

## Notes:

- Use public, free APIs where possible (fallback to hardcoded data if needed)
- SQLite is local; no external DB server needed
- For production, consider PostgreSQL + Railway hosting
- All timestamps should handle IST (UTC+5:45)
- Embeds should be color-coded: News (Blue), Sports (Green), Health (Purple)

Good luck! Let me know if you need modifications. 🚀
```

---

## How to Use This:

1. Copy the prompt above (the section between the triple backticks)
2. Go to Claude Code (in desktop app or web)
3. Paste the prompt
4. Let it generate the full bot code
5. Create a `.env` file with your tokens
6. Run `node bot.js`

---

## Quick Customization Checklist:

- [ ] Add your Discord bot token to `.env`
- [ ] Add NewsAPI key to `.env`
- [ ] Create Discord channels (#nepal-news, #sports, #health)
- [ ] Update channel IDs in `config.json`
- [ ] Change timezone from IST to your preference (if needed)
- [ ] Add more teams to `config.json` if you want
- [ ] Customize health reminder quotes
- [ ] Test each command before inviting to server
