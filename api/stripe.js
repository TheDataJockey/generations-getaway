/**
 * FILE: api/stripe.js
 * ENDPOINT: /api/stripe?action=[action]
 * USED BY: Admin Dashboard - All Bookings (admin/dashboard.html)
 * ============================================================
 * PURPOSE:
 *   All Stripe payment processing. Kyle uses this to send
 *   payment links to guests and process refunds.
 *
 * ACTIONS:
 *   create_payment_link  - Creates a Stripe link Kyle sends to guest
 *                         Guest pays by card, Apple Pay, Google Pay
 *   create_deposit_auth  - Places an authorization hold for security
 *                         deposit (card not charged yet)
 *   capture_deposit      - Charges the security deposit (e.g. damage)
 *   release_deposit      - Releases hold, guest card never charged
 *   refund_payment       - Refunds based on cancellation policy:
 *                         30+ days = 100%, 14-29 days = 50%,
 *                         7-13 days = 25%, under 7 days = 0%
 *   payment_status       - Returns payment status for a booking
 *   webhook              - Called by Stripe when payment completes
 *                         Updates booking status automatically
 *
 * REQUIRES in Vercel:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *
 * DATABASE TABLES USED:
 *   - bookings (reads/updates payment status)
 *   - audit_logs (records all payment events)
 */

import { createClient } from '@supabase/supabase-js';

const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const BASE_URL              = 'https://www.generationsgetawayfl.com';

// Strip any trailing /rest/v1 from Supabase URL
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Stripe REST helper (no SDK — keeps bundle small) ──
async function stripe(method, path, body = null) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(flattenParams(body)).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe error');
  return data;
}

// Flatten nested objects for Stripe's form encoding
function flattenParams(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && val !== undefined) {
      if (typeof val === 'object' && !Array.isArray(val)) {
        Object.assign(result, flattenParams(val, fullKey));
      } else if (Array.isArray(val)) {
        val.forEach((item, i) => {
          if (typeof item === 'object') {
            Object.assign(result, flattenParams(item, `${fullKey}[${i}]`));
          } else {
            result[`${fullKey}[${i}]`] = item;
          }
        });
      } else {
        result[fullKey] = String(val);
      }
    }
  }
  return result;
}

// ── CORS ──
const ALLOWED_ORIGINS = [
  'https://www.generationsgetawayfl.com',
  'https://generationsgetawayfl.com',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || origin.includes('localhost') || origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-token');
}

// ── Validate admin session ──
async function validateAdmin(req) {
  const token = req.headers['x-session-token'] || req.body?.session_token;
  if (!token) return null;
  const { data } = await supabase
    .from('admin_users')
    .select('id, email, role')
    .eq('session_token', token)
    .gt('session_expires', new Date().toISOString())
    .single();
  return data || null;
}

// ── Calculate refund percentage based on days until check-in ──
function getRefundPolicy(checkInDate) {
  const today     = new Date();
  const checkIn   = new Date(checkInDate + 'T15:00:00');
  const daysUntil = Math.ceil((checkIn - today) / (1000 * 60 * 60 * 24));

  if (daysUntil >= 30) return { pct: 100, label: 'Full refund',     days: daysUntil };
  if (daysUntil >= 14) return { pct: 50,  label: '50% refund',      days: daysUntil };
  if (daysUntil >= 7)  return { pct: 25,  label: '25% refund',      days: daysUntil };
  return                      { pct: 0,   label: 'No refund',        days: daysUntil };
}

// ════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe not configured.' });
  }

  const { action } = req.query;

  try {
    switch (action) {
      case 'create_payment_link': return await createPaymentLink(req, res);
      case 'create_deposit_auth': return await createDepositAuth(req, res);
      case 'capture_deposit':     return await captureDeposit(req, res);
      case 'release_deposit':     return await releaseDeposit(req, res);
      case 'refund_payment':      return await refundPayment(req, res);
      case 'payment_status':      return await getPaymentStatus(req, res);
      case 'webhook':             return await handleWebhook(req, res);
      default:
        return res.status(400).json({ error: 'Invalid action.' });
    }
  } catch (err) {
    console.error(`[stripe/${action}]`, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// ACTION: Create Payment Link
// Called from admin dashboard to send guest a payment URL
// ════════════════════════════════════════════════════════════════
async function createPaymentLink(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const admin = await validateAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });

  const result = await buildPaymentLink({
    booking_id:   req.body?.booking_id,
    payment_type: req.body?.payment_type || 'full',
    admin_id:     admin.id,
  });
  return res.status(result.status).json(result.body);
}

