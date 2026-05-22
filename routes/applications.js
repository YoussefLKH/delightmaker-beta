/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — APPLICATIONS ROUTE
   Handles company + baker applications from landing page
   and admin approve / reject / direct invite

   Public:
     POST /api/applications          — submit application
   Admin only:
     GET  /api/applications          — list applications
     POST /api/applications/:id/approve — approve + create account
     POST /api/applications/:id/reject  — reject + notify
     POST /api/applications/invite      — direct invite (skip form)
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const {
  admin,
  db,
  auth,
  COLLECTIONS,
  serverTimestamp,
  authenticate,
  requireAdmin,
  writeAuditLog,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   POST /api/applications
   Public — submit an application from the landing page
   ═══════════════════════════════════════════════════ */

router.post('/', async (req, res) => {
  try {
    const {
      type,         // 'company' | 'baker'
      name,
      orgName,
      email,
      password,
      phone,
      address,
      addressLat,   // from Google Places autocomplete
      addressLng,
      planInterest, // company only
      specialty,    // baker only
      allergenFree, // baker only
      capacity,     // baker only
      website,      // baker only
      message,
    } = req.body;

    // ── Validate ───────────────────────────────────
    const errors = [];
    if (!type || !['company', 'baker'].includes(type)) errors.push('Type must be company or baker');
    if (!name    || name.trim().length < 2)            errors.push('Name is required');
    if (!orgName || orgName.trim().length < 2)         errors.push(type === 'baker' ? 'Bakery name is required' : 'Company name is required');
    if (!email   || !isValidEmail(email))              errors.push('Valid email is required');
    if (!password || password.length < 8)              errors.push('Password must be at least 8 characters');
    if (!phone   || phone.trim().length < 7)           errors.push('Phone number is required');
    if (!address || address.trim().length < 5)         errors.push('Address is required');

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], details: errors });
    }

    const cleanEmail = email.toLowerCase().trim();

    // ── Check if email already has an account ──────
    try {
      await auth.getUserByEmail(cleanEmail);
      return res.status(400).json({
        error: 'An account with this email already exists. Try logging in or use Forgot Password.',
      });
    } catch (notFound) {
      // Good — email is available
    }

    // ── Create Firebase Auth account ───────────────
    // Account is created immediately but set to 'pending'
    // They can't access any portal until Colton approves
    const firebaseUser = await auth.createUser({
      email:         cleanEmail,
      password,
      displayName:   name.trim(),
      emailVerified: false,
    });

    const uid = firebaseUser.uid;

    try {
      // Set pending role — blocks dashboard access
      await auth.setCustomUserClaims(uid, {
        role:            'pending',
        applicationType: type,
      });

      // Create user doc with pending status
      await db.collection(COLLECTIONS.USERS).doc(uid).set({
        email:       cleanEmail,
        displayName: name.trim(),
        role:        'pending',
        status:      'pending',
        createdAt:   serverTimestamp(),
      });
    } catch (setupErr) {
      // Firestore/claims write failed — clean up the orphaned Auth account
      console.error('Account setup failed — cleaning up Auth account:', setupErr.message);
      try { await auth.deleteUser(uid); } catch (_) {}
      throw setupErr;
    }

    // ── Check if baker is outside HRM (>40km from Halifax) ──
    const HALIFAX_LAT    = 44.6488;
    const HALIFAX_LNG    = -63.5752;
    const HRM_RADIUS_KM  = 40;

    function haversineKm(lat1, lng1, lat2, lng2) {
      const R    = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a    =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    let outOfRange = false;
    const lat = typeof addressLat === 'number' ? addressLat : null;
    const lng = typeof addressLng === 'number' ? addressLng : null;
    if (type === 'baker' && lat !== null && lng !== null) {
      const distKm = haversineKm(HALIFAX_LAT, HALIFAX_LNG, lat, lng);
      if (distKm > HRM_RADIUS_KM) {
        outOfRange = true;
        console.log(
          `⚠️  Baker application "${orgName}" is ${distKm.toFixed(1)}km` +
          ` from Halifax — flagged as out-of-range`
        );
      }
    }

    // ── Save application ───────────────────────────
    const application = {
      type,
      uid,
      name:         name.trim(),
      orgName:      orgName.trim(),
      email:        cleanEmail,
      phone:        phone.trim(),
      address:      address.trim(),
      addressLat:   lat,
      addressLng:   lng,
      outOfRange,
      planInterest: planInterest || null,
      specialty:    specialty    || null,
      allergenFree: allergenFree || null,
      capacity:     capacity     || null,
      website:      website      || null,
      message:      message      ? message.trim() : '',
      status:       'pending',
      source:       'landing_page',
      createdAt:    serverTimestamp(),
      reviewedAt:   null,
      reviewedBy:   null,
      notes:        '',
    };

    const docRef = await db
      .collection(COLLECTIONS.APPLICATIONS)
      .add(application);

    console.log(`📋 New ${type} application: ${docRef.id} — ${orgName} (${cleanEmail}) uid:${uid}`);

    // ── Send emails (awaited so Vercel doesn't kill the function early) ──
    await Promise.allSettled([
      sendApplicationConfirmationEmail({
        type,
        name:    name.trim(),
        orgName: orgName.trim(),
        email:   cleanEmail,
      }).catch(err => console.error('Confirmation email failed:', err.message)),

      sendApplicationNotification({
        id:          docRef.id,
        type,
        name:        name.trim(),
        orgName:     orgName.trim(),
        email:       cleanEmail,
        phone:       phone.trim(),
        address:     address.trim(),
        planInterest: planInterest || null,
        specialty:   specialty    || null,
        allergenFree: allergenFree || null,
        capacity:    capacity     || null,
        website:     website      || null,
        message:     message      || '',
      }).catch(err => console.error('Application notification failed:', err.message)),
    ]);

    return res.status(200).json({
      success: true,
      message: 'Account created. Application submitted for review.',
    });

  } catch (err) {
    console.error('Application submit error:', err);

    // Return meaningful Firebase errors
    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({
        error: 'An account with this email already exists. Try logging in.',
      });
    }
    if (err.code === 'auth/invalid-password') {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    return res.status(500).json({
      error: 'Failed to submit application. Please email hello@delightmaker.ca',
    });
  }
});


