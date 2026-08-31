/**
 * FILE: api/admin-chat.js
 * ENDPOINT: POST /api/admin-chat
 * USED BY: Admin Assistant (admin/assistant.html)
 * ============================================================
 * PURPOSE:
 *   An AI assistant for Kyle only. Unlike the guest chatbot in
 *   /api/chat.js, this one can see operational data: current
 *   discount codes and their exact terms, nightly rates, date
 *   overrides, upcoming bookings, and the full knowledge base.
 *
 * WHY THIS IS SEPARATE FROM /api/chat.js:
 *   The guest bot must NEVER see discount codes or booking data.
 *   Keeping the two endpoints apart means there is no code path
 *   where a guest question can reach admin context. This endpoint
 *   requires a valid admin Bearer token on every request.
 *
 * WHAT IT CAN ANSWER:
 *   - "What discount codes do I have and what do they do?"
 *   - "What would a week in March cost with FRIENDS?"
 *   - "Who is checking in this week?"
 *   - "How do I clean the pool filter?"  (from knowledge base)
 *   - "What's my cancellation policy?"
 *
 * SAFETY:
 *   Read-only. It reports on data and gives guidance, but it
 *   cannot change rates, edit codes, or alter bookings. Those
 *   stay in the Pricing page and Dashboard where every change
 *   is written to audit_logs.
 *
 * DATABASE TABLES USED:
 *   admin_users (auth), pricing_seasons, pricing_overrides,
 *   discount_codes, pricing_settings, bookings, guests,
 *   knowledge_base, admin_chat_logs
 *
 * REQUIRES: ANTHROPIC_API_KEY environment variable
 */

import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

const RATE_LIMIT = 60;          // messages per admin per hour
const MODEL      = 'claude-sonnet-4-20250514';

/* ── Auth (same pattern as api/admin.js) ── */
async function validateAdminToken(token) {
  if (!token) return { error: 'Unauthorized.', status: 401 };

  const { data: admin } = await supabase
    .from('admin_users')
    .select('id, first_name, email, role, is_active, session_expires')
    .eq('session_token', token)
    .eq('is_active', true)
    .single();

  if (!admin) return { error: 'Invalid or expired session.', status: 401 };
  if (admin.session_expires && new Date(admin.session_expires) < new Date()) {
    return { error: 'Session expired. Please log in again.', status: 401 };
  }
  return { admin };
}

/* ── Gather the operational picture ── */
async function buildContext() {
  const today = new Date().toISOString().slice(0, 10);
  const in60  = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

  const [seasons, overrides, codes, settings, bookings, kb] = await Promise.all([
    supabase.from('pricing_seasons').select('*').order('sort_order'),
    supabase.from('pricing_overrides').select('*').order('start_date'),
    supabase.from('discount_codes').select('*').order('code'),
    supabase.from('pricing_settings').select('*').eq('id', 1).single(),
    supabase.from('bookings')
      .select('check_in_date, check_out_date, num_guests, status, num_nights, guests(first_name, last_name, email)')
      .gte('check_out_date', today).lte('check_in_date', in60)
      .order('check_in_date'),
    supabase.from('knowledge_base').select('category, question, answer'),
  ]);

  const MONTHS = ['','January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  const seasonLines = (seasons.data || []).map(s =>
    `- ${s.label} (${s.id}): $${Number(s.nightly_rate).toFixed(2)}/night. ` +
    `Months: ${(s.months || []).map(m => MONTHS[m]).join(', ') || 'none'}`
  ).join('\n');

  const overrideLines = (overrides.data || []).length
    ? (overrides.data || []).map(o =>
        `- "${o.label}" ${o.start_date} to ${o.end_date}: ` +
        (o.is_blocked ? 'BLOCKED (not bookable)' : `$${Number(o.nightly_rate).toFixed(2)}/night`) +
        (o.min_nights ? `, min ${o.min_nights} nights` : '') +
        `, priority ${o.priority || 0}`
      ).join('\n')
    : '(none set)';

  const codeLines = (codes.data || []).map(c => {
    const effect = c.kind === 'percent'
      ? `${c.percent}% off the standard rate`
      : `flat rates — high $${c.rate_high ?? '—'}, medium $${c.rate_medium ?? '—'}, low $${c.rate_low ?? '—'}` +
        (c.free_nights ? `, first ${c.free_nights} night(s) free` +
          (c.free_seasons?.length ? ` in ${c.free_seasons.join('/')} season only` : '') : '');
    const limits = [
      c.valid_from  ? `valid from ${c.valid_from}`   : null,
      c.valid_until ? `valid until ${c.valid_until}` : null,
      c.max_uses != null ? `${c.times_used}/${c.max_uses} uses` : null,
      c.is_active ? null : 'INACTIVE',
    ].filter(Boolean).join(', ');
    return `- ${c.code} ("${c.label}"): ${effect}${limits ? ` [${limits}]` : ''}`;
  }).join('\n');

  const bookingLines = (bookings.data || []).length
    ? (bookings.data || []).map(b => {
        const g = b.guests || {};
        return `- ${b.check_in_date} to ${b.check_out_date} (${b.num_nights || '?'} nights): ` +
               `${g.first_name || '?'} ${g.last_name || ''}, ${b.num_guests || '?'} guests, status ${b.status}`;
      }).join('\n')
    : '(no bookings in the next 60 days)';

  const kbLines = (kb.data || []).map(k =>
    `- [${k.category}] ${k.question} => ${k.answer}`
  ).join('\n');

  const taxPct = ((settings.data?.tax_rate ?? 0.13) * 100).toFixed(2);

  return `TODAY'S DATE: ${today}

NIGHTLY RATES (all-in, include cleaning):
${seasonLines}

BOOKING SETTINGS:
- Minimum stay: ${settings.data?.min_nights ?? 3} nights (soft — shorter stays can be requested and approved)
- Lodging tax: ${taxPct}% (Broward County: 6% FL transient + 1% county surtax + 6% tourist development)
- Tax is charged on the discounted amount, so comped nights are untaxed.

DATE OVERRIDES (these beat the seasonal rate):
${overrideLines}

DISCOUNT CODES (CONFIDENTIAL — never to be shared with guests):
${codeLines}

UPCOMING BOOKINGS (next 60 days):
${bookingLines}

PROPERTY KNOWLEDGE BASE:
${kbLines || '(empty)'}

CANCELLATION POLICY:
- Guest cancels: 30+ days = full refund, 14-29 days = 50%, 7-13 days = 25%, under 7 days = none.
- Management may cancel any reservation at any time at its sole discretion; the guest's
  sole remedy is a refund of amounts paid (pro-rated if the stay has begun).`;
}

