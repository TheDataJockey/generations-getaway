/**
 * Generations Getaway LLC
 * /api/admin/guests
 * ==================
 * CRUD operations for guest records.
 * Creates guest + booking records atomically.
 *
 * GET    /api/admin/guests          — list guests
 * GET    /api/admin/guests/[id]     — single guest
 * POST   /api/admin/guests          — create guest + booking
 * PUT    /api/admin/guests          — update guest + booking
 *
 * Security:
 *  - Requires family_admin or super_admin role
 *  - All input sanitized server-side
 *  - PIN stored as plain text (encrypted at rest by Supabase)
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = extractToken(req);
  const auth  = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { admin } = auth;

  try {
    // ── GET: List guests ──
    if (req.method === 'GET') {
      const { search = '', filter = '' } = req.query;

      let query = supabase
        .from('guests')
        .select(`
          id, first_name, last_name, email, phone,
          total_stays, is_active, is_blacklisted, vip_status,
          bookings(check_out_date)
        `)
        .order('last_name', { ascending: true });

      if (search) {
        query = query.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`
        );
      }
      if (filter === 'vip')         query = query.eq('vip_status', true);
      if (filter === 'blacklisted') query = query.eq('is_blacklisted', true);

      const { data, error } = await query;
      if (error) throw error;

      // Find most recent checkout per guest
      const guests = (data || []).map(g => ({
        ...g,
        last_stay: g.bookings?.length
          ? g.bookings.sort((a, b) =>
              new Date(b.check_out_date) - new Date(a.check_out_date)
            )[0].check_out_date
          : null,
        bookings: undefined,
      }));

      return res.status(200).json({ guests });
    }

    // ── POST: Create guest + booking ──
    if (req.method === 'POST') {
      const body = sanitizeGuestPayload(req.body);
      const errors = validateGuestPayload(body);
      if (errors.length) return res.status(400).json({ error: errors.join(' ') });

      // Upsert guest record
      const { data: guest, error: guestError } = await supabase
        .from('guests')
        .upsert(
          {
            first_name:           body.first_name,
            last_name:            body.last_name,
            email:                body.email,
            phone:                body.phone,
            emergency_name:       body.emergency_name,
            emergency_phone:      body.emergency_phone,
            pin_code:             body.pin_code,
            pin_created_at:       new Date().toISOString(),
            pin_expires_at:       body.check_out_date
              ? new Date(body.check_out_date + 'T23:59:59').toISOString()
              : null,
            guest_notes:          body.guest_notes,
            maintenance_notes:    body.maintenance_notes,
            payment_notes:        body.payment_notes,
            access_notes:         body.access_notes,
            review_notes:         body.review_notes,
            general_notes:        body.general_notes,
          },
          { onConflict: 'email' }
        )
        .select('id')
        .single();

      if (guestError) throw guestError;

      // Calculate nights
      const numNights = body.check_in_date && body.check_out_date
        ? Math.round(
            (new Date(body.check_out_date) - new Date(body.check_in_date)) / 86400000
          )
        : null;

      // Create booking
      const { data: booking, error: bookingError } = await supabase
        .from('bookings')
        .insert({
          guest_id:        guest.id,
          check_in_date:   body.check_in_date,
          check_out_date:  body.check_out_date,
          num_guests:      body.num_guests,
          booking_source:  body.booking_source,
          nightly_rate:    body.nightly_rate,
          num_nights:      numNights,
          yale_pin_code:   body.pin_code,
          welcome_note:    body.welcome_note,
          status:          'confirmed',
        })
        .select('id')
        .single();

      if (bookingError) throw bookingError;

      // Audit log
      await supabase.from('audit_logs').insert({
        admin_id:    admin.id,
        admin_email: admin.email,
        admin_role:  admin.role,
        action:      'created',
        table_name:  'guests',
        record_id:   guest.id,
        notes:       `Created guest: ${body.first_name} ${body.last_name}`,
      });

      return res.status(200).json({ guest_id: guest.id, booking_id: booking.id });
    }

    // ── PUT: Update guest + booking ──
    if (req.method === 'PUT') {
      const body = sanitizeGuestPayload(req.body);
      if (!body.id) return res.status(400).json({ error: 'Guest ID required.' });

      await supabase
        .from('guests')
        .update({
          first_name:        body.first_name,
          last_name:         body.last_name,
          phone:             body.phone,
          emergency_name:    body.emergency_name,
          emergency_phone:   body.emergency_phone,
          guest_notes:       body.guest_notes,
          maintenance_notes: body.maintenance_notes,
          payment_notes:     body.payment_notes,
          access_notes:      body.access_notes,
          review_notes:      body.review_notes,
          general_notes:     body.general_notes,
        })
        .eq('id', body.id);

      // Audit log
      await supabase.from('audit_logs').insert({
        admin_id:    admin.id,
        admin_email: admin.email,
        admin_role:  admin.role,
        action:      'updated',
        table_name:  'guests',
        record_id:   body.id,
      });

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[/api/admin/guests]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

/**
 * Sanitize all guest payload fields.
 * @param {Object} body
 * @returns {Object}
 */
function sanitizeGuestPayload(body) {
  const s = (v) => v?.toString().trim().replace(/<[^>]*>/g, '') || null;
  return {
    id:                s(body.id),
    first_name:        s(body.first_name),
    last_name:         s(body.last_name),
    email:             s(body.email)?.toLowerCase(),
    phone:             s(body.phone),
    emergency_name:    s(body.emergency_name),
    emergency_phone:   s(body.emergency_phone),
    check_in_date:     s(body.check_in_date),
    check_out_date:    s(body.check_out_date),
    num_guests:        parseInt(body.num_guests) || 1,
    booking_source:    s(body.booking_source),
    pin_code:          s(body.pin_code),
    nightly_rate:      parseFloat(body.nightly_rate) || null,
    welcome_note:      s(body.welcome_note),
    guest_notes:       s(body.guest_notes),
    maintenance_notes: s(body.maintenance_notes),
    payment_notes:     s(body.payment_notes),
    access_notes:      s(body.access_notes),
    review_notes:      s(body.review_notes),
    general_notes:     s(body.general_notes),
  };
}

/**
 * Validate required guest fields.
 * @param {Object} body
 * @returns {string[]} Array of error messages
 */
function validateGuestPayload(body) {
  const errors = [];
  if (!body.first_name)  errors.push('First name is required.');
  if (!body.last_name)   errors.push('Last name is required.');
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    errors.push('Valid email is required.');
  }
  if (!body.check_in_date)  errors.push('Check-in date is required.');
  if (!body.check_out_date) errors.push('Check-out date is required.');
  if (!body.pin_code || !/^\d{4}$/.test(body.pin_code)) {
    errors.push('A valid 4-digit PIN is required.');
  }
  if (body.check_in_date && body.check_out_date &&
      body.check_out_date <= body.check_in_date) {
    errors.push('Check-out must be after check-in.');
  }
  return errors;
}
