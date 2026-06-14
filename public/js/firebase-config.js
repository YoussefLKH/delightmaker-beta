/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — FIREBASE CONFIG
   Client side Firebase initialization
   Included in every HTML page that needs Firebase
   ═══════════════════════════════════════════════════ */


// ── Firebase Configuration ─────────────────────────
// NOTE: It is safe and intentional for this client config to be public.
// Firebase Web API keys are NOT secrets — they identify the project.
// Per Google's own documentation, these values can be checked into source control.
// Security is enforced by Firestore Security Rules, not by hiding this config.
// See: https://firebase.google.com/docs/projects/api-keys
// The real secrets (Admin SDK private key, Stripe, etc.) are in .env — never committed.
const firebaseConfig = {
  apiKey:            "AIzaSyC2kz4cKLQfDSDhM7HhAtnrgsV-jqz18KQ",
  authDomain:        "delightmaker-40f30.firebaseapp.com",
  projectId:         "delightmaker-40f30",
  storageBucket:     "delightmaker-40f30.firebasestorage.app",
  messagingSenderId: "738876151566",
  appId:             "1:738876151566:web:ed7f1d4189457f919fa95f"
};


// ── Initialize Firebase ────────────────────────────
firebase.initializeApp(firebaseConfig);


// ── Firebase Services ──────────────────────────────
// These are available globally across all pages
const auth = firebase.auth();
const db   = firebase.firestore();


// ── Firestore Settings ─────────────────────────────
// Enable offline persistence
// Pages work even with spotty internet
db.enablePersistence()
  .catch((err) => {
    if (err.code === 'failed-precondition') {
      // Multiple tabs open
      // Persistence only works in one tab at a time
      console.warn(
        'Firebase persistence unavailable — ' +
        'multiple tabs open'
      );
    } else if (err.code === 'unimplemented') {
      // Browser does not support persistence
      console.warn(
        'Firebase persistence not supported ' +
        'in this browser'
      );
    }
  });


// ── Auth Helper Functions ──────────────────────────
// Used across all portal pages

/**
 * Get current logged in user
 * Returns null if not logged in
 */
function getCurrentUser() {
  return auth.currentUser;
}


/**
 * Get current user's role from Firebase token
 * Returns: 'admin' | 'company_user' | 'baker' | null
 */
async function getUserRole() {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const idTokenResult = await user.getIdTokenResult();
    return idTokenResult.claims.role || null;
  } catch (err) {
    console.error('Error getting user role:', err);
    return null;
  }
}


/**
 * Get current user's company ID
 * Only set for company_user role
 * Returns: companyId string or null
 */
async function getUserCompanyId() {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const idTokenResult = await user.getIdTokenResult();
    return idTokenResult.claims.companyId || null;
  } catch (err) {
    console.error('Error getting company ID:', err);
    return null;
  }
}


/**
 * Get current user's baker ID
 * Only set for baker role
 * Returns: bakerId string or null
 */
async function getUserBakerId() {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const idTokenResult = await user.getIdTokenResult();
    return idTokenResult.claims.bakerId || null;
  } catch (err) {
    console.error('Error getting baker ID:', err);
    return null;
  }
}


/**
 * Get current user's Firebase ID token
 * Used for authenticated API calls to our backend
 * Token auto-refreshes when expired
 */
async function getAuthToken() {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    return await user.getIdToken();
  } catch (err) {
    console.error('Error getting auth token:', err);
    return null;
  }
}


/**
 * Make authenticated API call to our backend
 * Automatically adds Firebase token to headers
 * Use this instead of fetch() for all API calls
 */
async function apiCall(endpoint, options = {}) {
  const token = await getAuthToken();

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(endpoint, {
    ...options,
    headers,
  });

  // If 401 — token expired or invalid
  // Sign out and redirect to login
  if (response.status === 401) {
    await auth.signOut();
    window.location.href = '/login';
    return null;
  }

  return response;
}


// ── Route Protection ───────────────────────────────
// Call this at the top of every protected page
// Checks user is logged in AND has the right role
// Redirects to login if not authenticated

/**
 * Protect a page — require specific role
 * Call at top of every portal page
 *
 * @param {string} requiredRole
 *   'admin' | 'company_user' | 'baker'
 *
 * Usage:
 *   requireAuth('admin');
 *   requireAuth('company_user');
 *   requireAuth('baker');
 */
