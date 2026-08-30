/**
 * FILE: js/main.js
 * USED BY: All public-facing pages
 *   - index.html           Home Page
 *   - booking.html         Booking Inquiry Page
 *   - events.html          Events Page
 *   - recommendations.html Explore Page
 *   - welcome.html         Guest Portal
 * ============================================================
 * PURPOSE:
 *   Shared JavaScript that runs on every public page.
 *   Handles common behaviour that is the same across all pages.
 *
 * WHAT IT DOES:
 *   Navigation bar:
 *     Adds a solid background when you scroll down so the nav
 *     is always readable over background images.
 *
 *   Mobile menu:
 *     Handles the hamburger button that opens and closes the
 *     navigation links on phones and tablets.
 *
 *   Scroll reveal animations:
 *     Fades page sections in as you scroll down for a smooth
 *     and polished appearance.
 *
 *   Visitor logging:
 *     Silently records that the page was visited by sending
 *     a request to /api/visitor-log in the background.
 *     No personal information is collected.
 *
 * NOTE: The Admin Dashboard does NOT use this file.
 */

/* ── Scroll-aware navbar ── */
const navbar = document.getElementById('navbar');
if (navbar) {
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 60);
  }, { passive: true });
}

/* ── Mobile nav toggle ── */
const navToggle = document.getElementById('navToggle');
const navLinks  = document.getElementById('navLinks');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    navToggle.setAttribute(
      'aria-expanded',
      navLinks.classList.contains('open')
    );
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!navbar.contains(e.target)) {
      navLinks.classList.remove('open');
    }
  });
}

/* ── Scroll reveal ── */
// Content is visible by default in CSS. We only arm the hide-then-
// animate behaviour here, once we know this script is executing.
// If anything below fails, the page stays readable.
(function initReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  const showAll = () =>
    items.forEach(el => el.classList.add('visible'));

  // No IntersectionObserver support -> just show everything.
  if (!('IntersectionObserver' in window)) return;

  // Arm the animation: CSS now hides .reveal items.
  document.documentElement.classList.add('js-reveal');

  // Hard safety net: if for any reason items are still hidden
  // after 3s, reveal them so nothing is ever stuck invisible.
  const safety = setTimeout(showAll, 3000);

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        setTimeout(() => entry.target.classList.add('visible'), i * 80);
        revealObserver.unobserve(entry.target);
      }
    });
  }, {
    // threshold 0 + rootMargin fires reliably even for sections
    // taller than the viewport (e.g. the stacked mobile gallery),
    // which a percentage threshold can never satisfy.
    threshold: 0,
    rootMargin: '0px 0px -10% 0px'
  });

  items.forEach(el => revealObserver.observe(el));

  // Once the first item shows, the observer is working; drop the net.
  window.addEventListener('scroll', function once() {
    clearTimeout(safety);
    window.removeEventListener('scroll', once);
  }, { passive: true, once: true });
})();

/* ── Active nav link ── */
// Highlight the nav link that matches the current page URL.
function setActiveNavLink() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-links a').forEach(link => {
    const href = link.getAttribute('href');
    link.classList.toggle(
      'active',
      href === path || (path === '/' && href === '/index.html')
    );
  });
}
setActiveNavLink();

/* ── Visitor logging ── */
// Fire-and-forget visitor log — sends page + device info
// to /api/visitor-log. Never blocks or throws to the user.
async function logVisit() {
  try {
    const sessionId = getOrCreateSessionId();
    await fetch('/api/visitor-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id:    sessionId,
        page_visited:  window.location.pathname,
        referrer:      document.referrer || null,
        user_agent:    navigator.userAgent,
        device_type:   getDeviceType(),
        utm_source:    getParam('utm_source'),
        utm_medium:    getParam('utm_medium'),
        utm_campaign:  getParam('utm_campaign'),
      })
    });
  } catch {
    // Silently fail — never break UX for analytics
  }
}

// Returns a persistent session ID for this browser tab,
// creating and storing one in sessionStorage if needed.
function getOrCreateSessionId() {
  let id = sessionStorage.getItem('gg_session');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('gg_session', id);
  }
  return id;
}

// Infer device category from user agent string.
function getDeviceType() {
  const ua = navigator.userAgent;
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  if (/mobile|iphone|android/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Read a single URL query parameter by name.
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Log visit after page load
window.addEventListener('load', logVisit);

/* ── Shared helpers ── */

/**
 * Format a date string to human-readable format
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

/**
 * Format currency
 * @param {number} amount
 * @returns {string}
 */
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style:    'currency',
    currency: 'USD',
  }).format(amount);
}

/**
 * Debounce utility
 * @param {Function} fn
 * @param {number} delay
 */
function debounce(fn, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Sanitize user input to prevent XSS
 * @param {string} str
 * @returns {string}
 */
function sanitize(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Show an alert message inside a container
 * @param {HTMLElement} container
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showAlert(container, message, type = 'info') {
  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  container.innerHTML = '';
  container.appendChild(alert);
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Expose shared helpers globally (no ES modules required) */
window.GG = { formatDate, formatCurrency, debounce, sanitize, showAlert };
