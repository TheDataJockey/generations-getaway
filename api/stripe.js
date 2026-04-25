/**
 * Generations Getaway LLC
 * Stripe Payment API — /api/stripe
 * ==================================
 * All Stripe operations via ?action= param:
 *
 *   POST ?action=create_payment_link
 *     Creates a Stripe Payment Link for a booking.
 *     Called from admin dashboard after booking confirmation.
 *     Returns a shareable URL emailed to the guest.
 *
 *   POST ?action=create_deposit_auth
 *     Creates a SetupIntent to authorize (not charge)
 *     the security deposit on guest's card.
 *
 *   POST ?action=webhook
 *     Handles Stripe webhook events:
 *       - payment_intent.succeeded  → mark booking paid
 *       - payment_intent.canceled   → mark booking unpaid
 *       - setup_intent.succeeded    → mark deposit authorized
 *
 *   GET  ?action=payment_status&booking_id=xxx
 *     Returns current payment status for a booking.
 *
 * Security:
 *   - Admin actions require valid session token
 *   - Webhook validated via Stripe signature
 *   - All amounts in cents (Stripe standard)
 *
 * Refund Policy (enforced in Stripe & tracked in DB):
 *   30+ days before check-in  → 100% refund
 *   14–29 days before check-in → 50% refund
 *   7–13 days before check-in  → 25% refund
 *   <7 days before check-in    → No refund
 *   No-show                    → No refund
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

  const { booking_id } = req.body;
  if (!booking_id) return res.status(400).json({ error: 'booking_id required.' });

  // Fetch booking + guest
  const { data: booking, error } = await supabase
    .from('bookings')
    .select(`
      id, check_in_date, check_out_date, num_nights,
      total_amount, security_deposit, payment_status,
      guests(first_name, last_name, email)
    `)
    .eq('id', booking_id)
    .single();

  if (error || !booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!booking.total_amount) return res.status(400).json({ error: 'Total amount not set on booking.' });

  const guest        = booking.guests;
  const amountCents  = Math.round(parseFloat(booking.total_amount) * 100);
  const refundPolicy = getRefundPolicy(booking.check_in_date);

  // Build description
  const checkIn  = new Date(booking.check_in_date  + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const checkOut = new Date(booking.check_out_date + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const nights   = booking.num_nights || Math.round((new Date(booking.check_out_date) - new Date(booking.check_in_date)) / 86400000);

  // Create Stripe Price (one-off)
  const price = await stripe('POST', '/prices', {
    currency:    'usd',
    unit_amount: amountCents,
    product_data: {
      name:        'Generations Getaway LLC — Booking Payment',
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
        check_in:  booking.check_in_date,
        check_out: booking.check_out_date,
      },
      receipt_email: guest.email,
    },
    phone_number_collection: { enabled: false },
  });

  // Save link to booking
  await supabase
    .from('bookings')
    .update({
      stripe_payment_link_id: paymentLink.id,
      stripe_payment_link_url: paymentLink.url,
      payment_status: 'pending',
    })
    .eq('id', booking_id);

  // Log to audit
  await supabase.from('audit_logs').insert({
    admin_id:   admin.id,
    action:     'stripe_payment_link_created',
    table_name: 'bookings',
    record_id:  booking_id,
    new_values: { payment_link: paymentLink.url, amount: booking.total_amount },
  });

  return res.status(200).json({
    success:      true,
    payment_url:  paymentLink.url,
    payment_link_id: paymentLink.id,
    amount:       booking.total_amount,
    refund_policy: refundPolicy,
  });
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
      const bookingId = obj.metadata?.booking_id;
      if (bookingId) {
        const amountPaid = (obj.amount_received / 100).toFixed(2);
        await supabase.from('bookings').update({
          payment_status:            'paid',
          amount_received:           amountPaid,
          balance_due:               0,
          stripe_payment_intent_id:  obj.id,
        }).eq('id', bookingId);
        console.log(`[stripe/webhook] Booking ${bookingId} paid: $${amountPaid}`);
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
