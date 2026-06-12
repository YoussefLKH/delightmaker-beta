/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — ACCOUNT SETTINGS ROUTES
   Self-serve profile, notifications, account deletion.
   Mount: /api/settings
   (Password changes happen client-side via Firebase Auth.)
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  db,
  auth,
  admin,
  COLLECTIONS,
  authenticate,
  writeAuditLog,
} = require('../firebase/config');


/* ── Geocode helper (best-effort) ──────────────────── */
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
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch (err) {
    console.error('Geocoding error:', err.message);
  }
  return { lat: null, lng: null };
}


/* ── Security alert email ──────────────────────────────
   Sends a "your <thing> was changed" notice. Returns a
   promise you can await so Vercel doesn't kill it early.   */
function sendSecurityAlert({ to, kind, newEmailMasked }) {
  const key = process.env.RESEND_API_KEY;
  if (!to || !key || key === 'your_resend_key_here') return Promise.resolve();

  const { Resend } = require('resend');
  const resend = new Resend(key);

  const isEmail = kind === 'email';
  const title   = isEmail ? 'Your login email was changed' : 'Your password was changed';
  const detail  = isEmail
    ? `The email on your Delightmaker account was just changed${newEmailMasked ? ` to <strong>${newEmailMasked}</strong>` : ''}. You'll use the new address to sign in from now on.`
    : `The password on your Delightmaker account was just changed. You'll use your new password to sign in from now on.`;
  const support = process.env.EMAIL_SUPPORT || process.env.RESEND_FROM_EMAIL || 'support@delightmaker.ca';

  return resend.emails.send({
    from:    `${process.env.RESEND_FROM_NAME} <${support}>`,
    to,
    subject: `🔐 ${title}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#FFFAF5">
        <div style="background:#1A1008;border-radius:12px 12px 0 0;padding:18px 24px;color:white;font-weight:700">🔐 Security Notice</div>
        <div style="background:white;border:1px solid #eee;padding:28px">
          <h2 style="margin:0 0 10px;color:#1A1008">${title}</h2>
          <p style="color:#6B5444;margin:0 0 16px;line-height:1.6">${detail}</p>
          <div style="background:#FFF3CD;border:1px solid #FFD966;border-radius:10px;padding:14px 16px;margin:0 0 16px">
            <p style="margin:0;color:#7A5C00;font-size:0.9rem;line-height:1.6">
              <strong>Didn't do this?</strong> Your account may be compromised. Contact us right away at
              <a href="mailto:${support}" style="color:#C4621D;font-weight:700">${support}</a> and we'll help you secure it.
            </p>
          </div>
          <p style="color:#8B7260;font-size:0.82rem;margin:0">${new Date().toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short' })}</p>
        </div>
        <div style="background:#F5F5F5;border:1px solid #eee;border-radius:0 0 12px 12px;padding:14px;text-align:center;font-size:0.75rem;color:#AAA">Delightmaker · Halifax, NS 🇨🇦</div>
      </div>
    `,
  }).catch(err => console.error('Security alert email failed:', err.message));
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [user, domain] = email.split('@');
  const shown = user.slice(0, 1);
  return `${shown}${'*'.repeat(Math.max(2, user.length - 1))}@${domain}`;
}


/* ═══════════════════════════════════════════════════
   GET /api/settings/me
   Returns the profile + notification prefs for the
   logged-in user (role-aware).
   ═══════════════════════════════════════════════════ */
