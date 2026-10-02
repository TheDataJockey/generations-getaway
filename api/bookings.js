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

// ── Rate limit: max 10 SUBMITTED inquiries per IP per hour ──
// Counts only successful submissions, not failed validation attempts,
// so a guest fumbling the form doesn't burn their allowance. Note the
// limit is per IP, and a household or hotel shares one — hence 10
// rather than something tighter.
const RATE_LIMIT = 10;

// Shown to guests who hit the limit so they always have a way through.
const CONTACT_EMAIL = 'kyle@generationsgetawayfl.com';

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
      // Work out when the oldest entry falls out of the window so we can
      // tell the guest how long to wait instead of just refusing.
      let waitMinutes = 60;
      try {
        const { data: oldest } = await supabase
          .from('visitor_logs')
          .select('created_at')
          .eq('ip_address', ip)
          .eq('page_visited', '/api/bookings')
          .gte('created_at', oneHourAgo)
          .order('created_at', { ascending: true })
          .limit(1)
          .single();
        if (oldest?.created_at) {
          const freeAt = new Date(oldest.created_at).getTime() + 3600000;
          waitMinutes = Math.max(1, Math.ceil((freeAt - Date.now()) / 60000));
        }
      } catch { /* fall back to 60 */ }

      return res.status(429).json({
        error: `You have submitted several requests recently. Please try again in ` +
               `about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}, or email ` +
               `us directly at ${CONTACT_EMAIL} and we will help right away.`,
        retry_after_minutes: waitMinutes,
      });
    }

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
    // Strip HTML tags AND the characters that break out of an HTML
    // attribute or a JS string literal. The old version only removed
    // tags, so a name like  x');alert(1);//  passed straight through
    // into the admin dashboard.
    const sanitize = (str) => {
      if (str == null) return null;
      const cleaned = String(str)
        .trim()
        .replace(/<[^>]*>/g, '')      // tags
        .replace(/[<>]/g, '')          // stray angle brackets
        .replace(/[\u0000-\u001F\u007F]/g, '')  // control chars
        .slice(0, 1000);
      return cleaned || null;
    };

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

    // ── Attribution ──
    // The booking form sends the browser session id that visitor_logs
    // already records on every page view. Storing it here is what lets
    // a reservation be traced back to the referrer or ad campaign that
    // brought the visitor. Optional by design: missing, blank or
    // over-long values are dropped rather than rejected.
    const sessionId =
      typeof req.body?.session_id === 'string' && req.body.session_id.trim()
        ? req.body.session_id.trim().slice(0, 100)
        : null;

    const bookingRow = {
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
    };

    if (sessionId) bookingRow.session_id = sessionId;

    let { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert(bookingRow)
      .select('id')
      .single();

    // If db/booking-attribution.sql has not been run yet, the
    // session_id column does not exist and Postgres rejects the whole
    // insert. A guest must never lose a booking over an analytics
    // field, so drop it and try once more.
    //   42703      — Postgres "undefined column"
    //   PGRST204   — PostgREST "column not found in schema cache"
    const missingColumn =
      bookingError &&
      (bookingError.code === '42703' ||
       bookingError.code === 'PGRST204' ||
       /session_id/i.test(bookingError.message || ''));

    if (missingColumn && sessionId) {
      console.warn('[bookings] session_id column missing — saving without attribution. Run db/booking-attribution.sql.');
      delete bookingRow.session_id;
      ({ data: booking, error: bookingError } = await supabase
        .from('bookings')
        .insert(bookingRow)
        .select('id')
        .single());
    }

    if (bookingError) throw new Error(`Failed to create booking record: ${bookingError.message} (code: ${bookingError.code})`);

    // ── Additional guests supplied on the form ──
    // Dormant until ENABLE_PARTY_ON_FORM is switched on in booking.html;
    // nothing sends this field today. Written here so turning that flag
    // on needs no change to the API.
    //
    // Deliberately forgiving: a bad entry is skipped, and the whole
    // block is wrapped so it can never cost someone their booking.
    try {
      const party = Array.isArray(req.body?.additional_guests)
        ? req.body.additional_guests.slice(0, 5)   // occupancy is 4; 5 is slack
        : [];

      const rows = party
        .map(p => ({
          booking_id: booking.id,
          first_name: String(p?.first_name || '').trim(),
          last_name:  String(p?.last_name  || '').trim() || null,
          email:      String(p?.email      || '').trim().toLowerCase(),
          added_by:   'guest',
        }))
        .filter(p =>
          p.first_name &&
          /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(p.email) &&
          p.email !== String(email || '').trim().toLowerCase()   // not the booker
        );

      if (rows.length) {
        const { error: partyErr } = await supabase
          .from('booking_guests')
          .insert(rows);
        if (partyErr) {
          console.warn('[bookings] additional guests not saved:', partyErr.message);
        }
      }
    } catch (partyEx) {
      console.warn('[bookings] additional guests threw:', partyEx.message);
    }

    // Record the submission for rate limiting. Deliberately after the
    // insert succeeds — validation failures shouldn't count against
    // a guest who is simply correcting a typo.
    await supabase.from('visitor_logs').insert({
      ip_address:   ip,
      page_visited: '/api/bookings',
      user_agent:   req.headers['user-agent'] || null,
    });

    // ── Send emails — confirmation to guest + notification to Kyle ──
    try {
      const { sendBookingConfirmation, sendKyleNotification, sendToParty } = await import('./_lib/email.js');

      const guestData   = { first_name, last_name, email, phone };
      const bookingData = {
        // id is what the fan-out uses to find anyone else on this
        // booking. Without it they are silently skipped.
        id: booking.id,
        check_in_date, check_out_date, num_guests,
        booking_source, special_requests,
        discount_code: cleanData.discount_code,
        quote,
        request_id: requestId,
      };
      await Promise.all([
        // Reaches anyone added on the form. While that block is hidden
        // there is never anybody else yet, so this behaves exactly as
        // a single send.
        sendToParty(sendBookingConfirmation, { guest: guestData, booking: bookingData }),
        // Kyle's own notification never fans out.
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
