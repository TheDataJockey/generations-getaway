/**
 * FILE: api/visitor-log.js
 * ENDPOINT: POST /api/visitor-log
 * USED BY: All public pages via /js/main.js (runs silently)
 * ============================================================
 * PURPOSE:
 *   Basic anonymous analytics. Records page visits without
 *   using any third-party tracking services.
 *   Visitors are not aware this is running.
 *
 * WHAT IS RECORDED:
 *   - Which page was visited
 *   - Browser and device type
 *   - IP address (also used for rate limiting in guest-auth)
 *   - Where the visitor came from (referrer)
 *
 * DATABASE TABLES USED:
 *   - visitor_logs (one row inserted per page visit)
 */

import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

export default async function handler(req, res) {
  setCors(req, res);

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
