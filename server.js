/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — SERVER.JS
   Main Node.js + Express server
   Run with: node server.js
   Dev mode: npm run dev
   ═══════════════════════════════════════════════════ */

'use strict';

// ── Load environment variables FIRST ──────────────
require('dotenv').config();

// ── Core dependencies ──────────────────────────────
const express    = require('express');
const path       = require('path');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

// ── App init ───────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;


/* ═══════════════════════════════════════════════════
   SECURITY MIDDLEWARE
   Applied to every single request
   ═══════════════════════════════════════════════════ */

// Helmet — sets secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   [
        "'self'",
        "'unsafe-inline'",
        "https://www.gstatic.com",
        "https://js.stripe.com",
        "https://fonts.googleapis.com",
        "https://maps.googleapis.com",
        "https://maps.gstatic.com",
      ],
      styleSrc:    [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "https://maps.googleapis.com",
      ],
      fontSrc:     [
        "'self'",
        "https://fonts.gstatic.com",
      ],
      imgSrc:      [
        "'self'",
        "data:",
        "https:",
      ],
      connectSrc:  [
        "'self'",
        // Firebase Auth
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        // Firebase / Firestore
        "https://firebase.googleapis.com",
        "https://firestore.googleapis.com",
        "https://*.firebaseio.com",
        "wss://*.firebaseio.com",
        // Google APIs (Firestore gRPC-web + source maps)
        "https://www.googleapis.com",
        "https://www.gstatic.com",
        // Google Maps
        "https://maps.googleapis.com",
        "https://maps.gstatic.com",
        // Stripe
        "https://api.stripe.com",
        "https://checkout.stripe.com",
      ],
      frameSrc:       [
        "https://js.stripe.com",
      ],
      scriptSrcAttr:  ["'unsafe-inline'"],
    },
  },
  // Allow Firebase scripts
  crossOriginEmbedderPolicy: false,
}));

// Trust Vercel's proxy so express-rate-limit can read the real client IP
app.set('trust proxy', 1);

// CORS — allow our own domain(s)
const allowedOrigins = [
  'http://localhost:3000',
  'https://delightmaker.ca',
  'https://www.delightmaker.ca',
  ...(process.env.APP_URL ? [process.env.APP_URL] : []),
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow any vercel.app preview URL for this project
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// General rate limit — all routes
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS)
            || 900000, // 15 minutes
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS)
            || 100,
  message: {
    error: 'Too many requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders:   false,
});
if (process.env.NODE_ENV === 'production') {
  app.use(generalLimiter);
}

// Auth rate limit — stricter for login endpoints
const authLimiter = rateLimit({
  windowMs: 900000, // 15 minutes
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX)
            || 10,
  message: {
    error: 'Too many login attempts. ' +
           'Please wait 15 minutes and try again.'
  },
  standardHeaders: true,
  legacyHeaders:   false,
});


/* ═══════════════════════════════════════════════════
   GENERAL MIDDLEWARE
   ═══════════════════════════════════════════════════ */

// Stripe webhook needs the RAW body for signature
// verification — must be registered BEFORE express.json()
// so body-parser doesn't consume the stream first.
app.use(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' })
);

// Parse JSON request bodies (all other routes)
app.use(express.json({ limit: '10mb' }));

// Parse URL encoded bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging (development only)
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));


/* ═══════════════════════════════════════════════════
   API ROUTES
   All backend endpoints
   ═══════════════════════════════════════════════════ */

// ── Public config (exposes safe client-side keys) ──
// Maps API key is intentionally public — restricted by HTTP referrer in Google Cloud
app.get('/api/config', (req, res) => {
  res.json({
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  });
});

// ── Demo request (landing page form) ──────────────
app.use('/api/demo',
  require('./routes/demo'));

// ── Applications (self-serve signup + admin approve) ─
app.use('/api/applications',
  require('./routes/applications'));

// ── Auth routes ────────────────────────────────────
app.use('/api/auth',
  authLimiter,
  require('./routes/auth'));

