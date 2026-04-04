// api/scrape-statichtml.js
// Static HTML scraper — config-driven, covers all SH1 rinks
// CommonJS (module.exports) — required for Vercel without "type":"module"
//
// Strategies:
//   A "fixed-weekly"      — hardcoded weekly schedule in config
//   B "civicplus"         — CivicPlus/CivicEngage government CMS calendar
//   C "wordpress-mycal"   — WordPress MyCal/Events plugin calendar
//
// ADDING A NEW RINK: add one entry to RINKS below, deploy. No other changes.

// Uses native fetch (Node.js 18+ / Vercel runtime)

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Classify ──────────────────────────────────────────────────────────────────
function classifyType(name = '') {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))  return 'freestyle';
  if (/stick|shoot|puck/.test(n))            return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))    return 'pickup';
  if (/public|open skat|adult skat/.test(n)) return 'public';
  return 'public'; // default — all sessions at these rinks are public-facing
}

const EXCLUDE = /game|learn.to.skat|lts|duck shinny|goalie.only|private|tournament|birthday|party|lesson|class|clinic|camp/i;

// ── Config — metadata from rinks.json, schedule data inline ──────────────────
const fs   = require('fs');
const path = require('path');
const _allRinks = JSON.parse(fs.readFileSync(path.join(__dirname, 'rinks.json'), 'utf8'));
const _shMeta   = Object.fromEntries(
  Object.values(_allRinks)
    .filter(r => r.scraper_file === 'api/scrape-statichtml.js' && r.scraper_key)
    .map(r => [r.scraper_key, r])
);

// Schedule data stays here — rinks.json only stores metadata
const RINK_SCHEDULES = {

  // ── STRATEGY A: Fixed weekly ──────────────────────────────────────────────

  smithfield: {
    strategy: 'fixed-weekly',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    5.00,
    schedule: {
      0: [],
      1: [{ start: '11:00', end: '12:30', name: 'Public Hockey', type: 'pickup' }],
      2: [{ start: '12:00', end: '13:30', name: 'Public Skate',  type: 'public' }],
      3: [],
      4: [{ start: '11:00', end: '12:30', name: 'Public Hockey', type: 'pickup' }],
      5: [{ start: '12:00', end: '13:30', name: 'Public Skate',  type: 'public' }],
      6: [],
    },
  },

  burbank: {
    strategy: 'fixed-weekly',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    8.00,
    schedule: {
      0: [{ start: '18:00', end: '19:15', name: 'Public Skate', type: 'public' }],
      1: [{ start: '11:00', end: '13:00', name: 'Public Skate', type: 'public' }],
      2: [{ start: '12:00', end: '13:50', name: 'Public Skate', type: 'public' }],
      3: [{ start: '12:30', end: '14:30', name: 'Public Skate', type: 'public' }],
      4: [{ start: '11:00', end: '13:00', name: 'Public Skate', type: 'public' }],
      5: [{ start: '12:00', end: '13:50', name: 'Public Skate', type: 'public' }],
      6: [],
    },
  },

  norfolk: {
    strategy: 'fixed-weekly',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    null,
    schedule: {
      0: [{ start: '13:00', end: '14:50', name: 'Public Skate', type: 'public' }],
      1: [], 2: [], 3: [], 4: [], 5: [],
      6: [{ start: '19:00', end: '20:50', name: 'Public Skate', type: 'public' }],
    },
  },

  bennymagiera: {
    strategy: 'fixed-weekly',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    10.00,
    schedule: {
      0: [],
      1: [],
      2: [{ start: '13:30', end: '16:30', name: 'Stick & Puck', type: 'stick' }],
      3: [],
      4: [{ start: '13:30', end: '16:30', name: 'Stick & Puck', type: 'stick' }],
      5: [{ start: '13:30', end: '16:30', name: 'Stick & Puck', type: 'stick' }],
      6: [],
    },
  },

  // ── STRATEGY B: CivicPlus HTML ────────────────────────────────────────────

  stoneham: {
    strategy:    'civicplus',
    calendarUrl: 'https://www.stoneham-ma.gov/calendar.aspx',
    calendarCid: '26',
    surface:     'Ice',
    timezone:    'America/New_York',
    price:       10.00,
    sessionTypes: ['Public Skating', 'Public Stick', 'Adult Stick'],
  },

  loring: {
    strategy:        'civicplus',
    calendarUrl:     'https://www.framinghamma.gov/calendar.aspx',
    calendarCid:     null,
    calendarKeyword: 'skate',
    surface:         'Ice',
    timezone:        'America/New_York',
    price:           null,
    sessionTypes:    ['Public Skate', 'Stick Time', 'Public Skating'],
  },

  // ── STRATEGY C: WordPress MyCal ──────────────────────────────────────────

  daly: {
    strategy:    'wordpress-mycal',
    calendarUrl: 'https://www.dalyrink.org/calendar/',
    surface:     'Ice',
    timezone:    'America/New_York',
    price:       8.00,
    seasonStart: { month: 9,  day: 1  },
    seasonEnd:   { month: 4,  day: 15 },
  },

};