router.get('/me', authenticate, async (req, res) => {
  try {
    const { role, uid, companyId, bakerId } = req.user;

    const userDoc = await db.collection(COLLECTIONS.USERS).doc(uid).get();
    const user    = userDoc.exists ? userDoc.data() : {};

    const payload = {
      role,
      email:       user.email || '',
      displayName: user.displayName || '',
    };

    if (role === 'company_user' && companyId) {
      const cDoc = await db.collection(COLLECTIONS.COMPANIES).doc(companyId).get();
      const c = cDoc.exists ? cDoc.data() : {};
      payload.company = {
        name:                   c.name || '',
        contactName:            c.contactName || '',
        phone:                  c.phone || '',
        defaultDeliveryAddress: c.defaultDeliveryAddress || '',
      };
      const rDoc = await db.collection(COLLECTIONS.GIFTING_RULES).doc(companyId).get();
      payload.notifications = (rDoc.exists && rDoc.data().notifications) || {
        confirmation: true, delivery: true, monthly: true, ccEmail: '',
      };
    }

    if (role === 'baker' && bakerId) {
      const bDoc = await db.collection(COLLECTIONS.BAKERIES).doc(bakerId).get();
      const b = bDoc.exists ? bDoc.data() : {};
      payload.bakery = {
        name:        b.name || '',
        contactName: b.contactName || '',
        phone:       b.phone || '',
        address:     b.address || '',
        serviceArea: b.serviceArea || '',
        specialty:   b.specialty || [],
        allergenFree: !!b.allergenFree,
        glutenFree:   !!b.glutenFree,
        nutFree:      !!b.nutFree,
      };
      payload.notifications = b.notifications || {
        orderAssigned: true, weeklyDigest: true, payout: true, ccEmail: '',
      };
    }

    return res.json({ success: true, settings: payload });
  } catch (err) {
    console.error('GET /api/settings/me error:', err);
    return res.status(500).json({ error: 'Failed to load settings' });
  }
});


/* ═══════════════════════════════════════════════════
   PATCH /api/settings/profile
   Updates role-aware profile fields.
   ═══════════════════════════════════════════════════ */