function requireAuth(requiredRole) {
  return new Promise((resolve, reject) => {
    // Show loading state while checking auth
    document.body.style.opacity = '0';

    const unsubscribe = auth.onAuthStateChanged(
      async (user) => {
        unsubscribe(); // Stop listening after first check

        if (!user) {
          // Not logged in → redirect to login
          window.location.href = '/login';
          return;
        }

        try {
          const idTokenResult =
            await user.getIdTokenResult();
          const role = idTokenResult.claims.role;

          if (role !== requiredRole) {
            // Wrong role → redirect to their portal
            if (role === 'admin') {
              window.location.href =
                '/admin/dashboard';
            } else if (role === 'company_user') {
              window.location.href =
                '/company/dashboard';
            } else if (role === 'baker') {
              window.location.href =
                '/baker/dashboard';
            } else {
              window.location.href = '/login';
            }
            return;
          }

          // Correct role — show the page
          document.body.style.opacity = '1';

          // Return enriched user object with claims
          resolve({
            uid:       user.uid,
            email:     user.email,
            name:      user.displayName,
            role:      idTokenResult.claims.role,
            companyId: idTokenResult.claims.companyId || null,
            bakerId:   idTokenResult.claims.bakerId   || null,
          });

        } catch (err) {
          console.error('Auth check error:', err);
          window.location.href = '/login';
        }
      },
      (err) => {
        console.error('Auth state error:', err);
        window.location.href = '/login';
      }
    );
  });
}


// ── Logout Helper ──────────────────────────────────
/**
 * Sign out current user
 * Redirects to login page
 */
async function logout() {
  try {
    await auth.signOut();
    window.location.href = '/login';
  } catch (err) {
    console.error('Logout error:', err);
    window.location.href = '/login';
  }
}


// ── Date Helpers ───────────────────────────────────

/**
 * Format a date nicely
 * Input:  "1990-11-28" or Date object
 * Output: "November 28, 1990"
 */
function formatDate(date) {
  if (!date) return '—';
  const d = date.toDate
    ? date.toDate()
    : new Date(date);
  return d.toLocaleDateString('en-CA', {
    year:  'numeric',
    month: 'long',
    day:   'numeric',
  });
}


/**
 * Format date short
 * Output: "Nov 28"
 */
function formatDateShort(date) {
  if (!date) return '—';
  const d = date.toDate
    ? date.toDate()
    : new Date(date);
  return d.toLocaleDateString('en-CA', {
    month: 'short',
    day:   'numeric',
  });
}


/**
 * Days until a date
 * Returns number of days from today
 */
