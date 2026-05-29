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