/**
 * Create a Stripe payment link for a booking and email it to the guest.
 * Shared by the admin endpoint above and the daily cron (balance reminders),
 * so both behave identically. Returns { status, body } rather than writing
 * to a response, because the cron has no response to write to.
 */
export async function buildPaymentLink({ booking_id, payment_type = 'full', admin_id = null }) {
  // payment_type: 'deposit' (50% now), 'balance' (remainder, due 14 days
  // before arrival) or 'full'. Defaults to full for backwards compatibility.
  if (!booking_id) return { status: 400, body: { error: 'booking_id required.' } };
  if (!['deposit', 'balance', 'full'].includes(payment_type)) {
    return { status: 400, body: { error: 'payment_type must be deposit, balance or full.' } };
  }

  // Fetch booking + guest
  const { data: booking, error } = await supabase
    .from('bookings')
    .select(`
      id, request_id, check_in_date, check_out_date, num_nights,
      total_amount, quoted_total, deposit_amount, balance_amount,
      balance_due_date, security_deposit, payment_status,
      guests(first_name, last_name, email)
    `)
    .eq('id', booking_id)
    .single();

  if (error || !booking) return { status: 404, body: { error: 'Booking not found.' } };

  // Work out what to charge. Bookings taken through the website store
  // quoted_total / deposit_amount / balance_amount; older ones only have
  // total_amount, so fall back to that.
  const fullAmount = booking.quoted_total ?? booking.total_amount;
  const amountMap = {
    deposit: booking.deposit_amount,
    balance: booking.balance_amount,
    full:    fullAmount,
  };
  const amount = amountMap[payment_type];

  if (amount == null || parseFloat(amount) <= 0) {
    return { status: 400, body: {
      error: payment_type === 'full'
        ? 'No total is set on this booking.'
        : `No ${payment_type} amount is set on this booking. It may predate the deposit schedule.`,
    } };
  }

  const guest        = booking.guests;
  const amountCents  = Math.round(parseFloat(amount) * 100);
  const refundPolicy = getRefundPolicy(booking.check_in_date);
  const typeLabel    = payment_type === 'deposit' ? 'Deposit (50%)'
                     : payment_type === 'balance' ? 'Balance'
                     : 'Booking Payment';

  // Build description
  const checkIn  = new Date(booking.check_in_date  + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const checkOut = new Date(booking.check_out_date + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const nights   = booking.num_nights || Math.round((new Date(booking.check_out_date) - new Date(booking.check_in_date)) / 86400000);

  // Create Stripe Price (one-off)
  const price = await stripe('POST', '/prices', {
    currency:    'usd',
    unit_amount: amountCents,
    product_data: {
      name:        `Generations Getaway LLC — ${typeLabel}`,
      description: `${nights} night stay · ${checkIn} – ${checkOut} · ${guest.first_name} ${guest.last_name}`,
    },
  });

  // Create Payment Link
  const paymentLink = await stripe('POST', '/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type:     'redirect',
      redirect: { url: `${BASE_URL}/welcome.html?payment=success` },
    },
    metadata: {
      booking_id,
      payment_type,
      guest_email: guest.email,
      check_in:    booking.check_in_date,
      check_out:   booking.check_out_date,
      refund_pct:  String(refundPolicy.pct),
    },
    customer_creation:    'always',
    payment_intent_data: {
      description: `Generations Getaway LLC — ${checkIn} to ${checkOut}`,
      metadata: {
        booking_id,
        payment_type,
        check_in:  booking.check_in_date,
        check_out: booking.check_out_date,
      },
      receipt_email: guest.email,
    },
    phone_number_collection: { enabled: false },
  });

  // Save link to booking. Deposit and balance links are stored in their
  // own columns so one doesn't overwrite the other.
  const updates = {
    stripe_payment_link_id:  paymentLink.id,
    stripe_payment_link_url: paymentLink.url,
    payment_status: 'pending',
  };
  if (payment_type === 'deposit') {
    updates.deposit_link_url  = paymentLink.url;
    updates.deposit_sent_at   = new Date().toISOString();
  } else if (payment_type === 'balance') {
    updates.balance_link_url  = paymentLink.url;
    updates.balance_sent_at   = new Date().toISOString();
  }

  const { error: saveErr } = await supabase
    .from('bookings').update(updates).eq('id', booking_id);
  if (saveErr) {
    // Retry without the newer columns so a missing migration doesn't
    // lose a link that Stripe has already created.
    console.error('[stripe] Save failed, retrying minimal:', saveErr.message);
    await supabase.from('bookings').update({
      stripe_payment_link_id:  paymentLink.id,
      stripe_payment_link_url: paymentLink.url,
      payment_status: 'pending',
    }).eq('id', booking_id);
  }

  // Email the link to the guest.
  let emailed = null;
  try {
    const { sendPaymentRequest } = await import('./_lib/email.js');
    const result = await sendPaymentRequest({
      guest,
      booking,
      payment_type,
      amount,
      payment_url: paymentLink.url,
    });
    emailed = result?.success
      ? `Emailed ${guest.email}`
      : `Email failed: ${result?.error || 'unknown'}`;
  } catch (mailErr) {
    console.error('[stripe] Payment email failed:', mailErr.message);
    emailed = `Email failed: ${mailErr.message}`;
  }

  // Log to audit
  await supabase.from('audit_logs').insert({
    admin_id:   admin_id,
    action:     'stripe_payment_link_created',
    table_name: 'bookings',
    record_id:  booking_id,
    new_values: { payment_link: paymentLink.url, amount, payment_type },
  });

  return { status: 200, body: {
    success:      true,
    payment_url:  paymentLink.url,
    payment_link_id: paymentLink.id,
    payment_type,
    amount,
    emailed,
    refund_policy: refundPolicy,
  } };
}