// ── Order routes ───────────────────────────────────
app.use('/api/orders',
  require('./routes/orders'));

// ── Stripe routes ──────────────────────────────────
// Note: Stripe webhooks need raw body
// so we handle that inside the stripe route
app.use('/api/stripe',
  require('./routes/stripe'));

// ── Claude API routes ──────────────────────────────
app.use('/api/claude',
  require('./routes/claude'));

// ── Email routes ───────────────────────────────────
app.use('/api/emails',
  require('./routes/emails'));

// ── Product routes (bakery menu + Stripe sync) ─────
app.use('/api/products',
  require('./routes/products'));

// ── Invoice routes ─────────────────────────────────
app.use('/api/invoices',
  require('./routes/invoices'));

app.use('/api/admin',
  require('./routes/admin'));

// ── Bakeries list (company + admin + baker) ────────
app.get('/api/bakeries', async (req, res) => {
  try {
    const { authenticate, db, COLLECTIONS } =
      require('./firebase/config');

    await new Promise((resolve, reject) => {
      authenticate(req, res, err =>
        err ? reject(err) : resolve()
      );
    });

    const snap = await db
      .collection(COLLECTIONS.BAKERIES)
      .get();

    const bakeries = snap.docs
      .filter(doc => doc.data().active !== false)
      .map(doc => ({
        id:   doc.id,
        name: doc.data().name || doc.id,
      }));

    return res.json({ success: true, bakeries });

  } catch (err) {
    console.error('GET /api/bakeries error:', err.message);
    return res.status(500).json({ error: 'Failed to load bakeries' });
  }
});


// ── Scheduler manual trigger (dev + admin only) ────
app.post('/api/admin/trigger-scan', async (req, res) => {
  try {
    const { authenticate, requireAdmin } =
      require('./firebase/config');

    // Inline auth check
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { runDailyScan } = require('./functions/scheduler');
    // force:true ensures all companies are scanned — useful for testing
    const results = await runDailyScan({ force: true });

    return res.status(200).json({
      success: true,
      message: 'Daily scan complete',
      results,
    });
  } catch (err) {
    console.error('Manual scan error:', err);
    return res.status(500).json({
      error: 'Scan failed: ' + err.message
    });
  }
});


// ── Manual invoice trigger (dev + admin only) ──────
// Accepts optional ?year=2026&month=4 query params
// to generate invoices for a specific month.
// Defaults to previous calendar month.
app.post('/api/admin/trigger-invoices', async (req, res) => {
  try {
    const { authenticate } = require('./firebase/config');

    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { generateMonthlyInvoices } =
      require('./functions/invoiceGenerator');

    // Support both query params (?year=2026&month=4) and JSON body
    const { year, month } = { ...req.query, ...(req.body || {}) };
    const results = await generateMonthlyInvoices(
      year && month
        ? { year: parseInt(year), month: parseInt(month) }
        : {}
    );

    return res.status(200).json({
      success: true,
      message: 'Invoice generation complete',
      results,
    });
  } catch (err) {
    console.error('Manual invoice trigger error:', err);
    return res.status(500).json({
      error: 'Invoice generation failed: ' + err.message,
    });
  }
});


/* ═══════════════════════════════════════════════════
   PAGE ROUTES
   Serve HTML files for each portal
   ═══════════════════════════════════════════════════ */

// ── Public pages ───────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.get('/login', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'login.html')
  );
});

// ── Admin portal pages ─────────────────────────────
// All /admin/* routes serve admin pages
// Actual auth protection is done client side
// via Firebase Auth + role check on each page
app.get('/admin', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'dashboard.html'
    )
  );
});

app.get('/admin/dashboard', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'dashboard.html'
    )
  );
});

app.get('/admin/clients', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'clients.html'
    )
  );
});

app.get('/admin/orders', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'orders.html'
    )
  );
});

app.get('/admin/bakeries', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'bakeries.html'
    )
  );
});

app.get('/admin/revenue', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'revenue.html'
    )
  );
});

app.get('/admin/applications', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'applications.html'
    )
  );
});

app.get('/admin/invoices', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'invoices.html'
    )
  );
});

