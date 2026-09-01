/**
 * FILE: api/admin.js
 * ENDPOINT: /api/admin?resource=[name]
 * USED BY: Admin Dashboard (admin/dashboard.html)
 * ============================================================
 * PURPOSE:
 *   The main API file for the Admin Dashboard. Every action
 *   Kyle takes in the dashboard goes through this single file.
 *   All requests require a valid admin session token.
 *
 * ROUTES (the ?resource= parameter selects the action):
 *   dashboard     GET  - Summary stats, recent bookings, alerts
 *   me            GET  - Current admin user info
 *   bookings      GET  - List all bookings with guest details
 *                PATCH - Update status or set PIN codes
 *   guests        GET  - List all guests
 *                POST  - Add guest manually (phone/email booking)
 *                PUT   - Edit existing guest
 *   generate-welcome POST - AI writes a personalized welcome note
 *   knowledge     GET/POST/PUT/DELETE - Manage chatbot Q&A pairs
 *   chat-logs     GET  - Guest chat history
 *                PATCH - Mark chat as resolved
 *   event-sources GET  - List event API sources
 *                PATCH - Toggle source on/off
 *   requests      GET  - Reservation change/cancel requests
 *                PATCH - Approve or decline a request
 *   users         GET  - Admin user list (super_admin only)
 *                PATCH - Enable/disable admin user
 *
 * DATABASE TABLES USED:
 *   - admin_users, guests, bookings, knowledge_base,
 *     chat_logs, event_source_settings, reservation_requests,
 *     audit_logs
 */

import crypto from 'crypto';
import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

const ADMIN_CORS_OPTS = {
  methods: 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  headers: 'Content-Type, Authorization',
};

// ── Extract Bearer token ──
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// ── Validate admin session token ──
async function validateAdminToken(token, requiredRole = null) {
  if (!token) return { error: 'Unauthorized.', status: 401 };

  const { data: admin } = await supabase
    .from('admin_users')
    .select('id, first_name, last_name, email, role, is_active, session_expires')
    .eq('session_token', token)
    .eq('is_active', true)
    .single();

  if (!admin) return { error: 'Invalid or expired session.', status: 401 };

  if (admin.session_expires && new Date(admin.session_expires) < new Date()) {
    return { error: 'Session expired. Please log in again.', status: 401 };
  }

  const roleLevel = { maintenance: 1, family_admin: 2, super_admin: 3 };
  if (requiredRole && roleLevel[admin.role] < roleLevel[requiredRole]) {
    return { error: 'Insufficient permissions.', status: 403 };
  }

  return { admin };
}

// ── Audit log helper ──
async function logAudit(admin, action, tableName, recordId = null, notes = null) {
  await supabase.from('audit_logs').insert({
    admin_id:    admin.id,
    admin_email: admin.email,
    admin_role:  admin.role,
    action,
    table_name:  tableName,
    record_id:   recordId || undefined,
    notes,
  });
}

// ── Main router ──
export default async function handler(req, res) {
  setCors(req, res, ADMIN_CORS_OPTS);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const resource = req.query.resource ||
    req.url.split('resource=')[1]?.split('&')[0];

  const token = extractToken(req);

  switch (resource) {
    case 'dashboard':        return handleDashboard(req, res, token);
    case 'me':               return handleMe(req, res, token);
    case 'guests':           return handleGuests(req, res, token);
    case 'bookings':         return handleBookings(req, res, token);
    case 'generate-welcome': return handleGenerateWelcome(req, res, token);
    case 'knowledge':        return handleKnowledge(req, res, token);
    case 'chat-logs':        return handleChatLogs(req, res, token);
    case 'event-sources':    return handleEventSources(req, res, token);
    case 'requests':         return handleRequests(req, res, auth);
    case 'users':            return handleUsers(req, res, token);
    case 'assistant':        return handleAssistant(req, res, token);
    case 'pricing-all':
    case 'season':
    case 'settings':
    case 'override':
    case 'code':             return handlePricingAdmin(req, res, token, resource);
    default:
      return res.status(400).json({ error: 'Missing or invalid resource parameter.' });
  }
}

