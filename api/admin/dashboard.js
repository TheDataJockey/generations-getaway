/**
 * Generations Getaway LLC
 * Admin API — Shared Middleware & Dashboard
 * ==========================================
 * validateAdminToken: reusable auth guard for all
 * admin API routes. Validates session token against
 * admin_users table and enforces role-based access.
 *
 * GET /api/admin/dashboard — returns stats and
 * recent data for the admin dashboard overview.
 *
 * Security:
 *  - Token validated on every request
 *  - Session expiry enforced
 *  - Role checked per endpoint
 *  - Service role key never exposed to client
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/**
 * Validate an admin session token.
 * Checks token against admin_users, verifies expiry,
 * and optionally enforces a minimum role.
 *
 * @param {string} token         - Bearer token from Authorization header
 * @param {string} [requiredRole] - Minimum role: 'maintenance'|'family_admin'|'super_admin'
 * @returns {{ admin: Object }|{ error: string, status: number }}
 */
export async function validateAdminToken(token, requiredRole = null) {
  if (!token) return { error: 'Unauthorized.', status: 401 };

  const { data: admin } = await supabase
    .from('admin_users')
    .select('id, first_name, last_name, email, role, is_active, session_expires')
    .eq('session_token', token)
    .eq('is_active', true)
    .single();

  if (!admin) return { error: 'Invalid or expired session.', status: 401 };

  // Check session expiry
  if (admin.session_expires && new Date(admin.session_expires) < new Date()) {
    return { error: 'Session expired. Please log in again.', status: 401 };
  }

  // Role hierarchy check
  const roleLevel = { maintenance: 1, family_admin: 2, super_admin: 3 };
  if (requiredRole && roleLevel[admin.role] < roleLevel[requiredRole]) {
    return { error: 'Insufficient permissions.', status: 403 };
  }

  return { admin };
}

/**
 * Extract Bearer token from Authorization header.
 * @param {Object} req
 * @returns {string|null}
 */
export function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// ── GET /api/admin/dashboard ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.generationsgetawayfl.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed.' });

  const token  = extractToken(req);
  const auth   = await validateAdminToken(token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    // ── Fetch all dashboard stats in parallel ──
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
        .select(`id, status, check_in_date, check_out_date, num_guests,
                 booking_source, guests(first_name, last_name)`)
        .order('created_at', { ascending: false })
        .limit(8),
      supabase.from('chat_logs')
        .select(`id, question, created_at, guests(first_name, last_name)`)
        .eq('was_escalated', true)
        .is('resolved_at', null)
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    // ── Flatten booking data ──
    const flatBookings = (recentBookings || []).map(b => ({
      id:             b.id,
      status:         b.status,
      check_in_date:  b.check_in_date,
      check_out_date: b.check_out_date,
      num_guests:     b.num_guests,
      booking_source: b.booking_source,
      guest_first:    b.guests?.first_name || '—',
      guest_last:     b.guests?.last_name  || '',
    }));

    const flatEscalations = (escalations || []).map(c => ({
      id:         c.id,
      question:   c.question,
      created_at: c.created_at,
      guest_name: c.guests
        ? `${c.guests.first_name} ${c.guests.last_name}`
        : 'Guest',
    }));

    return res.status(200).json({
      inquiries:       inquiries  || 0,
      confirmed:       confirmed  || 0,
      guests:          guests     || 0,
      unanswered:      unanswered || 0,
      recent_bookings: flatBookings,
      escalations:     flatEscalations,
    });

  } catch (err) {
    console.error('[/api/admin/dashboard]', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard data.' });
  }
}
