/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — STRIPE ROUTES
   One-time order payment webhook only.
   Subscription billing has been removed.
   All routes: /api/stripe/...
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  db,
  admin,
  COLLECTIONS,
  ORDER_STATUS,
  serverTimestamp,
  writeAuditLog,
} = require('../firebase/config');

const stripe = require('stripe')(
  process.env.STRIPE_SECRET_KEY
);


/* ═══════════════════════════════════════════════════
   GET /api/stripe/config
   Public — no auth
   Returns Stripe publishable key for checkout pages
   ═══════════════════════════════════════════════════ */

router.get('/config', (req, res) => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key || key.startsWith('pk_test_your')) {
    return res.status(503).json({
      error: 'Stripe not configured yet',
    });
  }
  return res.json({ publishableKey: key });
});


/* ═══════════════════════════════════════════════════
   POST /api/stripe/webhook
   Stripe webhook handler — handles one-time order
   approval payments.
   IMPORTANT: needs raw body — not JSON parsed.
   ═══════════════════════════════════════════════════ */

router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, secret
      );
    } catch (err) {
      console.error(
        '❌ Webhook signature verification failed:',
        err.message
      );
      return res.status(400).json({
        error: `Webhook error: ${err.message}`
      });
    }

    console.log(`📨 Stripe webhook: ${event.type}`);

    try {
      switch (event.type) {

        // ── Checkout session completed ─────────────
        // Handles one-time order approval payments
        case 'checkout.session.completed': {
          const session = event.data.object;
          const {
            orderId,
            tokenDocId,
            type,
          } = session.metadata || {};

          // ── Card saved for auto-approve ────────────
          if (
            session.mode === 'setup' &&
            session.metadata?.enableAutoApprove === 'true' &&
            session.metadata?.companyId
          ) {
            const cId = session.metadata.companyId;
            if (session.setup_intent) {
              try {
                const setupIntent =
                  await stripe.setupIntents.retrieve(
                    session.setup_intent
                  );
                if (setupIntent.payment_method) {
                  await stripe.customers.update(
                    session.customer,
                    {
                      invoice_settings: {
                        default_payment_method:
                          setupIntent.payment_method,
                      },
                    }
                  );
                }
              } catch (e) {
                console.warn(
                  'Could not set default PM:', e.message
                );
              }
            }
            await db
              .collection('giftingRules')
              .doc(cId)
              .set({ autoApprove: true }, { merge: true });
            console.log(
              `✅ Card saved + auto-approve enabled: ${cId}`
            );
          }

          // ── Order approval payment ─────────────────
          if (
            type === 'order_approval' &&
            orderId &&
            session.payment_status === 'paid'
          ) {
            const orderRef = db
              .collection(COLLECTIONS.ORDERS)
              .doc(orderId);
            const orderDoc = await orderRef.get();

            if (
              orderDoc.exists &&
              (orderDoc.data().status ===
                ORDER_STATUS.PENDING_CONFIRMATION ||
               orderDoc.data().status ===
                ORDER_STATUS.SCHEDULED)
            ) {
              if (tokenDocId) {
                await db
                  .collection('usedTokens')
                  .doc(tokenDocId)
                  .set({
                    usedAt:  serverTimestamp(),
                    orderId,
                    method:  'stripe_checkout_webhook',
                  });
              }

              await orderRef.update({
                status:          ORDER_STATUS.CONFIRMED,
                confirmedAt:     serverTimestamp(),
                confirmedBy:     'stripe_checkout',
                stripeSessionId: session.id,
                stripeChargeId:  session.payment_intent,
                chargeStatus:    'paid',
                chargedAt:       serverTimestamp(),
              });

              await writeAuditLog(
                'stripe_webhook',
                'confirm_order',
                'order',
                orderId,
                {
                  sessionId: session.id,
                  method:    'stripe_checkout',
                }
              );

              console.log(
                `✅ Order confirmed via webhook: ${orderId}`
              );

              const { autoRouteToBaker } =
                require('../functions/autoRoute');
              autoRouteToBaker(
                orderId, orderDoc.data()
              ).catch(err => console.error(
                'autoRouteToBaker error:', err.message
              ));

            } else {
              console.log(
                `ℹ️  Order ${orderId} already confirmed ` +
                `(webhook arrived after success page)`
              );
            }
          }

          break;
        }


        // ── Payment intent succeeded ───────────────
        case 'payment_intent.succeeded': {
          const intent = event.data.object;
          console.log(
            `✅ Payment succeeded: ${intent.id} ` +
            `— $${intent.amount / 100} CAD`
          );
          if (intent.metadata?.orderId) {
            await db
              .collection(COLLECTIONS.ORDERS)
              .doc(intent.metadata.orderId)
              .update({
                stripeChargeId: intent.id,
                chargeStatus:   'paid',
                chargedAt:      serverTimestamp(),
              });
          }
          break;
        }


        // ── Unhandled event ────────────────────────
        default:
          console.log(
            `ℹ️  Unhandled event type: ${event.type}`
          );
      }

      return res.status(200).json({ received: true });

    } catch (err) {
      console.error('❌ Webhook handler error:', err);
      return res.status(200).json({ received: true });
    }
  }
);


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;