// ════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════
async function handleDashboard(req, res, token) {
  const auth = await validateAdminToken(token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const [
      { count: inquiries },
      { count: confirmed },
      { count: guests },
      { count: unanswered },
      { data: recentBookings },
      { data: escalations },
    ] = await Promise.all([
      supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('status', 'inquiry'),
      supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('status', 'confirmed'),
      supabase.from('guests').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('chat_logs').select('*', { count: 'exact', head: true })
        .eq('was_escalated', true).is('resolved_at', null),
      supabase.from('bookings')
        .select('id, status, check_in_date, check_out_date, num_guests, booking_source, guests(first_name, last_name)')
        .order('created_at', { ascending: false }).limit(8),
      supabase.from('chat_logs')
        .select('id, question, created_at, guests(first_name, last_name)')
        .eq('was_escalated', true).is('resolved_at', null)
        .order('created_at', { ascending: false }).limit(5),
    ]);

    return res.status(200).json({
      inquiries:  inquiries  || 0,
      confirmed:  confirmed  || 0,
      guests:     guests     || 0,
      unanswered: unanswered || 0,
      recent_bookings: (recentBookings || []).map(b => ({
        id: b.id, status: b.status,
        check_in_date: b.check_in_date, check_out_date: b.check_out_date,
        num_guests: b.num_guests, booking_source: b.booking_source,
        guest_first:          b.guests?.first_name || '—',
        guest_last:           b.guests?.last_name  || '',
        confirmation_number:  b.confirmation_number || '',

      })),
      escalations: (escalations || []).map(c => ({
        id: c.id, question: c.question, created_at: c.created_at,
        guest_name: c.guests ? `${c.guests.first_name} ${c.guests.last_name}` : 'Guest',
      })),
    });
  } catch (err) {
    console.error('[admin/dashboard]', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard.' });
  }
}

// ════════════════════════════════════
// ME
// ════════════════════════════════════
async function handleMe(req, res, token) {
  const auth = await validateAdminToken(token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  return res.status(200).json({
    first_name: auth.admin.first_name,
    last_name:  auth.admin.last_name,
    email:      auth.admin.email,
    role:       auth.admin.role,
  });
}

// ════════════════════════════════════
// GUESTS
// ════════════════════════════════════
async function handleGuests(req, res, token) {
  const auth = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { search = '', filter = '' } = req.query;
      let query = supabase
        .from('guests')
        .select('id, first_name, last_name, email, phone, total_stays, is_active, is_blacklisted, vip_status, bookings(check_out_date)')
        .order('last_name', { ascending: true });
      if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
      if (filter === 'vip')         query = query.eq('vip_status', true);
      if (filter === 'blacklisted') query = query.eq('is_blacklisted', true);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({
        guests: (data || []).map(g => ({
          ...g,
          last_stay: g.bookings?.sort((a,b) => new Date(b.check_out_date) - new Date(a.check_out_date))[0]?.check_out_date || null,
          bookings: undefined,
        }))
      });
    }

    if (req.method === 'POST') {
      const body   = sanitizeGuest(req.body);
      const errors = validateGuest(body);
      if (errors.length) return res.status(400).json({ error: errors.join(' ') });

      const { data: guest, error: gErr } = await supabase
        .from('guests')
        .upsert({
          first_name: body.first_name, last_name: body.last_name,
          email: body.email, phone: body.phone,
          emergency_name: body.emergency_name, emergency_phone: body.emergency_phone,
          pin_code: body.pin_code,
          pin_created_at: new Date().toISOString(),
          pin_expires_at: body.check_out_date ? new Date(body.check_out_date + 'T23:59:59').toISOString() : null,
          guest_notes: body.guest_notes, maintenance_notes: body.maintenance_notes,
          payment_notes: body.payment_notes, access_notes: body.access_notes,
          review_notes: body.review_notes, general_notes: body.general_notes,
        }, { onConflict: 'email' })
        .select('id').single();
      if (gErr) throw gErr;

      const nights = body.check_in_date && body.check_out_date
        ? Math.round((new Date(body.check_out_date) - new Date(body.check_in_date)) / 86400000) : null;

      const { data: booking, error: bErr } = await supabase
        .from('bookings')
        .insert({
          guest_id: guest.id, check_in_date: body.check_in_date,
          check_out_date: body.check_out_date, num_guests: body.num_guests,
          booking_source: body.booking_source, nightly_rate: body.nightly_rate,
          num_nights: nights, yale_pin_code: body.pin_code,
          welcome_note: body.welcome_note, status: 'confirmed',
        })
        .select('id').single();
      if (bErr) throw bErr;

      await logAudit(auth.admin, 'created', 'guests', guest.id, `Created: ${body.first_name} ${body.last_name}`);
      return res.status(200).json({ guest_id: guest.id, booking_id: booking.id });
    }

    if (req.method === 'PUT') {
      const body = sanitizeGuest(req.body);
      if (!body.id) return res.status(400).json({ error: 'Guest ID required.' });
      await supabase.from('guests').update({
        first_name: body.first_name, last_name: body.last_name, phone: body.phone,
        emergency_name: body.emergency_name, emergency_phone: body.emergency_phone,
        guest_notes: body.guest_notes, maintenance_notes: body.maintenance_notes,
        payment_notes: body.payment_notes, access_notes: body.access_notes,
        review_notes: body.review_notes, general_notes: body.general_notes,
      }).eq('id', body.id);
      await logAudit(auth.admin, 'updated', 'guests', body.id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).end();
  } catch (err) {
    console.error('[admin/guests]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// BOOKINGS
// ════════════════════════════════════
async function handleBookings(req, res, token) {
  const auth = await validateAdminToken(token, 'maintenance');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { status = '', search = '', year, month, id } = req.query;

      // Single booking lookup
      if (id) {
        const { data, error } = await supabase
          .from('bookings')
          .select('*, guests(first_name, last_name, email, phone)')
          .eq('id', id)
          .single();
        if (error) throw error;

        // Return the same flattened shape the list view uses, at the top
        // level, so the dashboard modal can read it directly. `booking`
        // is kept for any caller that still expects the nested form.
        const flat = {
          ...data,
          guest_first: data.guests?.first_name || '—',
          guest_last:  data.guests?.last_name  || '',
          guest_email: data.guests?.email      || '',
          guest_phone: data.guests?.phone      || '',
        };
        delete flat.guests;
        return res.status(200).json({ ...flat, booking: data });
      }
      let query = supabase
        .from('bookings')
        .select('id, status, check_in_date, check_out_date, num_nights, num_guests, booking_source, total_amount, amount_received, balance_due, payment_method, payment_status, stripe_payment_link_url, created_at, guests(first_name, last_name, email, phone)')
        .order('check_in_date', { ascending: false });
      if (status) query = query.eq('status', status);
      if (year && month) {
        const y = parseInt(year), m = parseInt(month);
        const monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
        const monthEnd   = new Date(y, m, 0).toISOString().split('T')[0]; // last day of month
        // Fetch bookings that overlap with this month at all
        query = query
          .lte('check_in_date',  monthEnd)    // starts on or before last day
          .gte('check_out_date', monthStart); // ends on or after first day
      }
      const { data, error } = await query;
      if (error) throw error;
      let bookings = (data || []).map(b => ({
        id: b.id, status: b.status,
        check_in_date: b.check_in_date, check_out_date: b.check_out_date,
        num_nights: b.num_nights, num_guests: b.num_guests,
        booking_source: b.booking_source,
        guest_first: b.guests?.first_name || '—', guest_last: b.guests?.last_name || '',
        guest_email: b.guests?.email || '', guest_phone: b.guests?.phone || '',
      }));
      if (search) {
        const q = search.toLowerCase();
        bookings = bookings.filter(b =>
          b.guest_first.toLowerCase().includes(q) || b.guest_last.toLowerCase().includes(q)
        );
      }
      return res.status(200).json({ bookings });
    }

    if (req.method === 'PATCH') {
      if (auth.admin.role === 'maintenance') return res.status(403).json({ error: 'Insufficient permissions.' });
      const { id, status, pin_code, yale_pin_code } = req.body;
      if (!id) return res.status(400).json({ error: 'Booking ID required.' });

      // Build update payload — handle status change OR code update
      const updates = {};

      if (status) {
        const valid = ['inquiry','pending','confirmed','cancelled','completed','paid','refunded'];
        if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
        updates.status = status;
        if (status === 'cancelled') updates.cancelled_at = new Date().toISOString();

        if (status === 'confirmed') {
          const { data: bk } = await supabase
            .from('bookings')
            .select('guest_id, check_in_date, check_out_date')
            .eq('id', id).single();

          // Refuse to confirm a stay that overlaps one already confirmed.
          // The guest calendar hides taken dates, but nothing previously
          // stopped an admin approving two requests for the same week.
          if (bk?.check_in_date && bk?.check_out_date) {
            const { data: clashes } = await supabase
              .from('bookings')
              .select('id, request_id, check_in_date, check_out_date, guests(first_name, last_name)')
              .in('status', ['confirmed', 'paid', 'checked_in'])
              .neq('id', id)
              .lt('check_in_date', bk.check_out_date)
              .gt('check_out_date', bk.check_in_date);

            if (clashes && clashes.length) {
              const c = clashes[0];
              const who = c.guests
                ? `${c.guests.first_name || ''} ${c.guests.last_name || ''}`.trim()
                : 'another guest';
              return res.status(409).json({
                error: `These dates clash with a confirmed booking ` +
                       `(${c.check_in_date} to ${c.check_out_date}` +
                       `${who ? ' — ' + who : ''}` +
                       `${c.request_id ? ', ' + c.request_id : ''}). ` +
                       `Decline this request or change the dates first.`,
                conflict: {
                  id: c.id,
                  request_id: c.request_id,
                  check_in_date: c.check_in_date,
                  check_out_date: c.check_out_date,
                },
              });
            }
          }

          // Activate guest record when booking is confirmed
          if (bk?.guest_id) {
            await supabase.from('guests')
              .update({ is_active: true })
              .eq('id', bk.guest_id);
          }
        }
      }

      if (pin_code !== undefined)      updates.pin_code      = pin_code;
      if (yale_pin_code !== undefined) updates.yale_pin_code = yale_pin_code;

      if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: 'Nothing to update.' });

      const { error } = await supabase.from('bookings').update(updates).eq('id', id);
      if (error) {
        // 23P01 = exclusion_violation, raised by the overlap constraint.
        if (error.code === '23P01') {
          return res.status(409).json({
            error: 'These dates clash with a booking that is already confirmed. ' +
                   'Refresh the bookings list to see the conflict.',
          });
        }
        throw error;
      }
      await logAudit(auth.admin, 'updated', 'bookings', id, `Status → ${status}`);

      // Tell the guest. Email failure must never undo a status change,
      // so it is reported back rather than thrown.
      let emailed = null;
      if (status === 'confirmed' || status === 'cancelled') {
        try {
          const { data: full } = await supabase
            .from('bookings')
            .select('*, guests(first_name, last_name, email, phone)')
            .eq('id', id)
            .single();

          const g = full?.guests;
          if (g?.email) {
            const mail = await import('./_lib/email.js');
            const payload = { guest: g, booking: full };
            const result = status === 'confirmed'
              ? await mail.sendBookingApproved(payload)
              : await mail.sendBookingDeclined(payload);
            emailed = result?.success
              ? `Emailed ${g.email}`
              : `Email failed: ${result?.error || 'unknown'}`;
          } else {
            emailed = 'No guest email on file — nothing sent.';
          }
        } catch (mailErr) {
          console.error('[admin/bookings] Email failed:', mailErr.message);
          emailed = `Email failed: ${mailErr.message}`;
        }
      }

      return res.status(200).json({ success: true, status, emailed });
    }

    return res.status(405).end();
  } catch (err) {
    console.error('[admin/bookings]', err);
    return res.status(500).json({
      error: 'Could not update the booking.',
      detail: err.message,
    });
  }
}

