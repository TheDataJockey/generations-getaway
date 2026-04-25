/**
 * Generations Getaway LLC
 * /api/admin/me
 * ==============
 * Returns the current admin user's profile info.
 * Used by the dashboard to populate the sidebar.
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = extractToken(req);
  const auth  = await validateAdminToken(token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  return res.status(200).json({
    first_name: auth.admin.first_name,
    last_name:  auth.admin.last_name,
    email:      auth.admin.email,
    role:       auth.admin.role,
  });
}
