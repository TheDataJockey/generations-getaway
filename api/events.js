/**
 * Generations Getaway LLC
 * GET /api/events
 * ================
 * Returns events for a given month from Supabase,
 * filtered by type, source, and radius from the property.
 *
 * Also contains placeholder stub functions for future
 * integration with Eventbrite, Ticketmaster, and Google Events.
 * These stubs are wired in but return empty arrays until
 * API keys are configured in Vercel environment variables.
 *
 * Property: 647 NE 16th Terrace, Fort Lauderdale FL 33304
 * Coordinates: 26.1420, -80.1278
 *
 * Query params:
 *   year    — 4-digit year (default: current)
 *   month   — 1-12 (default: current)
 *   type    — event_type filter (optional)
 *   source  — source filter (optional)
 *   radius  — miles from property (optional)
 *   lat     — requester latitude (optional, defaults to property)
 *   lng     — requester longitude (optional, defaults to property)
 *
 * Security:
 *  - Read-only, public endpoint
 *  - Only returns active events with active sources
 *  - API keys stored in env vars, never exposed
 *  - CORS open for public event browsing
 */

import { createClient } from '@supabase/supabase-js';

// Strip any trailing /rest/v1 from URL
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Property coordinates ──
const PROPERTY_LAT = 26.1420;
const PROPERTY_LNG = -80.1278;

