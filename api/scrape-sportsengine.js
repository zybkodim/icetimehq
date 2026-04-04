// api/scrape-sportsengine.js
// SportsEngine calendar scraper — config-driven, covers all SE1 rinks
// CommonJS (module.exports) — required for Vercel without "type":"module"
//
// Tries JSON extraction from <script> tags first, then Cheerio HTML parsing.
// Returns [] on failure so frontend shows "no sessions found" instead of error.
//
// ADDING A NEW RINK: add one entry to RINKS below, deploy. No other changes.

// Uses native fetch (Node.js 18+ / Vercel runtime)

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Classify ──────────────────────────────────────────────────────────────────
function classifyType(name = '') {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))    return 'freestyle';
  if (/stick|shoot|puck/.test(n))              return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))      return 'pickup';
  if (/public|open skat|adult skat/.test(n))   return 'public';
  return null;
}

const EXCLUDE = /game|\bleague\b|learn.to.sk|lts|duck shinny|goalie.only|private|tournament|birthday|party|lesson|class|clinic|camp|practice|tryout|scrimmage/i;

// ── Config — metadata from rinks.json, schedule data inline ──────────────────
const fs   = require('fs');
const path = require('path');
const _allRinks = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/rinks.json'), 'utf8'));

// SE-specific URLs and prices (not stored in rinks.json)
const SE_URLS = {
  haymarket: {
    calendarUrl:      'https://www.haymarketiceplex.com/calendar',
    publicSkateUrl:   'https://www.haymarketiceplex.com/page/show/8615506-public-skate-schedule',
    price:            10.00,
    daysmartFallback: 'haymarket',
  },
  princeWilliam: {
    calendarUrl:    'https://www.innovativesportsva.com/page/show/357110-schedule',
    publicSkateUrl: 'https://www.innovativesportsva.com/page/show/357110-schedule',
    price:          null,
  },
  rockville: {
    calendarUrl:    'https://www.rockvilleicearena.com/page/show/2944804-public-and-stick-time-ice-schedules',
    publicSkateUrl: 'https://www.rockvilleicearena.com/page/show/2944804-public-and-stick-time-ice-schedules',
    price:          null,
    stickPrice:     18.00,
  },
  breakaway: {
    calendarUrl:    'https://www.breakawayicecenter.com/schedule/',
    publicSkateUrl: 'https://www.breakawayicecenter.com/schedule/',
    price:          null,
  },
};

// Build RINKS from rinks.json — only SE1 rinks
const RINKS = Object.fromEntries(
  Object.values(_allRinks)
    .filter(r => r.scraper_file === 'api/scrape-sportsengine.js' && r.scraper_key)
    .map(r => [r.scraper_key, {
      name:             r.name,
      calendarUrl:      SE_URLS[r.scraper_key]?.calendarUrl    || r.website,
      publicSkateUrl:   SE_URLS[r.scraper_key]?.publicSkateUrl || r.website,
      website:          r.website,
      surface:          'Ice',
      timezone:         'America/New_York',
      price:            SE_URLS[r.scraper_key]?.price          || null,
      stickPrice:       SE_URLS[r.scraper_key]?.stickPrice     || null,
      daysmartFallback: SE_URLS[r.scraper_key]?.daysmartFallback || null,
    }])
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function to24h(h, m, period) {
  let hr = parseInt(h, 10);
  const min = String(m || '00').padStart(2, '0');
  if (period.toUpperCase() === 'PM' && hr !== 12) hr += 12;
  if (period.toUpperCase() === 'AM' && hr === 12) hr = 0;
  return `${String(hr).padStart(2, '0')}:${min}`;
}

function parseTimeRange(text) {
  const full = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (full) return { start: to24h(full[1], full[2], full[3]), end: to24h(full[4], full[5], full[6]) };
  return null;
}

function buildSession(name, times, date, rink) {
  const type = classifyType(name);
  if (!type || EXCLUDE.test(name)) return null;
  return {
    name:            name.trim().substring(0, 60),
    type,
    start:           `${date}T${times.start}:00`,
    end:             `${date}T${times.end}:00`,
    price:           type === 'stick' ? (rink.stickPrice ?? rink.price) : rink.price,
    openSlots:       null,
    status:          'available',
    surface:         rink.surface,
    registrationUrl: rink.website,
  };
}

// ── Approach 1: JSON in <script> tags ─────────────────────────────────────────
function extractFromScripts(html, date, rink) {
  const sessions = [];
  const jsonPatterns = [
    /window\.__se_data\s*=\s*({.+?});/s,
    /window\.seScheduleData\s*=\s*(\[.+?\]);/s,
    /"events"\s*:\s*(\[.+?\])/s,
  ];

  for (const pattern of jsonPatterns) {
    const match = html.match(pattern);
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      const events = Array.isArray(data) ? data : (data.events || data.schedule || []);
      for (const ev of events) {
        const evDate = ev.date || ev.startDate || ev.start_date || '';
        if (!evDate.startsWith(date)) continue;
        const name = ev.title || ev.name || ev.event_title || '';
        const startStr = ev.startTime || ev.start_time || ev.start || '';
        const endStr   = ev.endTime   || ev.end_time   || ev.end   || '';
        if (!startStr) continue;
        const startFmt = startStr.length === 5 ? startStr : startStr.slice(11, 16);
        const endFmt   = endStr.length === 5   ? endStr   : endStr.slice(11, 16);
        const type = classifyType(name);
        if (!type || EXCLUDE.test(name)) continue;
        sessions.push({
          name, type,
          start:           `${date}T${startFmt}:00`,
          end:             `${date}T${endFmt}:00`,
          price:           rink.price,
          openSlots:       null,
          status:          'available',
          surface:         rink.surface,
          registrationUrl: rink.website,
        });
      }
      if (sessions.length > 0) return sessions;
    } catch (_) {}
  }
  return sessions;
}

