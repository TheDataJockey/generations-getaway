/**
 * Generations Getaway LLC
 * POST /api/admin-auth/credentials
 * ==================================
 * Step 1 of admin 2FA login.
 * Validates email + password via Supabase Auth.
 * If first login, generates TOTP secret and QR code.
 * Returns needs_setup flag and QR/secret if applicable.
 *
 * Security:
 *  - Uses Supabase Auth for password validation
 *  - TOTP secret generated server-side only
 *  - Rate limited by IP
 *  - All attempts logged to audit_logs
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Rate limit: 10 attempts per 15 min per IP ──
const RATE_LIMIT    = 10;
const RATE_WINDOW   = 15 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.generationsgetawayfl.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  const ip       = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const windowStart = new Date(Date.now() - RATE_WINDOW).toISOString();

  // ── Rate limit check ──
  const { count } = await supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .eq('action', 'failed_login')
    .gte('created_at', windowStart);

  if (count >= RATE_LIMIT) {
    return res.status(429).json({
      error: 'Too many login attempts. Please wait 15 minutes before trying again.'
    });
  }

  try {
    const { email, password } = req.body;

    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // ── Authenticate with Supabase Auth ──
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email:    email.trim().toLowerCase(),
      password,
    });

    if (authError || !authData.user) {
      // Log failed attempt
      await supabase.from('audit_logs').insert({
        action:     'failed_login',
        ip_address: ip,
        user_agent: req.headers['user-agent'] || null,
        notes:      `Failed admin login attempt for: ${email}`,
      });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // ── Check admin_users table ──
    const { data: adminUser } = await supabase
      .from('admin_users')
      .select('id, role, is_active, totp_verified, totp_secret')
      .eq('supabase_auth_id', authData.user.id)
      .single();

    if (!adminUser || !adminUser.is_active) {
      return res.status(403).json({ error: 'Access denied. Contact the super admin.' });
    }

    // ── If 2FA not yet set up, generate TOTP secret ──
    if (!adminUser.totp_verified || !adminUser.totp_secret) {
      const secret = generateTotpSecret();
      const qrUrl  = generateQrUrl(email, secret);

      // Store secret (not yet verified)
      await supabase
        .from('admin_users')
        .update({ totp_secret: secret, totp_verified: false })
        .eq('id', adminUser.id);

      return res.status(200).json({
        needs_setup: true,
        secret,
        qr_url: qrUrl,
      });
    }

    return res.status(200).json({ needs_setup: false });

  } catch (err) {
    console.error('[/api/admin-auth/credentials]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

/**
 * Generate a random base32-encoded TOTP secret.
 * @returns {string} 32-character base32 secret
 */
function generateTotpSecret() {
  const chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let   secret = '';
  const bytes  = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    secret += chars[byte % 32];
  }
  return secret;
}

/**
 * Generate a QR code URL for Microsoft Authenticator.
 * Uses the Google Charts API to render the QR code image.
 * @param {string} email
 * @param {string} secret
 * @returns {string} URL to QR code image
 */
function generateQrUrl(email, secret) {
  const issuer  = encodeURIComponent('Generations Getaway LLC');
  const account = encodeURIComponent(email);
  const otpAuth = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(otpAuth)}`;
}
