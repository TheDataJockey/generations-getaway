/**
 * FILE: api/recommendations.js
 * ENDPOINT: GET /api/recommendations
 * USED BY: Explore Page (recommendations.html)
 * ============================================================
 * PURPOSE:
 *   Returns local recommendations (restaurants, bars, beaches,
 *   shopping, spas, etc.) for the Explore page.
 *   All data is managed by Kyle in the Admin Dashboard.
 *   Results are cached for 10 minutes for performance.
 *
 * DATABASE TABLES USED:
 *   - recommendations (all active entries, featured first)
 */

import { createClient } from '@supabase/supabase-js';

// Strip any trailing /rest/v1 from URL
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  // ── CORS — public endpoint ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=600'); // 10 min cache

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const { category = '', sort = 'rating' } = req.query;

    let query = supabase
      .from('recommendations')
      .select(`
        id, name, category, subcategory,
        description, short_description,
        address, city, phone, website,
        instagram, facebook,
        latitude, longitude,
        distance_from_property,
        walking_time_mins, driving_time_mins,
        price_range, hours_of_operation,
        best_time_to_visit,
        reservation_required, reservation_url,
        our_rating, google_rating,
        yelp_rating, tripadvisor_rating,
        photo_url, photo_urls,
        is_featured, owner_notes
      `)
      .eq('is_active', true);

    if (category) query = query.eq('category', category);

    // Sort
    if (sort === 'distance') {
      query = query.order('driving_time_mins', { ascending: true, nullsFirst: false });
    } else {
      // Default: featured first, then by our rating
      query = query
        .order('is_featured', { ascending: false })
        .order('our_rating',  { ascending: false, nullsFirst: false });
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      recommendations: data || [],
      total: (data || []).length,
    });

  } catch (err) {
    console.error('[/api/recommendations]', err.message);
    return res.status(500).json({
      error: 'Failed to load recommendations.',
      recommendations: [],
    });
  }
}
