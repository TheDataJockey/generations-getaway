/**
 * FILE: api/pricing.js
 * ENDPOINT: POST /api/pricing
 * USED BY: Booking Inquiry Page (booking.html) — live quote
 * ============================================================
 * PURPOSE:
 *   Calculates a nightly-rate quote for a date range, applies
 *   seasonal pricing and any date-specific overrides, validates
 *   discount codes, and adds Florida / Broward lodging tax.
 *
 * WHERE THE NUMBERS COME FROM:
 *   Rates, overrides, codes and settings are read from Supabase
 *   so they can be edited in the Admin Pricing page. If the
 *   database is unreachable, the FALLBACK values below are used
 *   so the booking form never breaks.
 *
 * WHY THIS RUNS ON THE SERVER:
 *   Discount codes are secrets. If the list lived in browser
 *   JavaScript, any guest could open View Source and read every
 *   code. Here, the browser only learns the result for a code
 *   someone already supplied.
 *
 * PRECEDENCE when pricing a night (highest wins):
 *   1. pricing_overrides  (a date range set in the admin page)
 *   2. pricing_seasons    (the season that month belongs to)
 *
 * TAX (Broward County, FL) — 13% by default:
 *   6% Florida transient rental tax
 *   1% Broward discretionary sales surtax
 *   6% Broward Tourist Development Tax
 *   Confirm with your accountant; rates change.
 *
 * NOTE: Nightly rates are all-in and INCLUDE cleaning. If you ever
 *   add a separate cleaning fee, remember Florida taxes mandatory
 *   fees too — it must be added to `taxable`.
 */

import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

/* ============================================================
   FALLBACK CONFIG — used only if the database is unreachable
   ============================================================ */
const FALLBACK = {
  rates: { high: 550, medium: 425, low: 350 },
  seasonByMonth: {
    1: 'high', 2: 'high', 3: 'high', 4: 'high',
    5: 'medium', 6: 'low', 7: 'low', 8: 'low',
    9: 'low', 10: 'low', 11: 'medium', 12: 'medium',
  },
  minNights: 3,
  taxRate: 0.13,
  // Broward County lodging tax, broken out by who you remit to.
  taxComponents: [
    { key: 'state',   label: 'FL sales tax (transient rentals)', rate: 0.06, remit_to: 'Florida Dept. of Revenue' },
    { key: 'surtax',  label: 'Broward discretionary surtax',     rate: 0.01, remit_to: 'Florida Dept. of Revenue' },
    { key: 'tdt',     label: 'Broward Tourist Development Tax',  rate: 0.06, remit_to: 'Broward County' },
  ],
  overrides: [],
  codes: {
    FAMILYKB:  { kind: 'rates', label: 'Complimentary family stay',
                 rates: { high: 0, medium: 0, low: 0 }, freeNights: 0, freeSeasons: [] },
    FAMILYLOW: { kind: 'rates', label: 'Family low-season rate',
                 rates: { high: 250, medium: 200, low: 200 }, freeNights: 4, freeSeasons: ['low'] },
    FAMILY:    { kind: 'rates', label: 'Family rate',
                 rates: { high: 250, medium: 200, low: 200 }, freeNights: 0, freeSeasons: [] },
    FRIENDS:   { kind: 'percent', label: 'Friends rate', percent: 20 },
    WELCOME:   { kind: 'percent', label: 'Guest rate',   percent: 10 },
  },
};

/* ============================================================
   LOAD CONFIG FROM DATABASE
   ============================================================ */
