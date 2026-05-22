/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — AUTH ROUTES
   User creation, role assignment, account management
   All routes: /api/auth/...
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  db,
  auth,
  COLLECTIONS,
  ROLES,
  PLAN_TIERS,
  serverTimestamp,
  verifyToken,
  setUserRole,
  createUser,
  writeAuditLog,
  authenticate,
  requireAdmin,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   POST /api/auth/create-company-user
   Admin only
   Creates a new company user account
   Called when Colton onboards a new client
   ═══════════════════════════════════════════════════ */

router.post('/create-company-user',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const {
        email,
        password,
        displayName,
        companyId,
        companyName,
      } = req.body;


      // ── Validate ─────────────────────────────────
      const errors = [];

      if (!email || !isValidEmail(email)) {
        errors.push('Valid email required');
      }
      if (!password || password.length < 8) {
        errors.push('Password must be 8+ characters');
      }
      if (!displayName || displayName.trim().length < 2){
        errors.push('Display name required');
      }
      if (!companyId) {
        errors.push('Company ID required');
      }

      if (errors.length > 0) {
        return res.status(400).json({
          error:   'Validation failed',
          details: errors,
        });
      }


      // ── Check company exists ──────────────────────
      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(companyId)
        .get();

      if (!companyDoc.exists) {
        return res.status(404).json({
          error: 'Company not found'
        });
      }


      // ── Create Firebase user ──────────────────────
      const userRecord = await createUser(
        email.toLowerCase().trim(),
        password,
        displayName.trim()
      );


      // ── Set role + companyId as custom claims ─────
      await setUserRole(
        userRecord.uid,
        ROLES.COMPANY_USER,
        companyId,
        null
      );


      // ── Save user record to Firestore ─────────────
      await db
        .collection(COLLECTIONS.USERS)
        .doc(userRecord.uid)
        .set({
          uid:         userRecord.uid,
          email:       email.toLowerCase().trim(),
          displayName: displayName.trim(),
          role:        ROLES.COMPANY_USER,
          companyId,
          companyName: companyName || '',
          createdAt:   serverTimestamp(),
          lastLogin:   null,
          mfaEnabled:  false,
          active:      true,
        });


      // ── Send welcome email ─────────────────────────
      sendWelcomeEmail({
        email:       email.toLowerCase().trim(),
        displayName: displayName.trim(),
        companyName: companyName || '',
        tempPassword: password,
      }).catch(err => {
        console.error('Welcome email failed:',
                      err.message);
      });


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'create_company_user',
        'user',
        userRecord.uid,
        {
          email,
          companyId,
          companyName,
        }
      );

      console.log(
        `✅ Company user created: ${userRecord.uid} ` +
        `— ${email} (${companyName})`
      );

      return res.status(201).json({
        success: true,
        message: 'Company user created',
        uid:     userRecord.uid,
      });

    } catch (err) {
      console.error('Create company user error:', err);

      // Handle Firebase specific errors
      if (err.code === 'auth/email-already-exists') {
        return res.status(409).json({
          error: 'An account with this email ' +
                 'already exists'
        });
      }

      return res.status(500).json({
        error: 'Failed to create user'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/auth/create-baker-user
   Admin only
   Creates a new baker portal account
   Called when Colton onboards a bakery partner
   ═══════════════════════════════════════════════════ */

router.post('/create-baker-user',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const {
        email,
        password,
        displayName,
        bakerId,
        bakeryName,
      } = req.body;


      // ── Validate ─────────────────────────────────
      const errors = [];

      if (!email || !isValidEmail(email)) {
        errors.push('Valid email required');
      }
      if (!password || password.length < 8) {
        errors.push('Password must be 8+ characters');
      }
      if (!displayName || displayName.trim().length < 2){
        errors.push('Display name required');
      }
      if (!bakerId) {
        errors.push('Bakery ID required');
      }

      if (errors.length > 0) {
        return res.status(400).json({
          error:   'Validation failed',
          details: errors,
        });
      }


      // ── Check bakery exists ───────────────────────
      const bakeryDoc = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakerId)
        .get();

      if (!bakeryDoc.exists) {
        return res.status(404).json({
          error: 'Bakery not found'
        });
      }


      // ── Create Firebase user ──────────────────────
      const userRecord = await createUser(
        email.toLowerCase().trim(),
        password,
        displayName.trim()
      );


      // ── Set role + bakerId as custom claims ───────
      await setUserRole(
        userRecord.uid,
        ROLES.BAKER,
        null,
        bakerId
      );


      // ── Save user record to Firestore ─────────────
      await db
        .collection(COLLECTIONS.USERS)
        .doc(userRecord.uid)
        .set({
          uid:         userRecord.uid,
          email:       email.toLowerCase().trim(),
          displayName: displayName.trim(),
          role:        ROLES.BAKER,
          bakerId,
          bakeryName:  bakeryName || '',
          createdAt:   serverTimestamp(),
          lastLogin:   null,
          mfaEnabled:  false,
          active:      true,
        });


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'create_baker_user',
        'user',
        userRecord.uid,
        { email, bakerId, bakeryName }
      );

      console.log(
        `✅ Baker user created: ${userRecord.uid} ` +
        `— ${email} (${bakeryName})`
      );

      return res.status(201).json({
        success: true,
        message: 'Baker user created',
        uid:     userRecord.uid,
      });

    } catch (err) {
      console.error('Create baker user error:', err);

      if (err.code === 'auth/email-already-exists') {
        return res.status(409).json({
          error: 'An account with this email ' +
                 'already exists'
        });
      }

      return res.status(500).json({
        error: 'Failed to create baker user'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/auth/create-admin
   PROTECTED — only works if no admin exists yet
   Creates the first admin account (Colton)
   Run this ONCE during initial setup
   ═══════════════════════════════════════════════════ */

router.post('/create-admin', async (req, res) => {
  try {

    const {
      email,
      password,
      displayName,
      setupSecret,
    } = req.body;


    // ── Check setup secret ────────────────────────
    // Simple protection — must match env variable
    if (setupSecret !== process.env.JWT_SECRET) {
      return res.status(403).json({
        error: 'Invalid setup secret'
      });
    }


    // ── Check if admin already exists ─────────────
    const existingAdmins = await db
      .collection(COLLECTIONS.USERS)
      .where('role', '==', ROLES.ADMIN)
      .limit(1)
      .get();

    if (!existingAdmins.empty) {
      return res.status(409).json({
        error: 'Admin account already exists'
      });
    }


    // ── Validate ──────────────────────────────────
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: 'Valid email required'
      });
    }

    if (!password || password.length < 12) {
      return res.status(400).json({
        error: 'Admin password must be 12+ characters'
      });
    }


    // ── Create Firebase user ──────────────────────
    const userRecord = await createUser(
      email.toLowerCase().trim(),
      password,
      displayName || 'Colton'
    );


    // ── Set admin role ────────────────────────────
    await auth.setCustomUserClaims(
      userRecord.uid,
      { role: ROLES.ADMIN }
    );


    // ── Save to Firestore ─────────────────────────
    await db
      .collection(COLLECTIONS.USERS)
      .doc(userRecord.uid)
      .set({
        uid:         userRecord.uid,
        email:       email.toLowerCase().trim(),
        displayName: displayName || 'Colton',
        role:        ROLES.ADMIN,
        createdAt:   serverTimestamp(),
        lastLogin:   null,
        mfaEnabled:  false,
        active:      true,
      });

    console.log(
      `✅ Admin account created: ${userRecord.uid}`
    );

    return res.status(201).json({
      success: true,
      message: 'Admin account created. ' +
               'Please log in now.',
      uid:     userRecord.uid,
    });

  } catch (err) {
    console.error('Create admin error:', err);

    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({
        error: 'Email already exists'
      });
    }

    return res.status(500).json({
      error: 'Failed to create admin account'
    });
  }
});


