/**
 * FILE: api/_lib/cors.js
 * SHARED BY: All API endpoints that need CORS headers
 * ============================================================
 * PURPOSE:
 *   Two CORS variants used across the endpoints:
 *
 *   setCors        Origin allowlist (site domain, localhost, vercel.app
 *                  previews) for endpoints that handle guest/admin data.
 *   setPublicCors  Wildcard origin for public, read-only endpoints with
 *                  no session data (events, recommendations).
 *
 * NOTE: api/stripe.js keeps its own stricter CORS (exact-match
 *   allowlist) — payment files are excluded from this shared refactor
 *   per project instructions.
 */

export function setCors(req, res, { methods = 'POST, OPTIONS', headers = 'Content-Type' } = {}) {
  const origin = req.headers.origin || '';
  if (origin.includes('generationsgetawayfl.com') || origin.includes('localhost') || origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
}

export function setPublicCors(res, { methods = 'GET, OPTIONS', headers = 'Content-Type' } = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
}
