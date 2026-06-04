/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — SHARED ORDER CONFIRMATION
   Single source of truth for what happens when a paid
   order is confirmed. Called by BOTH the Stripe webhook
   and the /approve/success redirect, so whichever fires
   first does the full job (idempotent — only runs once).

   On confirm it:
     1. Flips status → confirmed + records the charge
     2. Marks any approval token as used
     3. Emails the company a confirmation
     4. Emails the admin a "payment received" alert
     5. Auto-routes to the bakery (which emails the baker)
   ═══════════════════════════════════════════════════ */

'use strict';

const {
  db,
  COLLECTIONS,
  ORDER_STATUS,
  serverTimestamp,
  writeAuditLog,
} = require('../firebase/config');


function fmtDate(deliveryDate) {
  if (!deliveryDate) return 'your scheduled date';
  const secs = deliveryDate._seconds || deliveryDate.seconds;
  if (!secs) return 'your scheduled date';
  return new Date(secs * 1000).toLocaleDateString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}


/**
 * Confirm a paid order. Idempotent: if the order is already
 * past pending/scheduled, it does nothing and returns false.
 *
 * @param {string} orderId
 * @param {object} payment { sessionId, paymentIntent, amountTotalCents, tokenDocId, method }
 * @returns {Promise<boolean>} true if it performed the confirmation
 */
