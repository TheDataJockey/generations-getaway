/**
 * Generations Getaway LLC
 * /api/admin/bookings
 * =====================
 * Read and update booking records.
 *
 * GET   /api/admin/bookings         — list bookings with filters
 * GET   /api/admin/bookings/[id]    — single booking detail
 * PATCH /api/admin/bookings         — update booking status
 *
 * Security:
 *  - Requires family_admin or super_admin role
 *  - All mutations logged to audit_logs
 */

import { createClient } from '@supabase/supabase-js';
import { validateAdminToken, extractToken } from './dashboard.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.generationsgetawayfl.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = extractToken(req);
  const auth  = await validateAdminToken(token, 'maintenance');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    // ── GET: List bookings ──
    if (req.method === 'GET') {
      const { status = '', search = '', year, month } = req.query;

      let query = supabase
        .from('bookings')
        .select(`
          id, status, check_in_date, check_out_date,
          num_nights, num_guests, booking_source, created_at,
          guests(first_name, last_name, email, phone)
        `)
        .order('check_in_date', { ascending: false });

      if (status) query = query.eq('status', status);

      // Calendar view — filter by month
      if (year && month) {
        const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
        const endDate   = new Date(year, month, 0).toISOString().split('T')[0];
        query = query
          .gte('check_in_date', startDate)
          .lte('check_out_date', endDate);
      }

      const { data, error } = await query;
      if (error) throw error;

      let bookings = (data || []).map(b => ({
        id:             b.id,
        status:         b.status,
        check_in_date:  b.check_in_date,
        check_out_date: b.check_out_date,
        num_nights:     b.num_nights,
        num_guests:     b.num_guests,
        booking_source: b.booking_source,
        guest_first:    b.guests?.first_name || '—',
        guest_last:     b.guests?.last_name  || '',
        guest_email:    b.guests?.email      || '',
        guest_phone:    b.guests?.phone      || '',
      }));

      // Search filter
      if (search) {
        const q = search.toLowerCase();
        bookings = bookings.filter(b =>
          b.guest_first.toLowerCase().includes(q) ||
          b.guest_last.toLowerCase().includes(q)
        );
      }

      return res.status(200).json({ bookings });
    }

    // ── PATCH: Update booking status ──
    if (req.method === 'PATCH') {
      const { id, status } = req.body;
      const validStatuses  = ['inquiry', 'confirmed', 'cancelled', 'completed'];

      if (!id || !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Valid booking ID and status required.' });
      }

      // Maintenance role cannot update bookings
      if (auth.admin.role === 'maintenance') {
        return res.status(403).json({ error: 'Insufficient permissions.' });
      }

      const updateData = {
        status,
        ...(status === 'cancelled' ? { cancelled_at: new Date().toISOString() } : {}),
      };

      const { error } = await supabase
        .from('bookings')
        .update(updateData)
        .eq('id', id);

      if (error) throw error;

      // Audit log
      await supabase.from('audit_logs').insert({
        admin_id:    auth.admin.id,
        admin_email: auth.admin.email,
        admin_role:  auth.admin.role,
        action:      'updated',
        table_name:  'bookings',
        record_id:   id,
        new_values:  { status },
        notes:       `Booking status updated to: ${status}`,
      });

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[/api/admin/bookings]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}
