/**
 * FILE: api/_lib/supabase.js
 * SHARED BY: All API endpoints that talk to the database
 * ============================================================
 * PURPOSE:
 *   Single Supabase service-role client, reused across endpoints
 *   instead of each file creating its own copy of the same client.
 *
 * WHY THE CLIENT IS CREATED LAZILY:
 *   createClient() throws if the URL or key is missing. Calling it
 *   at module load meant a missing environment variable crashed the
 *   whole serverless function before any code ran — Vercel then
 *   returns a plain-text "A server error has occurred" page instead
 *   of JSON, so the browser shows an unhelpful parse error and there
 *   is no clue what went wrong.
 *
 *   Creating it on first use means the module always loads, the
 *   endpoint can return a readable JSON error, and /api/admin?resource=health
 *   can report exactly which variable is missing.
 *
 * NOTE: api/stripe.js keeps its own client — payment files are
 *   excluded from this shared refactor per project instructions.
 */

import { createClient } from '@supabase/supabase-js';

// Strip any trailing /rest/v1 from URL — Vercel env vars sometimes include it
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** Which required variables are missing. Never exposes values. */
export function missingSupabaseEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!SERVICE_KEY)  missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return missing;
}

let _client = null;

function getClient() {
  if (_client) return _client;
  const missing = missingSupabaseEnv();
  if (missing.length) {
    throw new Error(
      `Supabase is not configured. Missing environment variable(s): ${missing.join(', ')}. ` +
      `Add them in Vercel under Settings, apply to Production, then redeploy.`
    );
  }
  _client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

// Behaves like the client, but is only built on first property access,
// so importing this file can never crash the function.
export const supabase = new Proxy({}, {
  get(_target, prop) {
    const client = getClient();
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
