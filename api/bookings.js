/**
 * FILE: api/bookings.js
 * ENDPOINT: POST /api/bookings
 * USED BY: Booking Inquiry Page (booking.html)
 * ============================================================
 * PURPOSE:
 *   Handles the booking inquiry form on the public website.
 *   When a potential guest fills out the form and clicks Submit,
 *   this file runs on the server.
 *
 * WHAT IT DOES:
 *   1. Validates all form fields (name, email, dates, guest count)
 *   2. Creates a guest record in the database marked as inactive
 *      (guest cannot log into portal until Kyle confirms booking)
 *   3. Creates a booking inquiry record in the database
 *   4. Sends a confirmation email to the guest
 *   5. Sends a notification email to Kyle
 *
 * IMPORTANT:
 *   No payment is collected here. Guest portal access is blocked
 *   until Kyle approves the booking in the Admin Dashboard.
 *
 * DATABASE TABLES USED:
 *   - guests   (creates guest record, is_active=false)
 *   - bookings (creates booking with status='inquiry')
 */

import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

// ── Rate limit: max 5 inquiries per IP per hour ──
const RATE_LIMIT = 5;

export default async function handler(req, res) {
  setCors(req, res);

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
      discount_code,
      terms_accepted,
      terms_accepted_at,
    } = req.body;

    // Server-side validation. Errors are keyed by field so the form
    // can put the message next to the input that caused it.
    const fieldErrors = {};

    if (!first_name?.trim())  fieldErrors.firstName = 'First name is required.';
    if (!last_name?.trim())   fieldErrors.lastName  = 'Last name is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || ''))
                              fieldErrors.email     = 'Enter a valid email address.';
    if (!check_in_date)       fieldErrors.checkIn   = 'Choose a check-in date.';
    if (!check_out_date)      fieldErrors.checkOut  = 'Choose a check-out date.';
    if (!num_guests || num_guests < 1 || num_guests > 4)
                              fieldErrors.numGuests = 'Choose between 1 and 4 guests.';
    if (check_in_date && check_out_date && check_out_date <= check_in_date) {
      fieldErrors.checkOut = 'Check-out must be after check-in.';
    }
    if (!terms_accepted) {
      fieldErrors.agreeTerms = 'Please read and accept the Reservation Terms and House Rules.';
    }

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({
        error: 'Please correct the highlighted fields.',
        field_errors: fieldErrors,
      });
    }

    // ── Sanitize inputs ──
    const sanitize = (str) => str?.trim().replace(/<[^>]*>/g, '') || null;

    // These columns carry CHECK constraints in Postgres. Sending a value
    // the constraint doesn't allow rejects the whole insert, so anything
    // unrecognised is stored as null (which CHECK always permits) and
    // noted instead. Better a booking with a blank source than no booking.
    const ALLOWED_SOURCES  = ['airbnb', 'vrbo', 'direct', 'referral', 'social', 'other'];
    const ALLOWED_PURPOSES = ['vacation', 'business', 'family',
                              'special_occasion', 'relocation', 'other'];

    const constrain = (value, allowed) => {
      const v = sanitize(value)?.toLowerCase();
      if (!v) return null;
      return allowed.includes(v) ? v : null;
    };

    const cleanData = {
      first_name:      sanitize(first_name),
      last_name:       sanitize(last_name),
      email:           sanitize(email)?.toLowerCase(),
      phone:           sanitize(phone),
      check_in_date,
      check_out_date,
      num_guests:      parseInt(num_guests),
      booking_source:  constrain(booking_source, ALLOWED_SOURCES),
      purpose_of_stay: constrain(purpose_of_stay, ALLOWED_PURPOSES),
      special_requests: sanitize(special_requests),
      discount_code:    sanitize(discount_code)?.toUpperCase() || null,
    };

    // Don't silently lose what they told us.
    const droppedNotes = [];
    if (booking_source && !cleanData.booking_source) {
      droppedNotes.push(`Heard about us via: ${sanitize(booking_source)}`);
    }
    if (purpose_of_stay && !cleanData.purpose_of_stay) {
      droppedNotes.push(`Purpose of stay: ${sanitize(purpose_of_stay)}`);
    }
    if (droppedNotes.length) {
      cleanData.special_requests =
        [cleanData.special_requests, droppedNotes.join(' | ')]
          .filter(Boolean).join(' \u2014 ');
    }

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

    // Price the stay server-side so the stored figures are ours, not
    // whatever the browser displayed.
    let quote = null;
    try {
      const { loadConfig, computeQuote } = await import('./pricing.js');
      const cfg = await loadConfig();
      const q = computeQuote(cfg, {
        check_in:      cleanData.check_in_date,
        check_out:     cleanData.check_out_date,
        discount_code: cleanData.discount_code,
      });
      if (!q.error) quote = q;
    } catch (quoteErr) {
      console.error('[bookings] Quote failed:', quoteErr.message);
    }

    // Human-readable request ID. If the helper is missing (migration
    // not run yet) we carry on without one rather than failing the
    // booking — the guest still gets through.
    let requestId = null;
    try {
      const { data: idData, error: idErr } =
        await supabase.rpc('next_public_id', { p_prefix: 'REQ' });
      if (idErr) console.error('[bookings] ID generation failed:', idErr.message);
      else requestId = idData;
    } catch (idEx) {
      console.error('[bookings] ID generation threw:', idEx.message);
    }

    const sched = quote?.payment_schedule || null;

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        guest_id:         guest.id,
        request_id:       requestId,
        terms_accepted:   !!terms_accepted,
        terms_accepted_at: terms_accepted_at || new Date().toISOString(),
        discount_code:    cleanData.discount_code,
        quoted_subtotal:  quote ? quote.subtotal : null,
        quoted_discount:  quote ? quote.discount : null,
        quoted_tax:       quote ? quote.tax      : null,
        quoted_total:     quote ? quote.total    : null,
        deposit_amount:   sched ? sched.deposit_amount : null,
        balance_amount:   sched ? sched.balance_amount : null,
        balance_due_date: sched && sched.split ? sched.balance_due_date : null,
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

    // ── Send emails — confirmation to guest + notification to Kyle ──
    try {
      const { sendBookingConfirmation, sendKyleNotification } = await import('./_lib/email.js');

      const guestData   = { first_name, last_name, email, phone };
      const bookingData = {
        check_in_date, check_out_date, num_guests,
        booking_source, special_requests,
        discount_code: cleanData.discount_code,
        quote,
        request_id: requestId,
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
      request_id: requestId,
      message:    'Booking inquiry received successfully.',
    });

  } catch (err) {
    console.error('[/api/bookings]', err);
    return res.status(500).json({
      error: 'We could not save your request. Please try again, or email us directly.',
      detail: err.message,   // shown in the browser console for diagnosis
    });
  }
}