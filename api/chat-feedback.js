/**
 * Generations Getaway LLC
 * POST /api/chat-feedback
 * ========================
 * Records guest thumbs up/down feedback on
 * chatbot responses so the owner can identify
 * which answers are helpful vs. need improvement.
 *
 * Security:
 *  - Session token required
 *  - Insert only — no reads exposed
 */

import { createClient } from '@supabase/supabase-js';

// Strip any trailing /rest/v1 from URL — Vercel env vars sometimes include it
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);


export default async function handler(req, res) {
  // Allow both www and non-www
  const origin = req.headers.origin || '';
  if (origin.includes('generationsgetawayfl.com') || origin.includes('localhost') || origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).end();

  try {
    const { answer, rating, session_token } = req.body;

    if (!session_token || !rating) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Convert thumbs rating to numeric score
    const numericRating = rating === 'up' ? 5 : 1;

    // Find the most recent chat log for this session with this answer
    const { data: log } = await supabase
      .from('chat_logs')
      .select('id')
      .eq('session_id', session_token)
      .eq('answer', answer)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (log) {
      // Update the chat log with guest rating
      await supabase
        .from('chat_logs')
        .update({ guest_rating: numericRating })
        .eq('id', log.id);
    }

    return res.status(200).json({ success: true });

  } catch {
    // Silently succeed — feedback must never break the chat UX
    return res.status(200).json({ success: true });
  }
}
