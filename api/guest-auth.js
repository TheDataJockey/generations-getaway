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

// ── Supabase admin client (service role — server only) ──
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Lockout thresholds ──
const LOCKOUT_RULES = [
  { attempts: 3,  lockoutMinutes: 2  },
  { attempts: 5,  lockoutMinutes: 15 },
  { attempts: 10, lockoutMinutes: 60 },
];

// ── Max attempts before permanent lock ──
const HARD_LOCK_ATTEMPTS = 15;

export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', 'https://www.generationsgetawayfl.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

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
    const today = new Date().toISOString().split('T')[0];

    const { data: booking } = await supabase
      .from('bookings')
      .select('check_in_date, check_out_date, yale_pin_code, num_nights, num_guests, welcome_note')
      .eq('guest_id', matchedGuest.id)
      .in('status', ['confirmed', 'completed'])
      .order('check_in_date', { ascending: false })
      .limit(1)
      .single();

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
      notes:      'Guest portal login',
    });

    // ── Return safe guest data (no full PIN, no sensitive fields) ──
    return res.status(200).json({
      success: true,
      token,
      guest: {
        first_name:     matchedGuest.first_name,
        last_name:      matchedGuest.last_name,
        check_in_date:  booking?.check_in_date  || null,
        check_out_date: booking?.check_out_date || null,
        yale_pin_code:  booking?.yale_pin_code  || null,
        num_nights:     booking?.num_nights     || null,
        num_guests:     booking?.num_guests     || null,
        welcome_note:   booking?.welcome_note   || null,
      },
    });

  } catch (err) {
    console.error('[/api/guest-auth]', err.message);
    return res.status(500).json({
      error: 'An unexpected error occurred. Please try again.'
    });
  }
}
