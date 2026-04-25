/**
 * Generations Getaway LLC
 * Shared Utilities (main.js)
 * ==========================
 * Navigation, scroll reveal, scroll effects,
 * visitor logging, and shared helpers.
 * Runs on every page.
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
// Observe all .reveal elements and animate them into view
// when they enter the viewport, with a staggered delay per item.
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      setTimeout(
        () => entry.target.classList.add('visible'),
        i * 80
      );
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('.reveal').forEach(el => {
  revealObserver.observe(el);
});

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
export function formatDate(dateStr) {
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
export function formatCurrency(amount) {
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
export function debounce(fn, delay = 300) {
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
export function sanitize(str) {
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
export function showAlert(container, message, type = 'info') {
  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  container.innerHTML = '';
  container.appendChild(alert);
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
