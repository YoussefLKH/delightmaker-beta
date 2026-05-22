/* ═══════════════════════════════════════════════════
   autoRoute.js
   Auto-routes a confirmed+paid order to its bakery.
   Called after Stripe payment succeeds.

   Looks up the bakeryId from the order's line items,
   fetches the bakery from Firestore, marks the order
   as ROUTED, and emails the bakery if a contactEmail
   is set on their profile in the admin bakeries page.
   ═══════════════════════════════════════════════════ */

'use strict';

const {
  db,
  COLLECTIONS,
  ORDER_STATUS,
  serverTimestamp,
} = require('../firebase/config');


async function autoRouteToBaker(orderId, order) {
  try {

    // ── Get bakeryId from first line item ──────────
    let bakeryId = order.lineItems?.[0]?.bakeryId;
    let bakeryDoc;

    if (!bakeryId) {
      // Fall back to first active bakery in Firestore
      console.log(
        `⚠️  No bakeryId on order ${orderId} ` +
        `— falling back to first active bakery`
      );

      const fallbackSnap = await db
        .collection(COLLECTIONS.BAKERIES)
        .where('active', '==', true)
        .limit(1)
        .get();

      if (fallbackSnap.empty) {
        console.log(
          `❌ No active bakeries found ` +
          `— cannot auto-route order ${orderId}`
        );
        return;
      }

      bakeryDoc = fallbackSnap.docs[0];
      bakeryId  = bakeryDoc.id;
      console.log(
        `↩️  Using fallback bakery: ${bakeryId}`
      );

    } else {
      // ── Look up bakery in Firestore ────────────────
      bakeryDoc = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakeryId)
        .get();

      if (!bakeryDoc.exists) {
        // Bakery deleted — fall back to first active
        console.log(
          `⚠️  Bakery ${bakeryId} not found ` +
          `— falling back to first active bakery`
        );

        const fallbackSnap = await db
          .collection(COLLECTIONS.BAKERIES)
          .where('active', '==', true)
          .limit(1)
          .get();

        if (fallbackSnap.empty) {
          console.log(
            `❌ No active bakeries found ` +
            `— cannot auto-route order ${orderId}`
          );
          return;
        }

        bakeryDoc = fallbackSnap.docs[0];
        bakeryId  = bakeryDoc.id;
        console.log(
          `↩️  Using fallback bakery: ${bakeryId}`
        );
      }
    }

    const bakery = bakeryDoc.data();


    // ── Mark order as ROUTED ───────────────────────
    await db
      .collection(COLLECTIONS.ORDERS)
      .doc(orderId)
      .update({
        status:     ORDER_STATUS.ROUTED,
        bakerId:    bakeryId,
        bakeryName: bakery.name || '',
        routedAt:   serverTimestamp(),
      });


    // ── Email baker ────────────────────────────────
    // contactEmail is the canonical field; fall back to
    // legacy 'contact' field for older bakery docs
    const bakerEmail = bakery.contactEmail || bakery.contact || null;

    if (bakerEmail) {
      const { notifyBakerNewOrder } =
        require('../routes/orders');

      await notifyBakerNewOrder(
        orderId,
        {
          ...order,
          bakerId:    bakeryId,
          bakeryName: bakery.name,
        },
        { ...bakery, contactEmail: bakerEmail }
      );

      console.log(
        `✅ Auto-routed order ${orderId} → ` +
        `${bakery.name} (${bakerEmail})`
      );

    } else {
      console.log(
        `✅ Auto-routed order ${orderId} → ` +
        `${bakery.name} ` +
        `(no contactEmail on bakery doc — add it in the bakeries page)`
      );
    }

  } catch (err) {
    console.error(
      `❌ autoRouteToBaker error for ${orderId}:`,
      err.message
    );
  }
}


module.exports = { autoRouteToBaker };
