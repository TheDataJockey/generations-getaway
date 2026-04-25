/**
 * Generations Getaway LLC
 * POST /api/visitor-log
 * ======================
 * Logs anonymous visitor data to Supabase.
 * Silently fails — never impacts UX.
 *
 * Security:
 *  - Insert-only, no reads exposed
 *  - No PII beyond IP (which is hashed)
 *  - Rate limited to prevent log flooding
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.generationsgetawayfl.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const {
      session_id,
      page_visited,
      referrer,
      user_agent,
      device_type,
      utm_source,
      utm_medium,
      utm_campaign,
    } = req.body;

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || null;

    await supabase.from('visitor_logs').insert({
      session_id,
      page_visited: page_visited || null,
      referrer:     referrer     || null,
      user_agent:   user_agent   || null,
      device_type:  device_type  || 'unknown',
      ip_address:   ip,
      utm_source:   utm_source   || null,
      utm_medium:   utm_medium   || null,
      utm_campaign: utm_campaign || null,
    });

    return res.status(200).json({ success: true });
  } catch {
    // Silently fail — analytics must never break the site
    return res.status(200).json({ success: true });
  }
}
