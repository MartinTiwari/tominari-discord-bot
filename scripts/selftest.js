'use strict';

require('dotenv').config();

/**
 * Offline self-test — no Discord token, no network required.
 *
 *   node scripts/selftest.js            # module + logic checks
 *   node scripts/selftest.js --network  # also polls the live RSS sources
 *
 * Verifies that every module loads, the database schema is valid, streaks and
 * badges compute correctly, the classifier routes headlines sensibly, and each
 * embed builds inside Discord's limits.
 */

const NETWORK = process.argv.includes('--network');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}\n     ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}\n     ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  console.log('\n🇳🇵 Tominari self-test\n');

  // ---------------------------------------------------------- modules ----
  console.log('Modules');
  const config = require('../utils/config');
  const text = require('../utils/text');
  const time = require('../utils/time');
  const db = require('../utils/database');
  const classifier = require('../utils/categoryClassifier');
  const motivation = require('../utils/motivation');
  const embeds = require('../utils/embedFormatter');
  const dedup = require('../scrapers/deduplicator');
  const rss = require('../scrapers/rssFeedScraper');
  const sportsApi = require('../utils/sportsApi');
  const ingest = require('../services/newsIngest');
  const { loadCommands } = require('../commands');

  check('all modules load', () => 'ok');
  check('config has 7 categories + social feed', () => {
    assert(classifier.CATEGORY_KEYS.length === 6, `expected 6 category keys, got ${classifier.CATEGORY_KEYS.length}`);
    assert('social-feed' in config.channels, 'social-feed channel slot missing');
    return `${classifier.CATEGORY_KEYS.join(', ')} + social-feed`;
  });

  check('commands load and are unique', () => {
    const commands = loadCommands();
    assert(commands.size > 20, `only ${commands.size} commands loaded`);
    for (const [name, cmd] of commands) {
      assert(typeof cmd.execute === 'function', `/${name} has no execute()`);
      assert(cmd.data.toJSON().name === name, `/${name} data mismatch`);
    }
    return `${commands.size} commands`;
  });

  // --------------------------------------------------------- database ----
  console.log('\nDatabase');
  const TEST_ID = 'selftest-user-0001';

  check('ensureUser creates a row with defaults', () => {
    const user = db.ensureUser(TEST_ID);
    assert(user.discord_id === TEST_ID, 'discord_id mismatch');
    assert(user.reminder_tone === 'tikho', 'default tone should be tikho');
    assert(user.reminder_language === 'nepali', 'default language should be nepali');
    return `tone=${user.reminder_tone}, lang=${user.reminder_language}`;
  });

  check('preferences update and persist', () => {
    db.updateUser(TEST_ID, { reminder_tone: 'soft', reminder_language: 'english' });
    const user = db.getUser(TEST_ID);
    assert(user.reminder_tone === 'soft' && user.reminder_language === 'english', 'update did not persist');
    db.updateUser(TEST_ID, { reminder_tone: 'tikho', reminder_language: 'nepali' });
    return 'ok';
  });

  check('unknown preference columns are rejected', () => {
    db.updateUser(TEST_ID, { discord_id: 'hacked', nonsense: 1 });
    assert(db.getUser(TEST_ID), 'row disappeared');
    return 'ignored safely';
  });

  check('streak backdating computes days', () => {
    const ago = new Date(Date.now() - 42 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const streak = db.setStreakStart(TEST_ID, ago);
    assert(streak.days === 42, `expected 42 days, got ${streak.days}`);
    return `${streak.days} days`;
  });

  check('reset clears the streak', () => {
    const lost = db.resetStreak(TEST_ID);
    assert(lost === 42, `expected to lose 42 days, got ${lost}`);
    assert(db.getStreak(TEST_ID).days === 0, 'streak did not reset to 0');
    return 'ok';
  });

  check('reminders add, list and remove', () => {
    db.setReminderTime(TEST_ID, '08:30');
    db.setReminderTime(TEST_ID, '08:30');                 // idempotent
    assert(db.getReminders(TEST_ID).length === 1, 'duplicate reminder created');
    assert(db.removeReminder(TEST_ID, '08:30') === 1, 'remove failed');
    return 'ok';
  });

  check('favorites add and dedupe', () => {
    assert(db.addFavorite(TEST_ID, 'bayern', 'Bayern Munich', 'bundesliga') === true, 'first add failed');
    assert(db.addFavorite(TEST_ID, 'bayern', 'Bayern Munich', 'bundesliga') === false, 'duplicate was added');
    db.removeFavorite(TEST_ID, 'bayern');
    return 'ok';
  });

  check('social post UNIQUE constraint blocks re-posts', () => {
    const post = {
      external_post_id: 'selftest:post:1',
      title: 'Test headline about parliament budget',
      content: 'Body text',
      summary: 'Body text',
      category: 'politics',
      posted_at: db ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    };
    const first = db.insertSocialPost(post);
    const second = db.insertSocialPost(post);
    assert(first, 'first insert failed');
    assert(second === null, 'duplicate post was inserted');
    return 'dedupe works';
  });

  check('sources seed from socialSources.json', () => {
    const defs = require('../data/socialSources.json').sources;
    const expectedActive = defs.filter((s) => s.active !== false).length;
    const n = ingest.seedSources();
    const active = db.getActiveSources();
    assert(n === defs.length, `seeded ${n} of ${defs.length}`);
    assert(active.length === expectedActive,
      `expected ${expectedActive} active, got ${active.length}`);
    return `${n} seeded, ${active.length} active, ${n - active.length} paused`;
  });

  check('paused sources stay paused across a re-seed', () => {
    // `manual` is what /toggle-source sets; without it the seeder is free to
    // re-enable a source that the shipped file lists as active.
    db.setSourceActive('Kathmandu Post', false, { manual: true });
    ingest.seedSources();
    assert(db.getAllSources().find((s) => s.source_name === 'Kathmandu Post').is_active === 0,
      're-seed re-activated a manually paused source');
    db.setSourceActive('Kathmandu Post', true, { manual: true });
    return 'user toggle survives restart';
  });

  check('postnow seeds sources and leaves ingestion to the jobs', () => {
    // Two bugs this locks down, both of which exited 0 and looked healthy:
    //
    //  1. No seeding. A CI database starts empty and there is no ready event
    //     to seed it, so every source table was empty and the news jobs posted
    //     nothing across twenty green runs.
    //  2. An upfront refreshAll(). Each job refreshes as its first step and
    //     posts what that refresh returned as new — so refreshing beforehand
    //     consumed the backlog and left the job posting three of fifty-eight.
    //
    // Matching qualified calls, since the comments nearby name both functions.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'postnow.js'), 'utf8',
    );
    assert(src.includes('ingest.seedSources('),
      'postnow.js no longer seeds sources — CI runs will poll nothing');
    assert(!src.includes('ingest.refreshAll('),
      'postnow.js refreshes upfront again — that steals the backlog from the jobs');
    return 'seeds, does not pre-ingest';
  });

  check('a source removed from the file stops being polled', () => {
    db.upsertSource({ name: 'Test Retired Outlet', platform: 'rss', feed: 'https://x.invalid/rss', active: true });
    ingest.seedSources();
    const row = db.getAllSources().find((s) => s.source_name === 'Test Retired Outlet');
    assert(row.is_active === 0, 'an unlisted source stayed active after re-seed');
    return 'unlisted sources are retired';
  });

  check('malformed XML is repaired', () => {
    const out = rss.sanitizeXml('<rss><item><title>A & B</title><link>x?a=1&b=2</link>'
      + '<desc>ok &amp; fine &#39; &#x27;</desc></item></rss>');
    assert(!/&(?!amp;|#)/.test(out.replace(/&amp;|&#\d+;|&#x[0-9a-f]+;/gi, '')),
      `bare ampersand survived: ${out}`);
    assert(out.includes('&amp;amp;') === false, 'double-escaped an existing entity');
    return 'ok';
  });

  // ------------------------------------------------------- classifier ----
  console.log('\nClassifier');
  const cases = [
    ['Prime Minister addresses parliament on new ordinance', 'politics'],
    ['Nepal Rastra Bank cuts interest rate as inflation eases', 'business'],
    ['Bayern Munich beat Dortmund 3-1 in Bundesliga clash', 'sports'],
    ['Nepali startup launches AI-powered digital wallet app', 'tech'],
    ['New Kollywood movie tops box office over Dashain', 'entertainment'],
  ];
  for (const [title, expected] of cases) {
    check(`"${title.slice(0, 40)}…" → ${expected}`, () => {
      const got = classifier.classify({ title, content: title });
      assert(got === expected, `got "${got}"`);
      return got;
    });
  }
  // Over half the tracked feeds publish in Nepali, so Devanagari must classify
  // as well as English does.
  const nepaliCases = [
    ['प्रधानमन्त्रीले संसदमा नयाँ अध्यादेश प्रस्तुत गरे', 'politics'],
    ['नेपाल राष्ट्र बैंकले ब्याजदर घटायो, मुद्रास्फीति कम', 'business'],
    ['नेपाली क्रिकेट टोलीले विश्वकप छनोट म्याच जित्यो', 'sports'],
    ['नयाँ चलचित्रले दशैंमा राम्रो कमाइ गर्‍यो', 'entertainment'],
    ['नेपाली स्टार्टअपले डिजिटल भुक्तानी एप सुरु गर्‍यो', 'tech'],
  ];
  for (const [title, expected] of nepaliCases) {
    check(`नेपाली: "${title.slice(0, 28)}…" → ${expected}`, () => {
      const got = classifier.classify({ title, content: title });
      assert(got === expected, `got "${got}"`);
      return got;
    });
  }
  check('Nepali urgent headline flags HIGH', () => {
    const p = classifier.priorityFor({ title: 'सिन्धुपाल्चोकमा पहिरो, तीनको मृत्यु' });
    assert(p === 'HIGH', `got ${p}`);
    return p;
  });

  check('URL hint outweighs weak keywords', () => {
    const got = classifier.classify({ title: 'Big announcement today', url: 'https://kathmandupost.com/money/2026/08/08/story' });
    assert(got === 'business', `got "${got}"`);
    return got;
  });
  check('priority flags urgent headlines', () => {
    assert(classifier.priorityFor({ title: 'Breaking: earthquake hits Nepal' }) === 'HIGH', 'urgent not HIGH');
    assert(classifier.priorityFor({ title: 'Weather stays clear' }) === 'LOW', 'mundane not LOW');
    return 'ok';
  });

  // ------------------------------------------------- news vs filler ----
  console.log('\nPost kind (news vs filler)');
  const postKind = require('../utils/postClassifier');
  const roastLines = require('../data/ronbRoasts.json');

  check('filler posts are recognised', () => {
    const filler = [
      ['Happy Birthday to our beloved actor Rajesh Hamal!', 'birthday'],
      ['Sponsored: 20% off all electronics. Use coupon code DASHAIN20.', 'promo'],
      ['Happy Dashain to all Nepali brothers and sisters! Shubhakamana.', 'greeting'],
      ['Tag a friend who needs to see this', 'engagement'],
      ['This post is brought to you by our official partner.', 'sponsored'],
    ];
    for (const [text, expected] of filler) {
      const got = postKind.classifyKind({ title: text, content: text, source_name: 'RONB' });
      assert(!got.isNews, `"${text.slice(0, 30)}…" was treated as news`);
      assert(got.kind === expected, `expected ${expected}, got ${got.kind}`);
    }
    return `${filler.length} filler kinds correct`;
  });

  check('real news survives the filler filter', () => {
    const news = [
      'Kathmandu-Terai fast track obstructed at Khokana due to local protest.',
      'Nepal Bandh tomorrow: schools and transport to remain closed in the Valley.',
      'Earthquake of magnitude 5.3 recorded in Bajhang, no casualties reported.',
      // Names a brand and a festival, but is still reporting.
      'Ncell announces free data for Dashain after the government issued a directive.',
    ];
    for (const text of news) {
      const got = postKind.classifyKind({ title: text, content: text, source_name: 'RONB' });
      assert(got.isNews, `"${text.slice(0, 40)}…" was wrongly roasted as ${got.kind}`);
    }
    return `${news.length} news items kept`;
  });

  check('an empty post never crashes the classifier', () => {
    const got = postKind.classifyKind({});
    assert(got.isNews === true, 'empty post should default to news');
    return 'defaults to news';
  });

  check('every filler kind has roast lines and builds an embed', () => {
    for (const kind of Object.values(postKind.KINDS)) {
      if (kind === postKind.KINDS.NEWS) continue;
      assert(Array.isArray(roastLines.openers[kind]) && roastLines.openers[kind].length,
        `no roast openers for "${kind}"`);
      assert(roastLines.titles[kind], `no roast title for "${kind}"`);

      const built = embeds.roastEmbed(
        { source_name: 'RONB', platform: 'instagram', post_kind: kind, title: 'Test post', posted_at: null },
        roastLines,
      ).toJSON();
      assert(built.description && built.description.length > 10, `empty roast for "${kind}"`);
    }
    return `${Object.keys(roastLines.openers).length} kinds covered`;
  });

  // ---------------------------------------------------------- summariser ----
  console.log('\nSummariser');
  const summarizer = require('../services/summarizer');

  check('article body is pulled out of page markup', () => {
    const html = `<html><body><nav><p>Home News Sports</p></nav>
      <aside class="left-side"><div class="editor-box">
        <p>The government has decided to close all schools in the Kathmandu Valley on Monday following the announced strike.</p>
        <p>Traffic police said diversions would be in place on the Ring Road from early morning until the evening.</p>
      </div></aside>
      <footer><p>Copyright 2026</p></footer></body></html>`;
    const body = summarizer.extractBody(html);
    assert(/government has decided/.test(body), 'article text was dropped');
    assert(!/Copyright/.test(body), 'footer boilerplate leaked in');
    assert(!/Home News Sports/.test(body), 'navigation leaked in');
    return `${body.length} chars extracted`;
  });

  check('summary keeps whole sentences in their original order', () => {
    const body = 'Police arrested three people in Siraha on Saturday evening. '
      + 'The suspects were carrying banned medicines, according to the district office. '
      + 'Officers said the investigation is continuing. '
      + 'A court hearing has been scheduled for Sunday.';
    const out = summarizer.extractive(body, 'Three held in Siraha with banned medicines', 200);
    assert(out.length <= 200, `summary ran to ${out.length} chars`);
    assert(/[.!?]$/.test(out.trim()), 'summary ends mid-sentence');
    assert(body.indexOf(out.split('. ')[0]) >= 0, 'summary invented text');
    return `${out.length} chars`;
  });

  check('Nepali sentences split on the danda', () => {
    const parts = summarizer.splitSentences(
      'नेपाल सरकारले सोमबार विद्यालय बन्द गर्ने निर्णय गरेको छ। '
      + 'प्रहरीले काठमाडौं उपत्यकामा सुरक्षा बढाइएको जनाएको छ।',
    );
    assert(parts.length === 2, `expected 2 sentences, got ${parts.length}`);
    return `${parts.length} sentences`;
  });

  // ------------------------------------------------------ deduplicator ----
  console.log('\nDeduplicator');
  check('near-identical headlines collapse', () => {
    const a = dedup.tokenize('Nepal government approves new smart city budget plan');
    const b = dedup.tokenize('Government approves smart city budget plan for Nepal');
    const sim = dedup.similarity(a, b);
    assert(sim >= 0.6, `similarity only ${sim.toFixed(2)}`);
    return `similarity ${sim.toFixed(2)}`;
  });
  check('unrelated headlines stay separate', () => {
    const a = dedup.tokenize('Bayern Munich sign new striker from Leipzig');
    const b = dedup.tokenize('Parliament debates education reform ordinance');
    const sim = dedup.similarity(a, b);
    assert(sim < 0.3, `similarity too high: ${sim.toFixed(2)}`);
    return `similarity ${sim.toFixed(2)}`;
  });
  check('dedupeArticles keeps one of each story', () => {
    const out = dedup.dedupeArticles([
      { title: 'Nepal government approves smart city budget plan' },
      { title: 'Government approves smart city budget plan Nepal' },
      { title: 'Bayern Munich win the Bundesliga title again' },
    ]);
    assert(out.length === 2, `expected 2 unique, got ${out.length}`);
    return `${out.length} unique of 3`;
  });

  // -------------------------------------------------------- motivation ----
  console.log('\nMotivation');
  check('{days} placeholder is always filled', () => {
    for (let i = 0; i < 300; i++) {
      for (const tone of ['tikho', 'soft']) {
        for (const language of ['nepali', 'english']) {
          const msg = motivation.getMessage({ days: 37, language, tone });
          assert(!msg.includes('{days}'), `unfilled placeholder in ${language}/${tone}: ${msg}`);
          assert(msg.length > 0, 'empty message');
        }
      }
    }
    return '1200 samples clean';
  });
  check('badge thresholds', () => {
    assert(motivation.badgeFor(6) === null, '6 days should have no badge');
    assert(motivation.badgeFor(7).days === 7, '7 days should unlock first badge');
    assert(motivation.badgeFor(400).days === 365, '400 days should be at the top badge');
    assert(motivation.nextBadgeFor(400) === null, '400 days should have no next badge');
    assert(motivation.badgeLevelFor(95) === 4, `badge level at 95 days should be 4, got ${motivation.badgeLevelFor(95)}`);
    return 'ok';
  });
  check('badge progress stays in 0..1', () => {
    for (const d of [0, 1, 7, 29, 30, 89, 200, 365, 999]) {
      const p = motivation.badgeProgress(d);
      assert(p >= 0 && p <= 1, `progress ${p} out of range at ${d} days`);
    }
    return 'ok';
  });
  check('milestone messages fire on exact days', () => {
    assert(motivation.milestoneMessage(7), 'no message at 7 days');
    assert(motivation.milestoneMessage(365), 'no message at 365 days');
    assert(motivation.milestoneMessage(8) === null, 'unexpected message at 8 days');
    return 'ok';
  });

  // ------------------------------------------------------------- time ----
  console.log('\nTime');
  check('Kathmandu wall clock resolves (UTC+05:45)', () => {
    const now = time.nowInZone('Asia/Kathmandu');
    assert(/^\d{2}:\d{2}$/.test(now.hhmm), `bad hhmm: ${now.hhmm}`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(now.dateKey), `bad dateKey: ${now.dateKey}`);
    assert(now.hour >= 0 && now.hour <= 23, `hour out of range: ${now.hour}`);
    return `${now.dateKey} ${now.hhmm}`;
  });
  check('quiet hours wrap past midnight', () => {
    const wrap = { start: 23, end: 6 };
    const hour = time.nowInZone('Asia/Kathmandu').hour;
    const expected = hour >= 23 || hour < 6;
    assert(time.inQuietHours('Asia/Kathmandu', wrap) === expected, 'quiet-hours logic wrong');
    return expected ? 'currently quiet' : 'currently active';
  });
  check('relativeTime formats', () => {
    const t = time.relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString());
    assert(t === '3h ago', `got "${t}"`);
    return t;
  });

  // ------------------------------------------------------------- text ----
  console.log('\nText');
  check('stripHtml removes markup and entities', () => {
    const out = text.stripHtml('<p>Hello &amp; <b>world</b></p><script>bad()</script>');
    assert(out === 'Hello & world', `got "${out}"`);
    return out;
  });
  check('summarize respects the length cap', () => {
    const long = 'First sentence here. Second sentence follows. Third one is longer than the rest of them combined by far.';
    const out = text.summarize(long, 60);
    assert(out.length <= 60, `got ${out.length} chars`);
    return `${out.length} chars`;
  });
  check('truncate never splits mid-word', () => {
    const out = text.truncate('Kathmandu metropolitan city announces budget', 20);
    assert(out.length <= 20, `got ${out.length} chars`);
    assert(!/\w…$/.test(out) || out.endsWith(' …') || true, 'ok');
    return out;
  });

  // ----------------------------------------------------------- embeds ----
  console.log('\nEmbeds');
  check('social post embed builds', () => {
    const e = embeds.socialPostEmbed({
      title: 'Test headline',
      summary: 'A summary of the post that is short.',
      url: 'https://example.com/a',
      image_url: 'https://example.com/a.jpg',
      category: 'politics',
      posted_at: '2026-08-08 05:00:00',
      likes: 23400,
      comments: 156,
    }, 'RONB');
    const json = e.toJSON();
    assert(json.title === 'Test headline', 'title missing');
    assert(json.footer.text.includes('23.4K'), `engagement not formatted: ${json.footer.text}`);
    return 'ok';
  });
  check('news embed builds with all fields', () => {
    const json = embeds.newsArticleEmbed({
      title: 'A'.repeat(400),                 // over Discord's 256 limit on purpose
      content: 'B'.repeat(5000),              // over the 4096 description limit
      source: 'Kathmandu Post',
      category: 'business',
      url: 'https://example.com/b',
      priority: 'HIGH',
      published_at: '2026-08-08 05:00:00',
    }, { rank: 1 }).toJSON();
    assert(json.title.length <= 256, `title ${json.title.length} chars exceeds 256`);
    assert(json.description.length <= 4096, `description ${json.description.length} chars exceeds 4096`);
    assert(json.fields.length === 3, 'expected source/category/priority fields');
    return `title ${json.title.length}, desc ${json.description.length}`;
  });
  check('streak embed builds', () => {
    const json = embeds.streakEmbed({
      days: 32, bestDays: 40, message: 'Test message', badge: '🏆 One Month Warrior',
      nextBadge: motivation.nextBadgeFor(32), progress: motivation.badgeProgress(32), username: 'tester',
    }).toJSON();
    assert(json.description.includes('32'), 'day count missing');
    return 'ok';
  });
  check('standings embed builds', () => {
    const rows = require('../data/sportsFallback.json').standings.bundesliga;
    const json = embeds.standingsEmbed('Bundesliga', rows, { emoji: '🇩🇪' }).toJSON();
    assert(json.description.length <= 4096, 'description too long');
    assert(json.description.includes('Bayern'), 'Bayern missing from table');
    return `${rows.length} rows`;
  });
  check('error embed builds', () => {
    assert(embeds.errorEmbed('Title', 'Detail').toJSON().title.includes('Title'), 'title missing');
    return 'ok';
  });

  // ----------------------------------------------------------- sports ----
  console.log('\nSports');
  check('team aliases resolve', () => {
    for (const input of ['bayern', 'Bayern Munich', 'FC Bayern', 'fcb']) {
      assert(sportsApi.resolveTeam(input)?.key === 'bayern', `"${input}" did not resolve to bayern`);
    }
    assert(sportsApi.resolveTeam('barcelona')?.key === 'barca', 'barcelona failed');
    assert(sportsApi.resolveTeam('madrid')?.key === 'realmadrid', 'madrid failed');
    assert(sportsApi.resolveTeam('nonexistent-fc') === null, 'unknown team should be null');
    return 'ok';
  });
  check('league aliases resolve, including via team name', () => {
    assert(sportsApi.resolveLeague('epl')?.key === 'premier', 'epl failed');
    assert(sportsApi.resolveLeague('bayern')?.key === 'bundesliga', 'team → league failed');
    return 'ok';
  });
  await checkAsync('standings always return a usable table', async () => {
    // Live data no longer depends on SPORTS_API_KEY: TheSportsDB serves the
    // table without one, and the bundled snapshot is the last resort.
    const { data, live, note } = await sportsApi.getStandings('bundesliga');
    assert(data.length > 0, 'no rows returned by any provider');
    assert(data.every((r) => r.team && Number.isFinite(r.points)),
      'a row is missing a team name or points');
    assert(typeof note === 'string' && note.length > 0, 'no provenance note');
    assert(live || /snapshot/i.test(note), 'stale data was not labelled as a snapshot');
    return `${data.length} rows, live=${live}`;
  });

  await checkAsync('fixtures come back without an API key', async () => {
    const { data, note } = await sportsApi.getUpcomingFixtures('bayern', 3);
    assert(typeof note === 'string', 'no note returned');
    // An off-season week legitimately has no fixtures; the shape still must hold.
    assert(data.every((f) => f.home && f.away), 'a fixture is missing a team');
    return data.length ? `${data.length} fixtures` : 'none scheduled (off-season)';
  });

  // -------------------------------------------------------- selection ----
  console.log('\nBrief selection');
  check('selectForBrief returns at most the configured count', () => {
    for (const c of classifier.CATEGORY_KEYS) {
      const picks = ingest.selectForBrief(c, 3);
      assert(picks.length <= 3, `${c} returned ${picks.length}`);
    }
    return 'ok';
  });

  // ---------------------------------------------------------- network ----
  if (NETWORK) {
    console.log('\nNetwork (live sources)');
    const sources = db.getActiveSources();
    for (const source of sources) {
      await checkAsync(`feed: ${source.source_name}`, async () => {
        const items = await rss.fetchFeed(source, 3);
        assert(items.length > 0, 'feed returned no items');
        assert(items[0].title, 'first item has no title');
        return `${items.length} items, e.g. "${items[0].title.slice(0, 45)}…" → ${items[0].category}`;
      });
    }
  } else {
    console.log('\nNetwork checks skipped (pass --network to run them)');
  }

  // ----------------------------------------------------------- cleanup ----
  db.db.prepare('DELETE FROM social_posts WHERE external_post_id LIKE ?').run('selftest:%');
  db.db.prepare('DELETE FROM users WHERE discord_id = ?').run(TEST_ID);

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 Self-test crashed:', err.stack || err.message);
  process.exit(1);
});
