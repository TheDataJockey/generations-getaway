/**
 * FILE: api/chat-feedback.js
 * ENDPOINT: POST /api/chat-feedback
 * USED BY: Guest Portal - Ask Us Tab (welcome.html)
 * ============================================================
 * PURPOSE:
 *   Records thumbs up or thumbs down feedback on chatbot answers.
 *   Helps Kyle identify weak answers to improve in Knowledge Base.
 *
 * DATABASE TABLES USED:
 *   - chat_logs (updates was_helpful flag on the conversation)
 */

import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

export default async function handler(req, res) {
  setCors(req, res);

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
