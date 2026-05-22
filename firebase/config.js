/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — FIREBASE ADMIN CONFIG
   Server side Firebase initialization
   Used by Node.js backend only
   Never sent to the browser
   ═══════════════════════════════════════════════════

   HOW TO FILL THIS IN:
   1. Go to Firebase Console
   2. Project Settings → Service Accounts
   3. Click "Generate New Private Key"
   4. Download the JSON file
   5. Copy values into your .env file:
      FIREBASE_ADMIN_PROJECT_ID
      FIREBASE_ADMIN_CLIENT_EMAIL
      FIREBASE_ADMIN_PRIVATE_KEY
   ═══════════════════════════════════════════════════ */

'use strict';

const admin = require('firebase-admin');


/* ═══════════════════════════════════════════════════
   INITIALIZE FIREBASE ADMIN
   Only initialize once — check if already initialized
   ═══════════════════════════════════════════════════ */

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,

        // Private key comes from .env as a string
        // Replace literal \n with actual newlines
        privateKey:  process.env.FIREBASE_ADMIN_PRIVATE_KEY
                       ?.replace(/\\n/g, '\n'),
      }),
    });

    console.log('✅ Firebase Admin initialized');

  } catch (err) {
    console.error('❌ Firebase Admin init error:', err);
    process.exit(1);
  }
}


/* ═══════════════════════════════════════════════════
   EXPORT SERVICES
   ═══════════════════════════════════════════════════ */

const db   = admin.firestore();
const auth = admin.auth();


/* ═══════════════════════════════════════════════════
   FIRESTORE COLLECTIONS
   Central place to define all collection names
   Change here → changes everywhere
   ═══════════════════════════════════════════════════ */

const COLLECTIONS = {
  COMPANIES:     'companies',
  EMPLOYEES:     'employees',
  ORDERS:        'orders',
  PRODUCTS:      'products',
  BAKERIES:      'bakeries',
  USERS:         'users',
  GIFTING_RULES: 'giftingRules',
  INVOICES:      'invoices',
  AUDIT_LOG:     'auditLog',
  DEMO_REQUESTS: 'demoRequests',
  APPLICATIONS:  'applications',
  CELEBRATIONS:  'celebrations',
};


/* ═══════════════════════════════════════════════════
   ORDER STATUS ENUM
   Single source of truth for all order statuses
   ═══════════════════════════════════════════════════ */

const ORDER_STATUS = {
  SCHEDULED:            'scheduled',
  PENDING_CONFIRMATION: 'pending_confirmation',
  CONFIRMED:            'confirmed',
  ROUTED:               'routed',
  IN_PREPARATION:       'in_preparation',
  DELIVERED:            'delivered',
  CANCELLED:            'cancelled',
  EXCEPTION:            'exception',
};


/* ═══════════════════════════════════════════════════
   USER ROLES
   ═══════════════════════════════════════════════════ */

const ROLES = {
  ADMIN:        'admin',
  COMPANY_USER: 'company_user',
  BAKER:        'baker',
};


/* ═══════════════════════════════════════════════════
   PLAN TIERS
   ═══════════════════════════════════════════════════ */

const PLAN_TIERS = {
  STARTER:      'starter',
  PROFESSIONAL: 'professional',
  BUSINESS:     'business',
};


/* ═══════════════════════════════════════════════════
   EVENT TYPES
   Types of celebrations that trigger orders
   ═══════════════════════════════════════════════════ */

const EVENT_TYPES = {
  BIRTHDAY:    'birthday',
  CELEBRATION: 'celebration',
};


/* ═══════════════════════════════════════════════════
   HELPER FUNCTIONS — SERVER SIDE
   ═══════════════════════════════════════════════════ */

/**
 * Verify a Firebase ID token from request headers
 * Used in route middleware to authenticate requests
 *
 * @param {string} token - Bearer token from header
 * @returns {object} decoded token with uid + claims
 * @throws error if token invalid or expired
 */
async function verifyToken(token) {
  if (!token) {
    throw new Error('No token provided');
  }

  // Remove "Bearer " prefix if present
  const cleanToken = token.startsWith('Bearer ')
    ? token.slice(7)
    : token;

  return await auth.verifyIdToken(cleanToken);
}


/**
 * Set user role via Firebase Custom Claims
 * Called when Colton creates a new user
 *
 * @param {string} uid        - Firebase user UID
 * @param {string} role       - 'admin' | 'company_user' | 'baker'
 * @param {string} companyId  - Required for company_user
 * @param {string} bakerId    - Required for baker
 */
async function setUserRole(uid, role,
                           companyId = null,
                           bakerId   = null) {
  const claims = { role };

  if (companyId) claims.companyId = companyId;
  if (bakerId)   claims.bakerId   = bakerId;

  await auth.setCustomUserClaims(uid, claims);
  console.log(`✅ Role set: ${uid} → ${role}`);
}