// Merge metadata from rinks.json with schedule data
const RINKS = Object.fromEntries(
  Object.entries(RINK_SCHEDULES).map(([key, sched]) => {
    const meta = _shMeta[key] || {};
    return [key, { ...sched, name: meta.name || key, website: meta.website || '#' }];
  })
);
// ── Helpers ───────────────────────────────────────────────────────────────────

function to24h(h, m, period) {
  let hr = parseInt(h, 10);
  const min = String(m || '00').padStart(2, '0');
  if (period.toUpperCase() === 'PM' && hr !== 12) hr += 12;
  if (period.toUpperCase() === 'AM' && hr === 12) hr = 0;
  return `${String(hr).padStart(2, '0')}:${min}`;
}

function shouldKeep(text, rink) {
  if (EXCLUDE.test(text)) return false;
  if (!rink.sessionTypes) return true;
  return rink.sessionTypes.some(t => text.toLowerCase().includes(t.toLowerCase()));
}

const timePatternGlobal = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}):(\d{2})\s*(AM|PM)/gi;

function parseTimeMatch(timeStr, context, date, rink) {
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const start = to24h(m[1], m[2], m[3]);
  const end   = to24h(m[4], m[5], m[6]);
  const nameLine = context.replace(timeStr, '').replace(/\s+/g, ' ').trim().substring(0, 60);
  const name = nameLine || 'Public Skate';
  return {
    name:            name.substring(0, 50),
    type:            classifyType(name),
    start:           `${date}T${start}:00`,
    end:             `${date}T${end}:00`,
    price:           rink.price,
    openSlots:       null,
    status:          'available',
    surface:         rink.surface,
    registrationUrl: rink.website,
  };
}

function parseEventTitle(title, date, rink) {
  const m = title.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  return parseTimeMatch(m[0], title, date, rink);
}

// ── Strategy A ────────────────────────────────────────────────────────────────
function buildFixedWeekly(rink, date) {
  const dow = new Date(date + 'T12:00:00').getDay();
  const slots = rink.schedule[dow] || [];
  return slots.map(slot => ({
    name:            slot.name || 'Public Skate',
    type:            slot.type || 'public',
    start:           `${date}T${slot.start}:00`,
    end:             `${date}T${slot.end}:00`,
    price:           rink.price,
    openSlots:       null,
    status:          'available',
    surface:         rink.surface,
    registrationUrl: rink.website,
  }));
}

// ── Strategy B ────────────────────────────────────────────────────────────────
async function fetchCivicPlus(rink, date, cheerio) {
  const [year, month] = date.split('-');
  const params = new URLSearchParams({ month, year });
  if (rink.calendarCid) params.set('CID', rink.calendarCid);
  const url = `${rink.calendarUrl}?${params}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`CivicPlus fetch failed: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const sessions = [];

  $('[data-start], [datetime]').each((_, el) => {
    const dtStr = $(el).attr('data-start') || $(el).attr('datetime') || '';
    if (!dtStr.startsWith(date)) return;
    const title = $(el).text().trim() || $(el).attr('title') || '';
    if (shouldKeep(title, rink)) {
      const session = parseEventTitle(title, date, rink);
      if (session) sessions.push(session);
    }
  });

  if (sessions.length === 0) {
    const pageText = $('body').text();
    const lines = pageText.split('\n');
    const timePattern = /(\d{1,2}:\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}:\d{2})\s*(AM|PM)/gi;
    for (const line of lines) {
      if (!line.includes(date) && !line.match(/\d{1,2}:\d{2}\s*(?:AM|PM)/i)) continue;
      if (!shouldKeep(line, rink)) continue;
      const timeMatch = line.match(timePattern);
      if (timeMatch) {
        const s = parseTimeMatch(timeMatch[0], line, date, rink);
        if (s) sessions.push(s);
      }
    }
  }

  if (sessions.length === 0) {
    const listUrl = `${rink.calendarUrl}?${params}&format=list`;
    try {
      const listRes = await fetch(listUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      if (listRes.ok) {
        const listHtml = await listRes.text();
        const $l = cheerio.load(listHtml);
        const tp = /(\d{1,2}:\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}:\d{2})\s*(AM|PM)/gi;
        $l('.events-list-item, .calendar-listing, .fc-list-item').each((_, el) => {
          const text = $l(el).text();
          if (!text.includes(date.replace(/-/g, '/')) &&
              !text.includes(`${parseInt(date.split('-')[2])} `)) return;
          if (!shouldKeep(text, rink)) return;
          const timeMatch = text.match(tp);
          if (timeMatch) {
            const s = parseTimeMatch(timeMatch[0], text, date, rink);
            if (s) sessions.push(s);
          }
        });
      }
    } catch (_) {}
  }

  return sessions;
}

