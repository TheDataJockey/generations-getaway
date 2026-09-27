/**
 * FILE: api/admin-auth.js
 * ENDPOINT: POST /api/admin-auth?step=[step]
 * USED BY: Admin Login Page (admin/login.html)
 * ============================================================
 * PURPOSE:
 *   Handles the secure two-step login for the Admin Dashboard.
 *
 * STEP 1 (?step=credentials):
 *   Kyle enters email and password.
 *   Verified against Supabase Auth.
 *   If first login ever: returns a QR code to scan with
 *   Microsoft Authenticator to set up two-factor auth.
 *   On success it also returns a short-lived "pending" token
 *   that step 2 will not proceed without.
 *
 * STEP 2 (?step=totp):
 *   Kyle enters the 6-digit code from Authenticator app.
 *   Validated using RFC 6238 standard (industry standard
 *   for time-based one-time passwords).
 *   On success: returns an 8-hour session token.
 *
 * ============================================================
 * SECURITY NOTES — why this file looks the way it does
 *
 *   1. Step 2 REQUIRES the pending token from step 1.
 *      Without it, anyone who knew an admin's email address
 *      could skip the password entirely and guess 6-digit
 *      codes straight at step 2. The password is the first
 *      factor; the pending token is what proves it was given.
 *
 *   2. Both steps are rate limited per IP. Step 2 has its own
 *      lower limit, counted separately, so a brute-force run
 *      at the code stops after a handful of tries.
 *
 *   3. TOTP secrets come from crypto.randomBytes, never
 *      Math.random(), which is predictable and must never be
 *      used for anything secret.
 *
 *   4. Codes and tokens are compared with timingSafeEqual so
 *      the time taken to reject one does not leak how much of
 *      it was correct.
 *
 *   KNOWN GAP, NOT FIXED HERE: the setup QR code is rendered by
 *   api.qrserver.com, which means the TOTP secret is sent to a
 *   third party once, at first setup. Rendering it locally needs
 *   a change to login.html. Until then, treat an existing admin's
 *   secret as having been exposed to that service.
 *
 * DATABASE TABLES USED:
 *   - admin_users (reads/writes TOTP secret and session)
 *   - audit_logs  (login attempts, used for rate limiting)
 */

import crypto from 'crypto';
import { supabase } from './_lib/supabase.js';
import { setCors } from './_lib/cors.js';

// How long the user has to enter their code after the password.
const PENDING_TTL_MS = 5 * 60 * 1000;

// Rate limits, per IP, per 15 minutes.
const WINDOW_MS            = 15 * 60 * 1000;
const MAX_CREDENTIAL_FAILS = 10;
const MAX_TOTP_FAILS       = 5;

// Written into audit_logs.notes so TOTP failures can be counted
// on their own without adding a new `action` value to the table.
const TOTP_FAIL_NOTE = 'Invalid TOTP code';

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
// PENDING TOKEN  (proves step 1 passed)
// ════════════════════════════════════

function pendingSecret() {
  const s = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return s;
}

/** Sign a short-lived token binding this admin + email to a passed password check. */
function makePendingToken(adminId, email) {
  const expires = Date.now() + PENDING_TTL_MS;
  const body    = `${adminId}.${expires}`;
  const sig     = crypto
    .createHmac('sha256', pendingSecret())
    .update(`totp-pending:${body}:${String(email).trim().toLowerCase()}`)
    .digest('hex');
  return `${body}.${sig}`;
}

/** Returns the adminId if the token is valid for this email, otherwise null. */
function verifyPendingToken(token, email) {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [adminId, expiresRaw, sig] = parts;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;

  const expected = crypto
    .createHmac('sha256', pendingSecret())
    .update(`totp-pending:${adminId}.${expiresRaw}:${String(email).trim().toLowerCase()}`)
    .digest('hex');

  if (!safeEqual(sig, expected)) return null;
  return adminId;
}

/** Constant-time string compare — never leaks how much of a value matched. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ════════════════════════════════════
// RATE LIMITING
// ════════════════════════════════════

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Count recent failures from this IP.
 * `note` narrows it to TOTP failures; omit it for credential failures.
 * On a database error we fail OPEN (return 0) so a Supabase blip can
 * never lock the owner out of his own dashboard.
 */
