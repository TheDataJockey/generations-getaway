/**
 * Generations Getaway LLC
 * /api/admin-auth
 * ================
 * Two-step admin authentication handler.
 * Routes by ?step= query parameter:
 *
 *  POST /api/admin-auth?step=credentials
 *    — validates email + password via Supabase Auth
 *    — generates TOTP secret/QR on first login
 *
 *  POST /api/admin-auth?step=totp
 *    — validates 6-digit TOTP code
 *    — issues session token on success
 *
 * Security:
 *  - Supabase Auth for password validation
 *  - TOTP implements RFC 6238 server-side (no npm needed)
 *  - Rate limited by IP via audit_logs
 *  - All attempts logged to audit_logs
 *  - Session token HMAC-signed, 8hr expiry
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── CORS helper ──
function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin.includes('generationsgetawayfl.com') ||
      origin.includes('localhost') ||
      origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  const step = req.query.step || req.url.split('step=')[1]?.split('&')[0];

  if (step === 'credentials') return handleCredentials(req, res);
  if (step === 'totp')        return handleTotp(req, res);

  return res.status(400).json({ error: 'Missing step parameter.' });
}

// ════════════════════════════════════
// STEP 1: Email + Password
// ════════════════════════════════════
async function handleCredentials(req, res) {
  const ip          = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const windowStart = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // ── Rate limit: 10 attempts per 15 min per IP ──
  const { count } = await supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .eq('action', 'failed_login')
    .gte('created_at', windowStart);

  if (count >= 10) {
    return res.status(429).json({
      error: 'Too many login attempts. Please wait 15 minutes before trying again.'
    });
  }

  try {
    const { email, password } = req.body;

    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // ── Authenticate via Supabase Auth REST API directly ──
    // Uses fetch instead of SDK signInWithPassword to avoid URL parsing issues
    const supabaseUrl  = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
    const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const authResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       supabaseAnon,
      },
      body: JSON.stringify({
        email:    email.trim().toLowerCase(),
        password,
      }),
    });

    const authData = await authResponse.json();

    if (!authResponse.ok || !authData.user) {
      await supabase.from('audit_logs').insert({
        action:     'failed_login',
        ip_address: ip,
        user_agent: req.headers['user-agent'] || null,
        notes:      `Failed admin login for: ${email} — ${authData.error_description || authData.message || 'unknown'}`,
      });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // ── Check admin_users record ──
    const { data: adminUser } = await supabase
      .from('admin_users')
      .select('id, role, is_active, totp_verified, totp_secret')
      .eq('supabase_auth_id', authData.user.id)
      .single();

    console.log('[admin-auth] Found admin user:', adminUser?.id || 'NOT FOUND', 'active:', adminUser?.is_active);

    if (!adminUser || !adminUser.is_active) {
      return res.status(403).json({ error: 'Access denied. Contact the super admin.' });
    }

    // ── First login — generate TOTP setup ──
    if (!adminUser.totp_verified || !adminUser.totp_secret) {
      const secret = generateTotpSecret();
      const qrUrl  = generateQrUrl(email, secret);
      await supabase
        .from('admin_users')
        .update({ totp_secret: secret, totp_verified: false })
        .eq('id', adminUser.id);
      return res.status(200).json({ needs_setup: true, secret, qr_url: qrUrl });
    }

    return res.status(200).json({ needs_setup: false });

  } catch (err) {
    console.error('[admin-auth/credentials]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// STEP 2: TOTP Verification
// ════════════════════════════════════
async function handleTotp(req, res) {
  try {
    const { email, code } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';

    if (!email || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Valid email and 6-digit code are required.' });
    }

    // ── Get admin user ──
    const { data: adminUser } = await supabase
      .from('admin_users')
      .select('id, first_name, last_name, role, totp_secret, totp_verified, is_active')
      .eq('is_active', true)
      .ilike('email', email.trim())
      .single();

    if (!adminUser?.totp_secret) {
      return res.status(401).json({ error: 'Invalid session. Please start login again.' });
    }

    // ── Validate TOTP ──
    if (!validateTotp(adminUser.totp_secret, code)) {
      await supabase.from('audit_logs').insert({
        admin_id:    adminUser.id,
        admin_email: email,
        admin_role:  adminUser.role,
        action:      'failed_login',
        ip_address:  ip,
        notes:       'Invalid TOTP code',
      });
      return res.status(401).json({ error: 'Invalid code. Please try again.' });
    }

    // ── Mark 2FA verified on first setup ──
    if (!adminUser.totp_verified) {
      await supabase
        .from('admin_users')
        .update({ totp_verified: true })
        .eq('id', adminUser.id);
    }

    // ── Generate session token (HMAC, 8hr expiry) ──
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    const token     = crypto
      .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
      .update(`${adminUser.id}:${expiresAt}`)
      .digest('hex');

    await supabase
      .from('admin_users')
      .update({
        session_token:   token,
        session_expires: new Date(expiresAt).toISOString(),
        last_login_at:   new Date().toISOString(),
        last_login_ip:   ip,
      })
      .eq('id', adminUser.id);

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
      success:    true,
      token,
      role:       adminUser.role,
      first_name: adminUser.first_name,
      last_name:  adminUser.last_name,
    });

  } catch (err) {
    console.error('[admin-auth/totp]', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ════════════════════════════════════
// TOTP HELPERS (RFC 6238)
// ════════════════════════════════════

/**
 * Validate a TOTP code — checks current window ±1 for clock drift.
 * @param {string} secret - base32 TOTP secret
 * @param {string} code   - 6-digit code
 * @returns {boolean}
 */
function validateTotp(secret, code) {
  const timeStep = Math.floor(Date.now() / 1000 / 30);
  for (const offset of [-1, 0, 1]) {
    if (generateTotp(secret, timeStep + offset) === code) return true;
  }
  return false;
}

/**
 * Generate a TOTP code for a given time step using HMAC-SHA1 (RFC 6238).
 * @param {string} secret   - base32-encoded secret
 * @param {number} timeStep - 30-second window counter
 * @returns {string} 6-digit code
 */
function generateTotp(secret, timeStep) {
  const key  = base32Decode(secret);
  const time = Buffer.alloc(8);
  let   t    = timeStep;
  for (let i = 7; i >= 0; i--) { time[i] = t & 0xff; t >>= 8; }

  const hmac   = crypto.createHmac('sha1', key).update(time).digest();
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
 * Decode a base32 string to Buffer.
 * @param {string} base32
 * @returns {Buffer}
 */
function base32Decode(base32) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const c of base32.toUpperCase().replace(/=+$/, '')) {
    value = (value << 5) | alpha.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/**
 * Generate a random 20-char base32 TOTP secret.
 * @returns {string}
 */
function generateTotpSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let   s     = '';
  for (let i = 0; i < 20; i++) s += chars[Math.floor(Math.random() * 32)];
  return s;
}

/**
 * Generate a QR code URL for Microsoft Authenticator.
 * @param {string} email
 * @param {string} secret
 * @returns {string}
 */
function generateQrUrl(email, secret) {
  const issuer  = encodeURIComponent('Generations Getaway LLC');
  const account = encodeURIComponent(email);
  const otp     = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(otp)}`;
}