// ════════════════════════════════════
// GENERATE WELCOME NOTE (AI)
// ════════════════════════════════════
async function handleGenerateWelcome(req, res, token) {
  const auth = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { first_name, last_name, check_in, check_out, num_guests } = req.body;
    if (!first_name || !check_in || !check_out) {
      return res.status(400).json({ error: 'Guest name and dates are required.' });
    }

    const fmt = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const nights = Math.round((new Date(check_out) - new Date(check_in)) / 86400000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: `You are writing a warm, personalized welcome note for a guest at Generations Getaway LLC, a luxury short-term rental in Fort Lauderdale, FL at 647 NE 16th Terrace with a heated pool, spa, and outdoor living space. Write 2-4 sentences: address the guest by first name, mention arrival warmly, reference 1-2 property features, end with a warm sentiment. Sound personal, not corporate. Do NOT mention checkout or house rules. Return ONLY the note text.`,
        messages: [{ role: 'user', content: `Guest: ${first_name} ${last_name || ''}\nArrival: ${fmt(check_in)}\nDeparture: ${fmt(check_out)}\nNights: ${nights}\nGuests: ${num_guests || 1}` }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'AI generation failed.');
    const note = data.content?.[0]?.text?.trim();
    if (!note) throw new Error('Empty AI response.');
    return res.status(200).json({ welcome_note: note });

  } catch (err) {
    console.error('[admin/generate-welcome]', err.message);
    return res.status(500).json({ error: 'Could not generate welcome note. Please write one manually.' });
  }
}