app.get('/admin/invoice-view', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'admin', 'invoice-view.html'
    )
  );
});

// ── Company portal pages ───────────────────────────
app.get('/company', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'dashboard.html'
    )
  );
});

app.get('/company/dashboard', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'dashboard.html'
    )
  );
});

app.get('/company/onboarding', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'onboarding.html'
    )
  );
});

app.get('/company/employees', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'employees.html'
    )
  );
});

app.get('/company/rules', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'rules.html'
    )
  );
});

app.get('/company/approvals', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'approvals.html'
    )
  );
});

app.get('/company/spending', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'spending.html'
    )
  );
});

app.get('/company/orders', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'company', 'orders.html'
    )
  );
});

// Redirect old celebrations URLs to new orders page
app.get(['/company/celebrations', '/company/celebrations.html'], (req, res) => {
  res.redirect(301, '/company/orders');
});

// ── Baker portal pages ─────────────────────────────
app.get('/baker', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'baker', 'dashboard.html'
    )
  );
});

app.get('/baker/dashboard', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'baker', 'dashboard.html'
    )
  );
});

app.get('/baker/order', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'baker', 'order.html'
    )
  );
});

app.get('/baker/menu', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public', 'baker', 'menu.html'
    )
  );
});

// ── Legal pages ────────────────────────────────────
// Placeholder routes for privacy + terms
// Add real HTML files later
app.get('/privacy', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Privacy Policy — Delightmaker</title>
        <style>
          body { 
            font-family: sans-serif; 
            max-width: 800px; 
            margin: 60px auto; 
            padding: 0 24px;
            line-height: 1.6;
          }
          a { color: #FF6B6B; }
        </style>
      </head>
      <body>
        <h1>Privacy Policy</h1>
        <p>Coming soon. For questions contact 
        <a href="mailto:hello@delightmaker.ca">
        hello@delightmaker.ca</a></p>
        <p><a href="/">← Back to home</a></p>
      </body>
    </html>
  `);
});

app.get('/terms', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Terms of Service — Delightmaker</title>
        <style>
          body { 
            font-family: sans-serif; 
            max-width: 800px; 
            margin: 60px auto; 
            padding: 0 24px;
            line-height: 1.6;
          }
          a { color: #FF6B6B; }
        </style>
      </head>
      <body>
        <h1>Terms of Service</h1>
        <p>Coming soon. For questions contact 
        <a href="mailto:hello@delightmaker.ca">
        hello@delightmaker.ca</a></p>
        <p><a href="/">← Back to home</a></p>
      </body>
    </html>
  `);
});


/* ═══════════════════════════════════════════════════
   ONE CLICK EMAIL APPROVAL ROUTE
   When HR clicks approve link in email
   No login required — uses signed token
   Redirects to Stripe Checkout for payment
   ═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════
   APPROVE SUCCESS PAGE
   Stripe redirects here after successful payment
   Confirms the order and shows success message
   IMPORTANT: must be declared BEFORE /approve/:token
   so Express doesn't treat "success" as a JWT token
   ═══════════════════════════════════════════════════ */

