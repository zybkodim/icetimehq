// ─────────────────────────────────────────────────────────────────────────────
// /api/schedule.js — IceTimeHQ DaySmart API Proxy
// Vercel Serverless Function
//
// Query params:
//   company      (required) — e.g. "ashburn", "skatequest", "capitals", "sdia", "rinks"
//   date         (required) — YYYY-MM-DD
//   facility_id  (optional) — only needed for company=rinks (Poway = "4")
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
function classifySession(name) {
  const n = (name || '').toLowerCase();
  if (/public|playground on ice|adult skate/.test(n))          return 'public';
  if (/stick|shoot|puck/.test(n))                               return 'stick';
  if (/pickup|pick up|drop-in hockey|adult pickup/.test(n))     return 'pickup';
  if (/freestyle|freeskate|figure/.test(n))                     return 'freestyle';
  return null; // unknown — will be filtered out
}

// ─── FILTER: should this event be excluded? ───────────────────────────────────
function shouldExclude(event, summaryName, resourceId) {
  // Exclude private coach resource at Ashburn
  if (resourceId === 21) return true;

  const n = (summaryName || '').toLowerCase();
  if (/coach|guest coach|private lesson instructor|inside edge training|strength and conditioning/.test(n)) return true;

  // No capacity + no team = internal block
  const attrs = event.attributes || {};
  if (attrs.register_capacity === 0 && !attrs.hteam_id) return true;

  return false;
}

// ─── PARSE TIME from ISO datetime → "HH:MM" ──────────────────────────────────
function parseTime(iso) {
  if (!iso) return null;
  // Format: "2026-03-24T06:40:00" or with timezone offset
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

  // Index included objects by type + id for fast lookup
  const byTypeId = {};
  for (const item of included) {
    const key = `${item.type}::${item.id}`;
    byTypeId[key] = item;
  }

  const sessions = [];

  for (const event of events) {
    const attrs = event.attributes || {};
    const rels = event.relationships || {};

    // ── Resolve summary (session name) ────────────────────────────────────
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

    // SDIA fallback: uses attributes.desc directly (no homeTeam)
    if (!summaryName) {
      summaryName = attrs.desc || attrs.name || '';
    }

    // ── Resolve resource (rink surface) ───────────────────────────────────
    let surface = null;
    let resourceId = null;
    const resourceRel = rels.resource?.data;
    if (resourceRel) {
      resourceId = Number(resourceRel.id);
      const resource = byTypeId[`${resourceRel.type}::${resourceRel.id}`];
      if (resource) surface = resource.attributes?.name || null;
    }

    // ── Resolve price ──────────────────────────────────────────────────────
    let price = null;
    const productRel = rels['homeTeam.product']?.data || rels.product?.data;
    if (productRel) {
      const product = byTypeId[`${productRel.type}::${productRel.id}`];
      if (product) price = product.attributes?.price ?? null;
    }

    // ── Filter check ──────────────────────────────────────────────────────
    if (shouldExclude(event, summaryName, resourceId)) continue;

    // ── Classify session type ─────────────────────────────────────────────
    const type = classifySession(summaryName);
    if (!type) continue; // skip sessions we can't classify

    // ── Times ─────────────────────────────────────────────────────────────
    const start = parseTime(attrs.start);
    const end   = parseTime(attrs.end);
    if (!start || !end) continue;

    sessions.push({
      id:              event.id,
      name:            summaryName,
      type,
      label:           summaryName,   // frontend uses label for display
      start,
      end,
      price:           price !== null ? Number(price) : null,
      openSlots,
      status:          regStatus,
      surface,
      registrationUrl: buildRegUrl(company, date, facilityId),
    });
  }

  // Sort by start time
  sessions.sort((a, b) => a.start.localeCompare(b.start));
  return sessions;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — allow requests from our own domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, date, facility_id } = req.query;

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!company || !date) {
    return res.status(400).json({ error: 'Missing required params: company, date', sessions: [] });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD', sessions: [] });
  }

  // ── Cache lookup ───────────────────────────────────────────────────────────
  const cacheKey = `${company}::${date}::${facility_id || ''}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ sessions: cached, source: 'cache' });
  }

  // ── Build DaySmart URL ─────────────────────────────────────────────────────
  // end date = date + 1 day (API is exclusive on upper bound)
  const dateParts = date.split('-').map(Number);
  const nextDay = new Date(dateParts[0], dateParts[1] - 1, dateParts[2] + 1);
  const endDate = `${nextDay.getFullYear()}-${String(nextDay.getMonth()+1).padStart(2,'0')}-${String(nextDay.getDate()).padStart(2,'0')}`;

  const params = new URLSearchParams({
    'cache[save]':          'false',
    'page[size]':           '50',
    'sort':                 'end,start',
    'include':              'summary,resource,homeTeam.league,homeTeam.product,facility.address',
    'filter[start_date__gte]': date,
    'filter[start_date__lte]': endDate,
    'filter[unconstrained]':   '1',
    'company':              company,
  });

  if (facility_id) {
    params.set('filter[facility_id]', facility_id);
  }

  const apiUrl = `${DAYSMART_BASE}?${params.toString()}`;

  // ── Fetch from DaySmart ────────────────────────────────────────────────────
  try {
    const upstream = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'User-Agent': 'IceTimeHQ/1.0',
      },
      // Ignore DaySmart's Cache-Control: no-cache — we cache on our side
      cache: 'no-store',
    });

    if (!upstream.ok) {
      console.error(`DaySmart non-200: ${upstream.status} for ${company} on ${date}`);
      return res.status(200).json({ sessions: [], error: `Upstream returned ${upstream.status}` });
    }

    const json = await upstream.json();
    const sessions = normalizeResponse(json, company, date, facility_id || null);

    // Cache the result
    cacheSet(cacheKey, sessions);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ sessions, source: 'live' });

  } catch (err) {
    console.error(`DaySmart fetch error for ${company} ${date}:`, err.message);
    return res.status(200).json({ sessions: [], error: err.message });
  }
}