const SYSTEM_PROMPT = `You are the operations assistant for Kyle, who owns and runs
Generations Getaway LLC — a 2 bed / 1 bath short-term rental with a heated pool and spa
at 647 NE 16th Terrace, Fort Lauderdale, FL.

You are speaking to Kyle himself, not to a guest. You may freely discuss discount codes,
rates, margins, guest details, and operational matters.

HOW TO ANSWER:
- Be direct and concise. Kyle is busy and often on his phone.
- Use the CONTEXT below as the source of truth about his business. Prefer it over
  general knowledge whenever they disagree.
- When he asks what something costs, do the arithmetic and show the figures.
- When the context does not cover something, say so plainly rather than guessing.
  Never invent a discount code, a rate, a booking, or a property detail.
- For maintenance questions not in the knowledge base, general guidance is fine, but
  say clearly that it is general advice and not specific to his equipment.
- You cannot change anything. If he asks you to update a rate, add a code, or edit a
  booking, tell him which page to use: the Pricing & Discounts page for rates, overrides
  and codes, or the Dashboard for bookings and guests.
- Flag anything that looks like a problem — a comped booking, a stay under the minimum,
  an expired code still active, overlapping overrides.

CONTEXT:
`;

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const auth = await validateAdminToken(token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const admin = auth.admin;

  try {
    const { question, history } = req.body || {};
    if (!question?.trim()) {
      return res.status(400).json({ error: 'A question is required.' });
    }
    if (question.length > 4000) {
      return res.status(400).json({ error: 'That question is too long.' });
    }

    // ── Rate limit per admin, per hour ──
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const { count } = await supabase
      .from('admin_chat_logs')
      .select('id', { count: 'exact', head: true })
      .eq('admin_id', admin.id)
      .gte('created_at', hourAgo);

    if ((count || 0) >= RATE_LIMIT) {
      return res.status(429).json({
        error: 'Too many messages this hour. Please try again shortly.'
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'The assistant is not configured yet. ANTHROPIC_API_KEY is missing in Vercel.'
      });
    }

    const context = await buildContext();

    // Keep the last few turns so follow-up questions make sense.
    const priorTurns = Array.isArray(history)
      ? history.slice(-8).filter(m =>
          (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 1200,
        system:     SYSTEM_PROMPT + context,
        messages:   [...priorTurns, { role: 'user', content: question.trim() }],
      }),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text();
      console.error('[admin-chat] Anthropic error:', aiRes.status, detail.slice(0, 400));
      return res.status(502).json({ error: 'The assistant could not be reached. Please try again.' });
    }

    const data = await aiRes.json();
    const answer = data.content?.[0]?.text
      || 'Sorry — I could not produce an answer for that.';

    // Log for review. Never block the reply if logging fails.
    supabase.from('admin_chat_logs').insert({
      admin_id:    admin.id,
      admin_email: admin.email,
      question:    question.trim(),
      answer,
    }).then(({ error }) => {
      if (error) console.error('[admin-chat] Log failed:', error.message);
    });

    return res.status(200).json({ answer });

  } catch (err) {
    console.error('[admin-chat]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