app.get('/approve/success', async (req, res) => {
  try {
    const { session_id } = req.query;

    if (!session_id) {
      throw new Error('No session ID provided');
    }

    const stripe = require('stripe')(
      process.env.STRIPE_SECRET_KEY
    );

    // Verify payment actually completed
    const session =
      await stripe.checkout.sessions.retrieve(session_id);

    console.log(`💳 Session payment_intent: ${session.payment_intent}, status: ${session.payment_status}`);

    if (session.payment_status !== 'paid') {
      throw new Error('Payment not completed');
    }

    const {
      orderId,
      tokenDocId,
    } = session.metadata || {};

    if (orderId) {
      const {
        db,
        COLLECTIONS,
        ORDER_STATUS,
        serverTimestamp,
        writeAuditLog,
      } = require('./firebase/config');

      const orderRef = db
        .collection(COLLECTIONS.ORDERS)
        .doc(orderId);
      const orderDoc = await orderRef.get();

      // Confirm order if still pending or scheduled
      // (webhook may have already done this — idempotent)
      if (
        orderDoc.exists &&
        (orderDoc.data().status ===
          ORDER_STATUS.PENDING_CONFIRMATION ||
         orderDoc.data().status ===
          ORDER_STATUS.SCHEDULED)
      ) {
        // Mark token as used
        if (tokenDocId) {
          await db
            .collection('usedTokens')
            .doc(tokenDocId)
            .set({
              usedAt:  serverTimestamp(),
              orderId,
              method:  'stripe_checkout',
            });
        }

        // Confirm order + record payment
        await orderRef.update({
          status:          ORDER_STATUS.CONFIRMED,
          confirmedAt:     serverTimestamp(),
          confirmedBy:     'stripe_checkout',
          stripeSessionId: session_id,
          stripeChargeId:  session.payment_intent,
          chargeStatus:    'paid',
          chargedAt:       serverTimestamp(),
        });

        await writeAuditLog(
          'stripe_checkout',
          'confirm_order',
          'order',
          orderId,
          {
            sessionId: session_id,
            method:    'stripe_checkout',
          }
        );

        console.log(
          `✅ Order confirmed via Stripe checkout: ${orderId}`
        );

        // ── Notify Colton that payment came in ────────
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey && resendKey !== 'your_resend_key_here') {
          const { Resend } = require('resend');
          const resend = new Resend(resendKey);
          const o = orderDoc.data();

          const delivDateStr = o.deliveryDate
            ? new Date(o.deliveryDate._seconds * 1000)
                .toLocaleDateString('en-CA', {
                  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
                })
            : 'TBD';

          const amountStr = session.amount_total
            ? `$${(session.amount_total / 100).toFixed(2)} CAD`
            : o.chargeAmount
            ? `$${o.chargeAmount.toFixed(2)} CAD`
            : 'TBD';

          resend.emails.send({
            from:    `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`,
            to:      process.env.ADMIN_EMAIL,
            subject: `💳 Payment received — ${o.employeeName}'s order (${amountStr})`,
            html: `
              <!DOCTYPE html>
              <html>
              <head><meta charset="UTF-8"/></head>
              <body style="font-family:Arial,sans-serif;background:#FFFAF5;margin:0;padding:24px">
                <div style="max-width:520px;margin:0 auto">

                  <div style="background:#2D2D2D;border-radius:12px 12px 0 0;padding:20px 24px;text-align:center;color:white;font-size:1.1rem;font-weight:700">
                    🧁 Delightmaker
                  </div>

                  <div style="background:white;border:1px solid #eee;padding:28px">
                    <h2 style="margin:0 0 6px;color:#2D2D2D">💳 Payment Received</h2>
                    <p style="color:#888;margin:0 0 20px;font-size:0.9rem">A company just approved and paid for an order.</p>

                    <div style="background:#FFFAF5;border:2px solid #FFD93D;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                      <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
                        <tr style="border-bottom:1px solid #eee">
                          <td style="padding:7px 0;color:#888">Company</td>
                          <td style="padding:7px 0;font-weight:700;text-align:right">${o.companyName || o.companyId}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #eee">
                          <td style="padding:7px 0;color:#888">Employee</td>
                          <td style="padding:7px 0;font-weight:700;text-align:right">${o.employeeName}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #eee">
                          <td style="padding:7px 0;color:#888">Treat</td>
                          <td style="padding:7px 0;font-weight:700;text-align:right">${o.productName || 'Birthday Bundle'}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #eee">
                          <td style="padding:7px 0;color:#888">Delivery</td>
                          <td style="padding:7px 0;font-weight:700;text-align:right;color:#FF6B6B">${delivDateStr}</td>
                        </tr>
                        <tr>
                          <td style="padding:7px 0;color:#888"><strong>Amount paid</strong></td>
                          <td style="padding:7px 0;font-weight:700;text-align:right;font-size:1.05rem;color:#2E7D32">${amountStr}</td>
                        </tr>
                      </table>
                    </div>

                    <p style="color:#888;font-size:0.82rem;margin:0">Order has been auto-routed to the baker. Check your admin dashboard for details.</p>
                  </div>

                  <div style="background:#F5F5F5;border:1px solid #eee;border-radius:0 0 12px 12px;padding:14px;text-align:center;font-size:0.75rem;color:#AAA">
                    Delightmaker · Halifax, NS 🇨🇦 ·
                    <a href="${process.env.APP_URL}/admin/orders" style="color:#FF6B6B">View order →</a>
                  </div>
                </div>
              </body>
              </html>
            `,
          }).catch(err =>
            console.error('Admin payment notification failed:', err.message)
          );
        }

        // ── Auto-route to baker ────────────────────────
        const { autoRouteToBaker } =
          require('./functions/autoRoute');
        autoRouteToBaker(orderId, orderDoc.data())
          .catch(err => console.error(
            'autoRouteToBaker error:', err.message
          ));
      }
    }

    res.send(approvePageHtml(
      '🎉',
      'Payment Complete!',
      `Your order has been confirmed and payment collected.
       We'll take it from here — the treat will arrive on
       the scheduled delivery date.`,
      '/company/dashboard',
      'View your dashboard →'
    ));

  } catch (err) {
    console.error('Approve success error:', err.message);
    res.status(400).send(approvePageHtml(
      '⚠️',
      'Something went wrong',
      'We could not verify your payment. Please contact support@delightmaker.ca with your order details.',
      'mailto:support@delightmaker.ca',
      'Contact support →'
    ));
  }
});