/* ═══════════════════════════════════════════════════
   POST /api/auth/update-last-login
   Called after successful login
   Updates last login timestamp in Firestore
   ═══════════════════════════════════════════════════ */

router.post('/update-last-login',
  authenticate,
  async (req, res) => {
    try {

      await db
        .collection(COLLECTIONS.USERS)
        .doc(req.user.uid)
        .update({
          lastLogin: serverTimestamp(),
        });

      return res.status(200).json({
        success: true
      });

    } catch (err) {
      // Non critical — don't fail the login
      console.error('Update last login error:', err);
      return res.status(200).json({
        success: true
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   GET /api/auth/me
   Returns current user's profile from Firestore
   ═══════════════════════════════════════════════════ */

router.get('/me',
  authenticate,
  async (req, res) => {
    try {

      const userDoc = await db
        .collection(COLLECTIONS.USERS)
        .doc(req.user.uid)
        .get();

      if (!userDoc.exists) {
        return res.status(404).json({
          error: 'User profile not found'
        });
      }

      const userData = userDoc.data();

      // Never return sensitive fields
      delete userData.passwordHash;

      return res.status(200).json({
        success: true,
        user: {
          uid:        req.user.uid,
          email:      userData.email,
          name:       userData.displayName,
          role:       userData.role,
          companyId:  userData.companyId  || null,
          bakerId:    userData.bakerId    || null,
          lastLogin:  userData.lastLogin
                        ?.toDate()
                        ?.toISOString() || null,
          createdAt:  userData.createdAt
                        ?.toDate()
                        ?.toISOString() || null,
        },
      });

    } catch (err) {
      console.error('Get user profile error:', err);
      return res.status(500).json({
        error: 'Failed to get user profile'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/auth/disable-user/:uid
   Admin only
   Disables a user account
   ═══════════════════════════════════════════════════ */

router.patch('/disable-user/:uid',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { uid } = req.params;

      // Cannot disable yourself
      if (uid === req.user.uid) {
        return res.status(400).json({
          error: 'Cannot disable your own account'
        });
      }

      // Disable in Firebase Auth
      await auth.updateUser(uid, {
        disabled: true
      });

      // Mark inactive in Firestore
      await db
        .collection(COLLECTIONS.USERS)
        .doc(uid)
        .update({
          active:    false,
          updatedAt: serverTimestamp(),
        });

      // Write audit log
      await writeAuditLog(
        req.user.uid,
        'disable_user',
        'user',
        uid,
        {}
      );

      return res.status(200).json({
        success: true,
        message: 'User disabled'
      });

    } catch (err) {
      console.error('Disable user error:', err);
      return res.status(500).json({
        error: 'Failed to disable user'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/auth/enable-user/:uid
   Admin only
   Re-enables a disabled user account
   ═══════════════════════════════════════════════════ */

router.patch('/enable-user/:uid',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { uid } = req.params;

      // Enable in Firebase Auth
      await auth.updateUser(uid, {
        disabled: false
      });

      // Mark active in Firestore
      await db
        .collection(COLLECTIONS.USERS)
        .doc(uid)
        .update({
          active:    true,
          updatedAt: serverTimestamp(),
        });

      // Write audit log
      await writeAuditLog(
        req.user.uid,
        'enable_user',
        'user',
        uid,
        {}
      );

      return res.status(200).json({
        success: true,
        message: 'User enabled'
      });

    } catch (err) {
      console.error('Enable user error:', err);
      return res.status(500).json({
        error: 'Failed to enable user'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   DELETE /api/auth/delete-user/:uid
   Admin only
   Permanently deletes a user account
   PIPEDA: required for data deletion requests
   ═══════════════════════════════════════════════════ */

router.delete('/delete-user/:uid',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { uid } = req.params;

      // Cannot delete yourself
      if (uid === req.user.uid) {
        return res.status(400).json({
          error: 'Cannot delete your own account'
        });
      }

      // Write audit log BEFORE deletion
      await writeAuditLog(
        req.user.uid,
        'delete_user',
        'user',
        uid,
        { reason: req.body.reason || 'Admin deletion' }
      );

      // Delete from Firebase Auth
      await auth.deleteUser(uid);

      // Delete from Firestore
      await db
        .collection(COLLECTIONS.USERS)
        .doc(uid)
        .delete();

      return res.status(200).json({
        success: true,
        message: 'User permanently deleted'
      });

    } catch (err) {
      console.error('Delete user error:', err);
      return res.status(500).json({
        error: 'Failed to delete user'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   GET /api/auth/users
   Admin only
   List all users
   ═══════════════════════════════════════════════════ */

router.get('/users',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { role, limit = 100 } = req.query;

      let query = db
        .collection(COLLECTIONS.USERS)
        .orderBy('createdAt', 'desc')
        .limit(parseInt(limit));

      if (role) {
        query = query.where('role', '==', role);
      }

      const snapshot = await query.get();

      const users = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          uid:        doc.id,
          email:      data.email,
          name:       data.displayName,
          role:       data.role,
          companyId:  data.companyId  || null,
          bakerId:    data.bakerId    || null,
          active:     data.active,
          lastLogin:  data.lastLogin
                        ?.toDate()
                        ?.toISOString() || null,
          createdAt:  data.createdAt
                        ?.toDate()
                        ?.toISOString() || null,
        };
      });

      return res.status(200).json({
        success: true,
        count:   users.length,
        users,
      });

    } catch (err) {
      console.error('List users error:', err);
      return res.status(500).json({
        error: 'Failed to list users'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/auth/resend-verification
   Public — no auth required (user isn't signed in yet)
   Generates a new email verification link via Admin SDK
   and sends a branded email via Resend
   ═══════════════════════════════════════════════════ */

router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email is required'
      });
    }

    // Look up user by email via Admin SDK
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (err) {
      // Don't reveal whether the email exists
      return res.status(200).json({
        success: true,
        message: 'If that email exists, a verification link has been sent.'
      });
    }

    // Already verified — nothing to do
    if (userRecord.emailVerified) {
      return res.status(200).json({
        success: true,
        message: 'Email is already verified. You can log in now.'
      });
    }

    // Generate fresh verification link
    const verifyLink = await auth.generateEmailVerificationLink(
      email,
      { url: `${process.env.APP_URL}/login` }
    );

    // Get display name for personalisation
    const name = userRecord.displayName
      ? userRecord.displayName.split(' ')[0]
      : 'there';

    // Send branded email
    await sendVerificationEmail({ name, email, verifyLink });

    console.log(`✅ Verification email resent to ${email}`);

    return res.status(200).json({
      success: true,
      message: 'Verification email sent!'
    });

  } catch (err) {
    console.error('Resend verification error:', err.message);
    return res.status(500).json({
      error: 'Failed to send verification email'
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
 * Send welcome email to new company user
 */
async function sendWelcomeEmail({
  email,
  displayName,
  companyName,
  tempPassword,
}) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    if (!process.env.RESEND_API_KEY ||
        process.env.RESEND_API_KEY ===
        'your_resend_key_here') {
      console.log(
        '📧 Welcome email skipped — ' +
        'Resend not configured yet'
      );
      return;
    }

    await resend.emails.send({
      from:    `${process.env.RESEND_FROM_NAME} ` +
               `<${process.env.RESEND_FROM_EMAIL}>`,
      to:      email,
      subject: `Welcome to Delightmaker! 🧁`,
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
              padding:       32px;
              border-radius: 12px 12px 0 0;
              text-align:    center;
            }
            .body {
              background:    #FFFAF5;
              padding:       32px;
              border-radius: 0 0 12px 12px;
              border:        1px solid #eee;
            }
            .credential-box {
              background:    white;
              border:        2px solid #FFD93D;
              border-radius: 12px;
              padding:       20px;
              margin:        20px 0;
              text-align:    center;
            }
            .cta {
              display:         block;
              background:      #FF6B6B;
              color:           white;
              padding:         14px 28px;
              border-radius:   100px;
              text-decoration: none;
              font-weight:     700;
              text-align:      center;
              margin-top:      24px;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div style="font-size:2.5rem">🧁</div>
            <h2 style="margin:12px 0 4px">
              Welcome to Delightmaker!
            </h2>
            <p style="margin:0;opacity:0.85">
              ${companyName} is all set up
            </p>
          </div>

          <div class="body">
            <p>Hi ${displayName},</p>
            <p>
              Your Delightmaker account is ready.
              You can now log in and start setting
              up your team's gifting preferences.
            </p>

            <div class="credential-box">
              <p style="margin:0 0 8px;
                        font-size:0.8rem;
                        color:#888;
                        text-transform:uppercase;
                        letter-spacing:0.08em">
                Your Login Details
              </p>
              <p style="margin:0 0 4px">
                <strong>Email:</strong> ${email}
              </p>
              <p style="margin:0">
                <strong>Temp Password:</strong>
                ${tempPassword}
              </p>
            </div>

            <p style="color:#888;font-size:0.88rem">
              ⚠️ Please change your password
              after your first login.
            </p>

            <p>Here's what to do next:</p>
            <ol>
              <li>Log in to your dashboard</li>
              <li>Upload your employee list (CSV)</li>
              <li>Set your gifting rules</li>
              <li>Add your payment method</li>
            </ol>
            <p>
              The whole setup takes about
              5 minutes. After that —
              we handle everything!
            </p>

            <a href="${process.env.APP_URL}/login"
               class="cta">
              Log In to Delightmaker →
            </a>

            <p style="
              margin-top:  24px;
              font-size:   0.85rem;
              color:       #888;
              text-align:  center;
            ">
              Questions? Reply to this email
              or contact
              <a href="mailto:hello@delightmaker.ca">
                hello@delightmaker.ca
              </a>
            </p>
          </div>
        </body>
        </html>
      `,
    });

    console.log(`✅ Welcome email sent to ${email}`);

  } catch (err) {
    throw err;
  }
}


/* ═══════════════════════════════════════════════════
   EMAIL HELPER
   ═══════════════════════════════════════════════════ */

async function sendVerificationEmail({ name, email, verifyLink }) {
  if (!process.env.RESEND_API_KEY ||
      process.env.RESEND_API_KEY === 'your_resend_key_here') {
    console.log(`📧 Verification email skipped — Resend not configured`);
    console.log(`🔗 Verify link: ${verifyLink}`);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from:    `Colton at Delightmaker <${process.env.EMAIL_FROM || 'hello@delightmaker.ca'}>`,
    to:      email,
    subject: `Verify your Delightmaker email address 📧`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont,
                         'Segoe UI', Helvetica, Arial, sans-serif;
            background:  #FFFAF5;
            color:       #2D2D2D;
            padding:     40px 16px;
          }
          .wrap    { max-width: 560px; margin: 0 auto; }
          .logo    {
            text-align:    center;
            margin-bottom: 28px;
          }
          .logo-inner {
            display:       inline-flex;
            align-items:   center;
            gap:           8px;
            font-size:     1.1rem;
            font-weight:   700;
            color:         #FF6B6B;
          }
          .card {
            background:    #ffffff;
            border-radius: 20px;
            padding:       48px 44px;
            box-shadow:    0 4px 32px rgba(0,0,0,0.07);
            border:        1px solid rgba(0,0,0,0.04);
          }
          .icon-wrap {
            text-align:    center;
            margin-bottom: 24px;
          }
          .icon-circle {
            display:       inline-flex;
            align-items:   center;
            justify-content: center;
            width:         72px;
            height:        72px;
            background:    linear-gradient(135deg, #FFF3E0, #FFE0B2);
            border-radius: 50%;
            font-size:     2rem;
          }
          h1 {
            font-size:     1.6rem;
            font-weight:   700;
            color:         #1A1A1A;
            text-align:    center;
            margin-bottom: 12px;
            line-height:   1.3;
          }
          .subtitle {
            text-align:  center;
            font-size:   0.95rem;
            color:       #777;
            line-height: 1.7;
            margin-bottom: 32px;
          }
          .cta-wrap { text-align: center; margin-bottom: 28px; }
          .cta {
            display:         inline-block;
            background:      #FF6B6B;
            color:           #ffffff !important;
            text-decoration: none;
            padding:         16px 40px;
            border-radius:   100px;
            font-weight:     700;
            font-size:       1rem;
            letter-spacing:  0.01em;
            box-shadow:      0 4px 16px rgba(255,107,107,0.35);
          }
          .expire-note {
            text-align:  center;
            font-size:   0.8rem;
            color:       #BBBBBB;
            margin-bottom: 32px;
          }
          .divider {
            border:     none;
            border-top: 1px solid #F3EDE5;
            margin:     0 0 24px;
          }
          .fallback {
            font-size:   0.82rem;
            color:       #AAAAAA;
            line-height: 1.6;
          }
          .fallback a {
            color:           #FF6B6B;
            text-decoration: none;
            word-break:      break-all;
          }
          .footer {
            text-align:  center;
            margin-top:  28px;
            font-size:   0.8rem;
            color:       #CCCCCC;
            line-height: 1.7;
          }
          .footer a { color: #FF6B6B; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="wrap">

          <!-- Logo -->
          <div class="logo">
            <div class="logo-inner">
              <span>🧁</span>
              <span>Delightmaker</span>
            </div>
          </div>

          <!-- Card -->
          <div class="card">

            <div class="icon-wrap">
              <div class="icon-circle">📧</div>
            </div>

            <h1>Verify your email, ${name}</h1>

            <p class="subtitle">
              You're almost in! Click the button below to
              verify your email address and access your
              Delightmaker dashboard.
            </p>

            <div class="cta-wrap">
              <a href="${verifyLink}" class="cta">
                Verify My Email →
              </a>
            </div>

            <p class="expire-note">
              ⏱ This link expires in 24 hours.
            </p>

            <hr class="divider"/>

            <p class="fallback">
              Button not working? Copy and paste this link
              into your browser:<br/>
              <a href="${verifyLink}">${verifyLink}</a>
            </p>

          </div>

          <!-- Footer -->
          <div class="footer">
            <p>
              Delightmaker · Halifax, Nova Scotia 🇨🇦<br/>
              Questions? <a href="mailto:hello@delightmaker.ca">hello@delightmaker.ca</a>
            </p>
            <p style="margin-top:8px;font-size:0.75rem">
              If you didn't request this, you can safely ignore it.
            </p>
          </div>

        </div>
      </body>
      </html>
    `,
  });
}


/* ═══════════════════════════════════════════════════
   POST /api/auth/impersonate/:companyId
   Admin only — generates a short-lived custom token
   for a company_user of the given company.
   Frontend uses it to sign in as that company.
   ═══════════════════════════════════════════════════ */

router.post('/impersonate/:companyId',
  authenticate,
  requireAdmin,
  async (req, res) => {
    const { companyId } = req.params;

    try {
      // Verify company exists
      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(companyId)
        .get();

      if (!companyDoc.exists) {
        return res.status(404).json({
          error: 'Company not found'
        });
      }

      const company = companyDoc.data();

      // Find a company_user for this company
      // Query by companyId only (avoids needing composite index)
      // then filter by role in JS
      const usersSnap = await db
        .collection(COLLECTIONS.USERS)
        .where('companyId', '==', companyId)
        .get();

      const userDoc = usersSnap.docs.find(
        d => d.data().role === ROLES.COMPANY_USER
      );

      if (!userDoc) {
        return res.status(404).json({
          error: 'No company user found for this company. ' +
                 'Create a company user first via Admin → Clients.'
        });
      }

      const companyUser = userDoc.data();
      // Use the document ID as UID (doc is stored at users/{uid})
      // Fall back to stored uid field if present
      const uid = userDoc.id || companyUser.uid;

      // Generate a custom token valid for 1 hour
      // Include extra claim so company portal can
      // detect impersonation and show the banner
      const customToken = await auth.createCustomToken(uid, {
        impersonatedBy: req.user.uid,
        impersonatedAt: Date.now(),
      });

      // Audit log
      await writeAuditLog(
        req.user.uid,
        'impersonate_company',
        'company',
        companyId,
        {
          targetUid:   uid,
          companyName: company.name,
        }
      );

      console.log(
        `👁  Admin ${req.user.uid} impersonating ` +
        `${company.name} (${companyId})`
      );

      // ── Security notification email to company ────
      await sendImpersonationNotice(company);


      return res.json({
        customToken,
        companyId,
        companyName: company.name,
        userEmail:   companyUser.email,
      });

    } catch (err) {
      console.error('Impersonation error:', err);
      return res.status(500).json({
        error: `Impersonation failed: ${err.message}`
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   SEND IMPERSONATION SECURITY NOTICE
   Fires every time Colton uses "View as Company"
   ═══════════════════════════════════════════════════ */

async function sendImpersonationNotice(company) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey || !company.contactEmail) return;

    const { Resend } = require('resend');
    const resend     = new Resend(resendKey);

    const now = new Date().toLocaleString('en-CA', {
      timeZone:    'America/Halifax',
      weekday:     'long',
      year:        'numeric',
      month:       'long',
      day:         'numeric',
      hour:        '2-digit',
      minute:      '2-digit',
      timeZoneName: 'short',
    });

    await resend.emails.send({
      from:    `Delightmaker <${process.env.EMAIL_SUPPORT}>`,
      to:      company.contactEmail,
      subject: `🔐 Delightmaker support accessed your account`,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;padding:0;background:#FAF7F2;
                     font-family:'Helvetica Neue',Arial,sans-serif">
          <div style="max-width:540px;margin:40px auto;background:#fff;
                      border-radius:16px;overflow:hidden;
                      box-shadow:0 2px 12px rgba(0,0,0,0.08)">

            <!-- Header -->
            <div style="background:#1a1a2e;padding:28px 40px;text-align:center">
              <div style="font-size:2rem;margin-bottom:8px">🔐</div>
              <h1 style="color:#fff;margin:0;font-size:1.2rem;font-weight:700">
                Security Notice
              </h1>
              <p style="color:rgba(255,255,255,0.65);margin:6px 0 0;
                         font-size:0.85rem">
                Automated account access alert
              </p>
            </div>

            <!-- Body -->
            <div style="padding:36px 40px">
              <p style="color:#333;font-size:1rem;
                         line-height:1.6;margin-top:0">
                Hi <strong>${company.name || 'there'}</strong>,
              </p>
              <p style="color:#555;font-size:0.95rem;line-height:1.6">
                A Delightmaker support team member accessed your company
                portal. This is an automated notice so you're always
                informed when your account is accessed.
              </p>

              <!-- Detail box -->
              <div style="background:#F5F5F5;border-radius:10px;
                           padding:20px 24px;margin:24px 0">
                <table style="width:100%;border-collapse:collapse;
                               font-size:0.88rem">
                  <tr>
                    <td style="color:#888;padding:6px 0;
                                width:40%">Accessed by</td>
                    <td style="color:#1a1a2e;font-weight:600">
                      Delightmaker Support
                    </td>
                  </tr>
                  <tr>
                    <td style="color:#888;padding:6px 0">Time</td>
                    <td style="color:#1a1a2e;font-weight:600">
                      ${now}
                    </td>
                  </tr>
                  <tr>
                    <td style="color:#888;padding:6px 0">Session limit</td>
                    <td style="color:#1a1a2e;font-weight:600">
                      1 hour
                    </td>
                  </tr>
                </table>
              </div>

              <p style="color:#555;font-size:0.88rem;line-height:1.6">
                ✅ If you requested support or were expecting this,
                you can safely ignore this email.
              </p>
              <p style="color:#555;font-size:0.88rem;line-height:1.6">
                ⚠️ If this was unexpected, please reply to this email
                immediately or contact us at
                <a href="mailto:hello@delightmaker.ca"
                   style="color:#C66228">hello@delightmaker.ca</a>.
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#FAF7F2;padding:20px 40px;
                         text-align:center">
              <p style="color:#aaa;font-size:0.75rem;margin:0">
                Delightmaker · Halifax, NS ·
                <a href="mailto:hello@delightmaker.ca"
                   style="color:#aaa">hello@delightmaker.ca</a>
              </p>
            </div>

          </div>
        </body>
        </html>
      `,
    });

    console.log(
      `📧 Impersonation notice sent to ${company.contactEmail}`
    );

  } catch (err) {
    // Never block the impersonation if email fails
    console.error('Impersonation notice email failed:', err.message);
  }
}


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;