router.patch('/profile', authenticate, async (req, res) => {
  try {
    const { role, uid, companyId, bakerId } = req.user;
    const body = req.body || {};

    if (role === 'admin') {
      const displayName = (body.displayName || '').trim();
      if (displayName.length < 2) {
        return res.status(400).json({ error: 'Name must be at least 2 characters' });
      }
      await db.collection(COLLECTIONS.USERS).doc(uid).update({ displayName });
      await auth.updateUser(uid, { displayName }).catch(() => {});
      return res.json({ success: true });
    }

    if (role === 'company_user') {
      if (!companyId) return res.status(403).json({ error: 'No company on account' });
      const name        = (body.name || '').trim();
      const contactName = (body.contactName || '').trim();
      const phone       = (body.phone || '').trim();
      const address     = (body.defaultDeliveryAddress || '').trim();

      if (name.length < 2) {
        return res.status(400).json({ error: 'Business name is required' });
      }

      const update = {
        name,
        contactName,
        phone,
        defaultDeliveryAddress: address,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Re-geocode if address provided
      if (address) {
        const geo = await geocodeAddress(address);
        update.addressLat = geo.lat;
        update.addressLng = geo.lng;
      }

      await db.collection(COLLECTIONS.COMPANIES).doc(companyId).update(update);
      return res.json({ success: true });
    }

    if (role === 'baker') {
      if (!bakerId) return res.status(403).json({ error: 'No bakery on account' });
      const name    = (body.name || '').trim();
      const phone   = (body.phone || '').trim();
      const address = (body.address || '').trim();

      if (name.length < 2) {
        return res.status(400).json({ error: 'Bakery name is required' });
      }

      const update = {
        name,
        contactName: (body.contactName || '').trim(),
        phone,
        address,
        serviceArea: (body.serviceArea || '').trim(),
        specialty: Array.isArray(body.specialty)
          ? body.specialty.map(s => String(s).trim()).filter(Boolean)
          : [],
        allergenFree: body.allergenFree === true,
        glutenFree:   body.glutenFree === true,
        nutFree:      body.nutFree === true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (address) {
        const geo = await geocodeAddress(address);
        update.addressLat = geo.lat;
        update.addressLng = geo.lng;
      }

      await db.collection(COLLECTIONS.BAKERIES).doc(bakerId).update(update);
      return res.json({ success: true });
    }

    return res.status(403).json({ error: 'Unsupported role' });
  } catch (err) {
    console.error('PATCH /api/settings/profile error:', err);
    return res.status(500).json({ error: 'Failed to save profile' });
  }
});


/* ═══════════════════════════════════════════════════
   PATCH /api/settings/email
   Change the account's login email. The client must
   reauthenticate (current password) before calling this.
   Updates Firebase Auth + the users doc + the org's
   contactEmail so notifications keep working.
   ═══════════════════════════════════════════════════ */
router.patch('/email', authenticate, async (req, res) => {
  try {
    const { role, uid, companyId, bakerId } = req.user;
    const newEmail = (req.body?.email || '').trim().toLowerCase();

    // Basic format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    // Already in use by a different account?
    try {
      const existing = await auth.getUserByEmail(newEmail);
      if (existing && existing.uid !== uid) {
        return res.status(400).json({ error: 'That email is already in use by another account' });
      }
    } catch (_) { /* not found = available */ }

    // Capture the OLD email first so we can alert it after the change
    let oldEmail = null;
    try {
      const cur = await auth.getUser(uid);
      oldEmail = cur.email || null;
    } catch (_) {}

    // No-op guard
    if (oldEmail && oldEmail.toLowerCase() === newEmail) {
      return res.status(400).json({ error: 'That is already your email' });
    }

    // Update Firebase Auth (admin-approved accounts are trusted → verified)
    await auth.updateUser(uid, { email: newEmail, emailVerified: true });

    // Update the users doc
    await db.collection(COLLECTIONS.USERS).doc(uid)
      .update({ email: newEmail }).catch(() => {});

    // Update the org's contact email so notifications go to the new address
    if (role === 'company_user' && companyId) {
      await db.collection(COLLECTIONS.COMPANIES).doc(companyId)
        .update({ contactEmail: newEmail }).catch(() => {});
    } else if (role === 'baker' && bakerId) {
      await db.collection(COLLECTIONS.BAKERIES).doc(bakerId)
        .update({ contactEmail: newEmail, contact: newEmail }).catch(() => {});
    }

    // Security alert to the OLD address (await so Vercel doesn't kill it)
    if (oldEmail) {
      await sendSecurityAlert({
        to: oldEmail,
        kind: 'email',
        newEmailMasked: maskEmail(newEmail),
      });
    }

    console.log(`✉️  Email changed for ${role} ${uid} → ${newEmail}`);
    return res.json({ success: true, email: newEmail });

  } catch (err) {
    console.error('PATCH /api/settings/email error:', err);
    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'That email is already in use' });
    }
    return res.status(500).json({ error: 'Failed to change email' });
  }
});


/* ═══════════════════════════════════════════════════
   POST /api/settings/notify-password-change
   Called by the client right after a successful password
   update (which happens client-side via Firebase). Sends
   a security alert to the account's current email.
   ═══════════════════════════════════════════════════ */
