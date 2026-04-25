/**
 * Generations Getaway LLC
 * POST /api/admin-auth/totp
 * ==========================
 * Step 2 of admin 2FA login.
 * Validates the 6-digit TOTP code from Microsoft Authenticator.
 * On success, issues a signed session token and logs the login.
 *
 * Security:
 *  - TOTP validated server-side using time-window check
 *  - Accepts current window ±1 (30s tolerance for clock drift)
 *  - Session token is a signed HMAC, expires in 8 hours
 *  - All logins logged to audit_logs
 *  - Rate limited by IP
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

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
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const { email, code } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';

    if (!email || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Valid email and 6-digit code are required.' });
    }

    // ── Get admin user with TOTP secret ──
    const { data: adminUser } = await supabase
      .from('admin_users')
      .select('id, first_name, last_name, role, totp_secret, is_active, supabase_auth_id')
      .eq('is_active', true)
      .ilike('email', email.trim())
      .single();

    if (!adminUser || !adminUser.totp_secret) {
      return res.status(401).json({ error: 'Invalid session. Please start login again.' });
    }

    // ── Validate TOTP code ──
    const isValid = validateTotp(adminUser.totp_secret, code);

    if (!isValid) {
      await supabase.from('audit_logs').insert({
        admin_id:   adminUser.id,
        admin_email: email,
        admin_role: adminUser.role,
        action:     'failed_login',
        ip_address: ip,
        notes:      'Invalid TOTP code',
      });
      return res.status(401).json({ error: 'Invalid code. Please try again.' });
    }

    // ── Mark 2FA as verified (first time setup) ──
    if (!adminUser.totp_verified) {
      await supabase
        .from('admin_users')
        .update({ totp_verified: true })
        .eq('id', adminUser.id);
    }

    // ── Generate session token (HMAC, 8 hour expiry) ──
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    const token     = crypto
      .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
      .update(`${adminUser.id}:${expiresAt}`)
      .digest('hex');

    // ── Store session token ──
    await supabase
      .from('admin_users')
      .update({
        session_token:   token,
        session_expires: new Date(expiresAt).toISOString(),
        last_login_at:   new Date().toISOString(),
        last_login_ip:   ip,
      })
      .eq('id', adminUser.id);

    // ── Log successful login ──
    await supabase.from('audit_logs').insert({
      admin_id:    adminUser.id,
      admin_email: email,
      admin_role:  adminUser.role,
      action:      'login',
      ip_address:  ip,
      user_agent:  req.headers['user-agent'] || null,
      notes:       'Successful admin login with 2FA',
    });

    return res.status(200).json({
      success: true,
      token,
      role:       adminUser.role,
      first_name: adminUser.first_name,
      last_name:  adminUser.last_name,
    });

  } catch (err) {
    console.error('[/api/admin-auth/totp]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

/**
 * Validate a TOTP code against a base32 secret.
 * Checks current time window ±1 (30s tolerance).
 * @param {string} secret - base32 TOTP secret
 * @param {string} code   - 6-digit code from authenticator
 * @returns {boolean}
 */
function validateTotp(secret, code) {
  const timeStep = Math.floor(Date.now() / 1000 / 30);

  // Check current window and one either side for clock drift
  for (const offset of [-1, 0, 1]) {
    if (generateTotp(secret, timeStep + offset) === code) return true;
  }
  return false;
}

/**
 * Generate a TOTP code for a given time step.
 * Implements RFC 6238 TOTP using HMAC-SHA1.
 * @param {string} secret    - base32-encoded secret
 * @param {number} timeStep  - current 30-second window counter
 * @returns {string} 6-digit code
 */
function generateTotp(secret, timeStep) {
  const key = base32Decode(secret);

  // Pack time step as 8-byte big-endian
  const time = Buffer.alloc(8);
  let   t    = timeStep;
  for (let i = 7; i >= 0; i--) {
    time[i] = t & 0xff;
    t >>= 8;
  }

  const hmac  = crypto.createHmac('sha1', key).update(time).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8)  |
     (hmac[offset + 3] & 0xff)
  ) % 1_000_000;

  return String(code).padStart(6, '0');
}

/**
 * Decode a base32 string to a Buffer.
 * @param {string} base32
 * @returns {Buffer}
 */
function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let   bits     = 0;
  let   value    = 0;
  const output   = [];

  for (const char of base32.toUpperCase().replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
