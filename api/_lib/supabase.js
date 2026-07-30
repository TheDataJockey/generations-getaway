/**
 * FILE: api/_lib/supabase.js
 * SHARED BY: All API endpoints that talk to the database
 * ============================================================
 * PURPOSE:
 *   Single Supabase service-role client, reused across endpoints
 *   instead of each file creating its own copy of the same client.
 *
 * NOTE: api/stripe.js keeps its own client — payment files are
 *   excluded from this shared refactor per project instructions.
 */

import { createClient } from '@supabase/supabase-js';

// Strip any trailing /rest/v1 from URL — Vercel env vars sometimes include it
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

export const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