/* ═══════════════════════════════════════════════════
   GET /api/applications
   Admin only — list all applications
   ═══════════════════════════════════════════════════ */

router.get('/',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { status, type, limit = 100 } = req.query;

      // Fetch all (or filtered by type/status individually — no compound
      // index needed) then filter in memory to avoid Firestore index errors
      const snapshot = await db
        .collection(COLLECTIONS.APPLICATIONS)
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get();

      let applications = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt:  doc.data().createdAt?.toDate()?.toISOString()  || null,
        reviewedAt: doc.data().reviewedAt?.toDate()?.toISOString() || null,
      }));

      // Filter in memory — avoids needing composite Firestore indexes
      if (status) applications = applications.filter(a => a.status === status);
      if (type)   applications = applications.filter(a => a.type   === type);

      // Honour the limit param
      applications = applications.slice(0, parseInt(limit));

      return res.status(200).json({
        success: true,
        count:   applications.length,
        applications,
      });

    } catch (err) {
      console.error('Get applications error:', err);
      return res.status(500).json({ error: 'Failed to get applications' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/applications/invite
   Admin only — direct invite, bypasses application form
   Creates account immediately + sends setup email
   ═══════════════════════════════════════════════════ */

router.post('/invite',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        type,         // 'company' | 'baker'
        name,         // contact name
        orgName,      // company or bakery name
        email,
        specialty,    // baker only
        deliveryAddress, // company only
      } = req.body;

      if (!type || !name || !orgName || !email) {
        return res.status(400).json({ error: 'type, name, orgName, email required' });
      }

      const result = await createAccountAndSendInvite({
        type,
        name,
        orgName,
        email,
        specialty:       specialty       || '',
        deliveryAddress: deliveryAddress || '',
        invitedBy:       req.user.uid,
      });

      await writeAuditLog(
        req.user.uid,
        'direct_invite',
        type,
        result.uid,
        { orgName, email }
      );

      return res.status(200).json({
        success: true,
        message: `Invite sent to ${email}`,
        uid:     result.uid,
        orgId:   result.orgId,
      });

    } catch (err) {
      console.error('Direct invite error:', err);
      return res.status(500).json({ error: err.message || 'Invite failed' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/applications/:id/approve
   Admin only — approve application, create account,
   send password setup email
   ═══════════════════════════════════════════════════ */

router.post('/:id/approve',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { deliveryAddress, notes } = req.body;

      // Get application
      const appRef = db.collection(COLLECTIONS.APPLICATIONS).doc(id);
      const appDoc = await appRef.get();

      if (!appDoc.exists) {
        return res.status(404).json({ error: 'Application not found' });
      }

      const app = appDoc.data();

      if (!['pending', 'waitlisted'].includes(app.status)) {
        return res.status(400).json({
          error: `Application is already ${app.status}`,
        });
      }

      // Account already exists (created on application submit)
      // Just activate it + create org doc
      const result = await activateAccount({
        app,
        deliveryAddress: deliveryAddress || app.address || '',
        approvedBy:      req.user.uid,
      });

      // Update application status
      await appRef.update({
        status:     'approved',
        reviewedAt: serverTimestamp(),
        reviewedBy: req.user.uid,
        notes:      notes || '',
        uid:        result.uid,
        orgId:      result.orgId,
      });

      await writeAuditLog(
        req.user.uid,
        'approve_application',
        app.type,
        result.uid,
        { applicationId: id, orgName: app.orgName, email: app.email }
      );

      console.log(`✅ Application approved: ${id} — ${app.orgName} (${app.email})`);

      return res.status(200).json({
        success: true,
        message: `Account created and invite sent to ${app.email}`,
        uid:     result.uid,
        orgId:   result.orgId,
      });

    } catch (err) {
      console.error('Approve application error:', err);
      return res.status(500).json({ error: err.message || 'Approval failed' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/applications/:id/reject
   Admin only — reject application + send polite email
   ═══════════════════════════════════════════════════ */

router.post('/:id/reject',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { id }    = req.params;
      const { notes } = req.body;

      const appRef = db.collection(COLLECTIONS.APPLICATIONS).doc(id);
      const appDoc = await appRef.get();

      if (!appDoc.exists) {
        return res.status(404).json({ error: 'Application not found' });
      }

      const app = appDoc.data();

      if (!['pending', 'waitlisted'].includes(app.status)) {
        return res.status(400).json({
          error: `Application is already ${app.status}`,
        });
      }

      // Delete their Firebase Auth account + user doc
      if (app.uid) {
        try {
          await auth.deleteUser(app.uid);
          await db.collection(COLLECTIONS.USERS).doc(app.uid).delete();
          console.log(`🗑️  Deleted pending Auth account for ${app.email}`);
        } catch (delErr) {
          console.error('Could not delete Auth account on reject:', delErr.message);
        }
      }

      // Update status
      await appRef.update({
        status:     'rejected',
        reviewedAt: serverTimestamp(),
        reviewedBy: req.user.uid,
        notes:      notes || '',
      });

      // Send rejection email
      sendRejectionEmail(app).catch(err => {
        console.error('Rejection email failed:', err.message);
      });

      await writeAuditLog(
        req.user.uid,
        'reject_application',
        app.type,
        id,
        { orgName: app.orgName, email: app.email }
      );

      console.log(`❌ Application rejected: ${id} — ${app.orgName}`);

      return res.status(200).json({
        success: true,
        message: `Application rejected. Notification sent to ${app.email}`,
      });

    } catch (err) {
      console.error('Reject application error:', err);
      return res.status(500).json({ error: 'Rejection failed' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/applications/:id/waitlist
   Admin only — move application to waitlist + notify
   ═══════════════════════════════════════════════════ */

router.post('/:id/waitlist',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { id }    = req.params;
      const { notes } = req.body;

      const appRef = db.collection(COLLECTIONS.APPLICATIONS).doc(id);
      const appDoc = await appRef.get();

      if (!appDoc.exists) {
        return res.status(404).json({ error: 'Application not found' });
      }

      const app = appDoc.data();

      if (app.status !== 'pending') {
        return res.status(400).json({
          error: `Application is already ${app.status}`,
        });
      }

      // Update status to waitlisted
      await appRef.update({
        status:       'waitlisted',
        waitlistedAt: serverTimestamp(),
        reviewedBy:   req.user.uid,
        notes:        notes || '',
      });

      // Send waitlist notification email
      sendWaitlistEmail(app).catch(err => {
        console.error('Waitlist email failed:', err.message);
      });

      await writeAuditLog(
        req.user.uid,
        'waitlist_application',
        app.type,
        id,
        { orgName: app.orgName, email: app.email }
      );

      console.log(`⏸  Application waitlisted: ${id} — ${app.orgName}`);

      return res.status(200).json({
        success: true,
        message: `Application waitlisted. Notification sent to ${app.email}`,
      });

    } catch (err) {
      console.error('Waitlist application error:', err);
      return res.status(500).json({ error: 'Waitlist action failed' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/applications/:id
   Admin only — update notes/status manually
   ═══════════════════════════════════════════════════ */

router.patch('/:id',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { id }    = req.params;
      const { notes } = req.body;

      await db.collection(COLLECTIONS.APPLICATIONS).doc(id).update({
        notes:     notes || '',
        updatedAt: serverTimestamp(),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Update failed' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   HELPER — ACTIVATE ACCOUNT (used by approve flow)
   Account was already created on application submit.
   We just upgrade the role, create the org doc,
   and send an approval email.
   ═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════
   GEOCODE HELPER
   Converts a plain text address → { lat, lng }
   Used as fallback when autocomplete lat/lng is missing
   ═══════════════════════════════════════════════════ */

async function geocodeAddress(address) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !address) return { lat: null, lng: null };
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json` +
                `?address=${encodeURIComponent(address)}&key=${key}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results[0]) {
      const loc = data.results[0].geometry.location;
      console.log(`📍 Geocoded "${address}" → ${loc.lat}, ${loc.lng}`);
      return { lat: loc.lat, lng: loc.lng };
    }
    console.warn(`Geocoding returned status: ${data.status} for "${address}"`);
  } catch (err) {
    console.error('Geocoding error:', err.message);
  }
  return { lat: null, lng: null };
}


async function activateAccount({ app, deliveryAddress, approvedBy }) {
  const { uid, type, name, orgName, email, specialty, allergenFree } = app;

  if (!uid) throw new Error('Application has no uid — was it submitted via the new form?');

  // Resolve coordinates — use stored lat/lng from autocomplete,
  // or fall back to geocoding the address text now
  let lat = app.addressLat || null;
  let lng = app.addressLng || null;
  if (!lat || !lng) {
    const geo = await geocodeAddress(deliveryAddress || app.address || '');
    lat = geo.lat;
    lng = geo.lng;
  }

  let orgId;

  if (type === 'company') {
    const companyDoc = await db.collection(COLLECTIONS.COMPANIES).add({
      name:                   orgName,
      contactName:            name,
      contactEmail:           email,
      phone:                  app.phone        || '',
      defaultDeliveryAddress: deliveryAddress  || app.address || '',
      addressLat:             lat,
      addressLng:             lng,
      autoApprove:            false,
      onboardingComplete:     false,
      notes:                  '',
      stats: { employeeCount: 0, pendingOrders: 0, deliveredOrders: 0, totalSpend: 0 },
      createdAt:  serverTimestamp(),
      approvedBy,
    });
    orgId = companyDoc.id;

    await auth.setCustomUserClaims(uid, { role: 'company_user', companyId: orgId });

    await db.collection(COLLECTIONS.USERS).doc(uid).set({
      email,
      displayName: name,
      role:        'company_user',
      companyId:   orgId,
      status:      'active',
      createdAt:   serverTimestamp(),
    });

    await db.collection(COLLECTIONS.GIFTING_RULES).doc(orgId).set({
      companyId:   orgId,
      birthday:    { enabled: true, productId: null, advanceDays: 7 },
      autoApprove: false,
      updatedAt:   serverTimestamp(),
    });

  } else if (type === 'baker') {
    const bakeryDoc = await db.collection(COLLECTIONS.BAKERIES).add({
      name:         orgName,
      active:       true,
      specialty:    specialty
                      ? specialty.split(',').map(s => s.trim())
                      : [],
      allergenFree: allergenFree === 'yes' || allergenFree === 'dedicated',
      allergenNote: allergenFree || 'no',
      contact:      email,
      phone:        app.phone   || '',
      address:      app.address || '',
      addressLat:   lat,
      addressLng:   lng,
      website:      app.website || '',
      capacity:     app.capacity|| '',
      createdAt:    serverTimestamp(),
      approvedBy,
    });
    orgId = bakeryDoc.id;

    await auth.setCustomUserClaims(uid, { role: 'baker', bakerId: orgId });

    await db.collection(COLLECTIONS.USERS).doc(uid).set({
      email,
      displayName: name,
      role:        'baker',
      bakerId:     orgId,
      status:      'active',
      createdAt:   serverTimestamp(),
    });
  }

  // Generate email verification link (expires in 24h)
  // User must click this before they can log in
  let verifyLink;
  try {
    verifyLink = await auth.generateEmailVerificationLink(email, {
      url: `${process.env.APP_URL}/login`,
    });
  } catch (err) {
    console.error('Could not generate verification link:', err.message);
    verifyLink = `${process.env.APP_URL}/login`; // fallback
  }

  // Send approval email with the verification link
  await sendApprovalEmail({ type, name, orgName, email, verifyLink });

  console.log(`✅ Account activated: ${uid} (${type}) — ${orgName} <${email}>`);
  return { uid, orgId };
}


/* ═══════════════════════════════════════════════════
   HELPER — DIRECT INVITE (admin creates account from scratch)
   ═══════════════════════════════════════════════════ */

async function createAccountAndSendInvite({
  type, name, orgName, email, specialty,
  deliveryAddress, invitedBy,
}) {
  // Create new user with random temp password
  const tempPassword = crypto.randomBytes(16).toString('hex');
  let firebaseUser;
  try {
    firebaseUser = await auth.getUserByEmail(email);
  } catch (_) {
    firebaseUser = await auth.createUser({
      email, password: tempPassword, displayName: name, emailVerified: false,
    });
  }
  const uid = firebaseUser.uid;
  let orgId;

  if (type === 'company') {
    const companyDoc = await db.collection(COLLECTIONS.COMPANIES).add({
      name: orgName,
      contactName: name, contactEmail: email,
      defaultDeliveryAddress: deliveryAddress || '',
      autoApprove: false, onboardingComplete: false,
      notes: '',
      stats: { employeeCount: 0, pendingOrders: 0, deliveredOrders: 0, totalSpend: 0 },
      createdAt: serverTimestamp(), invitedBy,
    });
    orgId = companyDoc.id;
    await auth.setCustomUserClaims(uid, { role: 'company_user', companyId: orgId });
    await db.collection(COLLECTIONS.USERS).doc(uid).set({
      email, displayName: name, role: 'company_user', companyId: orgId,
      status: 'active', createdAt: serverTimestamp(),
    });
    await db.collection(COLLECTIONS.GIFTING_RULES).doc(orgId).set({
      companyId: orgId, birthday: { enabled: true, productId: null, advanceDays: 7 },
      autoApprove: false, updatedAt: serverTimestamp(),
    });
  } else {
    const bakeryDoc = await db.collection(COLLECTIONS.BAKERIES).add({
      name: orgName, active: true,
      specialty: specialty ? specialty.split(',').map(s => s.trim()) : [],
      allergenFree: false,
      contact:      email,       // legacy field
      contactEmail: email,       // used by autoRoute + notifications
      createdAt: serverTimestamp(), invitedBy,
    });
    orgId = bakeryDoc.id;
    await auth.setCustomUserClaims(uid, { role: 'baker', bakerId: orgId });
    await db.collection(COLLECTIONS.USERS).doc(uid).set({
      email, displayName: name, role: 'baker', bakerId: orgId,
      status: 'active', createdAt: serverTimestamp(),
    });
  }

  // Generate password setup link for direct invites
  const resetLink = await auth.generatePasswordResetLink(email, {
    url: `${process.env.APP_URL}/login`,
  });
  await sendWelcomeEmail({ type, name, orgName, email, resetLink });

  console.log(`✅ Direct invite sent: ${uid} (${type}) — ${orgName} <${email}>`);
  return { uid, orgId };
}


/* ═══════════════════════════════════════════════════
   EMAIL HELPERS
   ═══════════════════════════════════════════════════ */

async function sendApplicationConfirmationEmail({ type, name, orgName, email }) {
  if (!process.env.RESEND_API_KEY ||
      process.env.RESEND_API_KEY === 'your_resend_key_here') {
    console.log(`📧 Application confirmation skipped — Resend not configured (${email})`);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const isCompany  = type === 'company';
  const roleLabel  = isCompany ? 'company' : 'bakery partner';
  const emoji      = isCompany ? '🏢' : '🧁';
  const whatToExpect = isCompany
    ? `Once approved, you'll have access to your HR dashboard where you can upload your team, set gifting rules, and let us handle every birthday and work anniversary from there.`
    : `Once approved, you'll have access to your baker dashboard where you can view incoming orders, confirm deliveries, and manage your schedule with us.`;

  await resend.emails.send({
    from:    `Colton at Delightmaker <${process.env.EMAIL_FROM || 'hello@delightmaker.ca'}>`,
    to:      email,
    subject: `${emoji} We received your application, ${name.split(' ')[0]}!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>
        body        { font-family: sans-serif; background: #FFFAF5; margin: 0; padding: 24px; color: #2D2D2D; }
        .wrap       { max-width: 580px; margin: 0 auto; }
        .logo       { text-align: center; font-size: 1.1rem; font-weight: 700; color: #FF6B6B; margin-bottom: 24px; }
        .card       { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,.07); }
        h1          { font-size: 1.5rem; margin: 0 0 12px; color: #2D2D2D; }
        p           { color: #555; line-height: 1.75; margin: 0 0 16px; font-size: .95rem; }
        .status-box {
          background:    #FFF3CD;
          border:        1.5px solid #FFD966;
          border-radius: 12px;
          padding:       16px 20px;
          margin:        24px 0;
          display:       flex;
          align-items:   flex-start;
          gap:           12px;
        }
        .status-icon { font-size: 1.5rem; line-height: 1; }
        .status-text { font-size: .9rem; color: #7A5C00; line-height: 1.6; }
        .status-text strong { color: #5C4300; }
        .what-next  { background: #F8F4FF; border-radius: 12px; padding: 20px 24px; margin: 20px 0; }
        .what-next h3 { font-size: .95rem; color: #6B21A8; margin: 0 0 10px; }
        .what-next ul { margin: 0; padding: 0 0 0 18px; color: #555; font-size: .9rem; line-height: 1.8; }
        .divider    { border: none; border-top: 1px solid #F0EAE2; margin: 24px 0; }
        .footer-note { font-size: .82rem; color: #AAA; text-align: center; margin-top: 24px; }
        .footer-note a { color: #FF6B6B; text-decoration: none; }
      </style></head>
      <body>
        <div class="wrap">
          <div class="logo">🧁 Delightmaker</div>
          <div class="card">

            <h1>Thanks for applying, ${name.split(' ')[0]}! ${emoji}</h1>
            <p>
              We've received your ${roleLabel} application for
              <strong>${orgName}</strong> and your account has been created.
              Colton reviews every application personally — you'll hear back
              within <strong>1 business day</strong>.
            </p>

            <div class="status-box">
              <div class="status-icon">⏳</div>
              <div class="status-text">
                <strong>Your application is under review.</strong><br/>
                Your account is ready but access is on hold until approval.
                We'll email you at <strong>${email}</strong> the moment
                you're approved.
              </div>
            </div>

            <div class="what-next">
              <h3>✨ What happens next</h3>
              <ul>
                <li>Colton reviews your application (usually same day)</li>
                <li>You'll get an approval email with a link to log in</li>
                <li>${whatToExpect}</li>
              </ul>
            </div>

            <hr class="divider"/>
            <p style="font-size:.9rem;color:#888;margin:0">
              Questions in the meantime? Just reply to this email or reach us at
              <a href="mailto:hello@delightmaker.ca" style="color:#FF6B6B">
                hello@delightmaker.ca
              </a>.
              We're a small team and we actually read every message.
            </p>

          </div>
          <div class="footer-note">
            <p>Delightmaker · Halifax, Nova Scotia 🇨🇦</p>
            <p><a href="${process.env.APP_URL}">delightmaker.ca</a></p>
          </div>
        </div>
      </body>
      </html>
    `,
  });

  console.log(`📧 Application confirmation sent to ${email}`);
}


async function sendApplicationNotification(app) {
  if (!process.env.RESEND_API_KEY ||
      process.env.RESEND_API_KEY === 'your_resend_key_here') {
    console.log('📧 Application notification skipped — Resend not configured');
    console.log('📋 Application:', app);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const typeLabel = app.type === 'baker' ? '🧁 Bakery Partner' : '🏢 Company';

  const companyRows = app.type === 'company' ? `
    <div class="field"><div class="label">Plan Interest</div><div class="value">${app.planInterest || 'Not sure yet'}</div></div>
  ` : '';

  const bakerRows = app.type === 'baker' ? `
    <div class="field"><div class="label">Specialty</div><div class="value">${app.specialty || '—'}</div></div>
    <div class="field"><div class="label">Allergen-Free</div><div class="value">${app.allergenFree || 'No'}</div></div>
    <div class="field"><div class="label">Weekly Capacity</div><div class="value">${app.capacity || '—'}</div></div>
    ${app.website ? `<div class="field"><div class="label">Website/Instagram</div><div class="value"><a href="${app.website}">${app.website}</a></div></div>` : ''}
  ` : '';

  await resend.emails.send({
    from:    `Delightmaker <${process.env.EMAIL_FROM || 'hello@delightmaker.ca'}>`,
    to:      process.env.ADMIN_EMAIL,
    subject: `${typeLabel} Application — ${app.orgName}`,
    html: `
      <!DOCTYPE html><html><head><style>
        body{font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2D2D2D}
        .header{background:#FF6B6B;color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center}
        .body{background:#FFFAF5;padding:24px;border-radius:0 0 12px 12px;border:1px solid #eee}
        .field{margin-bottom:14px}
        .label{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:3px}
        .value{font-size:.95rem;color:#2D2D2D;font-weight:500}
        .cta{display:inline-block;background:#FF6B6B;color:white;padding:12px 28px;border-radius:100px;text-decoration:none;font-weight:700;margin-top:20px}
        .footer{text-align:center;margin-top:24px;font-size:.8rem;color:#888}
        .divider{border:none;border-top:1px solid #eee;margin:16px 0}
      </style></head><body>
        <div class="header">
          <h2 style="margin:0">🎉 New ${typeLabel} Application!</h2>
          <p style="margin:8px 0 0;opacity:.85">${app.orgName}</p>
        </div>
        <div class="body">
          <div class="field"><div class="label">Contact Name</div><div class="value">${app.name}</div></div>
          <div class="field"><div class="label">${app.type === 'baker' ? 'Bakery' : 'Company'} Name</div><div class="value">${app.orgName}</div></div>
          <div class="field"><div class="label">Email</div><div class="value"><a href="mailto:${app.email}">${app.email}</a></div></div>
          <div class="field"><div class="label">Phone</div><div class="value"><a href="tel:${app.phone}">${app.phone}</a></div></div>
          <div class="field"><div class="label">Address</div><div class="value">${app.address}</div></div>
          <hr class="divider"/>
          ${companyRows}
          ${bakerRows}
          ${app.message ? `<div class="field"><div class="label">Message</div><div class="value">"${app.message}"</div></div>` : ''}
          <div style="text-align:center">
            <a href="${process.env.APP_URL}/admin/applications" class="cta">Review in Dashboard →</a>
          </div>
        </div>
        <div class="footer"><p>Delightmaker Admin · <a href="${process.env.APP_URL}/admin/applications">View all applications</a></p></div>
      </body></html>
    `,
  });

  console.log(`✅ Application notification sent for ${app.orgName}`);
}


async function sendApprovalEmail({ type, name, orgName, email, verifyLink }) {
  const roleLabel = type === 'baker' ? 'bakery partner' : 'company';
  const emoji     = type === 'baker' ? '🧁' : '🏢';

  if (!process.env.RESEND_API_KEY ||
      process.env.RESEND_API_KEY === 'your_resend_key_here') {
    console.log(`📧 Approval email skipped — Resend not configured (${email})`);
    console.log(`🔗 Verify link: ${verifyLink}`);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from:    `Colton at Delightmaker <${process.env.EMAIL_FROM || 'hello@delightmaker.ca'}>`,
    to:      email,
    subject: `You're approved! One step left 🎉`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>
        body      { font-family: sans-serif; background: #FFFAF5; margin: 0; padding: 24px; color: #2D2D2D; }
        .wrap     { max-width: 580px; margin: 0 auto; }
        .logo     { text-align: center; font-size: 1.1rem; font-weight: 700; color: #FF6B6B; margin-bottom: 24px; }
        .card     { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,.07); }
        h1        { font-size: 1.5rem; margin: 0 0 12px; }
        p         { color: #555; line-height: 1.75; margin: 0 0 16px; font-size: .95rem; }
        .step-box {
          background: #F0FDF4; border: 1.5px solid #86EFAC;
          border-radius: 12px; padding: 20px 24px; margin: 24px 0;
        }
        .step-box h3 { color: #15803D; font-size: .95rem; margin: 0 0 12px; }
        .step     { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
        .step-num {
          background: #22C55E; color: white; border-radius: 50%;
          width: 24px; height: 24px; display: flex; align-items: center;
          justify-content: center; font-size: .8rem; font-weight: 700;
          flex-shrink: 0; margin-top: 1px;
        }
        .step-text { color: #374151; font-size: .9rem; line-height: 1.5; }
        .cta-wrap  { text-align: center; margin: 28px 0 20px; }
        .cta       {
          display: inline-block; background: #FF6B6B; color: white;
          padding: 15px 36px; border-radius: 100px; text-decoration: none;
          font-weight: 700; font-size: 1rem;
        }
        .cta:hover { background: #e85555; }
        .expire-note { text-align: center; font-size: .8rem; color: #aaa; margin-top: 8px; }
        .divider  { border: none; border-top: 1px solid #F0EAE2; margin: 24px 0; }
        .footer   { text-align: center; font-size: .82rem; color: #aaa; margin-top: 24px; }
        .footer a { color: #FF6B6B; text-decoration: none; }
      </style></head>
      <body>
        <div class="wrap">
          <div class="logo">🧁 Delightmaker</div>
          <div class="card">

            <h1>You're approved, ${name.split(' ')[0]}! 🎉 ${emoji}</h1>
            <p>
              Great news — your <strong>${orgName}</strong> application has been
              approved. Your Delightmaker ${roleLabel} account is ready.
              There's just <strong>one quick step</strong> before you can log in:
              verify your email address.
            </p>

            <div class="step-box">
              <h3>✅ Here's what to do:</h3>
              <div class="step">
                <div class="step-num">1</div>
                <div class="step-text">
                  Click the button below to verify your email address
                  <strong>${email}</strong>
                </div>
              </div>
              <div class="step">
                <div class="step-num">2</div>
                <div class="step-text">
                  You'll be redirected to the login page
                </div>
              </div>
              <div class="step">
                <div class="step-num">3</div>
                <div class="step-text">
                  Log in with the email and password you created when you applied
                </div>
              </div>
            </div>

            <div class="cta-wrap">
              <a href="${verifyLink}" class="cta">Verify My Email & Log In →</a>
              <div class="expire-note">This link expires in 24 hours.</div>
            </div>

            <hr class="divider"/>
            <p style="font-size:.85rem;color:#888;margin:0">
              Didn't apply for a Delightmaker account? You can safely ignore this email.
              Questions? Reply here or email
              <a href="mailto:hello@delightmaker.ca" style="color:#FF6B6B">hello@delightmaker.ca</a>.
            </p>

          </div>
          <div class="footer">
            <p>Delightmaker · Halifax, Nova Scotia 🇨🇦</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });

  console.log(`✅ Approval + verification email sent to ${email}`);
}


async function sendWelcomeEmail({ type, name, orgName, email, resetLink }) {
  if (!process.env.RESEND_API_KEY ||
      process.env.RESEND_API_KEY === 'your_resend_key_here') {
    console.log('📧 Welcome email skipped — Resend not configured');
    console.log(`🔗 Password setup link for ${email}:`, resetLink);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const dashboardUrl = type === 'baker'
    ? `${process.env.APP_URL}/baker/dashboard`
    : `${process.env.APP_URL}/company/dashboard`;

  const roleLabel = type === 'baker' ? 'bakery partner' : 'company';

  await resend.emails.send({
    from:    `Colton at Delightmaker <${process.env.EMAIL_FROM || 'hello@delightmaker.ca'}>`,
    to:      email,
    subject: `You're approved! Set up your Delightmaker account 🧁`,
    html: `
      <!DOCTYPE html><html><head><style>
        body{font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2D2D2D;background:#FFFAF5}
        .card{background:white;border-radius:16px;padding:40px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
        h1{color:#2D2D2D;font-size:1.6rem;margin-bottom:8px}
        p{color:#555;line-height:1.7;margin-bottom:16px}
        .cta{display:inline-block;background:#FF6B6B;color:white;padding:14px 32px;border-radius:100px;text-decoration:none;font-weight:700;font-size:1rem;margin:8px 0 24px}
        .note{font-size:.85rem;color:#888;border-top:1px solid #eee;padding-top:16px;margin-top:16px}
        .logo{text-align:center;margin-bottom:24px;font-size:1.1rem;font-weight:700;color:#FF6B6B}
      </style></head><body>
        <div class="logo">🧁 Delightmaker</div>
        <div class="card">
          <h1>Welcome to Delightmaker, ${name}! 🎉</h1>
          <p>Your application for <strong>${orgName}</strong> has been approved. You're all set to get started as a Delightmaker ${roleLabel}.</p>
          <p>Click the button below to set your password and activate your account:</p>
          <a href="${resetLink}" class="cta">Set My Password & Get Started →</a>
          <p>Once you've set your password, log in at <a href="${process.env.APP_URL}/login">${process.env.APP_URL}/login</a> and you'll land on your dashboard.</p>
          <div class="note">
            <p>This link expires in 24 hours. If it expires, you can use "Forgot Password?" on the login page to get a new one.</p>
            <p>Questions? Reply to this email or reach us at <a href="mailto:hello@delightmaker.ca">hello@delightmaker.ca</a>.</p>
          </div>
        </div>
      </body></html>
    `,
  });

  console.log(`✅ Welcome email sent to ${email}`);
}


async function sendRejectionEmail(app) {
  if (!process.env.RESEND_API_KEY ||
      process.env.RESEND_API_KEY === 'your_resend_key_here') {
    console.log(`📧 Rejection email skipped — Resend not configured (${app.email})`);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from:    `Colton at Delightmaker <${process.env.EMAIL_FROM || 'hello@delightmaker.ca'}>`,
    to:      app.email,
    subject: `Your Delightmaker application — update`,
    html: `
      <!DOCTYPE html><html><head><style>
        body{font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2D2D2D;background:#FFFAF5}
        .card{background:white;border-radius:16px;padding:40px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
        h1{color:#2D2D2D;font-size:1.4rem;margin-bottom:8px}
        p{color:#555;line-height:1.7;margin-bottom:16px}
        .logo{text-align:center;margin-bottom:24px;font-size:1.1rem;font-weight:700;color:#FF6B6B}
      </style></head><body>
        <div class="logo">🧁 Delightmaker</div>
        <div class="card">
          <h1>Hi ${app.name},</h1>
          <p>Thank you for your interest in Delightmaker. After reviewing your application for <strong>${app.orgName}</strong>, we're not able to move forward at this time.</p>
          <p>We're currently focused on specific areas of Halifax and have limited capacity for new partners. This may change in the future.</p>
          <p>If you'd like to discuss further or re-apply down the road, please reach out directly at <a href="mailto:hello@delightmaker.ca">hello@delightmaker.ca</a>.</p>
          <p>Thanks again for your interest — we genuinely appreciate it.</p>
          <p>— Colton<br/><em>Founder, Delightmaker</em></p>
        </div>
      </body></html>
    `,
  });

  console.log(`📧 Rejection email sent to ${app.email}`);
}


async function sendWaitlistEmail(app) {
  if (!process.env.RESEND_API_KEY ||
      process.env.RESEND_API_KEY === 'your_resend_key_here') {
    console.log(`📧 Waitlist email skipped — Resend not configured (${app.email})`);
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const roleLabel = app.type === 'baker' ? 'bakery partner' : 'company';
  const emoji     = app.type === 'baker' ? '🧁' : '🏢';

  await resend.emails.send({
    from:    `Colton at Delightmaker <${process.env.EMAIL_FROM || 'hello@delightmaker.ca'}>`,
    to:      app.email,
    subject: `${emoji} You're on our waitlist, ${app.name.split(' ')[0]}!`,
    html: `
      <!DOCTYPE html><html><head><style>
        body        { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2D2D2D; background: #FFFAF5; }
        .logo       { text-align: center; margin-bottom: 24px; font-size: 1.1rem; font-weight: 700; color: #FF6B6B; }
        .card       { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
        h1          { color: #2D2D2D; font-size: 1.4rem; margin-bottom: 8px; }
        p           { color: #555; line-height: 1.75; margin-bottom: 16px; }
        .status-box {
          background:    #FFF8E7;
          border:        1.5px solid #F59E0B;
          border-radius: 12px;
          padding:       16px 20px;
          margin:        24px 0;
          display:       flex;
          align-items:   flex-start;
          gap:           12px;
        }
        .status-icon { font-size: 1.5rem; line-height: 1; }
        .status-text { font-size: .9rem; color: #7A5500; line-height: 1.6; }
        .status-text strong { color: #5C3D00; }
        .footer-note { font-size: .82rem; color: #AAA; text-align: center; margin-top: 24px; }
        .footer-note a { color: #FF6B6B; text-decoration: none; }
      </style></head>
      <body>
        <div class="logo">🧁 Delightmaker</div>
        <div class="card">
          <h1>Hi ${app.name.split(' ')[0]}! ${emoji}</h1>
          <p>
            Thanks for your application for <strong>${app.orgName}</strong> as a
            ${roleLabel} on Delightmaker. We've added you to our waitlist!
          </p>
          <div class="status-box">
            <div class="status-icon">⏸</div>
            <div class="status-text">
              <strong>You're on our waitlist.</strong><br/>
              We're growing our network carefully to make sure we can serve
              every partner well. As soon as a spot opens up, you'll be among
              the first to hear from us.
            </div>
          </div>
          <p>
            We'll be in touch by email the moment we're ready to bring you on board.
            In the meantime, if you have any questions just reply to this email —
            we read every message.
          </p>
          <p>Thanks for your patience and interest in Delightmaker!</p>
          <p>— Colton<br/><em>Founder, Delightmaker</em></p>
        </div>
        <div class="footer-note">
          <p>Delightmaker · Halifax, Nova Scotia 🇨🇦</p>
          <p><a href="${process.env.APP_URL}">delightmaker.ca</a></p>
        </div>
      </body></html>
    `,
  });

  console.log(`📧 Waitlist email sent to ${app.email}`);
}


/* ═══════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════ */

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;
