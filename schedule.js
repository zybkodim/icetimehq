// ─────────────────────────────────────────────────────────────────────────────
// /api/schedule.js — IceTimeHQ DaySmart API Proxy
// Vercel Serverless Function
//
// Query params:
//   company      (required) — e.g. "ashburn", "skatequest", "capitals", "sdia", "rinks"
//   date         (required) — YYYY-MM-DD
//   facility_id  (optional) — only needed for company=rinks (Poway = "4")
//   debug        (optional) — set to "1" to return raw API response for debugging
// ─────────────────────────────────────────────────────────────────────────────

const DAYSMART_BASE = 'https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events';

// ─── IN-MEMORY CACHE (60 min TTL) ────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── SESSION TYPE CLASSIFIER ──────────────────────────────────────────────────
// Patterns cover real-world DaySmart session names across DC Metro and SD rinks.
// Order matters — more specific matches come first.
// If a session name doesn't match any pattern it is kept as type "other" and
// shown rather than silently dropped (helps catch new session types).
function classifySession(name) {
  const n = (name || '').toLowerCase();

  // Freestyle / figure skating (check before 'public' to avoid false matches)
  if (/freestyle|freeskate|free skate|figure|fs session|patch/.test(n)) return 'freestyle';

  // Pickup hockey
  if (/pickup|pick[\s-]up|drop[\s-]in|adult hock|shinny|open hock/.test(n)) return 'pickup';

  // Stick & Puck
  if (/stick|shoot|puck/.test(n)) return 'stick';

  // Public skating — broadened to catch common variants
  if (/public|open skat|general skat|family skat|adult skat|playground on ice|tot|learn to skat|recreational/.test(n)) return 'public';

  // Fallback: return 'other' so we still show it rather than silently drop
  return 'other';
}

// Map 'other' to a neutral display color (muted blue-grey)
// The frontend already handles all 4 defined types; 'other' sessions use
// whatever default bg the class provides (transparent).

// ─── FILTER: should this event be excluded entirely? ─────────────────────────
function shouldExclude(event, summaryName, resourceId) {
  const n = (summaryName || '').toLowerCase();

  // Exclude private coach resource at Ashburn (resource_id === 21)
  if (resourceId === 21) return true;

  // Exclude clearly internal/staff events by name
  if (/\bcoach\b|guest coach|private lesson instructor|inside edge training|strength and conditioning|staff|maintenance|ice resurfac|rental setup|locker|admin|test event/.test(n)) return true;

  // Exclude league games and tournaments (not drop-in public sessions)
  if (/\bleague\b|\btournament\b|\bgame\b|\bmatch\b/.test(n)) return true;

  // IMPORTANT: do NOT exclude on register_capacity === 0 alone — some rinks
  // legitimately set 0 for "walk-in only" sessions (no online registration).
  // Only exclude if capacity is 0 AND the name looks internal.
  const attrs = event.attributes || {};
  if (attrs.register_capacity === 0 && !attrs.hteam_id && n.length < 3) return true;

  return false;
}

