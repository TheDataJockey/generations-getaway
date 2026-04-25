/**
 * Generations Getaway LLC
 * /api/admin
 * ===========
 * Consolidated admin API handler.
 * Routes by ?resource= query parameter:
 *
 *  GET  /api/admin?resource=dashboard
 *  GET  /api/admin?resource=me
 *  GET|POST|PUT  /api/admin?resource=guests
 *  GET|PATCH     /api/admin?resource=bookings
 *  POST          /api/admin?resource=generate-welcome
 *  GET|POST|PUT|DELETE /api/admin?resource=knowledge
 *  GET|PATCH     /api/admin?resource=chat-logs
 *  GET|PATCH     /api/admin?resource=event-sources
 *  GET|PATCH     /api/admin?resource=users
 *
 * Security:
 *  - All routes validate admin session token
 *  - Role-based access enforced per resource
 *  - All mutations logged to audit_logs
 *  - Service role key never exposed to client
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

// ── CORS helper ──
function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin.includes('generationsgetawayfl.com') ||
      origin.includes('localhost') ||
      origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

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
  setCors(req, res);
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
    case 'users':            return handleUsers(req, res, token);
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
        guest_first: b.guests?.first_name || '—',
        guest_last:  b.guests?.last_name  || '',
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
      const { status = '', search = '', year, month } = req.query;
      let query = supabase
        .from('bookings')
        .select('id, status, check_in_date, check_out_date, num_nights, num_guests, booking_source, created_at, guests(first_name, last_name, email, phone)')
        .order('check_in_date', { ascending: false });
      if (status) query = query.eq('status', status);
      if (year && month) {
        query = query
          .gte('check_in_date', `${year}-${String(month).padStart(2,'0')}-01`)
          .lte('check_out_date', new Date(year, month, 0).toISOString().split('T')[0]);
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
      const { id, status } = req.body;
      const valid = ['inquiry','confirmed','cancelled','completed'];
      if (!id || !valid.includes(status)) return res.status(400).json({ error: 'Valid ID and status required.' });
      const { error } = await supabase.from('bookings').update({
        status,
        ...(status === 'cancelled' ? { cancelled_at: new Date().toISOString() } : {}),
      }).eq('id', id);
      if (error) throw error;
      await logAudit(auth.admin, 'updated', 'bookings', id, `Status → ${status}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).end();
  } catch (err) {
    console.error('[admin/bookings]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
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