// ════════════════════════════════════════════════════════════════
// ACTION: Create Security Deposit Authorization (hold, not charge)
// ════════════════════════════════════════════════════════════════
async function createDepositAuth(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const admin = await validateAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });

  const { booking_id } = req.body;
  if (!booking_id) return res.status(400).json({ error: 'booking_id required.' });

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, check_in_date, check_out_date, security_deposit, guests(first_name, last_name, email)')
    .eq('id', booking_id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!booking.security_deposit) return res.status(400).json({ error: 'No security deposit amount set.' });

  const depositCents = Math.round(parseFloat(booking.security_deposit) * 100);
  const guest        = booking.guests;

  // Create PaymentIntent with manual capture (authorize only)
  const intent = await stripe('POST', '/payment_intents', {
    amount:               depositCents,
    currency:             'usd',
    capture_method:       'manual',
    confirmation_method:  'automatic',
    description:          `Security Deposit — Generations Getaway LLC · ${booking.check_in_date} to ${booking.check_out_date}`,
    receipt_email:        guest.email,
    metadata: {
      booking_id,
      type:      'security_deposit',
      check_in:  booking.check_in_date,
      check_out: booking.check_out_date,
    },
  });

  // Save to booking
  await supabase
    .from('bookings')
    .update({
      stripe_deposit_intent_id: intent.id,
      stripe_deposit_status:    'requires_payment_method',
    })
    .eq('id', booking_id);

  return res.status(200).json({
    success:        true,
    client_secret:  intent.client_secret,
    deposit_amount: booking.security_deposit,
    intent_id:      intent.id,
  });
}

