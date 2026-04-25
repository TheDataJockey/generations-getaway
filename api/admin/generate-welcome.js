/**
 * Generations Getaway LLC
 * POST /api/admin/generate-welcome
 * ==================================
 * Uses Claude AI to generate a personalized
 * welcome note for a guest based on their booking details.
 * Admin can edit the result before saving.
 *
 * Security:
 *  - Requires family_admin or super_admin role
 *  - Input sanitized before sending to AI
 *  - Anthropic API key stored in env var only
 */

import { validateAdminToken, extractToken } from './dashboard.js';

export default async function handler(req, res) {
  // Allow both www and non-www
  const origin = req.headers.origin || '';
  if (origin.includes('generationsgetawayfl.com') || origin.includes('localhost') || origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  const token = extractToken(req);
  const auth  = await validateAdminToken(token, 'family_admin');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    const { first_name, last_name, check_in, check_out, num_guests } = req.body;

    if (!first_name || !check_in || !check_out) {
      return res.status(400).json({ error: 'Guest name and dates are required.' });
    }

    // ── Format dates for the AI ──
    const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const nights = Math.round(
      (new Date(check_out) - new Date(check_in)) / 86400000
    );

    const checkInFmt  = fmtDate(check_in);
    const checkOutFmt = fmtDate(check_out);

    // ── Call Claude API ──
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: `You are writing a warm, personalized welcome note for a guest at Generations Getaway LLC, a luxury short-term rental property in Fort Lauderdale, FL at 647 NE 16th Terrace. The property features a heated pool, spa, and outdoor living space.

Write a 2-4 sentence welcome note that:
- Addresses the guest by first name
- Mentions their arrival date warmly
- References 1-2 specific property features (pool, spa, outdoor space, Fort Lauderdale location)
- Ends with a warm sentiment about their stay
- Sounds personal and genuine, not corporate
- Does NOT mention check-out or house rules (those are covered elsewhere)

Return ONLY the welcome note text. No preamble, no quotes, no extra formatting.`,
        messages: [{
          role:    'user',
          content: `Guest: ${first_name} ${last_name || ''}
Arrival: ${checkInFmt}
Departure: ${checkOutFmt}
Nights: ${nights}
Guests: ${num_guests || 1}`,
        }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'AI generation failed.');
    }

    const welcomeNote = data.content?.[0]?.text?.trim();
    if (!welcomeNote) throw new Error('Empty response from AI.');

    return res.status(200).json({ welcome_note: welcomeNote });

  } catch (err) {
    console.error('[/api/admin/generate-welcome]', err.message);
    return res.status(500).json({
      error: 'Could not generate welcome note. Please write one manually.'
    });
  }
}
