/**
 * Generations Getaway LLC
 * Email Service — Templates & Sending
 * =====================================
 * Handles all outbound emails via Resend.
 * Called by:
 *   - /api/bookings.js  (booking confirmation + Kyle notification)
 *   - /api/cron.js      (scheduled welcome, reminder, checkout, review)
 *
 * All emails are HTML with plain-text fallback.
 * Sender: welcome@ for guest emails, bookings@ for admin notifications.
 *
 * Templates:
 *   1. bookingConfirmation  — instant on inquiry
 *   2. kyleNotification     — instant on inquiry
 *   3. welcomeEmail         — 3 days before check-in
 *   4. dayBeforeReminder    — 1 day before check-in
 *   5. checkoutReminder     — morning of checkout
 *   6. reviewRequest        — 1 day after checkout
 */

const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const BASE_URL        = 'https://www.generationsgetawayfl.com';
const PROPERTY_NAME   = 'Generations Getaway LLC';
const PROPERTY_ADDRESS = '647 NE 16th Terrace, Fort Lauderdale, FL 33304';
const KYLE_EMAIL      = 'kyle@generationsgetawayfl.com';
const FROM_WELCOME    = `${PROPERTY_NAME} <welcome@generationsgetawayfl.com>`;
const FROM_BOOKINGS   = `${PROPERTY_NAME} <bookings@generationsgetawayfl.com>`;

// ── Shared email styles ──
const emailStyles = `
  <style>
    body { margin:0; padding:0; background:#0D1B2E; font-family:'Helvetica Neue',Arial,sans-serif; }
    .wrapper { max-width:600px; margin:0 auto; background:#1B2A4A; }
    .header { background:#0D1B2E; padding:32px 40px; text-align:center; border-bottom:1px solid rgba(91,141,217,0.2); }
    .header img { width:72px; height:72px; }
    .header-title { font-family:Georgia,serif; font-size:22px; font-weight:300; color:#A8C4E0; margin:12px 0 4px; letter-spacing:0.05em; }
    .header-sub { font-size:11px; color:#7A90AE; letter-spacing:0.2em; text-transform:uppercase; }
    .body { padding:36px 40px; }
    .greeting { font-family:Georgia,serif; font-size:26px; font-weight:300; color:#F4F7FB; margin-bottom:16px; line-height:1.3; }
    .greeting em { font-style:italic; color:#A8C4E0; }
    p { font-size:15px; color:rgba(164,196,224,0.85); line-height:1.8; margin:0 0 16px; }
    .info-card { background:rgba(13,27,46,0.6); border:1px solid rgba(91,141,217,0.2); border-radius:6px; padding:24px; margin:24px 0; }
    .info-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(91,141,217,0.1); font-size:14px; }
    .info-row:last-child { border-bottom:none; }
    .info-label { color:#7A90AE; letter-spacing:0.08em; text-transform:uppercase; font-size:11px; padding-top:2px; }
    .info-value { color:#F4F7FB; font-weight:500; text-align:right; }
    .pin-box { background:rgba(46,95,163,0.2); border:1px solid rgba(91,141,217,0.3); border-radius:6px; padding:20px; text-align:center; margin:24px 0; }
    .pin-label { font-size:11px; letter-spacing:0.25em; text-transform:uppercase; color:#7A90AE; margin-bottom:8px; }
    .pin-code { font-family:Georgia,serif; font-size:42px; font-weight:300; color:#A8C4E0; letter-spacing:0.3em; }
    .btn { display:inline-block; background:#2E5FA3; color:#ffffff !important; text-decoration:none; padding:14px 32px; border-radius:4px; font-size:13px; letter-spacing:0.15em; text-transform:uppercase; margin:8px 0; }
    .btn-outline { display:inline-block; border:1px solid rgba(91,141,217,0.4); color:#A8C4E0 !important; text-decoration:none; padding:12px 28px; border-radius:4px; font-size:13px; letter-spacing:0.12em; text-transform:uppercase; margin:8px 0; }
    .checklist { list-style:none; padding:0; margin:16px 0; }
    .checklist li { padding:8px 0; border-bottom:1px solid rgba(91,141,217,0.1); font-size:14px; color:rgba(164,196,224,0.85); display:flex; align-items:center; gap:10px; }
    .checklist li:last-child { border-bottom:none; }
    .check { color:#34c759; font-size:16px; }
    .divider { border:none; border-top:1px solid rgba(91,141,217,0.15); margin:28px 0; }
    .footer { background:#0D1B2E; padding:24px 40px; text-align:center; border-top:1px solid rgba(91,141,217,0.15); }
    .footer p { font-size:12px; color:#7A90AE; margin:4px 0; }
    .footer a { color:#5B8DD9; text-decoration:none; }
    .star { color:#FFD54F; font-size:22px; }
    .highlight { color:#A8C4E0; font-weight:500; }
    @media (max-width:600px) {
      .body, .header, .footer { padding:24px 20px; }
      .pin-code { font-size:32px; }
      .greeting { font-size:22px; }
    }
  </style>`;

