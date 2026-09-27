/*
  FILE: js/consent.js
  ============================================================
  PURPOSE:
    Shows a consent notice and loads Google's tag ONLY after the
    visitor agrees. Does nothing at all until you fill in your
    measurement ID below, so it is safe to ship today.

  WHY IT EXISTS:
    Right now the site sets no cookies and needs no banner. The
    moment you add Google Analytics or Ads conversion tracking,
    those set cookies and EU/UK visitors must be asked first.
    This file handles that, and keeps US visitors banner-free.

  HOW TO TURN IT ON:
    1. Put your Google tag ID in GA_MEASUREMENT_ID below
       (looks like "G-XXXXXXXXXX" for Analytics, or
        "AW-XXXXXXXXX" for Ads conversion tracking).
    2. That's it. The banner starts appearing for EU/UK visitors
       and the tag loads for everyone who is allowed it.

  HOW TO TURN IT OFF AGAIN:
    Blank out GA_MEASUREMENT_ID. No banner, no tag, no cookies.
*/
(function () {
  'use strict';

  // ── Set this to switch tracking on. Empty = nothing happens. ──
  var GA_MEASUREMENT_ID = '';

  if (!GA_MEASUREMENT_ID) return;   // nothing configured, nothing to do

  var STORAGE_KEY = 'gg_consent';   // 'granted' | 'denied'

  // localStorage throws in some privacy modes — never let that break the page.
  function readChoice() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function saveChoice(v) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch (e) { /* ignore */ }
  }

  /*
    Who needs to be asked.

    We use the browser's own timezone rather than an IP lookup, because
    an IP lookup would mean sending the visitor's address to a third
    party just to decide whether to ask their permission — which is
    backwards. Timezone is approximate: a European traveller sitting in
    Miami reads as US. Erring that way is the wrong direction, so when
    we cannot read a timezone at all we ask anyway.
  */
  function mustAsk() {
    var tz;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (e) { return true; }
    if (!tz) return true;
    return tz.indexOf('Europe/') === 0 ||
           tz === 'Atlantic/Canary'  || tz === 'Atlantic/Madeira'  ||
           tz === 'Atlantic/Azores'  || tz === 'Atlantic/Reykjavik';
  }

  // ── Google Consent Mode v2 ──
  // Deny everything before the tag loads, then lift it if they agree.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  gtag('consent', 'default', {
    ad_storage:              'denied',
    ad_user_data:            'denied',
    ad_personalization:      'denied',
    analytics_storage:       'denied',
    functionality_storage:   'granted',
    security_storage:        'granted',
    wait_for_update:         500
  });

  function grantConsent() {
    gtag('consent', 'update', {
      ad_storage:         'granted',
      ad_user_data:       'granted',
      ad_personalization: 'granted',
      analytics_storage:  'granted'
    });
  }

  var tagLoaded = false;
  function loadTag() {
    if (tagLoaded) return;
    tagLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' +
            encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID);
  }

  // ── The notice itself ──
  function showBanner() {
    var wrap = document.createElement('div');
    wrap.id = 'ggConsent';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-live', 'polite');
    wrap.setAttribute('aria-label', 'Cookie consent');

    wrap.innerHTML =
      '<div class="gg-consent-inner">' +
        '<p class="gg-consent-text">' +
          'We would like to use cookies to measure how people find this site. ' +
          'They are not required to browse or to book. ' +
          '<a href="/privacy.html">Read our privacy policy</a>.' +
        '</p>' +
        '<div class="gg-consent-actions">' +
          '<button type="button" class="gg-btn gg-btn-ghost" id="ggDecline">Decline</button>' +
          '<button type="button" class="gg-btn gg-btn-solid" id="ggAccept">Accept</button>' +
        '</div>' +
      '</div>';

    var css = document.createElement('style');
    css.textContent = [
      '#ggConsent{position:fixed;left:0;right:0;bottom:0;z-index:9999;',
        'background:#132339;border-top:1px solid rgba(46,95,163,.4);',
        'box-shadow:0 -8px 32px rgba(0,0,0,.35);',
        'font-family:Montserrat,-apple-system,sans-serif;',
        'animation:ggSlide .3s ease both;}',
      '@keyframes ggSlide{from{transform:translateY(100%)}to{transform:translateY(0)}}',
      '.gg-consent-inner{max-width:1100px;margin:0 auto;padding:1.1rem 1.5rem;',
        'display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;}',
      '.gg-consent-text{flex:1 1 320px;margin:0;font-size:.82rem;line-height:1.7;color:#A8C4E0;}',
      '.gg-consent-text a{color:#5B8DD9;}',
      '.gg-consent-actions{display:flex;gap:.6rem;flex-shrink:0;}',
      '.gg-btn{padding:.6rem 1.3rem;border-radius:4px;cursor:pointer;',
        'font-family:inherit;font-size:.66rem;font-weight:500;',
        'letter-spacing:.14em;text-transform:uppercase;transition:all .2s;}',
      '.gg-btn-solid{background:#2E5FA3;color:#fff;border:1px solid #2E5FA3;}',
      '.gg-btn-solid:hover{background:#5B8DD9;border-color:#5B8DD9;}',
      '.gg-btn-ghost{background:transparent;color:#A8C4E0;',
        'border:1px solid rgba(91,141,217,.4);}',
      '.gg-btn-ghost:hover{border-color:#5B8DD9;color:#F4F7FB;}',
      '@media(max-width:560px){',
        '.gg-consent-inner{padding:1rem 1.2rem;gap:.9rem;}',
        '.gg-consent-actions{width:100%;}',
        '.gg-btn{flex:1;text-align:center;}}'
    ].join('');

    document.head.appendChild(css);
    document.body.appendChild(wrap);

    function close() { wrap.parentNode && wrap.parentNode.removeChild(wrap); }

    document.getElementById('ggAccept').addEventListener('click', function () {
      saveChoice('granted'); grantConsent(); loadTag(); close();
    });
    document.getElementById('ggDecline').addEventListener('click', function () {
      saveChoice('denied'); close();
    });
  }

  function start() {
    var choice = readChoice();

    if (choice === 'granted') { grantConsent(); loadTag(); return; }
    if (choice === 'denied')  { return; }          // respect it, load nothing

    if (mustAsk()) { showBanner(); return; }       // EU/UK: ask first

    // Elsewhere: consent is not required, so load without interrupting.
    grantConsent();
    loadTag();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