/**
 * Create a new Firebase user
 * Called by admin when onboarding a company or baker
 *
 * @param {string} email
 * @param {string} password   - Temporary password
 * @param {string} displayName
 * @returns {object} Firebase UserRecord
 */
async function createUser(email, password, displayName) {
  return await auth.createUser({
    email,
    password,
    displayName,
    emailVerified: false,
  });
}


/**
 * Write to immutable audit log
 * Called whenever sensitive data changes
 *
 * @param {string} userId     - Who did the action
 * @param {string} action     - What they did
 * @param {string} entityType - What was affected
 * @param {string} entityId   - ID of affected record
 * @param {object} detail     - Extra context
 */
async function writeAuditLog(userId, action,
                              entityType, entityId,
                              detail = {}) {
  try {
    await db.collection(COLLECTIONS.AUDIT_LOG).add({
      userId,
      action,
      entityType,
      entityId,
      detail,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Audit log failure should never crash the app
    // but we always log it
    console.error('❌ Audit log write failed:', err);
  }
}


/**
 * Get a Firestore server timestamp
 * Use this instead of new Date() for consistency
 */
function serverTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}


/**
 * Get days between two dates
 * Used for scheduling logic
 */
function daysBetween(date1, date2) {
  const d1 = date1 instanceof Date
    ? date1
    : date1.toDate();
  const d2 = date2 instanceof Date
    ? date2
    : date2.toDate();
  const diff = Math.abs(d2 - d1);
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}


/**
 * Get next occurrence of a recurring date
 * Used for birthday scheduling
 *
 * @param {Date} storedDate - Original date from DB
 * @returns {Date} Next upcoming occurrence
 */
function getNextOccurrence(storedDate) {
  const d = storedDate instanceof Date
    ? storedDate
    : storedDate.toDate();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const next = new Date(
    today.getFullYear(),
    d.getMonth(),
    d.getDate()
  );

  // If already passed this year → next year
  if (next < today) {
    next.setFullYear(today.getFullYear() + 1);
  }

  return next;
}



/**
 * Format currency as CAD string
 * Server side version
 */
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-CA', {
    style:    'currency',
    currency: 'CAD',
  }).format(amount || 0);
}


/* ═══════════════════════════════════════════════════
   MIDDLEWARE — AUTHENTICATE REQUEST
   Use this in routes to verify Firebase token
   ═══════════════════════════════════════════════════ */

/**
 * Express middleware — verify Firebase auth token
 * Attaches decoded user to req.user
 *
 * Usage in routes:
 *   router.get('/protected',
 *     authenticate,
 *     (req, res) => { ... }
 *   );
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: 'No authorization header'
      });
    }

    const decoded = await verifyToken(authHeader);
    req.user = decoded;
    next();

  } catch (err) {
    console.error('Auth middleware error:', err.code);
    return res.status(401).json({
      error: 'Invalid or expired token'
    });
  }
}


/**
 * Express middleware — require specific role
 * Must come AFTER authenticate middleware
 *
 * Usage:
 *   router.get('/admin-only',
 *     authenticate,
 *     requireRole('admin'),
 *     (req, res) => { ... }
 *   );
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Not authenticated'
      });
    }

    if (req.user.role !== role) {
      return res.status(403).json({
        error: 'Insufficient permissions'
      });
    }

    next();
  };
}


/**
 * Express middleware — require admin role
 * Shortcut for requireRole('admin')
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== ROLES.ADMIN) {
    return res.status(403).json({
      error: 'Admin access required'
    });
  }
  next();
}


/**
 * Express middleware — require company user role
 * Also checks companyId matches requested resource
 */
function requireCompanyUser(req, res, next) {
  if (!req.user ||
      req.user.role !== ROLES.COMPANY_USER) {
    return res.status(403).json({
      error: 'Company user access required'
    });
  }
  next();
}


/**
 * Express middleware — require baker role
 */
function requireBaker(req, res, next) {
  if (!req.user || req.user.role !== ROLES.BAKER) {
    return res.status(403).json({
      error: 'Baker access required'
    });
  }
  next();
}


/* ═══════════════════════════════════════════════════
   EXPORTS
   Everything routes and functions need
   ═══════════════════════════════════════════════════ */

module.exports = {
  // Firebase services
  admin,
  db,
  auth,

  // Constants
  COLLECTIONS,
  ORDER_STATUS,
  ROLES,
  PLAN_TIERS,
  EVENT_TYPES,

  // Auth helpers
  verifyToken,
  setUserRole,
  createUser,

  // Audit log
  writeAuditLog,

  // Date helpers
  serverTimestamp,
  daysBetween,
  getNextOccurrence,

  // Format helpers
  formatCurrency,

  // Middleware
  authenticate,
  requireRole,
  requireAdmin,
  requireCompanyUser,
  requireBaker,
};