// ── Strategy C ────────────────────────────────────────────────────────────────
async function fetchWordPressMyCal(rink, date, cheerio) {
  const [year, month, day] = date.split('-').map(Number);

  if (rink.seasonStart && rink.seasonEnd) {
    const { seasonStart: ss, seasonEnd: se } = rink;
    const inSeason = (month > ss.month || (month === ss.month && day >= ss.day)) &&
                     (month < se.month  || (month === se.month  && day <= se.day));
    if (!inSeason) return [];
  }

  const url = `${rink.calendarUrl}?yr=${year}&month=${month}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`WordPress calendar fetch failed: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const sessions = [];

  $('td').each((_, td) => {
    const tdId = $(td).attr('id') || '';
    const dayMatch = tdId.match(/^mc_calendar_(\d{1,2})_/);
    if (!dayMatch || parseInt(dayMatch[1], 10) !== day) return;

    const cellText = $(td).text();
    const tp = /(\d{1,2}:\d{2})\s*(am|pm)\s*[-–]+\s*(\d{1,2}:\d{2})\s*(am|pm)/gi;
    let match;
    while ((match = tp.exec(cellText)) !== null) {
      const beforeTime = cellText.slice(0, match.index).replace(/\d+\s*$/, '').trim();
      const eventName = beforeTime.split(/\n/).filter(Boolean).pop()?.trim() || 'Public Skate';
      if (EXCLUDE.test(eventName)) continue;
      const start = to24h(...match[1].split(':'), match[2]);
      const end   = to24h(...match[3].split(':'), match[4]);
      sessions.push({
        name:            eventName || 'Public Skate',
        type:            classifyType(eventName),
        start:           `${date}T${start}:00`,
        end:             `${date}T${end}:00`,
        price:           rink.price,
        openSlots:       null,
        status:          'available',
        surface:         rink.surface,
        registrationUrl: rink.website,
      });
    }
  });

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

  const cacheKey = `statichtml:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ sessions: cached.data, source: 'cache' });
  }

  const rink = RINKS[rinkKey];

  try {
    let sessions = [];

    if (rink.strategy === 'fixed-weekly') {
      sessions = buildFixedWeekly(rink, date);
    } else {
      // Only import cheerio for strategies that need it
      let cheerio;
      try {
        cheerio = await import('cheerio').then(m => m.default ?? m);
      } catch (e) {
        console.error('[scrape-statichtml] cheerio not available:', e.message);
        cache.set(cacheKey, { ts: Date.now(), data: [] });
        return res.status(200).json({ sessions: [], error: 'cheerio not installed' });
      }

      switch (rink.strategy) {
        case 'civicplus':
          sessions = await fetchCivicPlus(rink, date, cheerio);
          break;
        case 'wordpress-mycal':
          sessions = await fetchWordPressMyCal(rink, date, cheerio);
          break;
        default:
          return res.status(400).json({ sessions: [], error: `Unknown strategy: ${rink.strategy}` });
      }
    }

    sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json({ sessions, source: rink.strategy === 'fixed-weekly' ? 'static' : 'live' });

  } catch (err) {
    console.error(`[scrape-statichtml] ${rinkKey} error:`, err.message);
    if (rink.strategy !== 'fixed-weekly') {
      cache.set(cacheKey, { ts: Date.now(), data: [] });
      return res.status(200).json({ sessions: [], error: err.message });
    }
    return res.status(500).json({ sessions: [], error: err.message });
  }
};
