/**
 * FILE: api/pricing-admin.js
 * ENDPOINT: /api/pricing-admin?resource=[resource]
 * USED BY: Admin Pricing Page (admin/pricing.html)
 * ============================================================
 * PURPOSE:
 *   Lets Kyle edit nightly rates, set date-specific overrides
 *   (holidays, events, blackouts), and manage discount codes
 *   without touching code.
 *
 * AUTH:
 *   Requires a valid admin Bearer token, same as /api/admin.
 *   Writes require family_admin or higher. Every change is
 *   written to audit_logs.
 *
 * RESOURCES:
 *   GET  ?resource=all         - seasons, overrides, codes, settings
 *   PUT  ?resource=season      - update one season's rate/months
 *   PUT  ?resource=settings    - update min nights / tax rate
 *   POST ?resource=override    - create a date-range override
 *   PUT  ?resource=override    - update one (needs id)
 *   DEL  ?resource=override    - delete one (needs id)
 *   POST ?resource=code        - create a discount code
 *   PUT  ?resource=code        - update one (needs code)
 *   DEL  ?resource=code        - delete one (needs code)
 *
 * DATABASE TABLES USED:
 *   pricing_seasons, pricing_overrides, discount_codes,
 *   pricing_settings, audit_logs
 */

import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

/* ── Auth (mirrors api/admin.js) ── */
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

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

/* ── Validation helpers ── */
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const num    = (v) => (v === '' || v == null ? null : Number(v));

function badRate(v) {
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 || n > 100000;
}

/* ── Handler ── */
export default async function handler(req, res) {
  if (setCors(req, res)) return;

  const resource = (req.query.resource || '').toLowerCase();

  // Reads need any admin; writes need family_admin or above.
  const needsWrite = req.method !== 'GET';
  const auth = await validateAdminToken(
    extractToken(req),
    needsWrite ? 'family_admin' : null
  );
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const admin = auth.admin;

  try {
    /* ---------- READ EVERYTHING ---------- */
    if (req.method === 'GET' && (resource === 'all' || resource === '')) {
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