export default async function handler(req, res) {
  // ── CORS — public endpoint ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;
    const type  = req.query.type   || '';
    const source = req.query.source || '';
    const radius = parseFloat(req.query.radius) || null;
    const lat   = parseFloat(req.query.lat) || PROPERTY_LAT;
    const lng   = parseFloat(req.query.lng) || PROPERTY_LNG;

    // ── Date range for the requested month ──
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDate   = new Date(year, month, 0).toISOString().split('T')[0];

    // ── Query Supabase events table ──
    let query = supabase
      .from('events')
      .select(`
        id, name, description, short_description,
        event_date, start_time, end_time,
        venue_name, address, city, state,
        latitude, longitude,
        event_type, source, source_url,
        image_url, ticket_url,
        price_min, price_max, is_free,
        is_active, source_active
      `)
      .eq('is_active', true)
      .eq('source_active', true)
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .order('event_date', { ascending: true })
      .order('start_time', { ascending: true });

    if (type)   query = query.eq('event_type', type);
    if (source) query = query.eq('source', source);

    const { data: dbEvents, error } = await query;
    if (error) throw error;

    // ── Pull from external sources (stubs — activate when API keys set) ──
    const [
      eventbriteEvents,
      ticketmasterEvents,
      googleEvents,
    ] = await Promise.all([
      fetchEventbrite(year, month, lat, lng),
      fetchTicketmaster(year, month, lat, lng),
      fetchGoogleEvents(year, month, lat, lng),
    ]);

    // ── Merge all sources ──
    let allEvents = [
      ...(dbEvents || []),
      ...eventbriteEvents,
      ...ticketmasterEvents,
      ...googleEvents,
    ];

    // ── Apply source filter to merged results ──
    if (source) {
      allEvents = allEvents.filter(e => e.source === source);
    }

    // ── Apply type filter to merged results ──
    if (type) {
      allEvents = allEvents.filter(e => e.event_type === type);
    }

    // ── Apply radius filter ──
    if (radius) {
      allEvents = allEvents.filter(e => {
        if (!e.latitude || !e.longitude) return true;
        return haversineDistance(lat, lng, e.latitude, e.longitude) <= radius;
      });
    }

    // ── Deduplicate by source + source_event_id ──
    const seen = new Set();
    allEvents = allEvents.filter(e => {
      if (!e.source_event_id) return true;
      const key = `${e.source}:${e.source_event_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ events: allEvents, total: allEvents.length });

  } catch (err) {
    console.error('[/api/events]', err.message);
    return res.status(500).json({ error: 'Failed to load events.', events: [] });
  }
}

// ════════════════════════════════════════════════════════
// EXTERNAL SOURCE STUBS
// Activate each by adding the corresponding API key
// to Vercel environment variables.
// ════════════════════════════════════════════════════════

/**
 * Fetch events from Eventbrite API.
 * Activate by setting EVENTBRITE_API_KEY in Vercel env vars.
 *
 * @param {number} year
 * @param {number} month
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<Array>}
 */
async function fetchEventbrite(year, month, lat, lng) {
  const apiKey = process.env.EVENTBRITE_API_KEY;
  if (!apiKey) return []; // Not yet configured

  try {
    const startDate = `${year}-${String(month).padStart(2,'0')}-01T00:00:00`;
    const endDate   = new Date(year, month, 0).toISOString().split('T')[0] + 'T23:59:59';

    const url = new URL('https://www.eventbriteapi.com/v3/events/search/');
    url.searchParams.set('location.latitude',  lat);
    url.searchParams.set('location.longitude', lng);
    url.searchParams.set('location.within',    '50mi');
    url.searchParams.set('start_date.range_start', startDate);
    url.searchParams.set('start_date.range_end',   endDate);
    url.searchParams.set('expand', 'venue');
    url.searchParams.set('page_size', '100');

    const res  = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await res.json();

    return (data.events || []).map(e => ({
      id:              `eb-${e.id}`,
      source_event_id: e.id,
      source:          'eventbrite',
      name:            e.name?.text || '',
      description:     e.description?.text?.substring(0, 500) || '',
      event_date:      e.start?.local?.split('T')[0] || '',
      start_time:      e.start?.local || null,
      end_time:        e.end?.local   || null,
      venue_name:      e.venue?.name  || '',
      address:         e.venue?.address?.localized_address_display || '',
      city:            e.venue?.address?.city || 'Fort Lauderdale',
      latitude:        parseFloat(e.venue?.latitude)  || null,
      longitude:       parseFloat(e.venue?.longitude) || null,
      ticket_url:      e.url || null,
      is_free:         e.is_free || false,
      price_min:       e.ticket_availability?.minimum_ticket_price?.major_value || null,
      image_url:       e.logo?.url || null,
      event_type:      'other',
      is_active:       true,
      source_active:   true,
    }));

  } catch (err) {
    console.error('[Eventbrite]', err.message);
    return [];
  }
}

/**
 * Fetch events from Ticketmaster Discovery API.
 * Activate by setting TICKETMASTER_API_KEY in Vercel env vars.
 *
 * @param {number} year
 * @param {number} month
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<Array>}
 */
async function fetchTicketmaster(year, month, lat, lng) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return []; // Not yet configured

  try {
    const startDate = `${year}-${String(month).padStart(2,'0')}-01T00:00:00Z`;
    const endDate   = new Date(year, month, 0).toISOString().replace('.000', '');

    const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    url.searchParams.set('apikey',       apiKey);
    url.searchParams.set('latlong',      `${lat},${lng}`);
    url.searchParams.set('radius',       '50');
    url.searchParams.set('unit',         'miles');
    url.searchParams.set('startDateTime', startDate);
    url.searchParams.set('endDateTime',   endDate);
    url.searchParams.set('size',         '100');
    url.searchParams.set('sort',         'date,asc');

    const res  = await fetch(url.toString());
    const data = await res.json();
    const events = data?._embedded?.events || [];

    return events.map(e => {
      const venue    = e._embedded?.venues?.[0];
      const dateInfo = e.dates?.start;
      return {
        id:              `tm-${e.id}`,
        source_event_id: e.id,
        source:          'ticketmaster',
        name:            e.name || '',
        description:     e.info || e.pleaseNote || '',
        event_date:      dateInfo?.localDate || '',
        start_time:      dateInfo?.localDate && dateInfo?.localTime
          ? `${dateInfo.localDate}T${dateInfo.localTime}`
          : null,
        venue_name:      venue?.name || '',
        address:         venue?.address?.line1 || '',
        city:            venue?.city?.name    || 'Fort Lauderdale',
        latitude:        parseFloat(venue?.location?.latitude)  || null,
        longitude:       parseFloat(venue?.location?.longitude) || null,
        ticket_url:      e.url || null,
        is_free:         false,
        price_min:       e.priceRanges?.[0]?.min || null,
        image_url:       e.images?.[0]?.url || null,
        event_type:      mapTicketmasterSegment(e.classifications?.[0]?.segment?.name),
        is_active:       true,
        source_active:   true,
      };
    });

  } catch (err) {
    console.error('[Ticketmaster]', err.message);
    return [];
  }
}

/**
 * Fetch events from Google Events (via SerpAPI or similar).
 * Activate by setting SERPAPI_KEY in Vercel env vars.
 *
 * @param {number} year
 * @param {number} month
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<Array>}
 */
async function fetchGoogleEvents(year, month, lat, lng) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return []; // Not yet configured

  try {
    const monthName = new Date(year, month - 1, 1)
      .toLocaleString('en-US', { month: 'long' });

    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('engine',  'google_events');
    url.searchParams.set('q',       `events in Fort Lauderdale FL ${monthName} ${year}`);
    url.searchParams.set('location','Fort Lauderdale, Florida');
    url.searchParams.set('api_key', apiKey);

    const res  = await fetch(url.toString());
    const data = await res.json();

    return (data.events_results || []).map((e, idx) => ({
      id:              `ge-${idx}-${e.title?.substring(0,20).replace(/\s/g,'')}`,
      source_event_id: `ge-${idx}`,
      source:          'google_events',
      name:            e.title || '',
      description:     e.description || '',
      event_date:      parseGoogleDate(e.date?.start_date) || '',
      start_time:      null,
      venue_name:      e.venue?.name || '',
      address:         e.address?.[0] || '',
      city:            'Fort Lauderdale',
      latitude:        null,
      longitude:       null,
      ticket_url:      e.link || null,
      is_free:         false,
      price_min:       null,
      image_url:       e.thumbnail || null,
      event_type:      'other',
      is_active:       true,
      source_active:   true,
    }));

  } catch (err) {
    console.error('[Google Events]', err.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════

/**
 * Calculate distance between two coordinates in miles (Haversine formula).
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in miles
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Map Ticketmaster segment names to our event_type values.
 * @param {string} segment
 * @returns {string}
 */
function mapTicketmasterSegment(segment) {
  const map = {
    'Music':       'music_concerts',
    'Sports':      'sports_outdoors',
    'Arts & Theatre': 'theater_shows',
    'Film':        'arts_culture',
    'Miscellaneous': 'other',
  };
  return map[segment] || 'other';
}

/**
 * Parse a Google Events date string to YYYY-MM-DD.
 * Google returns dates like "Apr 25, 2026".
 * @param {string} dateStr
 * @returns {string|null}
 */
function parseGoogleDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch { return null; }
}