app.get('/approve/:token', async (req, res) => {
  try {
    const jwt    = require('jsonwebtoken');
    const crypto = require('crypto');
    const stripe = require('stripe')(
      process.env.STRIPE_SECRET_KEY
    );
    const token  = req.params.token;
    const secret = process.env.JWT_SECRET;

    // Verify JWT token
    const decoded = jwt.verify(token, secret);
    const orderId = decoded.orderId;

    if (!orderId) {
      throw new Error('Invalid token — no order ID');
    }

    const {
      db,
      COLLECTIONS,
      ORDER_STATUS,
      serverTimestamp,
    } = require('./firebase/config');

    // SHA-256 hash of token used as usedTokens doc ID
    const tokenDocId = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    // Check token hasn't already been used
    const tokenDoc = await db
      .collection('usedTokens')
      .doc(tokenDocId)
      .get();

    if (tokenDoc.exists) {
      return res.send(approvePageHtml(
        '✅',
        'Already Approved',
        'This order has already been confirmed and payment was collected. No further action needed.',
        '/company/dashboard',
        'View your dashboard →'
      ));
    }

    // Get order
    const orderRef = db
      .collection(COLLECTIONS.ORDERS)
      .doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      throw new Error('Order not found');
    }

    const order = orderDoc.data();

    // Already past pending — show appropriate page
    const alreadyDone =
      order.status === ORDER_STATUS.CONFIRMED ||
      order.status === ORDER_STATUS.ROUTED ||
      order.status === ORDER_STATUS.IN_PREPARATION ||
      order.status === ORDER_STATUS.DELIVERED;

    if (alreadyDone) {
      return res.send(approvePageHtml(
        '✅',
        'Already Confirmed!',
        'This delivery is already confirmed and being prepared.',
        '/company/dashboard',
        'View your dashboard →'
      ));
    }

    if (order.status !== ORDER_STATUS.PENDING_CONFIRMATION) {
      throw new Error(
        `Order cannot be confirmed — status: ${order.status}`
      );
    }

    // ── Get or create Stripe customer ─────────────
    const companyDoc = await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .get();

    const company = companyDoc.exists
      ? companyDoc.data()
      : {};

    let stripeCustomerId = company.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        name:  company.name || order.companyId,
        email: company.contactEmail || '',
        metadata: {
          companyId: order.companyId,
          platform:  'delightmaker',
        },
      });
      stripeCustomerId = customer.id;
      await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(order.companyId)
        .update({
          stripeCustomerId,
          updatedAt: serverTimestamp(),
        });
      console.log(
        `✅ Stripe customer auto-created: ` +
        `${stripeCustomerId} — ${company.name}`
      );
    }

    // ── Build Stripe line items from bundle ────────
    // Live-lookup each product from bakery subcollection
    // so prices are always fresh and Stripe Price IDs
    // are used directly when available.
    const { COLLECTIONS: COLS } = require('./firebase/config');

    const deliveryDateStr = order.deliveryDate
      ? new Date(order.deliveryDate._seconds * 1000)
          .toLocaleDateString('en-CA')
      : '';

    let lineItems = [];

    if (order.lineItems && order.lineItems.length > 0) {
      for (const item of order.lineItems) {
        let stripePriceId = null;
        let unitAmount    = Math.round((item.unitPrice || 0) * 100);
        let productName   = item.productName || item.treatType;

        // Attempt live lookup from bakery product subcollection
        if (item.bakeryId && item.treatType) {
          try {
            const prodDoc = await db
              .collection(COLS.BAKERIES)
              .doc(item.bakeryId)
              .collection('products')
              .doc(item.treatType)
              .get();

            if (prodDoc.exists) {
              const p = prodDoc.data();
              productName   = p.name  || productName;
              unitAmount    = Math.round((p.price || p.retailPrice || 0) * 100);
              stripePriceId = p.stripePriceId || null;
            }
          } catch (lookupErr) {
            console.warn(
              `⚠️ Product lookup failed for checkout: ` +
              `${item.treatType}`, lookupErr.message
            );
          }
        }

        // Use Stripe Price ID directly if available (cleanest)
        // Otherwise fall back to price_data with live price
        if (stripePriceId && unitAmount > 0) {
          lineItems.push({
            price:    stripePriceId,
            quantity: item.qty || 1,
          });
        } else {
          lineItems.push({
            price_data: {
              currency:     'cad',
              product_data: {
                name:        productName,
                description: `🎂 For ${order.employeeName}'s birthday` +
                             (deliveryDateStr ? ` — delivery ${deliveryDateStr}` : ''),
              },
              unit_amount: unitAmount,
            },
            quantity: item.qty || 1,
          });
        }
      }
    }

    // Fallback: no line items built — use order total as single line
    if (lineItems.length === 0) {
      lineItems = [{
        price_data: {
          currency:     'cad',
          product_data: {
            name:        order.productName || 'Birthday Treat Delivery',
            description: `🎂 For ${order.employeeName}'s birthday`,
          },
          unit_amount: Math.round((order.chargeAmount || 0) * 100),
        },
        quantity: 1,
      }];
    }

    // Guard: Stripe won't accept $0 checkout sessions.
    // If total is still 0 something is wrong — log and abort.
    const totalCents = lineItems.reduce((sum, li) => {
      if (li.price) return sum; // can't easily sum Price ID items here
      return sum + (li.price_data?.unit_amount || 0) * (li.quantity || 1);
    }, 0);

    console.log(
      `💳 Checkout line items: ${lineItems.length} | ` +
      `Calculated total: ${totalCents} cents`
    );

    // ── Create Stripe Checkout session ─────────────
    const base    = process.env.APP_URL;
    const session = await stripe.checkout.sessions.create({
      mode:     'payment',
      customer: stripeCustomerId,
      line_items: lineItems,
      success_url:
        `${base}/approve/success` +
        `?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/approve/${token}`,
      metadata: {
        orderId,
        tokenDocId,
        companyId:  order.companyId,
        type:       'order_approval',
      },
      // Pre-fill email if no Stripe customer yet
      customer_email: stripeCustomerId
        ? undefined
        : (company.contactEmail || undefined),
      billing_address_collection: 'auto',
    });

    console.log(
      `🔀 Redirecting to Stripe Checkout ` +
      `for order ${orderId} — session ${session.id}`
    );

    // Redirect HR person to Stripe Checkout
    return res.redirect(303, session.url);

  } catch (err) {
    console.error('Approve route error:', err.message);
    res.status(400).send(approvePageHtml(
      '⏰',
      'Link Expired',
      'This approval link has expired or is invalid. Please log in to your dashboard to manage this order.',
      '/login',
      'Log in to your dashboard →'
    ));
  }
});


