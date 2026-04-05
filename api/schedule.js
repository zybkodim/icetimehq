// /api/schedule.js — IceTimeHQ DaySmart Proxy
// v6 — facility bleed fix (post-filter by surface name), registration URL fix for The Rinks
// CommonJS (module.exports) — required for Vercel without "type":"module"

const DAYSMART_BASE = 'https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events';

// ─── CACHE (60 min) ──────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ─── CLEAN SESSION NAME ───────────────────────────────────────────────────────
// 1. Strip trailing date ranges:  "PI – Stick Time (3/23-3/29)" → "Stick Time"
// 2. Strip facility prefix codes: "PI – Stick Time" → "Stick Time"
// 3. Strip "GPI SKATER - Mon 5:30am" style prefixes → last meaningful part
function cleanName(raw) {
  let n = (raw || '').trim();
  // Strip trailing date ranges like (3/23-3/29) or (Mar 29-31)
  n = n.replace(/\s*\(\d{1,2}\/\d{1,2}[-–]\d{1,2}\/\d{1,2}\)\s*$/, '').trim();
  n = n.replace(/\s*\(Mar\s+\d+-\d+\)\s*$/, '').trim();
  // Strip facility prefix codes with dash/en-dash: "PI – ", "KHS – ", "GPI – "
  n = n.replace(/^[A-Z]{2,5}\s*[-–]\s*/, '').trim();
  // Strip "GPI SKATER - Mon 5:30am" → take everything after last " - "
  // These are program schedule labels, not session names
  if (/^[A-Z\s]+ - (Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/i.test(n)) {
    // e.g. "GPI SKATER - Mon 5:30am Open" → drop the facility+day prefix
    n = n.replace(/^[A-Z\s]+- (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s[\d:apm]+\s*/i, '').trim();
    if (!n) n = 'Open Session'; // fallback if nothing left
  }
  return n;
}

// ─── CLASSIFY by cleaned session name ────────────────────────────────────────
function classifySession(name) {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|free skate|figure|fs session|patch/.test(n))                              return 'freestyle';
  if (/pick[\s-]?up|pick up|drop[\s-]in|adult hock|open hock/.test(n))                              return 'pickup';
  if (/stick|shoot|puck|stick time|sticktime|open sticktime|open stick/.test(n))                    return 'stick';
  if (/public|open skat|general skat|family skat|adult skat|playground on ice|recreational|public session|open session/.test(n)) return 'public';
  return 'other';
}

// ─── EXCLUSION LIST ───────────────────────────────────────────────────────────
// NOTE: 'camp' removed — DaySmart uses "Camp" event type for stick time and
// freestyle blocks at The Rinks. We filter by name keywords only, not event type.
const EXCLUDE_KEYWORDS = [
  'learn to skate', 'lts', 'learn-to-skate',
  ' vs ', 'league game', 'tournament',
  'duck shin', 'shinny',
  'goalie',
  'clinic',
  'private', 'rental', 'staff', 'maintenance', 'resurfac', 'admin', 'test event',
  'coach', 'private lesson', 'inside edge', 'strength and cond',
];

function shouldExclude(cleanedName, resourceId) {
  if (resourceId === 21) return true;
  const n = cleanedName.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(kw => n.includes(kw))) return true;
  return false;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function parseTime(iso) {
  const m = (iso || '').match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

// ─── REGISTRATION URL ─────────────────────────────────────────────────────────
// The Rinks (company=rinks) uses a calendar URL with location= parameter.
// All other companies use the standard event-registration URL.
function buildRegUrl(company, date, facilityId) {
  if (company === 'rinks' && facilityId) {
    return `https://apps.daysmartrecreation.com/dash/x/#/online/rinks/calendar`
      + `?start=${date}&end=${date}&location=${facilityId}`;
  }
  return `https://apps.daysmartrecreation.com/dash/x/#/online/${company}/event-registration?date=${date}`;
}

function nextDateStr(date) {
  const [y, m, d] = date.split('-').map(Number);
  const nd = new Date(y, m - 1, d + 1);
  return [
    nd.getFullYear(),
    String(nd.getMonth() + 1).padStart(2, '0'),
    String(nd.getDate()).padStart(2, '0'),
  ].join('-');
}

// ─── BUILD URL (manual — never use URLSearchParams, it encodes brackets) ─────
function buildUrl(company, date, endDate, facilityId, includeStr) {
  const parts = [
    'cache[save]=false',
    'page[size]=50',
    'sort=end,start',
    `filter[start_date__gte]=${date}`,
    `filter[start_date__lte]=${endDate}`,
    'filter[unconstrained]=1',
    `company=${encodeURIComponent(company)}`,
  ];
  if (includeStr) parts.push(`include=${encodeURIComponent(includeStr)}`);
  if (facilityId) parts.push(`filter[facility_ids][]=${facilityId}`);
  return `${DAYSMART_BASE}?${parts.join('&')}`;
}

// ─── NORMALIZE ───────────────────────────────────────────────────────────────
// facilityFilter: optional lowercase substring to match against surface name.
// Used to prevent multi-facility bleed when company=rinks serves multiple venues.
function normalize(json, company, date, facilityId, facilityFilter) {
  const events   = json.data     || [];
  const included = json.included || [];

  const idx = {};
  for (const item of included) idx[`${item.type}::${item.id}`] = item;

  const sessions = [];
  let filteredByFacility = 0;

  for (const ev of events) {
    const attrs = ev.attributes || {};
    const rels  = ev.relationships || {};

    // ── Raw session name ──────────────────────────────────────────────────
    let rawName = '';
    let openSlots = null;
    let status = 'unknown';

    const sumRel = rels.summary?.data;
    if (sumRel) {
      const sum = idx[`${sumRel.type}::${sumRel.id}`];
      if (sum) {
        const sa  = sum.attributes || {};
        rawName   = sa.name || sa.desc || sa.title || '';
        openSlots = sa.open_slots ?? null;
        status    = sa.registration_status || 'unknown';
      }
    }
    if (!rawName) rawName = attrs.desc || attrs.name || attrs.title || '';

    // If summary name looks like it belongs to a different facility
    // (e.g. "GPI SKATER - Mon 5:30am" on a KHS event), fall back to
    // the event's own desc/name field which is more reliable
    if (facilityFilter && rawName) {
      const upperRaw = rawName.toUpperCase();
      const otherPrefixes = ['GPI ', 'AI-', 'AI ', 'LI-', 'LI ', 'PI -', 'PI–', 'COREY', 'CASEY'];
      const belongsToOther = otherPrefixes.some(p => upperRaw.startsWith(p));
      const belongsToUs = upperRaw.includes(facilityFilter.toUpperCase());
      if (belongsToOther && !belongsToUs) {
        // Summary is from another facility — use event attributes directly
        rawName = attrs.desc || attrs.name || attrs.title || rawName;
      }
    }

    // ── Clean the name ────────────────────────────────────────────────────
    const name = cleanName(rawName);

    // ── Resource / surface ────────────────────────────────────────────────
    let surface = null, resourceId = null;
    const resRel = rels.resource?.data;
    if (resRel) {
      resourceId = Number(resRel.id);
      const res  = idx[`${resRel.type}::${resRel.id}`];
      if (res) surface = res.attributes?.name || null;
    }

    // ── Facility filter: reject sessions from other venues ────────────────
    // DaySmart's facility_id param bleeds across facilities.
    // Post-filter by surface name when available.
    // If surface is null (resource data missing), trust facility_id did its job.
    if (facilityFilter && surface) {
      if (!surface.toLowerCase().includes(facilityFilter.toLowerCase())) {
        filteredByFacility++;
        continue;
      }
    }

    // ── Price ─────────────────────────────────────────────────────────────
    let price = null;
    const prodRel = rels['homeTeam.product']?.data || rels.product?.data;
    if (prodRel) {
      const prod = idx[`${prodRel.type}::${prodRel.id}`];
      if (prod) price = prod.attributes?.price ?? null;
    }

    // ── Exclude & classify ────────────────────────────────────────────────
    if (shouldExclude(name, resourceId)) continue;

    const type  = classifySession(name);
    const start = parseTime(attrs.start);
    const end   = parseTime(attrs.end);
    if (!start || !end) continue;

    sessions.push({
      id: ev.id, name, type, label: name,
      start, end,
      price:           price !== null ? Number(price) : null,
      openSlots, status, surface,
      registrationUrl: buildRegUrl(company, date, facilityId),
    });
  }

  // Sort by start time
  sessions.sort((a, b) => a.start.localeCompare(b.start));

  // ── Deduplicate same-time/surface/type ───────────────────────────────────
  const seen = new Set();
  const deduped = sessions.filter(s => {
    const key = `${s.start}::${s.end}::${s.surface || ''}::${s.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[schedule] ${company}${facilityFilter ? `(${facilityFilter})` : ''} ${date}: raw=${events.length} facilityFiltered=${filteredByFacility} kept=${deduped.length}`);
  return deduped;
}

// ─── FETCH (tries include strategies until one works) ─────────────────────────
// When facilityFilter is set we MUST have resource data to filter by surface.
// So we never fall back to the empty-include strategy in that case.
const INCLUDE_STRATEGIES_FULL = [
  'summary,resource,homeTeam.league,homeTeam.product,facility.address',
  'summary,resource',
  '',
];
const INCLUDE_STRATEGIES_FILTERED = [
  'summary,resource,homeTeam.league,homeTeam.product,facility.address',
  'summary,resource',
  // no empty fallback — we need resource to filter by surface
];

async function fetchDaySmart(company, date, facilityId, facilityFilter) {
  const endDate = nextDateStr(date);
  const headers = {
    'Accept':     'application/vnd.api+json, application/json',
    'User-Agent': 'IceTimeHQ/1.0 (+https://icetimehq.com)',
  };

  const strategies = facilityFilter ? INCLUDE_STRATEGIES_FILTERED : INCLUDE_STRATEGIES_FULL;

  for (const includeStr of strategies) {
    const url = buildUrl(company, date, endDate, facilityId, includeStr);
    console.log(`[schedule] Fetching company=${company} include="${includeStr || 'none'}"`);

    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    } catch (err) {
      console.error(`[schedule] Fetch error: ${err.message}`);
      continue;
    }

    console.log(`[schedule] Status ${res.status} company=${company}`);

    if (res.ok) {
      const json = await res.json();
      console.log(`[schedule] Raw events: ${(json.data || []).length}`);
      return { json, includeStr };
    }

    if (res.status >= 400 && res.status < 500) {
      const body = await res.text().catch(() => '');
      console.error(`[schedule] ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const errBody = await res.text().catch(() => '');
    console.warn(`[schedule] 500 with include="${includeStr}" — trying simpler. ${errBody.slice(0, 100)}`);
  }

  return null;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, date, facility_id, facility_filter, debug } = req.query;

  if (!company || !date) {
    return res.status(400).json({ error: 'Missing: company, date', sessions: [] });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD', sessions: [] });
  }

  // Include facility_filter in cache key so Poway and KHS cache separately
  const cacheKey = `${company}::${date}::${facility_id || ''}::${facility_filter || ''}`;

  if (!debug) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ sessions: hit, source: 'cache' });
    }
  }

  const result = await fetchDaySmart(company, date, facility_id || null, facility_filter || null);

  if (!result) {
    return res.status(200).json({
      sessions: [],
      error: 'All DaySmart strategies failed — check Vercel logs',
    });
  }

  const { json, includeStr } = result;

  // Debug mode — inspect raw DaySmart response
  if (debug === '1') {
    const allSurfaces = (json.included || [])
      .filter(i => i.type === 'resources')
      .map(i => i.attributes?.name || '(empty)');

    return res.status(200).json({
      _debug: true,
      facilityFilter:      facility_filter || null,
      includeStrategyUsed: includeStr,
      rawEventCount:       (json.data || []).length,
      allIncludedTypes:    [...new Set((json.included || []).map(i => i.type))],
      allSurfaces,
      sampleSummaryNames:  (json.included || [])
        .filter(i => i.type === 'event-summaries')
        .slice(0, 20)
        .map(i => ({
          raw:     i.attributes?.name || i.attributes?.desc || '(empty)',
          cleaned: cleanName(i.attributes?.name || i.attributes?.desc || ''),
          type:    classifySession(cleanName(i.attributes?.name || i.attributes?.desc || '')),
        })),
      sampleEvents: (json.data || []).slice(0, 3),
    });
  }

  const sessions = normalize(json, company, date, facility_id || null, facility_filter || null);
  cacheSet(cacheKey, sessions);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ sessions, source: 'live' });
};
