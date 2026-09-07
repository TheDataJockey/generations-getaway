/**
 * FILE: js/admin-idle.js
 * USED BY: every admin page
 *   - admin/dashboard.html
 *   - admin/pricing.html
 *   - admin/assistant.html
 *   - admin/settings.html
 * ============================================================
 * PURPOSE:
 *   Signs an admin out after a configurable period with no
 *   activity, with a countdown warning first.
 *
 * WHY THIS EXISTS:
 *   The admin area shows guest names, emails, phone numbers and
 *   discount codes. Sessions previously lasted 8 hours with no
 *   idle check, so an unattended laptop stayed signed in all day.
 *
 * HOW THE TIMEOUT IS DECIDED:
 *   Read once per page load from /api/admin?resource=system-settings
 *   and cached in sessionStorage so every page doesn't re-fetch it.
 *   Change it in Admin -> System Settings; it applies on next load.
 *
 * ACTIVITY = mousemove, keydown, click, scroll, touch. Any of these
 *   resets the clock. The timer also survives tab switches, because
 *   it compares timestamps rather than counting ticks — a laptop
 *   asleep for an hour is still idle for an hour.
 */

(function () {
  'use strict';

  var TOKEN_KEY  = 'gg_admin_token';
  var CACHE_KEY  = 'gg_idle_config';
  var LAST_KEY   = 'gg_last_activity';

  if (!sessionStorage.getItem(TOKEN_KEY)) return;   // not signed in

  var cfg = { idle_timeout_minutes: 30, idle_warning_seconds: 60 };
  var warningEl = null;
  var ticker = null;

  /* ── Config ── */
  function applyCached() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) cfg = JSON.parse(raw);
    } catch (e) { /* keep defaults */ }
  }

  function fetchConfig() {
    fetch('/api/admin?resource=system-settings', {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem(TOKEN_KEY) },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        cfg = {
          idle_timeout_minutes: Number(d.idle_timeout_minutes),
          idle_warning_seconds: Number(d.idle_warning_seconds),
        };
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(cfg));
      })
      .catch(function () { /* defaults are fine */ });
  }

  /* ── Activity tracking ── */
  function markActive() {
    sessionStorage.setItem(LAST_KEY, String(Date.now()));
    if (warningEl) dismissWarning();
  }

  function idleMs() {
    var last = Number(sessionStorage.getItem(LAST_KEY) || Date.now());
    return Date.now() - last;
  }

  /* ── Warning UI ── */
  function showWarning(secondsLeft) {
    if (warningEl) return;
    warningEl = document.createElement('div');
    warningEl.setAttribute('role', 'alertdialog');
    warningEl.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(13,27,46,0.82);' +
      'font-family:Montserrat,-apple-system,sans-serif;';
    warningEl.innerHTML =
      '<div style="background:#132339;border:1px solid rgba(46,95,163,0.4);' +
      'border-radius:6px;padding:1.6rem 1.8rem;max-width:380px;text-align:center;' +
      'color:#F4F7FB;box-shadow:0 20px 60px rgba(0,0,0,0.5);">' +
        '<p style="font-family:Cormorant Garamond,Georgia,serif;font-size:1.4rem;' +
        'margin-bottom:0.6rem;">Still there?</p>' +
        '<p style="font-size:0.85rem;line-height:1.7;color:#A8C4E0;margin-bottom:1.2rem;">' +
        'You will be signed out in <strong id="ggIdleCount">' + secondsLeft +
        '</strong> seconds to protect guest information.</p>' +
        '<button id="ggStayBtn" style="padding:0.6rem 1.2rem;border:none;border-radius:4px;' +
        'background:#2E5FA3;color:#fff;font-family:inherit;font-size:0.72rem;' +
        'letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;">' +
        'Stay Signed In</button>' +
      '</div>';
    document.body.appendChild(warningEl);
    document.getElementById('ggStayBtn').addEventListener('click', markActive);
  }

  function dismissWarning() {
    if (!warningEl) return;
    warningEl.remove();
    warningEl = null;
  }

  /* ── Logout ── */
  function signOut() {
    if (ticker) clearInterval(ticker);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('gg_admin_role');
    sessionStorage.removeItem(CACHE_KEY);
    sessionStorage.removeItem(LAST_KEY);
    window.location.href = '/admin/login.html?reason=idle';
  }

  /* ── Main loop ── */
  function check() {
    var timeoutMin = Number(cfg.idle_timeout_minutes);
    if (!timeoutMin || timeoutMin <= 0) { dismissWarning(); return; }  // disabled

    var limitMs   = timeoutMin * 60 * 1000;
    var warnMs    = Math.min(Number(cfg.idle_warning_seconds) * 1000, limitMs - 1000);
    var idle      = idleMs();

    if (idle >= limitMs) { signOut(); return; }

    if (idle >= limitMs - warnMs) {
      var left = Math.ceil((limitMs - idle) / 1000);
      showWarning(left);
      var el = document.getElementById('ggIdleCount');
      if (el) el.textContent = left;
    } else {
      dismissWarning();
    }
  }

  /* ── Wire up ── */
  applyCached();
  if (!sessionStorage.getItem(LAST_KEY)) markActive();
  fetchConfig();

  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click']
    .forEach(function (evt) {
      // Passive listeners so tracking never blocks scrolling.
      document.addEventListener(evt, throttle(markActive, 2000), { passive: true });
    });

  // Compare timestamps rather than counting ticks, so a sleeping laptop
  // or a background tab still counts as idle time.
  ticker = setInterval(check, 1000);

  function throttle(fn, wait) {
    var last = 0;
    return function () {
      var now = Date.now();
      if (now - last >= wait) { last = now; fn(); }
    };
  }
})();
