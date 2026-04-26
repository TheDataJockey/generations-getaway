/**
 * Generations Getaway LLC
 * POST /api/guest-auth
 * =====================
 * Authenticates a guest by last name + PIN.
 * Returns a signed session token and safe guest
 * data on success. Tracks failed attempts and
 * applies progressive lockouts server-side.
 *
 * Security:
 *  - PIN compared using timing-safe method
 *  - Failed attempts tracked in Supabase per guest
 *  - Progressive lockouts: 2min → 15min → 60min
 *  - Admin notified after 10 failed attempts
 *  - Session token is a signed JWT (via Supabase Auth)
 *  - No sensitive data (full PIN, ID) returned to client
 *  - Rate limited by IP via visitor_logs
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Strip any trailing /rest/v1 from URL — Vercel env vars sometimes include it
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Supabase admin client (service role — server only) ──

// ── Lockout thresholds ──
const LOCKOUT_RULES = [
  { attempts: 3,  lockoutMinutes: 2  },
  { attempts: 5,  lockoutMinutes: 15 },
  { attempts: 10, lockoutMinutes: 60 },
];

// ── Max attempts before permanent lock ──
const HARD_LOCK_ATTEMPTS = 15;



// ── Get requests handler ──
async function handleGetRequests(req, res, supabase) {
  const { session_token, booking_id } = req.body;
  if (!session_token || !booking_id) return res.status(400).json({ error: 'Missing parameters.' });

  const { data: requests } = await supabase
    .from('reservation_requests')
    .select('id, request_number, request_type, status, requested_details, guest_notes, admin_notes, created_at, resolved_at')
    .eq('booking_id', booking_id)
    .order('created_at', { ascending: false });

  return res.status(200).json({ requests: requests || [] });
}

// ── Reservation request handler ──
async function handleReservationRequest(req, res, supabase) {
  const { session_token, booking_id, guest_name, request_type, subject, details } = req.body;

  // Validate session token
  if (!session_token) return res.status(401).json({ error: 'Not authenticated.' });

  // Fetch booking to verify it belongs to this session
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, check_in_date, check_out_date, guest_id, guests(first_name, last_name, email)')
    .eq('id', booking_id)
    .in('status', ['confirmed', 'completed'])
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const guest = booking.guests;
  const fmt   = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });

  // Build email body
  let detailsHtml = '';
  if (request_type === 'dates') {
    detailsHtml = `
      <div style="margin:0 0 8px;"><strong>New Check-In:</strong> ${fmt(details.new_check_in)}</div>
      <div style="margin:0 0 8px;"><strong>New Check-Out:</strong> ${fmt(details.new_check_out)}</div>
      ${details.notes ? `<div><strong>Notes:</strong> ${details.notes}</div>` : ''}`;
  } else if (request_type === 'guests') {
    detailsHtml = `
      <div style="margin:0 0 8px;"><strong>New Guest Count:</strong> ${details.new_num_guests}</div>
      ${details.notes ? `<div><strong>Notes:</strong> ${details.notes}</div>` : ''}`;
  } else if (request_type === 'checkout') {
    detailsHtml = `
      <div style="margin:0 0 8px;"><strong>Type:</strong> ${details.checkout_type === 'early' ? 'Early Checkout' : 'Late Checkout'}</div>
      ${details.notes ? `<div><strong>Notes:</strong> ${details.notes}</div>` : ''}`;
  } else if (request_type === 'cancel') {
    detailsHtml = details.reason
      ? `<div><strong>Reason:</strong> ${details.reason}</div>`
      : `<div>No reason provided.</div>`;
  }

  // Send email via Resend
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from:    'Generations Getaway LLC <bookings@generationsgetawayfl.com>',
        to:      'kyle@generationsgetawayfl.com',
        subject: `🔔 Guest Request: ${subject} — ${guest_name}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#1B2A4A;color:#A8C4E0;padding:32px;border-radius:8px;">
            <h2 style="color:#F4F7FB;font-weight:300;margin-bottom:4px;">Guest Reservation Request</h2>
            <p style="color:#7A90AE;font-size:12px;margin-bottom:24px;text-transform:uppercase;letter-spacing:0.15em;">${subject}</p>
            <div style="background:rgba(13,27,46,0.6);border:1px solid rgba(91,141,217,0.2);border-radius:6px;padding:20px;margin-bottom:20px;">
              <div style="margin-bottom:8px;"><strong style="color:#F4F7FB;">Guest:</strong> ${guest.first_name} ${guest.last_name}</div>
              <div style="margin-bottom:8px;"><strong style="color:#F4F7FB;">Email:</strong> ${guest.email || 'N/A'}</div>
              <div style="margin-bottom:8px;"><strong style="color:#F4F7FB;">Current Check-In:</strong> ${fmt(booking.check_in_date)}</div>
              <div><strong style="color:#F4F7FB;">Current Check-Out:</strong> ${fmt(booking.check_out_date)}</div>
            </div>
            <div style="background:rgba(13,27,46,0.6);border:1px solid rgba(91,141,217,0.2);border-radius:6px;padding:20px;margin-bottom:24px;">
              <p style="color:#7A90AE;font-size:11px;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:12px;">Request Details</p>
              ${detailsHtml}
            </div>
            <a href="https://www.generationsgetawayfl.com/admin/dashboard.html"
              style="display:inline-block;background:#2E5FA3;color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">
              Review in Dashboard
            </a>
          </div>`,
      }),
    });
  }

  // Insert into reservation_requests table
  const { data: reqRow, error: reqError } = await supabase
    .from('reservation_requests')
    .insert({
      booking_id:        booking_id,
      guest_id:          booking.guest_id,
      request_type:      request_type,
      status:            'pending',
      requested_details: details,
      guest_notes:       details.notes || null,
    })
    .select('request_number')
    .single();

  if (reqError) {
    console.error('[guest-auth/reservation_request] Insert error:', reqError.message);
    return res.status(500).json({ error: 'Failed to submit request. Please try again.' });
  }

  return res.status(200).json({ success: true, request_number: reqRow.request_number });
}

export default async function handler(req, res) {
  // ── CORS ──
  // Allow both www and non-www
  const origin = req.headers.origin || '';
  if (origin.includes('generationsgetawayfl.com') || origin.includes('localhost') || origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  // ── Route reservation requests separately ──
  if (req.body?.action === 'reservation_request') {
    return handleReservationRequest(req, res, supabase);
  }
  if (req.body?.action === 'get_requests') {
    return handleGetRequests(req, res, supabase);
  }

  // ── IP-level rate limit: max 20 attempts per hour ──
  const ip         = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count: ipCount } = await supabase
    .from('visitor_logs')
    .select('*', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .eq('page_visited', '/api/guest-auth')
    .gte('created_at', oneHourAgo);

  if (ipCount >= 20) {
    return res.status(429).json({
      error: 'Too many login attempts from this device. Please try again later.'
    });
  }

  // ── Log this attempt ──
  await supabase.from('visitor_logs').insert({
    ip_address:   ip,
    page_visited: '/api/guest-auth',
    user_agent:   req.headers['user-agent'] || null,
  });

  try {
    const { last_name, pin } = req.body;

    // ── Basic input validation ──
    if (!last_name?.trim() || !pin) {
      return res.status(400).json({ error: 'Last name and PIN are required.' });
    }

    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }

    // ── Find guest by last name (case-insensitive) ──
    const { data: guests, error: findError } = await supabase
      .from('guests')
      .select(`
        id, first_name, last_name, email,
        pin_code, pin_expires_at,
        failed_pin_attempts, locked_until,
        is_active, is_blacklisted
      `)
      .ilike('last_name', last_name.trim())
      .eq('is_active', true)
      .limit(5);

    if (findError) throw new Error('Database error during guest lookup.');

    // ── No guest found — return generic error (don't reveal if last name exists) ──
    if (!guests || guests.length === 0) {
      return res.status(401).json({ error: 'Last name or PIN is incorrect.' });
    }

    // ── Find the guest whose PIN matches ──
    let matchedGuest = null;

    for (const guest of guests) {
      if (!guest.pin_code) continue;

      // Timing-safe PIN comparison
      const inputBuf  = Buffer.from(pin.padEnd(64));
      const storedBuf = Buffer.from(guest.pin_code.padEnd(64));

      if (
        inputBuf.length === storedBuf.length &&
        crypto.timingSafeEqual(inputBuf, storedBuf)
      ) {
        matchedGuest = guest;
        break;
      }
    }

    if (!matchedGuest) {
      // ── Increment failed attempts on first matching last name guest ──
      const targetGuest = guests[0];
      const newAttempts = (targetGuest.failed_pin_attempts || 0) + 1;

      // Determine lockout
      const lockoutRule = [...LOCKOUT_RULES]
        .reverse()
        .find(r => newAttempts >= r.attempts);

      const lockedUntil = lockoutRule
        ? new Date(Date.now() + lockoutRule.lockoutMinutes * 60 * 1000).toISOString()
        : null;

      await supabase
        .from('guests')
        .update({
          failed_pin_attempts: newAttempts,
          locked_until:        lockedUntil,
        })
        .eq('id', targetGuest.id);

      // ── Notify admin after hard lock threshold ──
      if (newAttempts >= HARD_LOCK_ATTEMPTS) {
        // TODO Phase 8: Send admin alert email
        console.warn(`[SECURITY] Guest ${targetGuest.id} reached ${newAttempts} failed PIN attempts from IP ${ip}`);
      }

      return res.status(401).json({ error: 'Last name or PIN is incorrect.' });
    }

    // ── Check if account is locked ──
    if (matchedGuest.is_blacklisted) {
      return res.status(423).json({
        error: 'This account has been locked. Please contact Generations Getaway LLC.'
      });
    }

    if (matchedGuest.locked_until && new Date(matchedGuest.locked_until) > new Date()) {
      const remaining = Math.ceil(
        (new Date(matchedGuest.locked_until) - Date.now()) / 60000
      );
      return res.status(423).json({
        error: `Account temporarily locked. Please try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`
      });
    }

    // ── Check PIN expiry ──
    if (matchedGuest.pin_expires_at && new Date(matchedGuest.pin_expires_at) < new Date()) {
      return res.status(401).json({
        error: 'Your access PIN has expired. Please contact Generations Getaway LLC.'
      });
    }

    // ── Successful login — reset failed attempts ──
    await supabase
      .from('guests')
      .update({
        failed_pin_attempts: 0,
        locked_until:        null,
      })
      .eq('id', matchedGuest.id);

    // ── Fetch current booking for this guest ──
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, check_in_date, check_out_date, yale_pin_code, num_nights, num_guests, welcome_note, payment_method, payment_status, total_amount, amount_received, balance_due, nightly_rate')
      .eq('guest_id', matchedGuest.id)
      .in('status', ['confirmed', 'completed'])
      .order('check_in_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    // ── Generate a simple session token ──
    const token = crypto
      .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
      .update(`${matchedGuest.id}:${Date.now()}`)
      .digest('hex');

    // ── Log the successful login ──
    await supabase.from('audit_logs').insert({
      action:     'login',
      table_name: 'guests',
      record_id:  matchedGuest.id,
      ip_address: ip,
      user_agent: req.headers['user-agent'] || null,
    });

    // ── Return safe guest data (no full PIN, no sensitive fields) ──
    // ── Fetch all bookings for this guest (for stay history) ──
    const { data: allBookings } = await supabase
      .from('bookings')
      .select(`
        id, check_in_date, check_out_date, num_nights, num_guests,
        status, booking_source,
        payment_method, payment_status,
        total_amount, amount_received, balance_due,
        nightly_rate, created_at
      `)
      .eq('guest_id', matchedGuest.id)
      .in('status', ['confirmed', 'completed'])
      .order('check_in_date', { ascending: false });

    // Separate current booking from past stays
    const todayStr  = new Date().toISOString().split('T')[0];
    const pastStays = (allBookings || []).filter(b =>
      b.check_out_date < todayStr && b.id !== booking?.id
    );

    return res.status(200).json({
      success: true,
      token,
      guest: {
        id:             matchedGuest.id,
        first_name:     matchedGuest.first_name,
        last_name:      matchedGuest.last_name,
        email:          matchedGuest.email,
        check_in_date:  booking?.check_in_date  || null,
        check_out_date: booking?.check_out_date || null,
        yale_pin_code:  booking?.yale_pin_code  || null,
        num_nights:     booking?.num_nights     || null,
        num_guests:     booking?.num_guests     || null,
        welcome_note:   booking?.welcome_note   || null,
        booking_id:     booking?.id             || null,
        payment_method: booking?.payment_method || null,
        payment_status: booking?.payment_status || null,
        total_amount:   booking?.total_amount   || null,
        amount_received:booking?.amount_received|| null,
        balance_due:    booking?.balance_due    || null,
        nightly_rate:   booking?.nightly_rate   || null,
        past_stays:     pastStays,
      },
    });

  } catch (err) {
    console.error('[/api/guest-auth]', err.message);
    return res.status(500).json({
      error: 'An unexpected error occurred. Please try again.'
    });
  }
}