// ════════════════════════════════════════════════════════════════
// ACTION: Capture Security Deposit (charge it — e.g. after damage)
// ════════════════════════════════════════════════════════════════
async function captureDeposit(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const admin = await validateAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });

  const { booking_id, amount_cents } = req.body;
  if (!booking_id) return res.status(400).json({ error: 'booking_id required.' });

  const { data: booking } = await supabase
    .from('bookings')
    .select('stripe_deposit_intent_id, security_deposit')
    .eq('id', booking_id)
    .single();

  if (!booking?.stripe_deposit_intent_id) return res.status(400).json({ error: 'No deposit authorization found.' });

  const captureCents = amount_cents || Math.round(parseFloat(booking.security_deposit) * 100);

  await stripe('POST', `/payment_intents/${booking.stripe_deposit_intent_id}/capture`, {
    amount_to_capture: captureCents,
  });

  await supabase.from('bookings').update({ stripe_deposit_status: 'captured' }).eq('id', booking_id);
  await supabase.from('audit_logs').insert({
    admin_id: admin.id, action: 'stripe_deposit_captured',
    table_name: 'bookings', record_id: booking_id,
    new_values: { amount_cents: captureCents },
  });

  return res.status(200).json({ success: true });
}

// ════════════════════════════════════════════════════════════════
// ACTION: Release Security Deposit (cancel authorization)
// ════════════════════════════════════════════════════════════════
async function releaseDeposit(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const admin = await validateAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });

  const { booking_id } = req.body;
  const { data: booking } = await supabase
    .from('bookings')
    .select('stripe_deposit_intent_id')
    .eq('id', booking_id)
    .single();

  if (!booking?.stripe_deposit_intent_id) return res.status(400).json({ error: 'No deposit authorization found.' });

  await stripe('POST', `/payment_intents/${booking.stripe_deposit_intent_id}/cancel`);
  await supabase.from('bookings').update({ stripe_deposit_status: 'released' }).eq('id', booking_id);
  await supabase.from('audit_logs').insert({
    admin_id: admin.id, action: 'stripe_deposit_released',
    table_name: 'bookings', record_id: booking_id, new_values: {},
  });

  return res.status(200).json({ success: true });
}

// ════════════════════════════════════════════════════════════════
// ACTION: Refund Payment (apply refund policy)
// ════════════════════════════════════════════════════════════════
async function refundPayment(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const admin = await validateAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });

  const { booking_id, override_pct } = req.body;

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, check_in_date, total_amount, stripe_payment_intent_id, payment_status')
    .eq('id', booking_id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!booking.stripe_payment_intent_id) return res.status(400).json({ error: 'No payment found for this booking.' });
  if (booking.payment_status !== 'paid') return res.status(400).json({ error: 'Booking has not been paid.' });

  const policy     = getRefundPolicy(booking.check_in_date);
  const refundPct  = override_pct !== undefined ? parseInt(override_pct) : policy.pct;
  const totalCents = Math.round(parseFloat(booking.total_amount) * 100);
  const refundCents = Math.round(totalCents * refundPct / 100);

  if (refundCents === 0) {
    return res.status(200).json({ success: true, refund_amount: 0, message: 'No refund applicable per cancellation policy.' });
  }

  const refund = await stripe('POST', '/refunds', {
    payment_intent: booking.stripe_payment_intent_id,
    amount:         refundCents,
    reason:         'requested_by_customer',
  });

  const refundAmount = (refundCents / 100).toFixed(2);
  await supabase.from('bookings').update({
    payment_status:   'refunded',
    amount_received:  (parseFloat(booking.total_amount) - parseFloat(refundAmount)).toFixed(2),
    balance_due:      0,
  }).eq('id', booking_id);

  await supabase.from('audit_logs').insert({
    admin_id: admin.id, action: 'stripe_refund_issued',
    table_name: 'bookings', record_id: booking_id,
    new_values: { refund_id: refund.id, refund_amount: refundAmount, refund_pct: refundPct },
  });

  return res.status(200).json({
    success:       true,
    refund_id:     refund.id,
    refund_amount: refundAmount,
    refund_pct:    refundPct,
    policy:        policy,
  });
}