export async function loadConfig() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [seasons, overrides, codes, settings, booked] = await Promise.all([
      supabase.from('pricing_seasons').select('*'),
      supabase.from('pricing_overrides').select('*'),
      supabase.from('discount_codes').select('*').eq('is_active', true),
      supabase.from('pricing_settings').select('*').eq('id', 1).single(),
      // Dates already taken. A stay occupies its check-in night through
      // the night BEFORE check-out, so a new guest may arrive on the
      // day someone else leaves.
      supabase.from('bookings')
        .select('check_in_date, check_out_date, status')
        .in('status', ['confirmed', 'paid', 'completed'])
        .gte('check_out_date', today),
    ]);

    const bookedRows = booked?.data || [];
    if (!seasons.data || !seasons.data.length) {
      return { ...FALLBACK, bookings: bookedRows };
    }

    const rates = {};
    const seasonByMonth = {};
    for (const s of seasons.data) {
      rates[s.id] = Number(s.nightly_rate);
      for (const m of (s.months || [])) seasonByMonth[m] = s.id;
    }

    const codeMap = {};
    for (const c of (codes.data || [])) {
      codeMap[c.code.toUpperCase()] = {
        kind:    c.kind,
        label:   c.label,
        percent: c.percent != null ? Number(c.percent) : null,
        rates: {
          high:   c.rate_high   != null ? Number(c.rate_high)   : null,
          medium: c.rate_medium != null ? Number(c.rate_medium) : null,
          low:    c.rate_low    != null ? Number(c.rate_low)    : null,
        },
        freeNights:  c.free_nights || 0,
        freeSeasons: c.free_seasons || [],
        validFrom:   c.valid_from,
        validUntil:  c.valid_until,
        maxUses:     c.max_uses,
        timesUsed:   c.times_used || 0,
      };
    }

    return {
      rates,
      seasonByMonth,
      overrides: overrides.data || [],
      minNights: settings.data?.min_nights ?? FALLBACK.minNights,
      taxRate:   settings.data?.tax_rate != null
                   ? Number(settings.data.tax_rate) : FALLBACK.taxRate,
      taxComponents: FALLBACK.taxComponents,
      codes:     Object.keys(codeMap).length ? codeMap : FALLBACK.codes,
      bookings:  bookedRows,
    };
  } catch (err) {
    console.error('Pricing config load failed, using fallback:', err);
    return { ...FALLBACK };
  }
}

/* ============================================================
   CALCULATION
   ============================================================ */
const round = (n) => Math.round(n * 100) / 100;

function parseDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return null;
  const d = new Date(`${str}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

// True when an existing confirmed booking occupies this night.
// A stay runs [check_in, check_out) — the checkout day is free.
function isBooked(iso, bookings) {
  for (const b of (bookings || [])) {
    if (iso >= b.check_in_date && iso < b.check_out_date) return true;
  }
  return false;
}

// Every unavailable date in a window, for greying out the picker.
export function unavailableDates(cfg, fromIso, toIso) {
  const out = new Set();
  for (const b of (cfg.bookings || [])) {
    let d = new Date(`${b.check_in_date}T00:00:00Z`);
    const end = new Date(`${b.check_out_date}T00:00:00Z`);
    while (d < end) {
      const iso = d.toISOString().slice(0, 10);
      if (iso >= fromIso && iso <= toIso) out.add(iso);
      d = new Date(d.getTime() + 86400000);
    }
  }
  for (const o of (cfg.overrides || [])) {
    if (!o.is_blocked) continue;
    let d = new Date(`${o.start_date}T00:00:00Z`);
    const end = new Date(`${o.end_date}T00:00:00Z`);
    while (d <= end) {
      const iso = d.toISOString().slice(0, 10);
      if (iso >= fromIso && iso <= toIso) out.add(iso);
      d = new Date(d.getTime() + 86400000);
    }
  }
  return [...out].sort();
}

// Nightly rate for every date in a window, for the booking calendar.
// Mirrors the pricing precedence used when quoting: a date override
// beats the seasonal rate.
export function rateCalendar(cfg, fromIso, toIso) {
  const out = {};
  let d = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  while (d <= end) {
    const iso    = d.toISOString().slice(0, 10);
    const season = cfg.seasonByMonth[d.getUTCMonth() + 1] || 'medium';
    const ov     = overrideFor(iso, cfg.overrides || []);
    if (!(ov && ov.is_blocked)) {
      out[iso] = ov && ov.nightly_rate != null
        ? Number(ov.nightly_rate)
        : (cfg.rates[season] ?? FALLBACK.rates[season]);
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

// Highest-priority override covering this date, if any.
function overrideFor(iso, overrides) {
  let best = null;
  for (const o of overrides) {
    if (iso >= o.start_date && iso <= o.end_date) {
      if (!best || (o.priority || 0) > (best.priority || 0)) best = o;
    }
  }
  return best;
}

export function computeQuote(cfg, { check_in, check_out, discount_code }) {
  const start = parseDate(check_in);
  const end   = parseDate(check_out);

  if (!start || !end) return { error: 'Please choose valid dates.' };
  if (end <= start)   return { error: 'Check-out must be after check-in.' };

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (start < today)  return { error: 'Check-in cannot be in the past.' };

  const nights = Math.round((end - start) / 86400000);
  if (nights > 90) {
    return { error: 'For stays over 90 nights, please contact us directly.' };
  }

  // Resolve the discount code before pricing nights.
  let code = null;
  let codeInvalid = false;
  const todayIso = today.toISOString().slice(0, 10);

  if (discount_code && discount_code.trim()) {
    const key = discount_code.trim().toUpperCase();
    const c = cfg.codes[key];
    const expired =
      c && ((c.validFrom  && todayIso < c.validFrom) ||
            (c.validUntil && todayIso > c.validUntil) ||
            (c.maxUses != null && c.timesUsed >= c.maxUses));
    if (c && !expired) code = c;
    else codeInvalid = true;
  }

  const breakdown = [];
  let subtotal    = 0;
  let collected   = 0;
  let freeLeft    = code ? (code.freeNights || 0) : 0;
  let freeUsed    = 0;
  let requiredMin = cfg.minNights;

  for (let i = 0; i < nights; i++) {
    const night  = new Date(start.getTime() + i * 86400000);
    const iso    = night.toISOString().slice(0, 10);
    const season = cfg.seasonByMonth[night.getUTCMonth() + 1] || 'medium';

    // A date override beats the seasonal rate.
    if (isBooked(iso, cfg.bookings)) {
      return {
        error: `Sorry — ${iso} is already booked. Please choose different dates.`,
        unavailable: true,
      };
    }

    const ov = overrideFor(iso, cfg.overrides || []);
    if (ov && ov.is_blocked) {
      return { error: `We are not accepting bookings for ${iso}. Please choose other dates.` };
    }
    if (ov && ov.min_nights && ov.min_nights > requiredMin) {
      requiredMin = ov.min_nights;
    }

    const standard = ov && ov.nightly_rate != null
      ? Number(ov.nightly_rate)
      : (cfg.rates[season] ?? FALLBACK.rates[season]);

    let charged = standard;
    let comped  = false;

    if (code) {
      if (code.kind === 'percent') {
        charged = standard * (1 - code.percent / 100);
      } else if (code.kind === 'rates') {
        const eligible =
          !code.freeSeasons?.length || code.freeSeasons.indexOf(season) !== -1;
        if (freeLeft > 0 && eligible) {
          charged = 0; comped = true; freeLeft--; freeUsed++;
        } else if (code.rates[season] != null) {
          charged = code.rates[season];
        }
      }
    }

    subtotal  += standard;
    collected += charged;
    breakdown.push({
      date: iso, season, standard, rate: round(charged), comped,
      override: ov ? ov.label : null,
    });
  }

  const discount = round(subtotal - collected);

  let discountLabel = null;
  if (code && discount > 0) {
    if (collected === 0)   discountLabel = `${code.label} — all nights free`;
    else if (freeUsed > 0) discountLabel = `${code.label} — ${freeUsed} night${freeUsed === 1 ? '' : 's'} free`;
    else if (code.kind === 'percent') discountLabel = `${code.label} (${code.percent}% off)`;
    else                   discountLabel = code.label;
  }

  const taxable = round(collected);

  // Break tax into its statutory components. Each is computed on the
  // same taxable base and rounded independently, then the total is the
  // sum — so the figures shown always add up to what is charged.
  const components = (cfg.taxComponents || FALLBACK.taxComponents).map(c => ({
    key:      c.key,
    label:    c.label,
    rate:     c.rate,
    remit_to: c.remit_to,
    amount:   round(taxable * c.rate),
  }));
  const tax   = round(components.reduce((sum, c) => sum + c.amount, 0));
  const total = round(taxable + tax);

  // Average nightly figure for display (a stay can mix seasons).
  const avgNightly = nights ? round(collected / nights) : 0;

  return {
    nights,
    below_minimum: nights < requiredMin,
    min_nights: requiredMin,
    free_nights_used: freeUsed,
    subtotal: round(subtotal),
    discount,
    discount_label: discountLabel,
    code_invalid: codeInvalid,
    taxable,
    tax,
    tax_components: components,
    tax_rate: cfg.taxRate,
    avg_nightly: avgNightly,
    total,
    nightly_breakdown: breakdown,
  };
}

/* ============================================================
   HANDLER
   ============================================================ */
export default async function handler(req, res) {
  if (setCors(req, res)) return;

  // GET returns the dates the booking form should grey out.
  if (req.method === 'GET') {
    try {
      const cfg  = await loadConfig();
      const from = new Date().toISOString().slice(0, 10);
      const to   = new Date(Date.now() + 540 * 86400000).toISOString().slice(0, 10);
      return res.status(200).json({
        unavailable: unavailableDates(cfg, from, to),
        rates:       rateCalendar(cfg, from, to),
        min_nights:  cfg.minNights,
        from, to,
      });
    } catch (err) {
      console.error('Availability error:', err);
      // Fail open — an empty list just means nothing is greyed out.
      return res.status(200).json({ unavailable: [], min_nights: 3 });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cfg    = await loadConfig();
    const result = computeQuote(cfg, req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('Pricing error:', err);
    return res.status(500).json({ error: 'Unable to calculate a quote.' });
  }
}
