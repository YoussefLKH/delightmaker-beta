/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — DEMO REQUEST ROUTE
   Handles demo booking form on landing page
   POST /api/demo
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  db,
  COLLECTIONS,
  serverTimestamp,
  authenticate,
  requireAdmin,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   POST /api/demo
   Saves demo request to Firestore
   Sends notification email to Colton
   ═══════════════════════════════════════════════════ */

router.post('/', async (req, res) => {
  try {

    // ── Extract fields from request body ───────────
    const {
      name,
      company,
      email,
      size,
    } = req.body;


    // ── Validate required fields ───────────────────
    const errors = [];

    if (!name || name.trim().length < 2) {
      errors.push('Name is required');
    }

    if (!company || company.trim().length < 2) {
      errors.push('Company name is required');
    }

    if (!email || !isValidEmail(email)) {
      errors.push('Valid email is required');
    }

    if (!size) {
      errors.push('Team size is required');
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error:   'Validation failed',
        details: errors,
      });
    }


    // ── Check for duplicate submission ─────────────
    // Prevent same email submitting multiple times
    const existing = await db
      .collection(COLLECTIONS.DEMO_REQUESTS)
      .where('email', '==', email.toLowerCase().trim())
      .limit(1)
      .get();

    if (!existing.empty) {
      // Already submitted — still return success
      // Don't tell them it's a duplicate
      // Colton can see it in Firebase
      return res.status(200).json({
        success: true,
        message: 'Demo request received',
      });
    }


    // ── Save to Firestore ──────────────────────────
    const demoRequest = {
      name:      name.trim(),
      company:   company.trim(),
      email:     email.toLowerCase().trim(),
      size,
      status:    'new',        // new | contacted | closed
      source:    'landing_page',
      createdAt: serverTimestamp(),
      notes:     '',
    };

    const docRef = await db
      .collection(COLLECTIONS.DEMO_REQUESTS)
      .add(demoRequest);

    console.log(`📋 New demo request: ${docRef.id} 
                 — ${company} (${email})`);


    // ── Send notification email to Colton ──────────
    // Fire and forget — don't wait for email
    // If email fails, request is still saved
    sendDemoNotification({
      id:      docRef.id,
      name:    name.trim(),
      company: company.trim(),
      email:   email.toLowerCase().trim(),
      size,
    }).catch(err => {
      console.error('Demo notification email failed:',
                    err.message);
    });


    // ── Return success ─────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Demo request received',
    });

  } catch (err) {
    console.error('Demo request error:', err);
    return res.status(500).json({
      error: 'Failed to submit demo request. ' +
             'Please email hello@delightmaker.ca'
    });
  }
});


/* ═══════════════════════════════════════════════════
   GET /api/demo
   Admin only — get all demo requests
   ═══════════════════════════════════════════════════ */

router.get('/',
  authenticate,
  requireAdmin,
  async (req, res) => {
  try {

    // ── Get all demo requests ──────────────────────
    const { status, limit = 50 } = req.query;

    let query = db
      .collection(COLLECTIONS.DEMO_REQUESTS)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit));

    // Filter by status if provided
    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();

    const requests = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      // Convert Firestore timestamp to ISO string
      createdAt: doc.data().createdAt?.toDate()
                   ?.toISOString() || null,
    }));

    return res.status(200).json({
      success:  true,
      count:    requests.length,
      requests,
    });

  } catch (err) {
    console.error('Get demo requests error:', err);
    return res.status(500).json({
      error: 'Failed to get demo requests'
    });
  }
});


/* ═══════════════════════════════════════════════════
   PATCH /api/demo/:id
   Admin only — update demo request status
   ═══════════════════════════════════════════════════ */

router.patch('/:id',
  authenticate,
  requireAdmin,
  async (req, res) => {
  try {

    // ── Update the demo request ────────────────────
    const { id }            = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['new', 'contacted', 'closed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status'
      });
    }

    const updates = {};
    if (status) updates.status    = status;
    if (notes)  updates.notes     = notes;
    updates.updatedAt = serverTimestamp();

    await db
      .collection(COLLECTIONS.DEMO_REQUESTS)
      .doc(id)
      .update(updates);

    return res.status(200).json({
      success: true,
      message: 'Demo request updated',
    });

  } catch (err) {
    console.error('Update demo request error:', err);
    return res.status(500).json({
      error: 'Failed to update demo request'
    });
  }
});


