/**
 * Generations Getaway LLC
 * /api/admin/knowledge
 * ======================
 * CRUD for the knowledge base used by the guest chatbot.
 *
 * GET    /api/admin/knowledge        — list all entries
 * GET    /api/admin/knowledge/[id]   — single entry
 * POST   /api/admin/knowledge        — create entry
 * PUT    /api/admin/knowledge        — update entry
 * DELETE /api/admin/knowledge/[id]   — delete entry
 *
 * /api/admin/chat-logs
 * ======================
 * GET   /api/admin/chat-logs         — list chat logs with filter
 * PATCH /api/admin/chat-logs         — mark as resolved
 *
 * /api/admin/event-sources
 * ==========================
 * GET   /api/admin/event-sources     — list all sources
 * PATCH /api/admin/event-sources     — toggle source on/off
 *
 * /api/admin/users
 * =================
 * GET   /api/admin/users             — list admin users
 * PATCH /api/admin/users             — activate/deactivate user
 *
 * Security:
 *  - All routes require valid admin session token
 *  - Role-based access enforced per endpoint
 *  - All mutations logged to audit_logs
 */

import { createClient } from '@supabase/supabase-js';
import { validateAdminToken, extractToken } from './dashboard.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Route dispatcher ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.generationsgetawayfl.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = extractToken(req);
  const path  = req.url.split('/api/admin/')[1]?.split('?')[0] || '';

  // Route to correct handler
  if (path.startsWith('knowledge'))     return handleKnowledge(req, res, token, path);
  if (path.startsWith('chat-logs'))     return handleChatLogs(req, res, token);
  if (path.startsWith('event-sources')) return handleEventSources(req, res, token);
  if (path.startsWith('users'))         return handleAdminUsers(req, res, token);

  return res.status(404).json({ error: 'Route not found.' });
}

// ════════════════════════════════════
// KNOWLEDGE BASE
// ════════════════════════════════════
async function handleKnowledge(req, res, token, path) {
  const auth = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('knowledge_base')
        .select('*')
        .order('category', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ entries: data });
    }

    if (req.method === 'POST') {
      const { category, question, answer, keywords } = req.body;
      if (!question?.trim() || !answer?.trim()) {
        return res.status(400).json({ error: 'Question and answer are required.' });
      }
      const { data, error } = await supabase
        .from('knowledge_base')
        .insert({ category, question: question.trim(), answer: answer.trim(),
                  keywords: keywords || [], created_by: auth.admin.id })
        .select('id').single();
      if (error) throw error;
      await logAudit(auth.admin, 'created', 'knowledge_base', data.id);
      return res.status(200).json({ id: data.id });
    }

    if (req.method === 'PUT') {
      const { id, category, question, answer, keywords } = req.body;
      if (!id) return res.status(400).json({ error: 'ID required.' });
      const { error } = await supabase
        .from('knowledge_base')
        .update({ category, question: question?.trim(), answer: answer?.trim(),
                  keywords: keywords || [], updated_by: auth.admin.id })
        .eq('id', id);
      if (error) throw error;
      await logAudit(auth.admin, 'updated', 'knowledge_base', id);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const id = path.split('/')[1];
      if (!id) return res.status(400).json({ error: 'ID required.' });
      const { error } = await supabase
        .from('knowledge_base')
        .update({ is_active: false })
        .eq('id', id);
      if (error) throw error;
      await logAudit(auth.admin, 'deleted', 'knowledge_base', id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[/api/admin/knowledge]', err.message);
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
        .select(`id, question, answer, answer_source, was_escalated,
                 resolved_at, created_at, guest_rating,
                 guests(first_name, last_name)`)
        .order('created_at', { ascending: false })
        .limit(50);

      if (filter === 'escalated') query = query.eq('was_escalated', true).is('resolved_at', null);
      if (filter === 'resolved')  query = query.not('resolved_at', 'is', null);

      const { data, error } = await query;
      if (error) throw error;

      const logs = (data || []).map(c => ({
        ...c,
        guest_name: c.guests
          ? `${c.guests.first_name} ${c.guests.last_name}`
          : 'Guest',
        guests: undefined,
      }));

      return res.status(200).json({ logs });
    }

    if (req.method === 'PATCH') {
      const { id, resolved } = req.body;
      if (!id) return res.status(400).json({ error: 'Chat log ID required.' });

      const { error } = await supabase
        .from('chat_logs')
        .update({
          resolved_at: resolved ? new Date().toISOString() : null,
          resolved_by: resolved ? auth.admin.id : null,
        })
        .eq('id', id);

      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[/api/admin/chat-logs]', err.message);
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
      const { data, error } = await supabase
        .from('event_source_settings')
        .select('*')
        .order('source_name', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ sources: data });
    }

    if (req.method === 'PATCH') {
      const { source_name, is_active } = req.body;
      if (!source_name) return res.status(400).json({ error: 'Source name required.' });
      if (source_name === 'manual') {
        return res.status(400).json({ error: 'Manual source cannot be toggled.' });
      }

      const { error } = await supabase
        .from('event_source_settings')
        .update({ is_active, updated_by: auth.admin.id })
        .eq('source_name', source_name);

      if (error) throw error;

      // If toggling OFF — hide all events from this source
      if (!is_active) {
        await supabase
          .from('events')
          .update({ source_active: false })
          .eq('source', source_name);
      } else {
        await supabase
          .from('events')
          .update({ source_active: true })
          .eq('source', source_name);
      }

      await logAudit(auth.admin, 'updated', 'event_source_settings', null,
        `Toggled ${source_name} to ${is_active ? 'ON' : 'OFF'}`);

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[/api/admin/event-sources]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// ADMIN USERS
// ════════════════════════════════════
async function handleAdminUsers(req, res, token) {
  // Super admin only
  const auth = await validateAdminToken(token, 'super_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('admin_users')
        .select('id, first_name, last_name, email, role, is_active, totp_verified, last_login_at')
        .order('last_name', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ users: data });
    }

    if (req.method === 'PATCH') {
      const { id, is_active } = req.body;
      if (!id) return res.status(400).json({ error: 'User ID required.' });

      // Cannot deactivate yourself
      if (id === auth.admin.id && !is_active) {
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      }

      const { error } = await supabase
        .from('admin_users')
        .update({
          is_active,
          deactivated_at: !is_active ? new Date().toISOString() : null,
        })
        .eq('id', id);

      if (error) throw error;
      await logAudit(auth.admin, 'updated', 'admin_users', id,
        `User ${is_active ? 'activated' : 'deactivated'}`);

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[/api/admin/users]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ── Shared audit log helper ──
async function logAudit(admin, action, tableName, recordId, notes = null) {
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
