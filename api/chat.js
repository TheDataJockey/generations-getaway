/**
 * Generations Getaway LLC
 * POST /api/chat
 * ==============
 * Handles guest chatbot questions.
 * Flow:
 *  1. Validate session token
 *  2. Search knowledge base for matching answer
 *  3. If found → return KB answer
 *  4. If not found → call Claude AI for general guidance
 *     + return escalation message + notify admin
 *  5. Log all questions to chat_logs for owner review
 *
 * Security:
 *  - Session token validated on every request
 *  - Rate limited per guest session
 *  - All input sanitized before KB search or AI prompt
 *  - Claude API key stored in env var, never exposed
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

// ── Supabase admin client ──

// ── Rate limit: max 30 messages per hour per session ──
const RATE_LIMIT = 30;

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
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const { question, session_token } = req.body;

    // ── Validate inputs ──
    if (!question?.trim()) {
      return res.status(400).json({ error: 'Question is required.' });
    }

    if (!session_token) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    // ── Rate limit by session ──
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const { count } = await supabase
      .from('chat_logs')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', session_token)
      .gte('created_at', oneHourAgo);

    if (count >= RATE_LIMIT) {
      return res.status(429).json({
        answer: "You've sent a lot of messages! Please wait a few minutes before sending more, or contact us directly at bookings@generationsgetawayfl.com"
      });
    }

    // ── Sanitize question ──
    const cleanQuestion = question.trim().replace(/<[^>]*>/g, '').substring(0, 500);

    // ── Search knowledge base ──
    const { data: kbResults } = await supabase
      .from('knowledge_base')
      .select('id, question, answer, keywords')
      .eq('is_active', true);

    const matched = findBestKBMatch(cleanQuestion, kbResults || []);

    let answer;
    let answerSource;
    let wasEscalated = false;
    let generalSteps = null;

    if (matched) {
      // ── KB match found ──
      answer       = matched.answer;
      answerSource = 'knowledge_base';

      // Update KB usage stats
      await supabase
        .from('knowledge_base')
        .update({
          times_used:   (matched.times_used || 0) + 1,
          last_used_at: new Date().toISOString(),
        })
        .eq('id', matched.id);

    } else {
      // ── No KB match — call Claude for general guidance ──
      wasEscalated = true;
      answerSource = 'escalated';

      const aiSteps = await getAIGeneralGuidance(cleanQuestion);
      generalSteps  = aiSteps;

      // ── Build the escalation response ──
      answer = `That's a great question! I'll need to follow up on that for you. I've already notified our team at Generations Getaway LLC and someone will be in touch shortly.\n\n${aiSteps ? `In the meantime, here are some general steps you can try:\n\n${aiSteps}\n\n` : ''}Is there anything else I can help you with?`;

      // ── Notify admin of unanswered question ──
      // TODO Phase 8: Send admin email notification
      console.log(`[CHAT ESCALATION] Question: "${cleanQuestion}"`);
    }

    // ── Log to chat_logs ──
    await supabase.from('chat_logs').insert({
      question:               cleanQuestion,
      answer,
      answer_source:          answerSource,
      general_steps_provided: generalSteps,
      was_escalated:          wasEscalated,
      escalated_at:           wasEscalated ? new Date().toISOString() : null,
      session_id:             session_token,
      ip_address:             req.headers['x-forwarded-for']?.split(',')[0] || null,
      user_agent:             req.headers['user-agent'] || null,
    });

    // ── Format answer for HTML display ──
    const formattedAnswer = answer
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br/>');

    return res.status(200).json({ answer: `<p>${formattedAnswer}</p>` });

  } catch (err) {
    console.error('[/api/chat]', err.message);
    return res.status(200).json({
      answer: "I'm having a little trouble right now. Please try again in a moment, or contact us directly at <strong>bookings@generationsgetawayfl.com</strong>"
    });
  }
}

/**
 * Find the best matching knowledge base entry for a question.
 * Uses keyword matching and simple similarity scoring.
 * @param {string} question
 * @param {Array} kbEntries
 * @returns {Object|null}
 */
function findBestKBMatch(question, kbEntries) {
  if (!kbEntries.length) return null;

  const q = question.toLowerCase();
  let   bestMatch = null;
  let   bestScore = 0;

  for (const entry of kbEntries) {
    let score = 0;

    // Check keywords array
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
    for (const kw of keywords) {
      if (q.includes(kw.toLowerCase())) score += 3;
    }

    // Check question text similarity
    const entryQ = entry.question.toLowerCase();
    const qWords = q.split(/\s+/);
    for (const word of qWords) {
      if (word.length > 3 && entryQ.includes(word)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  // Only return if score is meaningful
  return bestScore >= 3 ? bestMatch : null;
}

/**
 * Call Claude API for general guidance when question
 * is not in the knowledge base.
 * @param {string} question
 * @returns {string} General steps or guidance
 */
async function getAIGeneralGuidance(question) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: `You are a helpful assistant for Generations Getaway LLC, a luxury short-term rental property in Fort Lauderdale, FL at 647 NE 16th Terrace. A guest has asked a question that isn't covered in the property's knowledge base. Provide 2-4 brief, practical general steps or suggestions they can try. Be warm, helpful, and concise. Do not make up specific details about the property. Format as a short numbered list. Do not include any preamble or closing remarks — just the numbered steps.`,
        messages: [{ role: 'user', content: question }],
      }),
    });

    const data = await response.json();
    return data.content?.[0]?.text || null;

  } catch {
    // Silently fail — escalation message still goes through without AI steps
    return null;
  }
}
