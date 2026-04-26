/**
 * Generations Getaway LLC
 * POST /api/bookings
 * ====================
 * Receives booking inquiry from booking.html,
 * validates input server-side, upserts guest record,
 * creates booking inquiry in Supabase, and triggers
 * confirmation email via Resend.
 *
 * Security:
 *  - Input sanitized and validated server-side
 *  - Uses service role key (server only, never exposed)
 *  - Rate limiting via IP tracking in Supabase
 *  - CORS restricted to own domain
 */

import { createClient } from '@supabase/supabase-js';

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

// ── Rate limit: max 5 inquiries per IP per hour ──
const RATE_LIMIT = 5;

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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    // ── Rate limiting ──
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { count } = await supabase
      .from('visitor_logs')
      .select('*', { count: 'exact', head: true })
      .eq('ip_address', ip)
      .eq('page_visited', '/api/bookings')
      .gte('created_at', oneHourAgo);

    if (count >= RATE_LIMIT) {
      return res.status(429).json({
        error: 'Too many requests. Please wait before submitting another inquiry.'
      });
    }

    // ── Log this request ──
    await supabase.from('visitor_logs').insert({
      ip_address:   ip,
      page_visited: '/api/bookings',
      user_agent:   req.headers['user-agent'] || null,
    });

    // ── Parse & validate body ──
    const {
      first_name,
      last_name,
      email,
      phone,
      check_in_date,
      check_out_date,
      num_guests,
      booking_source,
      purpose_of_stay,
      special_requests,
    } = req.body;

    // Server-side validation
    const errors = [];

    if (!first_name?.trim())                   errors.push('First name is required.');
    if (!last_name?.trim())                    errors.push('Last name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Valid email is required.');
    if (!check_in_date)                        errors.push('Check-in date is required.');
    if (!check_out_date)                       errors.push('Check-out date is required.');
    if (!num_guests || num_guests < 1 || num_guests > 4) errors.push('Number of guests must be between 1 and 4.');
    if (check_in_date && check_out_date && check_out_date <= check_in_date) {
      errors.push('Check-out must be after check-in.');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(' ') });
    }

    // ── Sanitize inputs ──
    const sanitize = (str) => str?.trim().replace(/<[^>]*>/g, '') || null;

    const cleanData = {
      first_name:      sanitize(first_name),
      last_name:       sanitize(last_name),
      email:           sanitize(email)?.toLowerCase(),
      phone:           sanitize(phone),
      check_in_date,
      check_out_date,
      num_guests:      parseInt(num_guests),
      booking_source:  sanitize(booking_source),
      purpose_of_stay: sanitize(purpose_of_stay),
      special_requests: sanitize(special_requests),
    };

    // ── Upsert guest record (inquiry stage) ──
    // Guest records ARE created at inquiry stage so we can track them,
    // but portal access is blocked until booking is CONFIRMED —
    // guest-auth only grants access when status = confirmed/completed.
    let guest;
    const { data: existingGuest } = await supabase
      .from('guests')
      .select('id')
      .eq('email', cleanData.email)
      .maybeSingle();

    if (existingGuest) {
      guest = existingGuest;
    } else {
      const { data: newGuest, error: insertError } = await supabase
        .from('guests')
        .insert({
          email:      cleanData.email,
          first_name: cleanData.first_name,
          last_name:  cleanData.last_name,
          phone:      cleanData.phone,
          is_active:  false, // inactive until booking confirmed
        })
        .select('id')
        .single();
      if (insertError) throw new Error(`Failed to create guest: ${insertError.message}`);
      guest = newGuest;
    }

    // ── Create booking inquiry ──
    const numNights = Math.round(
      (new Date(cleanData.check_out_date) - new Date(cleanData.check_in_date))
      / (1000 * 60 * 60 * 24)
    );

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        guest_id:         guest.id,
        check_in_date:    cleanData.check_in_date,
        check_out_date:   cleanData.check_out_date,
        num_guests:       cleanData.num_guests,
        booking_source:   cleanData.booking_source,
        purpose_of_stay:  cleanData.purpose_of_stay,
        special_requests: cleanData.special_requests,
        num_nights:       numNights,
        status:           'inquiry',
      })
      .select('id')
      .single();

    if (bookingError) throw new Error(`Failed to create booking record: ${bookingError.message} (code: ${bookingError.code})`);

    // ── TODO Phase 8: Send confirmation email via Resend ──
    // await sendConfirmationEmail(cleanData, numNights);

    // ── Send emails — confirmation to guest + notification to Kyle ──
    try {
      const { sendBookingConfirmation, sendKyleNotification } = await import('./email.js');
      const guestData   = { first_name, last_name, email, phone };
      const bookingData = {
        check_in_date, check_out_date, num_guests,
        booking_source, special_requests
      };
      await Promise.all([
        sendBookingConfirmation({ guest: guestData, booking: bookingData }),
        sendKyleNotification({ guest: guestData, booking: bookingData }),
      ]);
    } catch (emailErr) {
      // Never block booking confirmation due to email failure
      console.error('[bookings] Email failed:', emailErr.message);
    }

    return res.status(200).json({
      success:    true,
      booking_id: booking.id,
      message:    'Booking inquiry received successfully.',
    });

  } catch (err) {
    console.error('[/api/bookings]', err.message);
    return res.status(500).json({
      error: 'An unexpected error occurred. Please try again.'
    });
  }
}