// ─── PARSE TIME from ISO datetime → "HH:MM" ──────────────────────────────────
function parseTime(iso) {
  if (!iso) return null;
  const match = iso.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

// ─── BUILD REGISTRATION URL ───────────────────────────────────────────────────
function buildRegUrl(company, date, facilityId) {
  let url = `https://apps.daysmartrecreation.com/dash/x/#/online/${company}/event-registration?date=${date}`;
  if (facilityId) url += `&facility_ids=${facilityId}`;
  return url;
}

// ─── NORMALIZE RAW DAYSMART RESPONSE ─────────────────────────────────────────
function normalizeResponse(json, company, date, facilityId) {
  const events = json.data || [];
  const included = json.included || [];

  // Index included objects by type::id for fast lookup
  const byTypeId = {};
  for (const item of included) {
    byTypeId[`${item.type}::${item.id}`] = item;
  }

  const sessions = [];
  const skipped = [];  // for debug logging

  for (const event of events) {
    const attrs = event.attributes || {};
    const rels = event.relationships || {};

    // ── Resolve summary (session name, slots, status) ─────────────────────
    let summaryName = '';
    let openSlots = null;
    let regStatus = 'unknown';

    const summaryRel = rels.summary?.data;
    if (summaryRel) {
      const summary = byTypeId[`${summaryRel.type}::${summaryRel.id}`];
      if (summary) {
        const sa = summary.attributes || {};
        summaryName = sa.name || sa.desc || '';
        openSlots = sa.open_slots ?? null;
        regStatus = sa.registration_status || 'unknown';
      }
    }

    // SDIA and some other rinks: name lives directly on the event
    if (!summaryName) {
      summaryName = attrs.desc || attrs.name || attrs.title || '';
    }

    // ── Resolve resource (rink surface name) ──────────────────────────────
    let surface = null;
    let resourceId = null;
    const resourceRel = rels.resource?.data;
    if (resourceRel) {
      resourceId = Number(resourceRel.id);
      const resource = byTypeId[`${resourceRel.type}::${resourceRel.id}`];
      if (resource) surface = resource.attributes?.name || null;
    }

    // ── Resolve price from homeTeam.product or product relationship ────────
    let price = null;
    const productRel = rels['homeTeam.product']?.data || rels.product?.data;
    if (productRel) {
      const product = byTypeId[`${productRel.type}::${productRel.id}`];
      if (product) price = product.attributes?.price ?? null;
    }

    // ── Exclusion check ───────────────────────────────────────────────────
    if (shouldExclude(event, summaryName, resourceId)) {
      skipped.push({ id: event.id, name: summaryName, reason: 'excluded' });
      continue;
    }

    // ── Classify session type ─────────────────────────────────────────────
    const type = classifySession(summaryName);

    // ── Times ─────────────────────────────────────────────────────────────
    const start = parseTime(attrs.start);
    const end   = parseTime(attrs.end);
    if (!start || !end) {
      skipped.push({ id: event.id, name: summaryName, reason: 'no-time' });
      continue;
    }

    sessions.push({
      id:              event.id,
      name:            summaryName,
      type,
      label:           summaryName,
      start,
      end,
      price:           price !== null ? Number(price) : null,
      openSlots,
      status:          regStatus,
      surface,
      registrationUrl: buildRegUrl(company, date, facilityId),
    });
  }

  sessions.sort((a, b) => a.start.localeCompare(b.start));

  if (skipped.length > 0) {
    console.log(`[schedule] ${company} ${date}: kept=${sessions.length} skipped=${skipped.length}`, JSON.stringify(skipped));
  }

  return sessions;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, date, facility_id, debug } = req.query;

  // ── Validate ───────────────────────────────────────────────────────────────
  if (!company || !date) {
    return res.status(400).json({ error: 'Missing required params: company, date', sessions: [] });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD', sessions: [] });
  }

  // ── Cache lookup (skip if debug mode) ──────────────────────────────────────
  const cacheKey = `${company}::${date}::${facility_id || ''}`;
  if (!debug) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ sessions: cached, source: 'cache' });
    }
  }

  // ── Build DaySmart request URL ─────────────────────────────────────────────
  // IMPORTANT: URLSearchParams encodes brackets as %5B%5D which breaks DaySmart.
  // Build the query string manually to keep literal brackets in parameter names.
  const dateParts = date.split('-').map(Number);
  const nextDay = new Date(dateParts[0], dateParts[1] - 1, dateParts[2] + 1);
  const endDate = [
    nextDay.getFullYear(),
    String(nextDay.getMonth() + 1).padStart(2, '0'),
    String(nextDay.getDate()).padStart(2, '0'),
  ].join('-');

  const qsParts = [
    'cache[save]=false',
    'page[size]=50',
    'sort=end,start',
    'include=summary,resource,homeTeam.league,homeTeam.product,facility.address',
    `filter[start_date__gte]=${date}`,
    `filter[start_date__lte]=${endDate}`,
    'filter[unconstrained]=1',
    `company=${encodeURIComponent(company)}`,
  ];

  if (facility_id) {
    qsParts.push(`filter[facility_id]=${encodeURIComponent(facility_id)}`);
  }

  const apiUrl = `${DAYSMART_BASE}?${qsParts.join('&')}`;
  console.log(`[schedule] Fetching: ${apiUrl}`);

  // ── Fetch from DaySmart ────────────────────────────────────────────────────
  try {
    const upstream = await fetch(apiUrl, {
      headers: {
        'Accept':     'application/vnd.api+json, application/json',
        'User-Agent': 'IceTimeHQ/1.0 (+https://icetimehq.com)',
      },
      signal: AbortSignal.timeout(9000),  // 9s timeout (Vercel limit is 10s)
    });

    console.log(`[schedule] DaySmart response: ${upstream.status} for company=${company} date=${date}`);

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      console.error(`[schedule] DaySmart error body: ${body.slice(0, 300)}`);
      return res.status(200).json({
        sessions: [],
        error: `Upstream returned ${upstream.status}`,
        debug: debug ? { url: apiUrl, status: upstream.status, body: body.slice(0, 500) } : undefined,
      });
    }

    const json = await upstream.json();

    // Debug mode: return raw response so you can inspect real field names
    if (debug === '1') {
      return res.status(200).json({
        _debug: true,
        url: apiUrl,
        rawEventCount: (json.data || []).length,
        rawIncludedCount: (json.included || []).length,
        sampleEvents: (json.data || []).slice(0, 3),
        sampleIncluded: (json.included || []).slice(0, 5),
        allIncludedTypes: [...new Set((json.included || []).map(i => i.type))],
        sampleSummaryNames: (json.included || [])
          .filter(i => i.type === 'event-summaries')
          .slice(0, 10)
          .map(i => i.attributes?.name || i.attributes?.desc || '(empty)'),
      });
    }

    const sessions = normalizeResponse(json, company, date, facility_id || null);
    console.log(`[schedule] Normalized: ${sessions.length} sessions for ${company} on ${date}`);

    cacheSet(cacheKey, sessions);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ sessions, source: 'live' });

  } catch (err) {
    console.error(`[schedule] Fetch error for ${company} ${date}: ${err.name} — ${err.message}`);
    return res.status(200).json({
      sessions: [],
      error: `${err.name}: ${err.message}`,
    });
  }
}