// ── Approach 2: Cheerio HTML parsing ─────────────────────────────────────────
function extractFromHTML(html, date, rink, cheerio) {
  const $ = cheerio.load(html);
  const sessions = [];
  const [,, dd] = date.split('-').map(Number);
  const dayOfWeek = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  const dateSelectors = [
    `[data-date="${date}"]`, `[data-day="${dd}"]`,
    `.se-calendar-day-${dd}`, `#se-calendar-${dd}`,
    `.fc-day[data-date="${date}"]`,
  ];

  for (const sel of dateSelectors) {
    $(sel).each((_, el) => {
      const text = $(el).text();
      text.split(/\n/).filter(l => l.trim()).forEach(item => {
        if (EXCLUDE.test(item)) return;
        const type = classifyType(item);
        if (!type) return;
        const times = parseTimeRange(item);
        if (!times) return;
        const s = buildSession(item, times, date, rink);
        if (s) sessions.push(s);
      });
    });
    if (sessions.length > 0) return sessions;
  }

  // Parse schedule listed by day of week
  const fullText = $('body').text();
  const lines = fullText.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  let currentSessionName = '';
  for (const line of lines) {
    if (!line.match(/\d{1,2}:\d{2}/) && classifyType(line) && !EXCLUDE.test(line)) {
      currentSessionName = line;
      continue;
    }
    if (!line.toLowerCase().includes(dayOfWeek.toLowerCase()) &&
        !line.toLowerCase().includes(dayOfWeek.slice(0, 3).toLowerCase())) continue;
    const times = parseTimeRange(line);
    if (!times) continue;
    const name = currentSessionName || line;
    if (EXCLUDE.test(name)) continue;
    const s = buildSession(name, times, date, rink);
    if (s) sessions.push(s);
  }

  return sessions;
}

// ── Main fetch ────────────────────────────────────────────────────────────────
async function fetchSESchedule(rink, date, cheerio) {
  const url = rink.publicSkateUrl || rink.calendarUrl;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`SE fetch failed: ${res.status} for ${url}`);

  const html = await res.text();
  let sessions = extractFromScripts(html, date, rink);
  if (sessions.length === 0) sessions = extractFromHTML(html, date, rink, cheerio);

  // DaySmart fallback for Haymarket if SE returns nothing
  if (sessions.length === 0 && rink.daysmartFallback) {
    try {
      const dsUrl = `https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events?` +
        `company=${rink.daysmartFallback}&filter[start_date__gte]=${date}&filter[start_date__lte]=${date}`;
      const dsRes = await fetch(dsUrl, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (dsRes.ok) {
        const dsData = await dsRes.json();
        const events = dsData.data || [];
        for (const ev of events) {
          const name = ev.attributes?.desc || ev.attributes?.name || '';
          if (EXCLUDE.test(name)) continue;
          const type = classifyType(name);
          if (!type) continue;
          const start = (ev.attributes?.start || '').replace(' ', 'T').slice(11, 16);
          const end   = (ev.attributes?.end   || '').replace(' ', 'T').slice(11, 16);
          if (!start) continue;
          sessions.push({ name, type, start: `${date}T${start}:00`, end: `${date}T${end}:00`,
            price: rink.price, openSlots: null, status: 'available',
            surface: rink.surface, registrationUrl: rink.website });
        }
      }
    } catch (_) {}
  }

  return sessions;
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { rink: rinkKey, date } = req.query;

  if (!rinkKey || !RINKS[rinkKey]) {
    return res.status(400).json({ sessions: [], error: `rink param required. Valid: ${Object.keys(RINKS).join(', ')}` });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ sessions: [], error: 'date param required: YYYY-MM-DD' });
  }

  const cacheKey = `sportsengine:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ sessions: cached.data, source: 'cache' });
  }

  const rink = RINKS[rinkKey];

  // Import cheerio — if not installed, return empty gracefully
  let cheerio;
  try {
    cheerio = await import('cheerio').then(m => m.default ?? m);
  } catch (e) {
    console.error('[scrape-sportsengine] cheerio not available:', e.message);
    cache.set(cacheKey, { ts: Date.now(), data: [] });
    return res.status(200).json({ sessions: [], error: 'cheerio not installed' });
  }

  try {
    const sessions = await fetchSESchedule(rink, date, cheerio);
    sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json({ sessions, source: 'live' });
  } catch (err) {
    console.error(`[scrape-sportsengine] ${rinkKey} error:`, err.message);
    cache.set(cacheKey, { ts: Date.now(), data: [] });
    return res.status(200).json({ sessions: [], error: err.message });
  }
};