function daysUntil(date) {
  if (!date) return 0;
  const d = date.toDate
    ? date.toDate()
    : new Date(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const diff = d - today;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}


/**
 * Get next occurrence of a birthday/anniversary
 * Takes a stored date and returns next upcoming date
 */
function getNextOccurrence(storedDate) {
  const d = storedDate.toDate
    ? storedDate.toDate()
    : new Date(storedDate);

  const today = new Date();
  const next  = new Date(
    today.getFullYear(),
    d.getMonth(),
    d.getDate()
  );

  if (next < today) {
    next.setFullYear(today.getFullYear() + 1);
  }

  return next;
}


// ── Currency Helper ────────────────────────────────
/**
 * Format number as CAD currency
 * Input:  55
 * Output: "$55.00"
 */
function formatCurrency(amount) {
  if (amount === null || amount === undefined) {
    return '—';
  }
  return new Intl.NumberFormat('en-CA', {
    style:    'currency',
    currency: 'CAD',
  }).format(amount);
}


// ── Status Badge Helper ────────────────────────────
/**
 * Get display info for order status
 */
function getStatusBadge(status) {
  const statuses = {
    scheduled: {
      label: 'Scheduled',
      color: '#888888',
      bg:    '#F5F5F5',
      icon:  '📅',
    },
    pending_confirmation: {
      label: 'Awaiting Approval',
      color: '#E65100',
      bg:    '#FFF3E0',
      icon:  '⏳',
    },
    confirmed: {
      label: 'Confirmed',
      color: '#1565C0',
      bg:    '#E3F2FD',
      icon:  '✅',
    },
    routed: {
      label: 'Routed to Baker',
      color: '#6A1B9A',
      bg:    '#F3E5F5',
      icon:  '🧁',
    },
    in_preparation: {
      label: 'Being Prepared',
      color: '#00695C',
      bg:    '#E0F2F1',
      icon:  '👨‍🍳',
    },
    delivered: {
      label: 'Delivered',
      color: '#2E7D32',
      bg:    '#E8F5E9',
      icon:  '🎉',
    },
    cancelled: {
      label: 'Cancelled',
      color: '#C62828',
      bg:    '#FFEBEE',
      icon:  '❌',
    },
    exception: {
      label: 'Needs Attention',
      color: '#C62828',
      bg:    '#FFEBEE',
      icon:  '🚨',
    },
  };

  return statuses[status] || {
    label: status,
    color: '#888888',
    bg:    '#F5F5F5',
    icon:  '❓',
  };
}


/**
 * Render a status badge HTML string
 */
function renderStatusBadge(status) {
  const badge = getStatusBadge(status);
  return `
    <span style="
      display:       inline-flex;
      align-items:   center;
      gap:           5px;
      padding:       4px 12px;
      border-radius: 100px;
      font-size:     0.78rem;
      font-weight:   600;
      color:         ${badge.color};
      background:    ${badge.bg};
    ">
      ${badge.icon} ${badge.label}
    </span>
  `;
}


// ── Dietary Flag Helper ────────────────────────────
/**
 * Render dietary flags as colored pills
 */
function renderDietaryFlags(flags) {
  if (!flags || flags.length === 0) {
    return '<span style="color:#888;font-size:0.85rem">' +
           'None</span>';
  }

  const colors = {
    'allergen-free': { bg: '#E8F5E9', color: '#2E7D32' },
    'gluten-free':   { bg: '#FFF3E0', color: '#E65100' },
    'nut-free':      { bg: '#FFEBEE', color: '#C62828' },
    'vegan':         { bg: '#E8F5E9', color: '#2E7D32' },
  };

  return flags.map(flag => {
    const c = colors[flag.toLowerCase()] || {
      bg: '#F5F5F5', color: '#555'
    };
    return `
      <span style="
        display:       inline-block;
        padding:       3px 10px;
        border-radius: 100px;
        font-size:     0.75rem;
        font-weight:   600;
        color:         ${c.color};
        background:    ${c.bg};
        margin-right:  4px;
      ">
        ${flag}
      </span>
    `;
  }).join('');
}


// ── Toast Notifications ────────────────────────────
/**
 * Show a toast notification
 * @param {string} message
 * @param {string} type 'success' | 'error' | 'info'
 * @param {number} duration milliseconds
 */
function showToast(message, type = 'success',
                   duration = 3500) {
  const existing = document.getElementById('dm-toast');
  if (existing) existing.remove();

  const colors = {
    success: { bg: '#E8F5E9', color: '#2E7D32',
               border: '#C8E6C9', icon: '✅' },
    error:   { bg: '#FFEBEE', color: '#C62828',
               border: '#FFCDD2', icon: '❌' },
    info:    { bg: '#E3F2FD', color: '#1565C0',
               border: '#BBDEFB', icon: 'ℹ️' },
  };

  const c = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.id = 'dm-toast';
  toast.style.cssText = `
    position:      fixed;
    bottom:        24px;
    right:         24px;
    background:    ${c.bg};
    color:         ${c.color};
    border:        1px solid ${c.border};
    border-radius: 12px;
    padding:       14px 20px;
    font-size:     0.9rem;
    font-weight:   500;
    box-shadow:    0 8px 30px rgba(0,0,0,0.12);
    z-index:       9999;
    display:       flex;
    align-items:   center;
    gap:           10px;
    max-width:     360px;
    animation:     dmSlideUp 0.3s ease;
    font-family:   'Inter', sans-serif;
  `;

  toast.innerHTML = `
    <span>${c.icon}</span>
    <span>${message}</span>
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes dmSlideUp {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0);    }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity    = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}


/**
 * Full-screen success overlay with a countdown, then signs the user
 * out and sends them to /login. Used after sensitive account changes
 * (email / password) that require re-authentication.
 */
function dmCountdownToLogin(title, subtitle, seconds = 5) {
  // Remove any existing overlay
  const prev = document.getElementById('dm-countdown');
  if (prev) prev.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dm-countdown';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 100000;
    background: linear-gradient(160deg, #2C1A0E 0%, #1A1008 100%);
    color: #fff; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center;
    padding: 24px; font-family: 'Inter', sans-serif;
    animation: dmFadeIn 0.3s ease;
  `;
  overlay.innerHTML = `
    <div style="font-size:3rem;margin-bottom:16px">✅</div>
    <h1 style="font-size:1.8rem;margin:0 0 10px;font-weight:800">${title}</h1>
    <p style="font-size:1rem;color:rgba(255,255,255,0.7);margin:0 0 28px;max-width:420px;line-height:1.6">${subtitle}</p>
    <div style="font-size:0.85rem;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.1em;font-weight:700;margin-bottom:8px">Redirecting to login</div>
    <div id="dm-countdown-num" style="
      width:84px;height:84px;border-radius:50%;
      border:3px solid rgba(212,152,42,0.4);
      display:flex;align-items:center;justify-content:center;
      font-size:2.4rem;font-weight:800;color:#F0C98A;
    ">${seconds}</div>
  `;

  const styleId = 'dm-countdown-style';
  if (!document.getElementById(styleId)) {
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = `@keyframes dmFadeIn { from { opacity: 0; } to { opacity: 1; } }`;
    document.head.appendChild(st);
  }

  document.body.appendChild(overlay);

  let remaining = seconds;
  const numEl = overlay.querySelector('#dm-countdown-num');
  const tick = setInterval(() => {
    remaining -= 1;
    if (numEl) numEl.textContent = Math.max(0, remaining);
    if (remaining <= 0) {
      clearInterval(tick);
      auth.signOut().finally(() => {
        window.location.href = '/login';
      });
    }
  }, 1000);
}


// ── Loading Spinner ────────────────────────────────
/**
 * Show full page loading spinner
 */
function showLoading() {
  const existing = document.getElementById('dm-loading');
  if (existing) return;

  const loader = document.createElement('div');
  loader.id = 'dm-loading';
  loader.style.cssText = `
    position:        fixed;
    inset:           0;
    background:      rgba(255,250,245,0.85);
    display:         flex;
    align-items:     center;
    justify-content: center;
    z-index:         9998;
    backdrop-filter: blur(4px);
  `;
  loader.innerHTML = `
    <div style="text-align:center">
      <div style="
        font-size:   3rem;
        animation:   dmSpin 1s linear infinite;
        display:     inline-block;
      ">🧁</div>
      <p style="
        margin-top:  12px;
        color:       #888;
        font-family: 'Inter', sans-serif;
        font-size:   0.9rem;
      ">Loading...</p>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes dmSpin {
      from { transform: rotate(0deg);   }
      to   { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(loader);
}

function hideLoading() {
  const loader = document.getElementById('dm-loading');
  if (loader) loader.remove();
}


// ── Confirm Dialog ─────────────────────────────────
/**
 * Show a branded confirm dialog
 * Returns Promise<boolean>
 * Usage: const confirmed = await confirmDialog('Are you sure?')
 */
function confirmDialog(message, title = 'Confirm') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:        fixed;
      inset:           0;
      background:      rgba(0,0,0,0.5);
      display:         flex;
      align-items:     center;
      justify-content: center;
      z-index:         9999;
    `;

    overlay.innerHTML = `
      <div style="
        background:    white;
        border-radius: 20px;
        padding:       36px;
        max-width:     400px;
        width:         90%;
        text-align:    center;
        box-shadow:    0 20px 60px rgba(0,0,0,0.2);
        font-family:   'Inter', sans-serif;
      ">
        <div style="font-size:2.5rem;margin-bottom:12px">
          🧁
        </div>
        <h3 style="
          margin-bottom: 10px;
          font-size:     1.2rem;
          color:         #2D2D2D;
          font-family:   'Playfair Display', serif;
        ">${title}</h3>
        <p style="
          color:         #888;
          font-size:     0.95rem;
          margin-bottom: 28px;
          line-height:   1.5;
        ">${message}</p>
        <div style="
          display:         flex;
          gap:             12px;
          justify-content: center;
        ">
          <button id="confirmNo" style="
            padding:       12px 28px;
            border-radius: 100px;
            border:        2px solid #ddd;
            background:    white;
            color:         #555;
            font-weight:   600;
            cursor:        pointer;
            font-size:     0.9rem;
            font-family:   'Inter', sans-serif;
          ">Cancel</button>
          <button id="confirmYes" style="
            padding:       12px 28px;
            border-radius: 100px;
            border:        none;
            background:    #FF6B6B;
            color:         white;
            font-weight:   600;
            cursor:        pointer;
            font-size:     0.9rem;
            font-family:   'Inter', sans-serif;
          ">Confirm</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#confirmYes')
      .addEventListener('click', () => {
        overlay.remove();
        resolve(true);
      });

    overlay.querySelector('#confirmNo')
      .addEventListener('click', () => {
        overlay.remove();
        resolve(false);
      });
  });
}

/* ═══════════════════════════════════════════════════
   MOBILE SIDEBAR DRAWER — global close behavior
   Works on every dashboard that has a .sidebar +
   .mobile-menu-btn, regardless of how each page wires
   its hamburger toggle. Adds:
     • a tap-anywhere backdrop that closes the drawer
     • an ✕ close button inside the drawer (mobile only)
     • Escape key to close
     • auto-close when a nav link is tapped
   ═══════════════════════════════════════════════════ */
(function initSidebarDrawer() {
  // Inject a "Settings" nav item at the end of the sidebar nav,
  // alongside the other tabs, pointing to the correct portal page.
  function injectSettingsLink(sidebar) {
    const nav = sidebar.querySelector('.sidebar-nav');
    if (!nav) return;
    if (nav.querySelector('.dm-settings-link')) return;

    const path = window.location.pathname;
    let href = null;
    if (path.includes('/admin/'))        href = '/admin/settings';
    else if (path.includes('/company/')) href = '/company/settings';
    else if (path.includes('/baker/'))   href = '/baker/settings';
    if (!href) return;

    // Mark active when we're on the settings page itself
    const onSettings = path.endsWith('/settings') ||
                       path.endsWith('settings.html');

    // ── Admin gets a Support tab (with open-ticket badge) ──
    if (path.includes('/admin/') && !nav.querySelector('.dm-support-link')) {
      const onSupport = path.endsWith('/support') ||
                        path.endsWith('support.html');
      const support = document.createElement('a');
      support.href = '/admin/support';
      support.className = 'nav-item dm-support-link' + (onSupport ? ' active' : '');
      support.innerHTML =
        '<span class="nav-icon">🆘</span>' +
        '<span class="nav-label">Support</span>' +
        '<span class="nav-badge" id="dmSupportBadge" style="display:none">0</span>';
      nav.appendChild(support);

      // Fetch open-ticket count for the badge.
      // IMPORTANT: wait for Firebase auth to be ready and use a plain
      // fetch (NOT apiCall) — apiCall force-signs-out on a 401, and at
      // page load the auth token often isn't restored yet, which would
      // bounce the admin straight back to the login page.
      auth.onAuthStateChanged(async (user) => {
        if (!user) return;
        try {
          const token = await user.getIdToken();
          const res = await fetch('/api/support/open-count', {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (!res.ok) return;            // never sign out from a badge fetch
          const data = await res.json();
          if (data.openCount > 0) {
            const b = document.getElementById('dmSupportBadge');
            if (b) { b.textContent = data.openCount; b.style.display = ''; }
          }
        } catch (_) { /* badge is non-critical */ }
      });
    }

    const link = document.createElement('a');
    link.href = href;
    link.className = 'nav-item dm-settings-link' + (onSettings ? ' active' : '');
    link.innerHTML =
      '<span class="nav-icon">⚙️</span>' +
      '<span class="nav-label">Settings</span>';

    // Append as the last tab in the nav list (after Support for admin)
    nav.appendChild(link);
  }

  function setup() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return; // page has no sidebar

    injectSettingsLink(sidebar);

    // Inject styles (self-contained — no dependency on dashboard.css)
    if (!document.getElementById('dm-drawer-styles')) {
      const style = document.createElement('style');
      style.id = 'dm-drawer-styles';
      style.textContent = `
        .dm-sidebar-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(20,12,6,0.5);
          backdrop-filter: blur(1px);
          z-index: 199;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.25s ease;
        }
        .dm-sidebar-backdrop.show {
          opacity: 1;
          pointer-events: auto;
        }
        .dm-sidebar-close {
          display: none;
          position: absolute;
          top: 16px;
          right: 16px;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: none;
          background: rgba(255,255,255,0.12);
          color: #fff;
          font-size: 1.1rem;
          line-height: 1;
          cursor: pointer;
          z-index: 5;
          align-items: center;
          justify-content: center;
        }
        .dm-sidebar-close:hover {
          background: rgba(255,255,255,0.22);
        }
        @media (max-width: 768px) {
          .sidebar .dm-sidebar-close { display: inline-flex; }
        }
      `;
      document.head.appendChild(style);
    }

    // Backdrop element
    let backdrop = document.querySelector('.dm-sidebar-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'dm-sidebar-backdrop';
      document.body.appendChild(backdrop);
    }

    const closeDrawer = () => sidebar.classList.remove('sidebar-open');

    // Tap backdrop to close
    backdrop.addEventListener('click', closeDrawer);

    // Escape to close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeDrawer();
    });

    // ✕ close button inside the drawer
    if (!sidebar.querySelector('.dm-sidebar-close')) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dm-sidebar-close';
      closeBtn.setAttribute('aria-label', 'Close menu');
      closeBtn.innerHTML = '✕';
      closeBtn.addEventListener('click', closeDrawer);
      sidebar.appendChild(closeBtn);
    }

    // Sync backdrop visibility with the sidebar's open state,
    // however the page chooses to toggle it.
    const observer = new MutationObserver(() => {
      const open = sidebar.classList.contains('sidebar-open');
      backdrop.classList.toggle('show', open);
    });
    observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });

    // Close the drawer automatically when a nav link is tapped
    sidebar.querySelectorAll('.sidebar-nav a, .nav-item').forEach(link => {
      link.addEventListener('click', () => {
        if (window.innerWidth <= 768) closeDrawer();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();


/* ═══════════════════════════════════════════════════
   REPORT AN ISSUE — floating widget (company + baker)
   Bottom-LEFT so it never overlaps toasts (bottom-right).
   Injected globally; no per-page HTML needed.
   ═══════════════════════════════════════════════════ */
(function initReportIssue() {
  function setup() {
    const path = window.location.pathname;
    // Only on company + baker portals (not admin, login, or landing)
    if (!path.includes('/company/') && !path.includes('/baker/')) return;
    if (document.getElementById('dm-report-btn')) return;

    // Styles
    const style = document.createElement('style');
    style.textContent = `
      #dm-report-btn {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        width: 100%; margin: 0 0 12px;
        background: rgba(212,152,42,0.14);
        color: #F0C98A; border: 1px solid rgba(212,152,42,0.25);
        padding: 11px 14px; border-radius: 10px;
        font-family: inherit; font-size: 0.86rem; font-weight: 700;
        cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      #dm-report-btn:hover {
        background: rgba(212,152,42,0.22); color: #FFE0B0;
        border-color: rgba(212,152,42,0.45);
      }
      #dm-report-overlay {
        position: fixed; inset: 0; background: rgba(20,12,6,0.5);
        backdrop-filter: blur(2px); z-index: 10000;
        display: none; align-items: center; justify-content: center; padding: 20px;
      }
      #dm-report-overlay.show { display: flex; }
      .dm-report-card {
        background: #fff; border-radius: 18px; width: 100%; max-width: 480px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.25); overflow: hidden;
        font-family: inherit; animation: dmSlideUp 0.25s ease;
      }
      .dm-report-head {
        background: #C4621D; color: #fff; padding: 18px 22px;
        display: flex; align-items: center; justify-content: space-between;
      }
      .dm-report-head h3 { margin: 0; font-size: 1.1rem; font-weight: 700; }
      .dm-report-x { background: rgba(255,255,255,0.18); border: none; color: #fff;
        width: 30px; height: 30px; border-radius: 50%; cursor: pointer; font-size: 1rem; }
      .dm-report-body { padding: 22px; }
      .dm-report-body label { display: block; font-size: 0.8rem; font-weight: 700; color: #4A3020; margin: 0 0 6px; }
      .dm-report-body .fg { margin-bottom: 16px; }
      .dm-report-body select, .dm-report-body input, .dm-report-body textarea {
        width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 0.92rem;
        border: 1.5px solid #E8DDD0; border-radius: 10px; font-family: inherit;
        color: #1A1008; background: #fff;
      }
      .dm-report-body select:focus, .dm-report-body input:focus, .dm-report-body textarea:focus {
        outline: none; border-color: #C4621D;
      }
      .dm-report-body textarea { resize: vertical; min-height: 90px; }
      .dm-report-foot { padding: 0 22px 22px; display: flex; gap: 10px; justify-content: flex-end; }
      .dm-report-foot button { padding: 10px 20px; border-radius: 100px; font-family: inherit; font-weight: 700; font-size: 0.9rem; cursor: pointer; border: none; }
      .dm-report-cancel { background: #F3ECE3; color: #6B5444; }
      .dm-report-submit { background: #C4621D; color: #fff; }
      .dm-report-err { display: none; color: #C62828; font-size: 0.82rem; font-weight: 600; margin-top: -6px; margin-bottom: 12px; }
      .dm-report-err.show { display: block; }
      @keyframes dmSlideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    `;
    document.head.appendChild(style);

    // Button — placed in the sidebar footer, just above the user block.
    const btn = document.createElement('button');
    btn.id = 'dm-report-btn';
    btn.innerHTML = '<span>💬</span><span>Report an Issue</span>';

    const footer = document.querySelector('.sidebar-footer');
    const userBlock = footer && footer.querySelector('.sidebar-user');
    if (footer && userBlock) {
      footer.insertBefore(btn, userBlock);   // above the name/avatar
    } else if (footer) {
      footer.insertBefore(btn, footer.firstChild);
    } else {
      // No sidebar on this page — fall back to a subtle fixed button
      btn.style.cssText += 'position:fixed;bottom:24px;left:24px;width:auto;z-index:9998;';
      document.body.appendChild(btn);
    }

    // Modal
    const overlay = document.createElement('div');
    overlay.id = 'dm-report-overlay';
    overlay.innerHTML = `
      <div class="dm-report-card" role="dialog" aria-modal="true">
        <div class="dm-report-head">
          <h3>💬 Report an Issue</h3>
          <button class="dm-report-x" aria-label="Close">✕</button>
        </div>
        <div class="dm-report-body">
          <div class="fg">
            <label>Category</label>
            <select id="dm-report-cat">
              <option>Bug</option>
              <option>Billing</option>
              <option>Delivery problem</option>
              <option>Feature request</option>
              <option selected>Other</option>
            </select>
          </div>
          <div class="fg">
            <label>Subject</label>
            <input id="dm-report-subj" type="text" maxlength="120" placeholder="Short summary of the issue"/>
          </div>
          <div class="fg">
            <label>Description</label>
            <textarea id="dm-report-desc" maxlength="2000" placeholder="What happened? Steps to reproduce, what you expected, anything that helps us fix it."></textarea>
          </div>
          <p class="dm-report-err" id="dm-report-err"></p>
        </div>
        <div class="dm-report-foot">
          <button class="dm-report-cancel" type="button">Cancel</button>
          <button class="dm-report-submit" type="button">Send Report →</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const open  = () => { overlay.classList.add('show'); };
    const close = () => {
      overlay.classList.remove('show');
      document.getElementById('dm-report-subj').value = '';
      document.getElementById('dm-report-desc').value = '';
      document.getElementById('dm-report-err').classList.remove('show');
    };

    btn.addEventListener('click', open);
    overlay.querySelector('.dm-report-x').addEventListener('click', close);
    overlay.querySelector('.dm-report-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const submitBtn = overlay.querySelector('.dm-report-submit');
    submitBtn.addEventListener('click', async () => {
      const category    = document.getElementById('dm-report-cat').value;
      const subject     = document.getElementById('dm-report-subj').value.trim();
      const description = document.getElementById('dm-report-desc').value.trim();
      const err         = document.getElementById('dm-report-err');
      err.classList.remove('show');

      if (subject.length < 3) { err.textContent = 'Please add a short subject.'; err.classList.add('show'); return; }
      if (description.length < 10) { err.textContent = 'Please describe the issue (a little more detail).'; err.classList.add('show'); return; }

      submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
      try {
        const res = await apiCall('/api/support/tickets', {
          method: 'POST',
          body: JSON.stringify({
            category, subject, description,
            page: window.location.pathname,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send');
        close();
        if (typeof showToast === 'function') {
          showToast(`✅ Report sent! Ref ${data.ref}`, 'success', 5000);
        }
      } catch (e) {
        err.textContent = e.message || 'Something went wrong.';
        err.classList.add('show');
      } finally {
        submitBtn.disabled = false; submitBtn.textContent = 'Send Report →';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();


console.log('🧁 Delightmaker Firebase initialized');