// ════════════════════════════════════════════════════════════════
// ACTION: Get Payment Status
// ════════════════════════════════════════════════════════════════
async function getPaymentStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const admin = await validateAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });

  const { booking_id } = req.query;
  const { data: booking } = await supabase
    .from('bookings')
    .select(`
      id, payment_status, payment_method, total_amount,
      amount_received, balance_due, security_deposit,
      stripe_payment_link_url, stripe_payment_intent_id,
      stripe_deposit_intent_id, stripe_deposit_status,
      check_in_date
    `)
    .eq('id', booking_id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const refundPolicy = getRefundPolicy(booking.check_in_date);

  return res.status(200).json({ booking, refund_policy: refundPolicy });
}

// ════════════════════════════════════════════════════════════════
// ACTION: Webhook (called by Stripe on payment events)
// ════════════════════════════════════════════════════════════════
export const config = { api: { bodyParser: false } };

async function handleWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Read raw body for signature verification
  const rawBody = await new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

  // Verify webhook signature if secret is set
  if (STRIPE_WEBHOOK_SECRET) {
    const sig       = req.headers['stripe-signature'];
    const timestamp = sig?.match(/t=(\d+)/)?.[1];
    const sigHash   = sig?.match(/v1=([a-f0-9]+)/)?.[1];

    if (timestamp && sigHash) {
      const crypto   = await import('crypto');
      const payload  = `${timestamp}.${rawBody}`;
      const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
      if (expected !== sigHash) {
        console.error('[stripe/webhook] Signature mismatch');
        return res.status(400).json({ error: 'Invalid signature.' });
      }
    }
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: 'Invalid JSON.' }); }

  const obj = event.data?.object;

  switch (event.type) {

    case 'payment_intent.succeeded': {
      const bookingId   = obj.metadata?.booking_id;
      const paymentType = obj.metadata?.payment_type || 'full';
      if (bookingId) {
        const amountPaid = Number((obj.amount_received / 100).toFixed(2));

        // A deposit is NOT the whole stay. Marking it 'paid' and zeroing
        // balance_due would hide the outstanding half, so accumulate what
        // has actually been received and only settle when it covers the total.
        const { data: current } = await supabase
          .from('bookings')
          .select('amount_received, quoted_total, total_amount, deposit_amount, balance_amount')
          .eq('id', bookingId)
          .single();

        const previous = Number(current?.amount_received || 0);
        const received = Number((previous + amountPaid).toFixed(2));
        const owed     = Number(current?.quoted_total ?? current?.total_amount ?? 0);
        const settled  = owed > 0 && received + 0.01 >= owed;

        const update = {
          amount_received:          received,
          balance_due:              owed > 0 ? Math.max(0, Number((owed - received).toFixed(2))) : 0,
          payment_status:           settled ? 'paid' : 'partial',
          stripe_payment_intent_id: obj.id,
        };
        if (paymentType === 'deposit') update.deposit_paid_at = new Date().toISOString();
        if (paymentType === 'balance') update.balance_paid_at = new Date().toISOString();

        const { error: upErr } = await supabase
          .from('bookings').update(update).eq('id', bookingId);

        if (upErr) {
          // Retry without the newer columns rather than lose the payment record.
          console.error('[stripe/webhook] Update failed, retrying minimal:', upErr.message);
          await supabase.from('bookings').update({
            amount_received:          received,
            payment_status:           settled ? 'paid' : 'partial',
            stripe_payment_intent_id: obj.id,
          }).eq('id', bookingId);
        }

        console.log(`[stripe/webhook] Booking ${bookingId} ${paymentType} $${amountPaid} ` +
                    `(received $${received} of $${owed}) → ${update.payment_status}`);
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const bookingId = obj.metadata?.booking_id;
      if (bookingId) {
        await supabase.from('bookings').update({
          payment_status: 'pending',
          stripe_payment_intent_id: obj.id,
        }).eq('id', bookingId);
        console.log(`[stripe/webhook] Payment failed for booking ${bookingId}`);
      }
      break;
    }

    case 'charge.refunded': {
      const bookingId = obj.metadata?.booking_id || obj.payment_intent_metadata?.booking_id;
      if (bookingId) {
        await supabase.from('bookings').update({ payment_status: 'refunded' }).eq('id', bookingId);
      }
      break;
    }

    default:
      console.log(`[stripe/webhook] Unhandled event: ${event.type}`);
  }

  return res.status(200).json({ received: true });
}