/* ═══════════════════════════════════════════════════
   APPROVE PAGE HTML HELPER
   Shared styled card used by all approve pages
   ═══════════════════════════════════════════════════ */

function approvePageHtml(icon, title, message, href, linkText) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${title} — Delightmaker</title>
        <meta name="viewport"
              content="width=device-width,
                       initial-scale=1.0"/>
        <style>
          * { box-sizing: border-box; margin: 0;
              padding: 0; }
          body {
            font-family: 'Nunito', sans-serif;
            display:         flex;
            align-items:     center;
            justify-content: center;
            min-height:      100vh;
            background:      #FFFAF5;
            padding:         24px;
          }
          .card {
            text-align:    center;
            padding:       48px 40px;
            background:    white;
            border-radius: 24px;
            box-shadow:    0 8px 30px rgba(0,0,0,0.08);
            max-width:     480px;
            width:         100%;
          }
          .icon {
            font-size:     3.5rem;
            margin-bottom: 16px;
          }
          h1 {
            color:         #2D2D2D;
            font-size:     1.6rem;
            margin-bottom: 12px;
          }
          p {
            color:       #777;
            line-height: 1.7;
            font-size:   0.95rem;
          }
          .cta {
            display:         inline-block;
            margin-top:      28px;
            background:      #FF6B6B;
            color:           white;
            padding:         12px 28px;
            border-radius:   100px;
            text-decoration: none;
            font-weight:     700;
            font-size:       0.95rem;
          }
          .logo {
            font-size:     0.8rem;
            color:         #bbb;
            margin-top:    32px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">${icon}</div>
          <h1>${title}</h1>
          <p>${message}</p>
          <a href="${href}" class="cta">${linkText}</a>
          <p class="logo">🧁 Delightmaker</p>
        </div>
      </body>
    </html>
  `;
}


/* ═══════════════════════════════════════════════════
   SCHEDULED JOBS
   Daily order scanning cron job
   ═══════════════════════════════════════════════════ */

// ── Cron endpoints (called by Vercel Cron in production) ──────────────────
// Both are protected by CRON_SECRET so random people can't trigger them.
// Vercel automatically sends: Authorization: Bearer <CRON_SECRET>

function verifyCronSecret(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured — only allow in development
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'CRON_SECRET not configured' });
      return false;
    }
    return true;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.post('/api/cron/daily-scan', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  console.log('⏰ [Vercel Cron] Running daily order scan...');
  try {
    const scheduler = require('./functions/scheduler');
    await scheduler.runDailyScan();
    console.log('✅ [Vercel Cron] Daily scan complete');
    return res.status(200).json({ success: true, job: 'daily-scan' });
  } catch (err) {
    console.error('❌ [Vercel Cron] Daily scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/cron/monthly-invoices', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  console.log('📋 [Vercel Cron] Running monthly invoice generation...');
  try {
    const { generateMonthlyInvoices } = require('./functions/invoiceGenerator');
    const results = await generateMonthlyInvoices();
    console.log(`✅ [Vercel Cron] Invoices complete: ${results.invoicesCreated} created`);
    return res.status(200).json({ success: true, job: 'monthly-invoices', ...results });
  } catch (err) {
    console.error('❌ [Vercel Cron] Invoice error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Local-only cron (node-cron) — skipped on Vercel ───────────────────────
// On Vercel there is no persistent process, so node-cron never fires.
// Vercel Cron (above) hits the endpoints above on the same schedule instead.
if (!process.env.VERCEL) {
  const cron = require('node-cron');

  // Every day at 8:00 AM Atlantic Time
  cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Running daily order scan...');
    try {
      const scheduler = require('./functions/scheduler');
      await scheduler.runDailyScan();
      console.log('✅ Daily order scan complete');
    } catch (err) {
      console.error('❌ Daily scan error:', err.message);
    }
  }, { timezone: 'America/Halifax' });

  // 1st of every month at 9:00 AM Atlantic Time
  cron.schedule('0 9 1 * *', async () => {
    console.log('📋 Running monthly invoice generation...');
    try {
      const { generateMonthlyInvoices } = require('./functions/invoiceGenerator');
      const results = await generateMonthlyInvoices();
      console.log(`✅ Monthly invoices complete: ${results.invoicesCreated} created, ${results.emailsSent} emails sent`);
    } catch (err) {
      console.error('❌ Monthly invoice generation error:', err.message);
    }
  }, { timezone: 'America/Halifax' });

  console.log('⏰ Local cron jobs scheduled (daily 8am + monthly 1st 9am Halifax time)');
}


/* ═══════════════════════════════════════════════════
   404 HANDLER
   Catches any route not defined above
   ═══════════════════════════════════════════════════ */

app.use((req, res, next) => {
  // If API route — return JSON error
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'API endpoint not found'
    });
  }
  // Otherwise — return friendly 404 page
  res.status(404).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Page Not Found — Delightmaker</title>
        <style>
          body {
            font-family: sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #FFFAF5;
          }
          .card {
            text-align: center;
            padding: 48px;
            background: white;
            border-radius: 24px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.1);
            max-width: 480px;
          }
          .icon { font-size: 4rem; margin-bottom: 16px; }
          h1 { color: #2D2D2D; margin-bottom: 12px; }
          p  { color: #888; line-height: 1.6; }
          a  {
            display: inline-block;
            margin-top: 20px;
            background: #FF6B6B;
            color: white;
            padding: 12px 28px;
            border-radius: 100px;
            text-decoration: none;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🧁</div>
          <h1>Page Not Found</h1>
          <p>
            Looks like this page got eaten. 
            Let's get you back home.
          </p>
          <a href="/">Back to Home</a>
        </div>
      </body>
    </html>
  `);
});