router.post('/notify-password-change', authenticate, async (req, res) => {
  try {
    const { uid } = req.user;
    let email = null;
    try {
      const cur = await auth.getUser(uid);
      email = cur.email || null;
    } catch (_) {}

    if (email) {
      await sendSecurityAlert({ to: email, kind: 'password' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('notify-password-change error:', err);
    // Non-critical — never block the client on this
    return res.json({ success: true });
  }
});


/* ═══════════════════════════════════════════════════
   PATCH /api/settings/notifications
   Company → giftingRules.notifications
   Baker   → bakeries.notifications
   ═══════════════════════════════════════════════════ */
router.patch('/notifications', authenticate, async (req, res) => {
  try {
    const { role, companyId, bakerId } = req.user;
    const n = req.body || {};
    const ccEmail = (n.ccEmail || '').trim().toLowerCase();

    if (role === 'company_user') {
      if (!companyId) return res.status(403).json({ error: 'No company on account' });
      await db.collection(COLLECTIONS.GIFTING_RULES).doc(companyId).set({
        notifications: {
          confirmation: n.confirmation !== false,
          delivery:     n.delivery     !== false,
          monthly:      n.monthly      !== false,
          ccEmail,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.json({ success: true });
    }

    if (role === 'baker') {
      if (!bakerId) return res.status(403).json({ error: 'No bakery on account' });
      await db.collection(COLLECTIONS.BAKERIES).doc(bakerId).update({
        notifications: {
          orderAssigned: n.orderAssigned !== false,
          weeklyDigest:  n.weeklyDigest  !== false,
          payout:        n.payout        !== false,
          ccEmail,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ success: true });
    }

    return res.status(403).json({ error: 'Notifications not available for this role' });
  } catch (err) {
    console.error('PATCH /api/settings/notifications error:', err);
    return res.status(500).json({ error: 'Failed to save notifications' });
  }
});


/* ═══════════════════════════════════════════════════
   DELETE /api/settings/account
   Self-serve cascading delete.
   Company: login + employees + gifting rules + company doc
   Baker:   login + products + bakery doc
   Keeps orders/invoices for accounting.
   Admin cannot self-delete.
   ═══════════════════════════════════════════════════ */
router.delete('/account', authenticate, async (req, res) => {
  try {
    const { role, uid, companyId, bakerId } = req.user;

    if (role === 'admin') {
      return res.status(403).json({ error: 'Admin accounts cannot be self-deleted' });
    }

    if (role === 'company_user') {
      if (!companyId) return res.status(403).json({ error: 'No company on account' });

      // Employees
      const empSnap = await db.collection(COLLECTIONS.EMPLOYEES)
        .where('companyId', '==', companyId).get();
      if (!empSnap.empty) {
        const batch = db.batch();
        empSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // Gifting rules
      await db.collection(COLLECTIONS.GIFTING_RULES).doc(companyId).delete().catch(() => {});

      // All users tied to this company
      const usersSnap = await db.collection(COLLECTIONS.USERS)
        .where('companyId', '==', companyId).get();
      for (const u of usersSnap.docs) {
        await auth.deleteUser(u.id).catch(() => {});
        await u.ref.delete().catch(() => {});
      }

      // Company doc
      await db.collection(COLLECTIONS.COMPANIES).doc(companyId).delete();

      await writeAuditLog(uid, 'self_delete_company', 'company', companyId, {
        deletedEmployees: empSnap.size,
      });

      console.log(`🗑️  Company self-deleted: ${companyId}`);
      return res.json({ success: true });
    }

    if (role === 'baker') {
      if (!bakerId) return res.status(403).json({ error: 'No bakery on account' });

      // Products
      const prodSnap = await db.collection(COLLECTIONS.BAKERIES)
        .doc(bakerId).collection('products').get();
      if (!prodSnap.empty) {
        const batch = db.batch();
        prodSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // Users tied to this bakery
      const usersSnap = await db.collection(COLLECTIONS.USERS)
        .where('bakerId', '==', bakerId).get();
      for (const u of usersSnap.docs) {
        await auth.deleteUser(u.id).catch(() => {});
        await u.ref.delete().catch(() => {});
      }

      // Bakery doc
      await db.collection(COLLECTIONS.BAKERIES).doc(bakerId).delete();

      await writeAuditLog(uid, 'self_delete_bakery', 'bakery', bakerId, {
        deletedProducts: prodSnap.size,
      });

      console.log(`🗑️  Bakery self-deleted: ${bakerId}`);
      return res.json({ success: true });
    }

    return res.status(403).json({ error: 'Unsupported role' });
  } catch (err) {
    console.error('DELETE /api/settings/account error:', err);
    return res.status(500).json({ error: err.message || 'Delete failed' });
  }
});


module.exports = router;
