/**
 * Generations Getaway LLC
 * GET /api/cron
 * ==============
 * Daily email automation — runs at 8:00 AM EST via Vercel cron.
 * Queries Supabase for bookings due for each email type and sends them.
 *
 * Email schedule:
 *   - Welcome email    → guests checking in exactly 3 days from today
 *   - Day-before       → guests checking in exactly 1 day from today
 *   - Checkout remind  → guests checking out today
 *   - Review request   → guests who checked out yesterday
 *
 * Each booking tracks which emails have been sent via boolean flags
 * to prevent duplicate sends if the cron runs multiple times.
 *
 * Security:
 *   - Protected by CRON_SECRET env var
 *   - Vercel automatically sets Authorization header on cron calls
 */

import { createClient } from '@supabase/supabase-js';
import {
  sendWelcomeEmail,
  sendDayBeforeReminder,
  sendCheckoutReminder,
  sendReviewRequest,
} from './email.js';

// Strip any trailing /rest/v1 from URL
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  // ── Verify cron secret ──
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  if (req.method !== 'GET') return res.status(405).end();

  // ── Get today's date in EST ──
  const now       = new Date();
  const estOffset = -5; // EST (UTC-5); adjust to -4 for EDT if needed
  const estNow    = new Date(now.getTime() + (estOffset * 60 * 60 * 1000));

  const today     = toDateStr(estNow);
  const tomorrow  = toDateStr(addDays(estNow, 1));
  const in3Days   = toDateStr(addDays(estNow, 3));
  const yesterday = toDateStr(addDays(estNow, -1));

  console.log(`[cron] Running for date: ${today}`);

  const results = {
    welcome:  { sent: 0, errors: 0 },
    dayBefore:{ sent: 0, errors: 0 },
    checkout: { sent: 0, errors: 0 },
    review:   { sent: 0, errors: 0 },
  };

  try {
    // ── Fetch all confirmed bookings with guest data ──
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        id, check_in_date, check_out_date,
        num_guests, yale_pin_code, welcome_note,
        booking_source, special_requests,
        email_welcome_sent, email_day_before_sent,
        email_checkout_sent, email_review_sent,
        guests(id, first_name, last_name, email, phone)
      `)
      .eq('status', 'confirmed')
      .not('guests', 'is', null);

    if (error) throw error;
    if (!bookings?.length) {
      console.log('[cron] No confirmed bookings found.');
      return res.status(200).json({ message: 'No bookings to process.', results });
    }

    // ── Process each booking ──
    for (const booking of bookings) {
      const guest = booking.guests;
      if (!guest?.email) continue;

      // 1. Welcome email — 3 days before check-in
      if (booking.check_in_date === in3Days && !booking.email_welcome_sent) {
        const result = await sendWelcomeEmail({ guest, booking });
        if (result.success) {
          await markSent(booking.id, 'email_welcome_sent');
          results.welcome.sent++;
        } else {
          results.welcome.errors++;
          console.error(`[cron] Welcome failed for booking ${booking.id}:`, result.error);
        }
      }

      // 2. Day-before reminder
      if (booking.check_in_date === tomorrow && !booking.email_day_before_sent) {
        const result = await sendDayBeforeReminder({ guest, booking });
        if (result.success) {
          await markSent(booking.id, 'email_day_before_sent');
          results.dayBefore.sent++;
        } else {
          results.dayBefore.errors++;
          console.error(`[cron] Day-before failed for booking ${booking.id}:`, result.error);
        }
      }

      // 3. Checkout reminder — morning of checkout
      if (booking.check_out_date === today && !booking.email_checkout_sent) {
        const result = await sendCheckoutReminder({ guest, booking });
        if (result.success) {
          await markSent(booking.id, 'email_checkout_sent');
          results.checkout.sent++;
        } else {
          results.checkout.errors++;
          console.error(`[cron] Checkout failed for booking ${booking.id}:`, result.error);
        }
      }

      // 4. Review request — 1 day after checkout
      if (booking.check_out_date === yesterday && !booking.email_review_sent) {
        const result = await sendReviewRequest({ guest, booking });
        if (result.success) {
          await markSent(booking.id, 'email_review_sent');
          results.review.sent++;
        } else {
          results.review.errors++;
          console.error(`[cron] Review failed for booking ${booking.id}:`, result.error);
        }
      }
    }

    console.log('[cron] Complete:', JSON.stringify(results));
    return res.status(200).json({ success: true, date: today, results });

  } catch (err) {
    console.error('[cron] Fatal error:', err.message);
    return res.status(500).json({ error: err.message, results });
  }
}

// ── Mark an email as sent in Supabase ──
async function markSent(bookingId, field) {
  await supabase
    .from('bookings')
    .update({ [field]: true })
    .eq('id', bookingId);
}

// ── Date helpers ──
function toDateStr(date) {
  return date.toISOString().split('T')[0];
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
