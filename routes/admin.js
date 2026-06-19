/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — ADMIN-ONLY ROUTES
   Destructive cascading operations
   Mount: /api/admin
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


function ensureAdmin(req, res) {
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' });
    return false;
  }
  return true;
}


/* Confirmation email to a deleted account holder.
   Only sent when a recipient email is provided (e.g. fulfilling a
   deletion request). Awaited so it sends before the function returns. */
function sendAccountDeletedEmail({ to, orgName }) {
  const key = process.env.RESEND_API_KEY;
  if (!to || !key || key === 'your_resend_key_here') return Promise.resolve();
  const { Resend } = require('resend');
  const resend  = new Resend(key);
  const support = process.env.EMAIL_SUPPORT || process.env.RESEND_FROM_EMAIL || 'support@delightmaker.ca';
  return resend.emails.send({
    from:    `${process.env.RESEND_FROM_NAME} <${support}>`,
    to,
    subject: 'Your Delightmaker account has been closed',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#FFFAF5">
        <div style="background:#1A1008;border-radius:12px 12px 0 0;padding:18px 24px;color:white;font-weight:700">🧁 Delightmaker</div>
        <div style="background:white;border:1px solid #eee;padding:28px">
          <h2 style="margin:0 0 10px;color:#1A1008">Your account has been closed</h2>
          <p style="color:#6B5444;margin:0 0 16px;line-height:1.6">
            As per your request, <strong>${orgName || 'your account'}</strong> has been removed from Delightmaker.
            Your login no longer works and no further orders or charges will be made.
          </p>
          <p style="color:#6B5444;margin:0 0 16px;line-height:1.6">
            Thank you for being part of Delightmaker — we're sorry to see you go. If you'd ever like to come
            back, you're always welcome to apply again.
          </p>
          <p style="color:#8B7260;font-size:0.85rem;margin:0">
            Think this was a mistake? Contact us right away at
            <a href="mailto:${support}" style="color:#C4621D;font-weight:700">${support}</a>.
          </p>
        </div>
        <div style="background:#F5F5F5;border:1px solid #eee;border-radius:0 0 12px 12px;padding:14px;text-align:center;font-size:0.75rem;color:#AAA">Delightmaker · Halifax, NS 🇨🇦</div>
      </div>`,
  }).catch(err => console.error('Account-deleted email failed:', err.message));
}


/* ═══════════════════════════════════════════════════
   DELETE /api/admin/companies/:id
   Hard delete a company. Cascades:
   - Auth user + user doc (forces re-application)
   - All employees of the company
   - Gifting rules
   KEEPS:
   - Orders and invoices (for accounting + Stripe refunds)
   - Stripe customer (so existing charges stay traceable)
   ═══════════════════════════════════════════════════ */
router.delete('/companies/:id',
  authenticate,
  async (req, res) => {
    if (!ensureAdmin(req, res)) return;

    const { id: companyId } = req.params;

    try {
      const companyRef = db.collection(COLLECTIONS.COMPANIES).doc(companyId);
      const companyDoc = await companyRef.get();

      if (!companyDoc.exists) {
        return res.status(404).json({ error: 'Company not found' });
      }

      const company = companyDoc.data();

      // Capture a notification address BEFORE we delete anything.
      // notifyEmail (passed when fulfilling a deletion request) wins;
      // otherwise fall back to the company's contact email.
      const notifyEmail = (req.body && req.body.notifyEmail) || company.contactEmail || null;
      const shouldNotify = !!(req.body && req.body.notifyEmail);

      // 1) Find + delete the auth account(s) for this company
      const usersSnap = await db
        .collection(COLLECTIONS.USERS)
        .where('companyId', '==', companyId)
        .get();

      const authDeletions = [];
      const userDocDeletions = [];

      for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        authDeletions.push(
          auth.deleteUser(uid).catch(err =>
            console.warn(`Auth delete failed for ${uid}:`, err.message)
          )
        );
        userDocDeletions.push(userDoc.ref.delete());
      }
      await Promise.all(authDeletions);
      await Promise.all(userDocDeletions);

      // 2) Delete all employees of this company
      const employeesSnap = await db
        .collection(COLLECTIONS.EMPLOYEES)
        .where('companyId', '==', companyId)
        .get();
      if (!employeesSnap.empty) {
        const batch = db.batch();
        employeesSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // 3) Delete gifting rules
      await db.collection(COLLECTIONS.GIFTING_RULES).doc(companyId).delete().catch(() => {});

      // 4) Delete the company doc itself
      await companyRef.delete();

      await writeAuditLog(
        req.user.uid,
        'delete_company',
        'company',
        companyId,
        {
          companyName: company.name,
          deletedUsers: usersSnap.size,
          deletedEmployees: employeesSnap.size,
        }
      );

      console.log(`🗑️  Company deleted: ${companyId} (${company.name}) — ${usersSnap.size} users, ${employeesSnap.size} employees`);

      // Confirmation email (only when fulfilling a request)
      if (shouldNotify) {
        await sendAccountDeletedEmail({ to: notifyEmail, orgName: company.name });
      }

      return res.status(200).json({
        success: true,
        deletedUsers:     usersSnap.size,
        deletedEmployees: employeesSnap.size,
      });

    } catch (err) {
      console.error('Delete company error:', err);
      return res.status(500).json({ error: err.message || 'Delete failed' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   DELETE /api/admin/bakeries/:id
   Hard delete a bakery. Cascades:
   - Auth user + user doc (forces re-application)
   - Products subcollection
   KEEPS:
   - Historical orders (bakerId/bakeryName are stored)
   ═══════════════════════════════════════════════════ */
router.delete('/bakeries/:id',
  authenticate,
  async (req, res) => {
    if (!ensureAdmin(req, res)) return;

    const { id: bakeryId } = req.params;

    try {
      const bakeryRef = db.collection(COLLECTIONS.BAKERIES).doc(bakeryId);
      const bakeryDoc = await bakeryRef.get();

      if (!bakeryDoc.exists) {
        return res.status(404).json({ error: 'Bakery not found' });
      }

      const bakery = bakeryDoc.data();

      // Capture notification address before deleting anything
      const notifyEmail = (req.body && req.body.notifyEmail) ||
                          bakery.contactEmail || bakery.contact || null;
      const shouldNotify = !!(req.body && req.body.notifyEmail);

      // 1) Delete auth account(s) tied to this bakery
      const usersSnap = await db
        .collection(COLLECTIONS.USERS)
        .where('bakerId', '==', bakeryId)
        .get();

      const authDeletions = [];
      const userDocDeletions = [];

      for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        authDeletions.push(
          auth.deleteUser(uid).catch(err =>
            console.warn(`Auth delete failed for ${uid}:`, err.message)
          )
        );
        userDocDeletions.push(userDoc.ref.delete());
      }
      await Promise.all(authDeletions);
      await Promise.all(userDocDeletions);

      // 2) Delete products subcollection
      const productsSnap = await bakeryRef.collection('products').get();
      if (!productsSnap.empty) {
        const batch = db.batch();
        productsSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // 3) Delete the bakery doc itself
      await bakeryRef.delete();

      await writeAuditLog(
        req.user.uid,
        'delete_bakery',
        'bakery',
        bakeryId,
        {
          bakeryName: bakery.name,
          deletedUsers: usersSnap.size,
          deletedProducts: productsSnap.size,
        }
      );

      console.log(`🗑️  Bakery deleted: ${bakeryId} (${bakery.name}) — ${usersSnap.size} users, ${productsSnap.size} products`);

      if (shouldNotify) {
        await sendAccountDeletedEmail({ to: notifyEmail, orgName: bakery.name });
      }

      return res.status(200).json({
        success: true,
        deletedUsers:    usersSnap.size,
        deletedProducts: productsSnap.size,
      });

    } catch (err) {
      console.error('Delete bakery error:', err);
      return res.status(500).json({ error: err.message || 'Delete failed' });
    }
  }
);


module.exports = router;