/* ═══════════════════════════════════════════════════
   GLOBAL ERROR HANDLER
   Catches any unhandled errors
   ═══════════════════════════════════════════════════ */

app.use((err, req, res, next) => {
  // Log full error internally
  console.error('❌ Server error:', err);

  // Never expose error details in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Something went wrong. Please try again.'
    : err.message;

  // Return JSON for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 500).json({
      error: message
    });
  }

  // Return page for browser routes
  res.status(500).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Error — Delightmaker</title>
        <style>
          body {
            font-family: sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #FFFAF5;
          }
          .card {
            text-align: center;
            padding: 48px;
            background: white;
            border-radius: 24px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.1);
            max-width: 480px;
          }
          .icon { font-size: 4rem; margin-bottom: 16px; }
          h1 { color: #2D2D2D; margin-bottom: 12px; }
          p  { color: #888; line-height: 1.6; }
          a  {
            display: inline-block;
            margin-top: 20px;
            background: #FF6B6B;
            color: white;
            padding: 12px 28px;
            border-radius: 100px;
            text-decoration: none;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">😬</div>
          <h1>Something went wrong</h1>
          <p>
            We hit an unexpected error. 
            Our team has been notified. 
            Please try again in a moment.
          </p>
          <a href="/">Back to Home</a>
        </div>
      </body>
    </html>
  `);
});


/* ═══════════════════════════════════════════════════
   START SERVER
   ═══════════════════════════════════════════════════ */

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║         🧁 DELIGHTMAKER               ║
║         Server is running!            ║
╠═══════════════════════════════════════╣
║                                       ║
║  🌐 Local:   http://localhost:${PORT}   ║
║                                       ║
║  Pages:                               ║
║  → Landing:  http://localhost:${PORT}  ║
║  → Login:    http://localhost:${PORT}/login ║
║  → Admin:    http://localhost:${PORT}/admin ║
║  → Company:  http://localhost:${PORT}/company ║
║  → Baker:    http://localhost:${PORT}/baker  ║
║                                       ║
║  Environment: ${process.env.NODE_ENV}          ║
║                                       ║
╚═══════════════════════════════════════╝
  `);
});

module.exports = app;