async function confirmPaidOrder(orderId, payment = {}) {
  const {
    sessionId        = null,
    paymentIntent    = null,
    amountTotalCents = null,
    tokenDocId       = null,
    method           = 'stripe_checkout',
  } = payment;

  const orderRef = db.collection(COLLECTIONS.ORDERS).doc(orderId);
  const orderDoc = await orderRef.get();

  if (!orderDoc.exists) {
    console.warn(`confirmPaidOrder: order ${orderId} not found`);
    return false;
  }

  const order  = orderDoc.data();
  const status = order.status;

  // Only confirm orders that are awaiting payment/approval
  if (status !== ORDER_STATUS.PENDING_CONFIRMATION &&
      status !== ORDER_STATUS.SCHEDULED) {
    // Already handled by the other path — nothing to do
    return false;
  }

  // 1) Mark token used (if any)
  if (tokenDocId) {
    await db.collection('usedTokens').doc(tokenDocId).set({
      usedAt:  serverTimestamp(),
      orderId,
      method,
    }).catch(() => {});
  }

  // 2) Confirm + record charge
  await orderRef.update({
    status:          ORDER_STATUS.CONFIRMED,
    confirmedAt:     serverTimestamp(),
    confirmedBy:     method,
    stripeSessionId: sessionId,
    stripeChargeId:  paymentIntent,
    chargeStatus:    'paid',
    chargedAt:       serverTimestamp(),
  });

  await writeAuditLog(method, 'confirm_order', 'order', orderId, {
    sessionId, method,
  }).catch(() => {});

  console.log(`✅ Order confirmed (${method}): ${orderId}`);

  // ── Emails ──────────────────────────────────────
  const resendKey = process.env.RESEND_API_KEY;
  const emailsOn  = resendKey && resendKey !== 'your_resend_key_here';

  if (emailsOn) {
    const { Resend } = require('resend');
    const resend = new Resend(resendKey);

    const delivStr = fmtDate(order.deliveryDate);
    const amtStr   = amountTotalCents
      ? `$${(amountTotalCents / 100).toFixed(2)} CAD`
      : (typeof order.chargeAmount === 'number'
          ? `$${order.chargeAmount.toFixed(2)} CAD` : '');
    const recipient = order.oneOff
      ? (order.celebrationName || order.employeeName || 'your event')
      : `${order.employeeName}'s birthday`;

    // Resolve company contact + name
    let companyEmail = null;
    let companyName  = order.companyName || '';
    if (order.companyId) {
      try {
        const cDoc = await db.collection(COLLECTIONS.COMPANIES)
          .doc(order.companyId).get();
        if (cDoc.exists) {
          companyEmail = cDoc.data().contactEmail || null;
          companyName  = cDoc.data().name || companyName;
        }
      } catch (_) {}
    }

    // 3) Company confirmation
    if (companyEmail) {
      resend.emails.send({
        from:    `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`,
        to:      companyEmail,
        subject: `✅ Order confirmed — ${recipient}`,
        html: `
          <!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
          <body style="font-family:Arial,sans-serif;background:#FFFAF5;margin:0;padding:24px">
            <div style="max-width:520px;margin:0 auto">
              <div style="background:#C4621D;border-radius:12px 12px 0 0;padding:20px 24px;text-align:center;color:white;font-size:1.1rem;font-weight:700">🧁 Delightmaker</div>
              <div style="background:white;border:1px solid #eee;padding:28px">
                <h2 style="margin:0 0 6px;color:#1A1008">✅ You're all set!</h2>
                <p style="color:#8B7260;margin:0 0 20px;font-size:0.92rem">Your payment went through and the order is confirmed. We've sent it to the bakery — no further action needed.</p>
                <div style="background:#FFFAF5;border:1px solid #EADBCB;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                  <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
                    <tr style="border-bottom:1px solid #F0EBE3"><td style="padding:7px 0;color:#8B7260">For</td><td style="padding:7px 0;font-weight:700;text-align:right">${recipient}</td></tr>
                    <tr style="border-bottom:1px solid #F0EBE3"><td style="padding:7px 0;color:#8B7260">Treat</td><td style="padding:7px 0;font-weight:700;text-align:right">${order.productName || 'Bundle'}</td></tr>
                    <tr style="border-bottom:1px solid #F0EBE3"><td style="padding:7px 0;color:#8B7260">Delivery</td><td style="padding:7px 0;font-weight:700;text-align:right;color:#C4621D">${delivStr}</td></tr>
                    ${amtStr ? `<tr><td style="padding:7px 0;color:#8B7260"><strong>Paid</strong></td><td style="padding:7px 0;font-weight:700;text-align:right;color:#2E7D32">${amtStr}</td></tr>` : ''}
                  </table>
                </div>
                <p style="color:#8B7260;font-size:0.82rem;margin:0">We'll email you again once it's delivered. 🎉</p>
              </div>
              <div style="background:#F5F5F5;border:1px solid #eee;border-radius:0 0 12px 12px;padding:14px;text-align:center;font-size:0.75rem;color:#AAA">Delightmaker · Halifax, NS 🇨🇦</div>
            </div>
          </body></html>
        `,
      }).catch(err => console.error('Company confirmation email failed:', err.message));
    }

    // 4) Admin alert
    if (process.env.ADMIN_EMAIL) {
      resend.emails.send({
        from:    `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`,
        to:      process.env.ADMIN_EMAIL,
        subject: `💳 Payment received — ${recipient} (${amtStr || 'paid'})`,
        html: `
          <!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
          <body style="font-family:Arial,sans-serif;background:#FFFAF5;margin:0;padding:24px">
            <div style="max-width:520px;margin:0 auto">
              <div style="background:#2D2D2D;border-radius:12px 12px 0 0;padding:20px 24px;text-align:center;color:white;font-size:1.1rem;font-weight:700">🧁 Delightmaker</div>
              <div style="background:white;border:1px solid #eee;padding:28px">
                <h2 style="margin:0 0 6px;color:#2D2D2D">💳 Payment Received</h2>
                <p style="color:#888;margin:0 0 20px;font-size:0.9rem">${order.oneOff ? 'A company paid for a one-off order.' : 'A company approved and paid for an order.'}</p>
                <div style="background:#FFFAF5;border:2px solid #FFD93D;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                  <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
                    <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Company</td><td style="padding:7px 0;font-weight:700;text-align:right">${companyName || order.companyId}</td></tr>
                    <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">For</td><td style="padding:7px 0;font-weight:700;text-align:right">${recipient}</td></tr>
                    <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Treat</td><td style="padding:7px 0;font-weight:700;text-align:right">${order.productName || 'Bundle'}</td></tr>
                    <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Delivery</td><td style="padding:7px 0;font-weight:700;text-align:right;color:#FF6B6B">${delivStr}</td></tr>
                    ${amtStr ? `<tr><td style="padding:7px 0;color:#888"><strong>Amount paid</strong></td><td style="padding:7px 0;font-weight:700;text-align:right;font-size:1.05rem;color:#2E7D32">${amtStr}</td></tr>` : ''}
                  </table>
                </div>
                <p style="color:#888;font-size:0.82rem;margin:0">Order has been auto-routed to the baker.</p>
              </div>
              <div style="background:#F5F5F5;border:1px solid #eee;border-radius:0 0 12px 12px;padding:14px;text-align:center;font-size:0.75rem;color:#AAA">Delightmaker · Halifax, NS 🇨🇦 · <a href="${process.env.APP_URL}/admin/orders" style="color:#FF6B6B">View order →</a></div>
            </div>
          </body></html>
        `,
      }).catch(err => console.error('Admin payment notification failed:', err.message));
    }
  }

  // 5) Auto-route to baker (emails the baker)
  try {
    const { autoRouteToBaker } = require('./autoRoute');
    await autoRouteToBaker(orderId, order);
  } catch (err) {
    console.error('autoRouteToBaker error:', err.message);
  }

  return true;
}


module.exports = { confirmPaidOrder };