// ── Send via Resend ──
export async function sendEmail({ to, from, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.error('[email] RESEND_API_KEY not set');
    return { success: false, error: 'API key not configured' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('[email] Resend error:', data);
      return { success: false, error: data.message };
    }
    console.log(`[email] Sent to ${to}: ${subject}`);
    return { success: true, id: data.id };

  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════
// TEMPLATE 1 — Booking Confirmation (instant)
// ════════════════════════════════════════════════════════
export async function sendBookingConfirmation({ guest, booking }) {
  const subject = `We received your inquiry — ${PROPERTY_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${emailStyles}</head>
<body><div class="wrapper">
  <div class="header">
    <div class="header-title">${PROPERTY_NAME}</div>
    <div class="header-sub">Fort Lauderdale, Florida</div>
  </div>
  <div class="body">
    <div class="greeting">Thank you, <em>${guest.first_name}</em>.</div>
    <p>We've received your booking inquiry and will be in touch shortly to confirm your stay at ${PROPERTY_NAME}.</p>

    <div class="info-card">
      <div class="info-row">
        <span class="info-label">Check-In</span>
        <span class="info-value">${formatDate(booking.check_in_date)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Check-Out</span>
        <span class="info-value">${formatDate(booking.check_out_date)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Guests</span>
        <span class="info-value">${booking.num_guests || 1}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Property</span>
        <span class="info-value">${PROPERTY_ADDRESS}</span>
      </div>
    </div>

    <p>Here's what happens next:</p>
    <ul class="checklist">
      <li><span class="check">✓</span> We'll review your dates and confirm availability</li>
      <li><span class="check">✓</span> You'll receive a confirmation email once approved</li>
      <li><span class="check">✓</span> 3 days before check-in, we'll send your guest portal access with door PIN and WiFi details</li>
    </ul>

    <hr class="divider"/>
    <p style="font-size:13px;">Questions? Reply to this email or reach us at <a href="mailto:${KYLE_EMAIL}" style="color:#5B8DD9;">${KYLE_EMAIL}</a></p>
  </div>
  <div class="footer">
    <p>${PROPERTY_NAME} &nbsp;&middot;&nbsp; ${PROPERTY_ADDRESS}</p>
    <p><a href="${BASE_URL}">${BASE_URL}</a></p>
  </div>
</div></body></html>`;

  const text = `Thank you, ${guest.first_name}. We received your inquiry for ${formatDate(booking.check_in_date)} – ${formatDate(booking.check_out_date)}. We'll be in touch shortly to confirm your stay.`;

  return sendEmail({ to: guest.email, from: FROM_BOOKINGS, subject, html, text });
}

// ════════════════════════════════════════════════════════
// TEMPLATE 2 — Kyle Notification (instant)
// ════════════════════════════════════════════════════════
export async function sendKyleNotification({ guest, booking }) {
  const subject = `🏠 New Booking Inquiry — ${guest.first_name} ${guest.last_name}`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${emailStyles}</head>
<body><div class="wrapper">
  <div class="header">
    <div class="header-title">New Booking Inquiry</div>
    <div class="header-sub">${PROPERTY_NAME}</div>
  </div>
  <div class="body">
    <div class="greeting"><em>New inquiry</em> received.</div>
    <div class="info-card">
      <div class="info-row"><span class="info-label">Guest</span><span class="info-value">${guest.first_name} ${guest.last_name}</span></div>
      <div class="info-row"><span class="info-label">Email</span><span class="info-value">${guest.email}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${guest.phone || '—'}</span></div>
      <div class="info-row"><span class="info-label">Check-In</span><span class="info-value">${formatDate(booking.check_in_date)}</span></div>
      <div class="info-row"><span class="info-label">Check-Out</span><span class="info-value">${formatDate(booking.check_out_date)}</span></div>
      <div class="info-row"><span class="info-label">Guests</span><span class="info-value">${booking.num_guests || 1}</span></div>
      <div class="info-row"><span class="info-label">Source</span><span class="info-value" style="text-transform:capitalize;">${booking.booking_source || 'Direct'}</span></div>
      ${booking.special_requests ? `<div class="info-row"><span class="info-label">Notes</span><span class="info-value" style="max-width:320px;">${booking.special_requests}</span></div>` : ''}
    </div>
    <div style="text-align:center;margin-top:24px;">
      <a href="${BASE_URL}/admin/dashboard.html" class="btn">Review in Dashboard</a>
    </div>
  </div>
  <div class="footer"><p>${PROPERTY_NAME} Admin Notification</p></div>
</div></body></html>`;

  const text = `New booking inquiry from ${guest.first_name} ${guest.last_name} (${guest.email}). Check-in: ${formatDate(booking.check_in_date)}, Check-out: ${formatDate(booking.check_out_date)}.`;

  return sendEmail({ to: KYLE_EMAIL, from: FROM_BOOKINGS, subject, html, text });
}

// ════════════════════════════════════════════════════════
// TEMPLATE 3 — Welcome Email (3 days before check-in)
// ════════════════════════════════════════════════════════
export async function sendWelcomeEmail({ guest, booking }) {
  const subject = `Your stay is almost here — ${PROPERTY_NAME}`;
  const portalUrl = `${BASE_URL}/welcome.html`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${emailStyles}</head>
<body><div class="wrapper">
  <div class="header">
    <div class="header-title">${PROPERTY_NAME}</div>
    <div class="header-sub">Fort Lauderdale, Florida</div>
  </div>
  <div class="body">
    <div class="greeting">We can't wait to welcome you, <em>${guest.first_name}</em>.</div>
    <p>Your stay at ${PROPERTY_NAME} begins in just 3 days. Everything is being prepared for your arrival — here's everything you need to know.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Check-In</span><span class="info-value">${formatDate(booking.check_in_date)} after 3:00 PM</span></div>
      <div class="info-row"><span class="info-label">Check-Out</span><span class="info-value">${formatDate(booking.check_out_date)} by 11:00 AM</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-value">${PROPERTY_ADDRESS}</span></div>
      <div class="info-row"><span class="info-label">Parking</span><span class="info-value">Driveway — fits 2 cars</span></div>
    </div>

    ${booking.yale_pin_code ? `
    <div class="pin-box">
      <div class="pin-label">Your Door PIN Code</div>
      <div class="pin-code">${booking.yale_pin_code}</div>
      <p style="font-size:13px;color:#7A90AE;margin:8px 0 0;">Enter this code on the Yale keypad at the front door</p>
    </div>` : ''}

    ${booking.welcome_note ? `
    <hr class="divider"/>
    <p style="font-family:Georgia,serif;font-size:16px;font-style:italic;color:#A8C4E0;line-height:1.8;">"${booking.welcome_note}"</p>
    <hr class="divider"/>` : ''}

    <p>Your <span class="highlight">Guest Portal</span> has everything you need — WiFi password, pool instructions, house rules, local recommendations, and a direct chat with us:</p>

    <div style="text-align:center;margin:24px 0;">
      <a href="${portalUrl}" class="btn">Access Your Guest Portal</a>
    </div>

    <p style="font-size:13px;color:#7A90AE;text-align:center;">Log in with your last name and the 4-digit PIN above</p>

    <hr class="divider"/>

    <p><span class="highlight">WiFi:</span> Details available in your Guest Portal after check-in.</p>
    <p><span class="highlight">Pool & Spa:</span> Heated year-round. Controls are in the outdoor utility box.</p>
    <p><span class="highlight">Questions?</span> Reply to this email or use the chat in your Guest Portal — we're always here.</p>
  </div>
  <div class="footer">
    <p>${PROPERTY_NAME} &nbsp;&middot;&nbsp; ${PROPERTY_ADDRESS}</p>
    <p><a href="${BASE_URL}">${BASE_URL}</a></p>
  </div>
</div></body></html>`;

  const text = `Your stay at ${PROPERTY_NAME} begins in 3 days on ${formatDate(booking.check_in_date)}. Your door PIN is ${booking.yale_pin_code || 'provided at check-in'}. Access your guest portal at ${portalUrl}.`;

  return sendEmail({ to: guest.email, from: FROM_WELCOME, subject, html, text });
}

// ════════════════════════════════════════════════════════
// TEMPLATE 4 — Day Before Reminder
// ════════════════════════════════════════════════════════
export async function sendDayBeforeReminder({ guest, booking }) {
  const subject = `See you tomorrow! — ${PROPERTY_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${emailStyles}</head>
<body><div class="wrapper">
  <div class="header">
    <div class="header-title">${PROPERTY_NAME}</div>
    <div class="header-sub">Fort Lauderdale, Florida</div>
  </div>
  <div class="body">
    <div class="greeting">See you <em>tomorrow</em>, ${guest.first_name}!</div>
    <p>Your Fort Lauderdale getaway begins tomorrow. Here's a quick reminder of everything you need for a smooth arrival.</p>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Check-In</span><span class="info-value">Tomorrow, ${formatDate(booking.check_in_date)} after 3:00 PM</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-value">${PROPERTY_ADDRESS}</span></div>
      <div class="info-row"><span class="info-label">Parking</span><span class="info-value">Driveway — fits 2 cars</span></div>
    </div>

    ${booking.yale_pin_code ? `
    <div class="pin-box">
      <div class="pin-label">Door PIN Code</div>
      <div class="pin-code">${booking.yale_pin_code}</div>
      <p style="font-size:13px;color:#7A90AE;margin:8px 0 0;">Yale keypad at the front door — no key needed</p>
    </div>` : ''}

    <p><span class="highlight">Getting here:</span></p>
    <ul class="checklist">
      <li><span class="check">→</span> From I-95: Take exit 31B for Sunrise Blvd East, then head north on NE 6th Ave</li>
      <li><span class="check">→</span> From Fort Lauderdale Airport: 20 min drive north on US-1</li>
      <li><span class="check">→</span> Rideshare: Uber/Lyft both service the area reliably</li>
    </ul>

    <div style="text-align:center;margin:24px 0;">
      <a href="https://maps.google.com/?q=647+NE+16th+Terrace+Fort+Lauderdale+FL+33304" class="btn-outline">Get Directions</a>
      &nbsp;&nbsp;
      <a href="${BASE_URL}/welcome.html" class="btn">Guest Portal</a>
    </div>

    <hr class="divider"/>
    <p style="font-size:13px;">Need to reach us before arrival? Reply to this email — we typically respond within the hour.</p>
  </div>
  <div class="footer">
    <p>${PROPERTY_NAME} &nbsp;&middot;&nbsp; ${PROPERTY_ADDRESS}</p>
    <p><a href="${BASE_URL}">${BASE_URL}</a></p>
  </div>
</div></body></html>`;

  const text = `See you tomorrow, ${guest.first_name}! Check-in is after 3 PM at ${PROPERTY_ADDRESS}. Your door PIN is ${booking.yale_pin_code || 'in your guest portal'}. Directions: https://maps.google.com/?q=647+NE+16th+Terrace+Fort+Lauderdale+FL`;

  return sendEmail({ to: guest.email, from: FROM_WELCOME, subject, html, text });
}

// ════════════════════════════════════════════════════════
// TEMPLATE 5 — Checkout Reminder (morning of checkout)
// ════════════════════════════════════════════════════════
export async function sendCheckoutReminder({ guest, booking }) {
  const subject = `Checkout today by 11 AM — ${PROPERTY_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${emailStyles}</head>
<body><div class="wrapper">
  <div class="header">
    <div class="header-title">${PROPERTY_NAME}</div>
    <div class="header-sub">Fort Lauderdale, Florida</div>
  </div>
  <div class="body">
    <div class="greeting">Good morning, <em>${guest.first_name}</em>.</div>
    <p>We hope you had a wonderful stay! Today is checkout day — please be out by <span class="highlight">11:00 AM</span>.</p>

    <p>Before you go, please take care of the following:</p>

    <ul class="checklist">
      <li><span class="check">☐</span> Strip beds and leave linens in a pile on the floor</li>
      <li><span class="check">☐</span> Load and start the dishwasher</li>
      <li><span class="check">☐</span> Take out any trash to the bins outside</li>
      <li><span class="check">☐</span> Turn off all lights, fans, and AC</li>
      <li><span class="check">☐</span> Lock all doors and windows</li>
      <li><span class="check">☐</span> Leave the keys/fobs on the kitchen counter (if applicable)</li>
      <li><span class="check">☐</span> Make sure the pool gate is latched</li>
    </ul>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Checkout Time</span><span class="info-value">By 11:00 AM today</span></div>
      <div class="info-row"><span class="info-label">Late Checkout</span><span class="info-value">Contact us if you need extra time</span></div>
    </div>

    <p>It's been a pleasure having you. Safe travels, ${guest.first_name}!</p>

    <div style="text-align:center;margin:24px 0;">
      <a href="${BASE_URL}/welcome.html" class="btn-outline">Full Checkout Checklist</a>
    </div>
  </div>
  <div class="footer">
    <p>${PROPERTY_NAME} &nbsp;&middot;&nbsp; ${PROPERTY_ADDRESS}</p>
    <p><a href="${BASE_URL}">${BASE_URL}</a></p>
  </div>
</div></body></html>`;

  const text = `Good morning ${guest.first_name}! Checkout is today by 11 AM. Please strip beds, load the dishwasher, take out trash, and lock up. Safe travels!`;

  return sendEmail({ to: guest.email, from: FROM_WELCOME, subject, html, text });
}

// ════════════════════════════════════════════════════════
// TEMPLATE 6 — Review Request (1 day after checkout)
// ════════════════════════════════════════════════════════
export async function sendReviewRequest({ guest, booking }) {
  const subject = `How was your stay? — ${PROPERTY_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${emailStyles}</head>
<body><div class="wrapper">
  <div class="header">
    <div class="header-title">${PROPERTY_NAME}</div>
    <div class="header-sub">Fort Lauderdale, Florida</div>
  </div>
  <div class="body">
    <div class="greeting">We hope you had an <em>amazing</em> stay.</div>
    <p>Thank you for choosing ${PROPERTY_NAME}, ${guest.first_name}. We truly hope your time in Fort Lauderdale was everything you hoped for.</p>

    <p>If you enjoyed your stay, we'd be incredibly grateful if you could take a moment to leave us a review. It means the world to us and helps future guests discover our home.</p>

    <div style="text-align:center;margin:32px 0;">
      <div class="star">★★★★★</div>
      <p style="font-size:13px;color:#7A90AE;margin:8px 0 20px;">It only takes 2 minutes</p>
      <a href="https://www.google.com/maps/search/?api=1&query=Generations+Getaway+LLC+Fort+Lauderdale" class="btn">Leave a Google Review</a>
    </div>

    <hr class="divider"/>

    <p>We'd also love to hear any private feedback — what we did well, and what we could do better. Simply reply to this email and we'll read every word.</p>

    <p>We hope to welcome you back to Fort Lauderdale soon!</p>

    <p style="font-family:Georgia,serif;font-style:italic;color:#A8C4E0;">With warmth,<br/>The Generations Getaway Team</p>
  </div>
  <div class="footer">
    <p>${PROPERTY_NAME} &nbsp;&middot;&nbsp; ${PROPERTY_ADDRESS}</p>
    <p><a href="${BASE_URL}">${BASE_URL}</a> &nbsp;&middot;&nbsp; <a href="mailto:${KYLE_EMAIL}">Contact Us</a></p>
  </div>
</div></body></html>`;

  const text = `Thank you for staying at ${PROPERTY_NAME}, ${guest.first_name}! We'd love it if you could leave us a Google review. Your feedback helps future guests discover our home.`;

  return sendEmail({ to: guest.email, from: FROM_WELCOME, subject, html, text });
}

// ════════════════════════════════════════════════════════
// HELPER: Format date as "Monday, April 25, 2026"
// ════════════════════════════════════════════════════════
function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
  } catch { return dateStr; }
}