// ════════════════════════════════════
// KNOWLEDGE BASE
// ════════════════════════════════════
async function handleKnowledge(req, res, token) {
  const auth = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('knowledge_base').select('*').order('category');
      if (error) throw error;
      return res.status(200).json({ entries: data });
    }
    if (req.method === 'POST') {
      const { category, question, answer, keywords } = req.body;
      if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'Question and answer required.' });
      const { data, error } = await supabase.from('knowledge_base')
        .insert({ category, question: question.trim(), answer: answer.trim(), keywords: keywords || [], created_by: auth.admin.id })
        .select('id').single();
      if (error) throw error;
      await logAudit(auth.admin, 'created', 'knowledge_base', data.id);
      return res.status(200).json({ id: data.id });
    }
    if (req.method === 'PUT') {
      const { id, category, question, answer, keywords } = req.body;
      if (!id) return res.status(400).json({ error: 'ID required.' });
      const { error } = await supabase.from('knowledge_base')
        .update({ category, question: question?.trim(), answer: answer?.trim(), keywords: keywords || [], updated_by: auth.admin.id })
        .eq('id', id);
      if (error) throw error;
      await logAudit(auth.admin, 'updated', 'knowledge_base', id);
      return res.status(200).json({ success: true });
    }
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'ID required.' });
      await supabase.from('knowledge_base').update({ is_active: false }).eq('id', id);
      await logAudit(auth.admin, 'deleted', 'knowledge_base', id);
      return res.status(200).json({ success: true });
    }
    return res.status(405).end();
  } catch (err) {
    console.error('[admin/knowledge]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// CHAT LOGS
// ════════════════════════════════════
async function handleChatLogs(req, res, token) {
  const auth = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { filter = '' } = req.query;
      let query = supabase
        .from('chat_logs')
        .select('id, question, answer, answer_source, was_escalated, resolved_at, created_at, guest_rating, guests(first_name, last_name)')
        .order('created_at', { ascending: false }).limit(50);
      if (filter === 'escalated') query = query.eq('was_escalated', true).is('resolved_at', null);
      if (filter === 'resolved')  query = query.not('resolved_at', 'is', null);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({
        logs: (data || []).map(c => ({
          ...c,
          guest_name: c.guests ? `${c.guests.first_name} ${c.guests.last_name}` : 'Guest',
          guests: undefined,
        }))
      });
    }
    if (req.method === 'PATCH') {
      const { id, resolved } = req.body;
      if (!id) return res.status(400).json({ error: 'ID required.' });
      await supabase.from('chat_logs').update({
        resolved_at: resolved ? new Date().toISOString() : null,
        resolved_by: resolved ? auth.admin.id : null,
      }).eq('id', id);
      return res.status(200).json({ success: true });
    }
    return res.status(405).end();
  } catch (err) {
    console.error('[admin/chat-logs]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// EVENT SOURCES
// ════════════════════════════════════
async function handleEventSources(req, res, token) {
  const auth = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('event_source_settings').select('*').order('source_name');
      if (error) throw error;
      return res.status(200).json({ sources: data });
    }
    if (req.method === 'PATCH') {
      const { source_name, is_active } = req.body;
      if (!source_name) return res.status(400).json({ error: 'Source name required.' });
      if (source_name === 'manual') return res.status(400).json({ error: 'Manual source cannot be toggled.' });
      await supabase.from('event_source_settings').update({ is_active, updated_by: auth.admin.id }).eq('source_name', source_name);
      await supabase.from('events').update({ source_active: is_active }).eq('source', source_name);
      await logAudit(auth.admin, 'updated', 'event_source_settings', null, `Toggled ${source_name} to ${is_active ? 'ON' : 'OFF'}`);
      return res.status(200).json({ success: true });
    }
    return res.status(405).end();
  } catch (err) {
    console.error('[admin/event-sources]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// ADMIN USERS
// ════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// RESOURCE: Reservation Requests
// ════════════════════════════════════════════════════════════════
async function handleRequests(req, res, auth) {
  // GET — list requests
  if (req.method === 'GET') {
    const { status } = req.query;

    let query = supabase
      .from('reservation_requests')
      .select(`
        id, request_number, request_type, status,
        requested_details, guest_notes, admin_notes,
        created_at, updated_at, resolved_at,
        bookings(confirmation_number, check_in_date, check_out_date),
        guests(first_name, last_name, email)
      `)
      .order('created_at', { ascending: false })
      .limit(100);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      requests: (data || []).map(r => ({
        id:                   r.id,
        request_number:       r.request_number,
        request_type:         r.request_type,
        status:               r.status,
        requested_details:    r.requested_details,
        guest_notes:          r.guest_notes,
        admin_notes:          r.admin_notes,
        created_at:           r.created_at,
        resolved_at:          r.resolved_at,
        guest_first:          r.guests?.first_name || '—',
        guest_last:           r.guests?.last_name  || '',
        guest_email:          r.guests?.email      || '',
        confirmation_number:  r.bookings?.confirmation_number || '',
        check_in_date:        r.bookings?.check_in_date || '',
        check_out_date:       r.bookings?.check_out_date || '',
      })),
    });
  }

  // PATCH — resolve a request (approve or decline)
  if (req.method === 'PATCH') {
    const { id, status, admin_notes } = req.body;
    if (!id || !['approved','declined','cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Valid request ID and status required.' });
    }

    const { error } = await supabase
      .from('reservation_requests')
      .update({
        status,
        admin_notes: admin_notes || null,
        resolved_at: new Date().toISOString(),
        resolved_by: auth.admin.id,
      })
      .eq('id', id);

    if (error) throw error;

    await logAudit(auth.admin, status === 'approved' ? 'updated' : 'updated',
      'reservation_requests', id, null, { status, admin_notes });

    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}


async function handleUsers(req, res, token) {
  const auth = await validateAdminToken(token, 'super_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('admin_users')
        .select('id, first_name, last_name, email, role, is_active, totp_verified, last_login_at')
        .order('last_name');
      if (error) throw error;
      return res.status(200).json({ users: data });
    }
    if (req.method === 'PATCH') {
      const { id, is_active } = req.body;
      if (!id) return res.status(400).json({ error: 'User ID required.' });
      if (id === auth.admin.id && !is_active) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      await supabase.from('admin_users').update({
        is_active,
        deactivated_at: !is_active ? new Date().toISOString() : null,
      }).eq('id', id);
      await logAudit(auth.admin, 'updated', 'admin_users', id, `User ${is_active ? 'activated' : 'deactivated'}`);
      return res.status(200).json({ success: true });
    }
    return res.status(405).end();
  } catch (err) {
    console.error('[admin/users]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// GUEST PAYLOAD HELPERS
// ════════════════════════════════════

/** Sanitize all guest input fields. */
function sanitizeGuest(body) {
  const s = (v) => v?.toString().trim().replace(/<[^>]*>/g, '') || null;
  return {
    id: s(body.id), first_name: s(body.first_name), last_name: s(body.last_name),
    email: s(body.email)?.toLowerCase(), phone: s(body.phone),
    emergency_name: s(body.emergency_name), emergency_phone: s(body.emergency_phone),
    check_in_date: s(body.check_in_date), check_out_date: s(body.check_out_date),
    num_guests: parseInt(body.num_guests) || 1, booking_source: s(body.booking_source),
    pin_code: s(body.pin_code), nightly_rate: parseFloat(body.nightly_rate) || null,
    // Payment fields
    payment_method:   s(body.payment_method),
    payment_status:   s(body.payment_status) || 'pending',
    total_amount:     parseFloat(body.total_amount)    || null,
    amount_received:  parseFloat(body.amount_received) || null,
    balance_due:      parseFloat(body.balance_due)     || null,
    security_deposit: parseFloat(body.security_deposit) || null,
    payment_note:     s(body.payment_note),
    // Notes
    welcome_note: s(body.welcome_note), guest_notes: s(body.guest_notes),
    maintenance_notes: s(body.maintenance_notes), payment_notes: s(body.payment_notes),
    access_notes: s(body.access_notes), review_notes: s(body.review_notes),
    general_notes: s(body.general_notes),
  };
}

/** Validate required guest fields. Returns array of error strings. */
function validateGuest(body) {
  const errors = [];
  if (!body.first_name)  errors.push('First name is required.');
  if (!body.last_name)   errors.push('Last name is required.');
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.push('Valid email is required.');
  if (!body.check_in_date)  errors.push('Check-in date is required.');
  if (!body.check_out_date) errors.push('Check-out date is required.');
  if (!body.pin_code || !/^\d{4}$/.test(body.pin_code)) errors.push('Valid 4-digit PIN is required.');
  if (body.check_in_date && body.check_out_date && body.check_out_date <= body.check_in_date) {
    errors.push('Check-out must be after check-in.');
  }
  return errors;
}

// ════════════════════════════════════
// PRICING ADMIN  (was api/pricing-admin.js)
// Merged here to stay within the Hobby plan's 12-function limit.
// ════════════════════════════════════

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const num    = (v) => (v === '' || v == null ? null : Number(v));

function badRate(v) {
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 || n > 100000;
}


async function handlePricingAdmin(req, res, token, resource) {
  const needsWrite = req.method !== 'GET';
  const auth = await validateAdminToken(token, needsWrite ? 'family_admin' : null);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const admin = auth.admin;
try {
    /* ---------- READ EVERYTHING ---------- */
    if (req.method === 'GET' && (resource === 'pricing-all' || resource === 'all')) {
      const [seasons, overrides, codes, settings] = await Promise.all([
        supabase.from('pricing_seasons').select('*').order('sort_order'),
        supabase.from('pricing_overrides').select('*').order('start_date'),
        supabase.from('discount_codes').select('*').order('code'),
        supabase.from('pricing_settings').select('*').eq('id', 1).single(),
      ]);
      return res.status(200).json({
        seasons:   seasons.data   || [],
        overrides: overrides.data || [],
        codes:     codes.data     || [],
        settings:  settings.data  || { min_nights: 3, tax_rate: 0.13 },
      });
    }

    /* ---------- SEASON RATE ---------- */
    if (resource === 'season' && req.method === 'PUT') {
      const { id, nightly_rate, months, label } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Season id is required.' });
      if (badRate(nightly_rate)) {
        return res.status(400).json({ error: 'Rate must be between 0 and 100000.' });
      }
      if (months && (!Array.isArray(months) || months.some(m => m < 1 || m > 12))) {
        return res.status(400).json({ error: 'Months must be numbers 1-12.' });
      }

      const patch = { nightly_rate: Number(nightly_rate), updated_at: new Date().toISOString() };
      if (months) patch.months = months;
      if (label)  patch.label  = label;

      const { error } = await supabase
        .from('pricing_seasons').update(patch).eq('id', id);
      if (error) throw error;

      await logAudit(admin, 'update', 'pricing_seasons', id,
        `Rate set to $${nightly_rate}`);
      return res.status(200).json({ success: true });
    }

    /* ---------- GLOBAL SETTINGS ---------- */
    if (resource === 'settings' && req.method === 'PUT') {
      const { min_nights, tax_rate } = req.body || {};
      const mn = parseInt(min_nights, 10);
      const tr = Number(tax_rate);
      if (!Number.isInteger(mn) || mn < 1 || mn > 30) {
        return res.status(400).json({ error: 'Minimum nights must be 1-30.' });
      }
      if (!Number.isFinite(tr) || tr < 0 || tr > 1) {
        return res.status(400).json({ error: 'Tax rate must be a decimal between 0 and 1.' });
      }
      const { error } = await supabase.from('pricing_settings')
        .update({ min_nights: mn, tax_rate: tr, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) throw error;
      await logAudit(admin, 'update', 'pricing_settings', '1',
        `Min nights ${mn}, tax ${(tr * 100).toFixed(2)}%`);
      return res.status(200).json({ success: true });
    }

    /* ---------- DATE OVERRIDES ---------- */
    if (resource === 'override') {
      if (req.method === 'POST' || req.method === 'PUT') {
        const b = req.body || {};
        if (!b.label?.trim()) return res.status(400).json({ error: 'A label is required.' });
        if (!isDate(b.start_date) || !isDate(b.end_date)) {
          return res.status(400).json({ error: 'Valid start and end dates are required.' });
        }
        if (b.end_date < b.start_date) {
          return res.status(400).json({ error: 'End date must be on or after start date.' });
        }
        if (!b.is_blocked && badRate(b.nightly_rate)) {
          return res.status(400).json({ error: 'Enter a valid nightly rate, or mark the dates blocked.' });
        }

        const row = {
          label:        b.label.trim(),
          start_date:   b.start_date,
          end_date:     b.end_date,
          nightly_rate: b.is_blocked ? null : Number(b.nightly_rate),
          is_blocked:   !!b.is_blocked,
          min_nights:   num(b.min_nights),
          priority:     parseInt(b.priority, 10) || 0,
          updated_at:   new Date().toISOString(),
        };

        if (req.method === 'POST') {
          const { data, error } = await supabase
            .from('pricing_overrides').insert(row).select('id').single();
          if (error) throw error;
          await logAudit(admin, 'create', 'pricing_overrides', data.id,
            `${row.label}: ${row.start_date} to ${row.end_date}`);
          return res.status(201).json({ success: true, id: data.id });
        }

        if (!b.id) return res.status(400).json({ error: 'Override id is required.' });
        const { error } = await supabase
          .from('pricing_overrides').update(row).eq('id', b.id);
        if (error) throw error;
        await logAudit(admin, 'update', 'pricing_overrides', b.id, row.label);
        return res.status(200).json({ success: true });
      }

      if (req.method === 'DELETE') {
        const id = req.query.id || (req.body || {}).id;
        if (!id) return res.status(400).json({ error: 'Override id is required.' });
        const { error } = await supabase.from('pricing_overrides').delete().eq('id', id);
        if (error) throw error;
        await logAudit(admin, 'delete', 'pricing_overrides', id, 'Override removed');
        return res.status(200).json({ success: true });
      }
    }

    /* ---------- DISCOUNT CODES ---------- */
    if (resource === 'code') {
      if (req.method === 'POST' || req.method === 'PUT') {
        const b = req.body || {};
        const code = (b.code || '').trim().toUpperCase();

        if (!/^[A-Z0-9._-]{3,32}$/.test(code)) {
          return res.status(400).json({
            error: 'Code must be 3-32 characters: letters, numbers, dot, dash or underscore.'
          });
        }
        if (!b.label?.trim()) return res.status(400).json({ error: 'A label is required.' });
        if (!['percent', 'rates'].includes(b.kind)) {
          return res.status(400).json({ error: 'Kind must be percent or rates.' });
        }
        if (b.kind === 'percent') {
          const p = Number(b.percent);
          if (!Number.isFinite(p) || p < 0 || p > 100) {
            return res.status(400).json({ error: 'Percent must be between 0 and 100.' });
          }
        } else {
          for (const k of ['rate_high', 'rate_medium', 'rate_low']) {
            if (b[k] != null && b[k] !== '' && badRate(b[k])) {
              return res.status(400).json({ error: 'Rates must be between 0 and 100000.' });
            }
          }
        }

        const row = {
          code,
          label:        b.label.trim(),
          kind:         b.kind,
          percent:      b.kind === 'percent' ? Number(b.percent) : null,
          rate_high:    b.kind === 'rates' ? num(b.rate_high)   : null,
          rate_medium:  b.kind === 'rates' ? num(b.rate_medium) : null,
          rate_low:     b.kind === 'rates' ? num(b.rate_low)    : null,
          free_nights:  parseInt(b.free_nights, 10) || 0,
          free_seasons: Array.isArray(b.free_seasons) ? b.free_seasons : [],
          is_active:    b.is_active !== false,
          valid_from:   isDate(b.valid_from)  ? b.valid_from  : null,
          valid_until:  isDate(b.valid_until) ? b.valid_until : null,
          max_uses:     num(b.max_uses),
          notes:        b.notes || null,
          updated_at:   new Date().toISOString(),
        };

        if (req.method === 'POST') {
          const { error } = await supabase.from('discount_codes').insert(row);
          if (error) {
            if (error.code === '23505') {
              return res.status(409).json({ error: 'That code already exists.' });
            }
            throw error;
          }
          await logAudit(admin, 'create', 'discount_codes', code, row.label);
          return res.status(201).json({ success: true });
        }

        const { error } = await supabase
          .from('discount_codes').update(row).eq('code', b.original_code || code);
        if (error) throw error;
        await logAudit(admin, 'update', 'discount_codes', code, row.label);
        return res.status(200).json({ success: true });
      }

      if (req.method === 'DELETE') {
        const code = (req.query.code || (req.body || {}).code || '').toUpperCase();
        if (!code) return res.status(400).json({ error: 'Code is required.' });
        const { error } = await supabase.from('discount_codes').delete().eq('code', code);
        if (error) throw error;
        await logAudit(admin, 'delete', 'discount_codes', code, 'Code removed');
        return res.status(200).json({ success: true });
      }
    }

    return res.status(404).json({ error: 'Unknown resource.' });
  } catch (err) {
    console.error('pricing-admin error:', err);
    return res.status(500).json({ error: 'Something went wrong saving your changes.' });
  }

}

// ════════════════════════════════════
// OPS ASSISTANT  (was api/admin-chat.js)
// ════════════════════════════════════
const ASSISTANT_RATE_LIMIT = 60;
const ASSISTANT_MODEL = 'claude-sonnet-4-20250514';

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


async function handleAssistant(req, res, token) {
  const auth = await validateAdminToken(token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const admin = auth.admin;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
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