async function recentFailures(ip, note) {
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  try {
    let q = supabase
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('ip_address', ip)
      .eq('action', 'failed_login')
      .gte('created_at', windowStart);

    q = note ? q.eq('notes', note) : q.neq('notes', TOTP_FAIL_NOTE);

    const { count, error } = await q;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

// ════════════════════════════════════
// STEP 1: Email + Password
// ════════════════════════════════════
async function handleCredentials(req, res) {
  const ip = clientIp(req);

  // ── Rate limit: 10 password attempts per 15 min per IP ──
  if (await recentFailures(ip) >= MAX_CREDENTIAL_FAILS) {
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
    // Must use raw env var URL — NOT the supabase client baseURL which appends /rest/v1/
    const rawUrl       = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
    const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const authResponse = await fetch(`${rawUrl}/auth/v1/token?grant_type=password`, {
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
    // REST token response nests user under authData.user
    const userId = authData.user?.id || authData.id;

    const { data: adminUser } = await supabase
      .from('admin_users')
      .select('id, role, is_active, totp_verified, totp_secret')
      .eq('supabase_auth_id', userId)
      .single();

    if (!adminUser || !adminUser.is_active) {
      return res.status(403).json({ error: 'Access denied. Contact the super admin.' });
    }

    // The password was correct. This token is what lets step 2 run.
    const pending = makePendingToken(adminUser.id, email);

    // ── First login — generate TOTP setup ──
    if (!adminUser.totp_verified || !adminUser.totp_secret) {
      const secret = generateTotpSecret();
      const qrUrl  = generateQrUrl(email, secret);
      await supabase
        .from('admin_users')
        .update({ totp_secret: secret, totp_verified: false })
        .eq('id', adminUser.id);
      return res.status(200).json({ needs_setup: true, secret, qr_url: qrUrl, pending });
    }

    return res.status(200).json({ needs_setup: false, pending });

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
    const { email, code, pending } = req.body;
    const ip = clientIp(req);

    if (!email || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Valid email and 6-digit code are required.' });
    }

    // ── The password must have been given first ──
    // Without this, email + a guessed code would be enough on its own.
    const pendingAdminId = verifyPendingToken(pending, email);
    if (!pendingAdminId) {
      return res.status(401).json({
        error: 'Your login session expired. Please enter your email and password again.'
      });
    }

    // ── Rate limit: 5 code attempts per 15 min per IP ──
    if (await recentFailures(ip, TOTP_FAIL_NOTE) >= MAX_TOTP_FAILS) {
      return res.status(429).json({
        error: 'Too many incorrect codes. Please wait 15 minutes before trying again.'
      });
    }

    // ── Get admin user BY ID FROM THE TOKEN, not by the posted email ──
    const { data: adminUser } = await supabase
      .from('admin_users')
      .select('id, first_name, last_name, role, totp_secret, totp_verified, is_active')
      .eq('id', pendingAdminId)
      .eq('is_active', true)
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
        user_agent:  req.headers['user-agent'] || null,
        notes:       TOTP_FAIL_NOTE,
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
 * Compared in constant time so a wrong code reveals nothing by how
 * long it took to reject.
 * @param {string} secret - base32 TOTP secret
 * @param {string} code   - 6-digit code
 * @returns {boolean}
 */
function validateTotp(secret, code) {
  const timeStep = Math.floor(Date.now() / 1000 / 30);
  let   ok       = false;
  for (const offset of [-1, 0, 1]) {
    // No early return: every call checks all three windows.
    if (safeEqual(generateTotp(secret, timeStep + offset), code)) ok = true;
  }
  return ok;
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
 * Generate a random 32-char base32 TOTP secret.
 *
 * Uses crypto.randomBytes, NOT Math.random(). Math.random() is a
 * predictable pseudo-random generator — given enough output an
 * attacker can work out its internal state and reproduce every
 * value it will ever produce. It must never generate a secret.
 *
 * @returns {string}
 */
function generateTotpSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';   // 32 chars = 5 bits each
  const bytes = crypto.randomBytes(32);
  let   s     = '';
  for (let i = 0; i < 32; i++) s += chars[bytes[i] & 31];
  return s;                                            // 32 × 5 = 160 bits
}

/**
 * Generate a QR code URL for Microsoft Authenticator.
 *
 * NOTE: this sends the TOTP secret to api.qrserver.com. It happens
 * once, at first setup, but it is a third party seeing a secret.
 * Rendering the QR in the browser instead would remove that.
 *
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