/* ═══════════════════════════════════════════════════
   HELPER FUNCTIONS
   ═══════════════════════════════════════════════════ */

/**
 * Validate email format
 */
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}


/**
 * Send demo notification email to Colton
 * Uses Resend to send a simple notification
 */
async function sendDemoNotification(request) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Only send if Resend is configured
    if (!process.env.RESEND_API_KEY ||
        process.env.RESEND_API_KEY === 
        'your_resend_key_here') {
      console.log('📧 Demo notification skipped ' +
                  '— Resend not configured yet');
      console.log('📋 Demo details:', request);
      return;
    }

    await resend.emails.send({
      from:    `${process.env.RESEND_FROM_NAME} ` +
               `<${process.env.EMAIL_COLTON}>`,
      to:      process.env.ADMIN_EMAIL,
      subject: `🎉 New Demo Request — ${request.company}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: sans-serif;
              max-width:   600px;
              margin:      0 auto;
              padding:     24px;
              color:       #2D2D2D;
            }
            .header {
              background:    #FF6B6B;
              color:         white;
              padding:       24px;
              border-radius: 12px 12px 0 0;
              text-align:    center;
            }
            .body {
              background:    #FFFAF5;
              padding:       24px;
              border-radius: 0 0 12px 12px;
              border:        1px solid #eee;
            }
            .field {
              margin-bottom: 16px;
            }
            .label {
              font-size:     0.8rem;
              font-weight:   700;
              text-transform: uppercase;
              letter-spacing: 0.08em;
              color:         #888;
              margin-bottom: 4px;
            }
            .value {
              font-size:   1rem;
              color:       #2D2D2D;
              font-weight: 500;
            }
            .cta {
              display:       inline-block;
              background:    #FF6B6B;
              color:         white;
              padding:       12px 28px;
              border-radius: 100px;
              text-decoration: none;
              font-weight:   700;
              margin-top:    20px;
            }
            .footer {
              text-align:  center;
              margin-top:  24px;
              font-size:   0.8rem;
              color:       #888;
            }
          </style>
        </head>
        <body>

          <div class="header">
            <h2 style="margin:0">
              🎉 New Demo Request!
            </h2>
            <p style="margin:8px 0 0;opacity:0.85">
              Someone wants to see Delightmaker
            </p>
          </div>

          <div class="body">

            <div class="field">
              <div class="label">Contact Name</div>
              <div class="value">${request.name}</div>
            </div>

            <div class="field">
              <div class="label">Company</div>
              <div class="value">${request.company}</div>
            </div>

            <div class="field">
              <div class="label">Email</div>
              <div class="value">
                <a href="mailto:${request.email}">
                  ${request.email}
                </a>
              </div>
            </div>

            <div class="field">
              <div class="label">Team Size</div>
              <div class="value">${request.size}</div>
            </div>

            <div class="field">
              <div class="label">Request ID</div>
              <div class="value" 
                   style="font-size:0.85rem;color:#888">
                ${request.id}
              </div>
            </div>

            <div style="text-align:center">
              <a href="mailto:${request.email}
                 ?subject=Your Delightmaker Demo 🧁
                 &body=Hi ${request.name},%0D%0A%0D%0A
                 Thanks for your interest in 
                 Delightmaker! I'd love to set up 
                 a quick 15-minute demo.%0D%0A%0D%0A
                 When works for you?%0D%0A%0D%0A
                 Colton"
                 class="cta">
                Reply to ${request.name} →
              </a>
            </div>

          </div>

          <div class="footer">
            <p>
              Delightmaker Admin · 
              <a href="${process.env.APP_URL}/admin">
                View Dashboard
              </a>
            </p>
          </div>

        </body>
        </html>
      `,
    });

    console.log(`✅ Demo notification sent to Colton 
                 for ${request.company}`);

  } catch (err) {
    // Re-throw so caller can handle
    throw err;
  }
}


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;