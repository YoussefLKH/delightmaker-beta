/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — ORDERS ROUTES
   Complete order management
   All routes: /api/orders/...
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');

const {
  db,
  admin,
  COLLECTIONS,
  ORDER_STATUS,
  ROLES,
  serverTimestamp,
  writeAuditLog,
  authenticate,
  requireAdmin,
  requireCompanyUser,
  getNextOccurrence,
  EVENT_TYPES,
} = require('../firebase/config');

const { Resend } = require('resend');

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

function isResendConfigured() {
  return process.env.RESEND_API_KEY &&
         process.env.RESEND_API_KEY !== 'your_resend_key_here' &&
         !process.env.RESEND_API_KEY.includes('placeholder');
}

const EMAIL_FROM = () =>
  `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`;


/* ═══════════════════════════════════════════════════
   GET /api/orders
   Admin: gets ALL orders
   Company: gets only THEIR orders
   Baker: gets only orders assigned to THEIR bakery
   ═══════════════════════════════════════════════════ */

router.get('/',
  authenticate,
  async (req, res) => {
    try {

      const {
        status,
        companyId,
        bakerId,
        limit  = 50,
        days   = 14,
      } = req.query;

      const role = req.user.role;
      let query  = db.collection(COLLECTIONS.ORDERS);


      // ── Filter by role ────────────────────────────
      if (role === ROLES.ADMIN) {
        // Admin sees everything
        // Optional filters from query params
        if (companyId) {
          query = query.where(
            'companyId', '==', companyId
          );
        }
        if (bakerId) {
          query = query.where(
            'bakerId', '==', bakerId
          );
        }

      } else if (role === ROLES.COMPANY_USER) {
        // Company sees only their orders
        const userCompanyId = req.user.companyId;
        if (!userCompanyId) {
          return res.status(403).json({
            error: 'No company associated with account'
          });
        }
        query = query.where(
          'companyId', '==', userCompanyId
        );

      } else if (role === ROLES.BAKER) {
        // Baker sees only their assigned orders
        const userBakerId = req.user.bakerId;
        if (!userBakerId) {
          return res.status(403).json({
            error: 'No bakery associated with account'
          });
        }
        query = query.where(
          'bakerId', '==', userBakerId
        );

      } else {
        return res.status(403).json({
          error: 'Unauthorized role'
        });
      }


      // ── Filter by status ──────────────────────────
      if (status) {
        query = query.where('status', '==', status);
      }


      // ── Filter by upcoming days ───────────────────
      if (days && !status) {
        const futureDate = new Date();
        futureDate.setDate(
          futureDate.getDate() + parseInt(days)
        );
        query = query.where(
          'deliveryDate', '<=',
          admin.firestore.Timestamp.fromDate(futureDate)
        );
      }


      // ── Order by delivery date ────────────────────
      query = query
        .orderBy('deliveryDate', 'asc')
        .limit(parseInt(limit));

      const snapshot = await query.get();

      const orders = snapshot.docs.map(doc =>
        formatOrder(doc)
      );

      return res.status(200).json({
        success: true,
        count:   orders.length,
        orders,
      });

    } catch (err) {
      console.error('Get orders error:', err);
      return res.status(500).json({
        error: 'Failed to get orders'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   GET /api/orders/:id
   Get single order detail
   ═══════════════════════════════════════════════════ */

router.get('/:id',
  authenticate,
  async (req, res) => {
    try {

      const { id }  = req.params;
      const role    = req.user.role;

      const orderDoc = await db
        .collection(COLLECTIONS.ORDERS)
        .doc(id)
        .get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();


      // ── Check access ──────────────────────────────
      if (role === ROLES.COMPANY_USER &&
          order.companyId !== req.user.companyId) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      if (role === ROLES.BAKER &&
          order.bakerId !== req.user.bakerId) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }


      return res.status(200).json({
        success: true,
        order:   formatOrder(orderDoc),
      });

    } catch (err) {
      console.error('Get order error:', err);
      return res.status(500).json({
        error: 'Failed to get order'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/orders
   Admin only — manually create an order
   (Scheduler auto-creates most orders)
   ═══════════════════════════════════════════════════ */

router.post('/',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const {
        companyId,
        employeeId,
        productId,
        deliveryDate,
        eventType,
        customMessage,
        deliveryAddress,
        chargeAmount,
        wholesaleCost,
      } = req.body;


      // ── Validate ──────────────────────────────────
      const errors = [];
      if (!companyId)      errors.push('Company ID required');
      if (!employeeId)     errors.push('Employee ID required');
      if (!productId)      errors.push('Product ID required');
      if (!deliveryDate)   errors.push('Delivery date required');
      if (!eventType)      errors.push('Event type required');
      if (!deliveryAddress)errors.push('Delivery address required');

      if (errors.length > 0) {
        return res.status(400).json({
          error:   'Validation failed',
          details: errors,
        });
      }


      // ── Verify company + employee + product exist ─
      const [companyDoc, employeeDoc, productDoc] =
        await Promise.all([
          db.collection(COLLECTIONS.COMPANIES)
            .doc(companyId).get(),
          db.collection(COLLECTIONS.EMPLOYEES)
            .doc(employeeId).get(),
          db.collection(COLLECTIONS.PRODUCTS)
            .doc(productId).get(),
        ]);

      if (!companyDoc.exists) {
        return res.status(404).json({
          error: 'Company not found'
        });
      }
      if (!employeeDoc.exists) {
        return res.status(404).json({
          error: 'Employee not found'
        });
      }
      if (!productDoc.exists) {
        return res.status(404).json({
          error: 'Product not found'
        });
      }

      const employee = employeeDoc.data();
      const product  = productDoc.data();


      // ── Check for duplicate order ─────────────────
      const deliveryDateObj = new Date(deliveryDate);
      const existing = await db
        .collection(COLLECTIONS.ORDERS)
        .where('employeeId',   '==', employeeId)
        .where('eventType',    '==', eventType)
        .where('deliveryDate', '==',
          admin.firestore.Timestamp
            .fromDate(deliveryDateObj))
        .limit(1)
        .get();

      if (!existing.empty) {
        return res.status(409).json({
          error: 'Order already exists for this ' +
                 'employee and event'
        });
      }


      // ── Create order ──────────────────────────────
      const newOrder = {
        companyId,
        employeeId,
        employeeName:    employee.name || '',
        productId,
        productName:     product.name  || '',
        bakerId:         product.bakerDefaultId || null,
        deliveryDate:    admin.firestore.Timestamp
                           .fromDate(deliveryDateObj),
        eventType,
        status:          ORDER_STATUS.SCHEDULED,
        dietaryFlags:    employee.dietaryFlags || [],
        deliveryAddress: deliveryAddress ||
                         employee.deliveryAddress || '',
        customMessage:   customMessage || '',
        chargeAmount:    chargeAmount ||
                         product.retailPrice || 0,
        wholesaleCost:   wholesaleCost ||
                         product.wholesaleCost || 0,
        confirmationSentAt: null,
        confirmedAt:        null,
        routedAt:           null,
        deliveredAt:        null,
        stripeChargeId:     null,
        createdAt:          serverTimestamp(),
        createdBy:          'admin',
      };

      const orderRef = await db
        .collection(COLLECTIONS.ORDERS)
        .add(newOrder);


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'create_order',
        'order',
        orderRef.id,
        { companyId, employeeId, eventType }
      );

      console.log(
        `✅ Order created manually: ${orderRef.id}`
      );

      return res.status(201).json({
        success: true,
        message: 'Order created',
        orderId: orderRef.id,
      });

    } catch (err) {
      console.error('Create order error:', err);
      return res.status(500).json({
        error: 'Failed to create order'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/orders/oneoff
   Company user or admin
   Creates a one-off order for a company-wide event
   (not tied to a specific employee). Bundle is from
   a single bakery. Status starts as pending_confirmation
   and must be paid via Stripe Checkout before routing.
   ═══════════════════════════════════════════════════ */

router.post('/oneoff',
  authenticate,
  async (req, res) => {
    try {

      const {
        companyId,
        eventName,
        bakerId,
        bundle,            // [{ treatType, qty }]
        deliveryDate,
        deliveryAddress,
        notes,
      } = req.body;

      const role = req.user.role;

      // Company users can only create for their own company
      if (role === 'company_user' &&
          req.user.companyId !== companyId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (role !== 'company_user' && role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // ── Validate ──────────────────────────────────
      const errors = [];
      if (!companyId)       errors.push('Company ID required');
      if (!eventName)       errors.push('Event name required');
      if (!bakerId)         errors.push('Bakery selection required');
      if (!Array.isArray(bundle) || bundle.length === 0) {
        errors.push('At least one treat required');
      }
      if (!deliveryDate)    errors.push('Delivery date required');
      if (!deliveryAddress) errors.push('Delivery address required');

      if (errors.length > 0) {
        return res.status(400).json({
          error: errors[0],
          details: errors,
        });
      }

      // Delivery date must be in the future
      const deliveryDateObj = new Date(deliveryDate + 'T09:00:00.000Z');
      if (isNaN(deliveryDateObj) || deliveryDateObj <= new Date()) {
        return res.status(400).json({
          error: 'Delivery date must be in the future',
        });
      }

      // ── Verify company + bakery exist ─────────────
      const [companyDoc, bakeryDoc] = await Promise.all([
        db.collection(COLLECTIONS.COMPANIES).doc(companyId).get(),
        db.collection(COLLECTIONS.BAKERIES).doc(bakerId).get(),
      ]);

      if (!companyDoc.exists) {
        return res.status(404).json({ error: 'Company not found' });
      }
      if (!bakeryDoc.exists) {
        return res.status(404).json({ error: 'Bakery not found' });
      }

      const company = companyDoc.data();
      const bakery  = bakeryDoc.data();

      // ── Build line items + total from bakery products ─
      const lineItems = [];
      let chargeAmount  = 0;
      let wholesaleCost = 0;

      for (const item of bundle) {
        if (!item.treatType) continue;
        const qty = Math.max(1, parseInt(item.qty) || 1);

        const productDoc = await db
          .collection(COLLECTIONS.BAKERIES)
          .doc(bakerId)
          .collection('products')
          .doc(item.treatType)
          .get();

        if (!productDoc.exists) {
          return res.status(400).json({
            error: `Treat "${item.treatType}" not found at this bakery`,
          });
        }

        const p             = productDoc.data();
        const unitPrice     = p.price         || p.retailPrice || 0;
        const wholesaleUnit = p.wholesaleCost || 0;

        lineItems.push({
          bakeryId:      bakerId,
          treatType:     item.treatType,
          productName:   p.name || item.treatType,
          qty,
          unitPrice,
          lineTotal:     unitPrice * qty,
          wholesaleCost: wholesaleUnit * qty,
        });

        chargeAmount  += unitPrice     * qty;
        wholesaleCost += wholesaleUnit * qty;
      }

      if (lineItems.length === 0) {
        return res.status(400).json({
          error: 'No valid treats in bundle',
        });
      }

      const productSummary = lineItems.length === 1
        ? lineItems[0].productName
        : `One-off Bundle (${lineItems.length} items)`;

      // ── Create order (status: pending_confirmation) ─
      const newOrder = {
        companyId,
        companyName:        company.name || '',
        employeeId:         null,
        employeeName:       eventName,         // shown as recipient
        celebrationName:    eventName,
        bakerId,
        bakeryName:         bakery.name || '',
        lineItems,
        productName:        productSummary,
        eventType:          EVENT_TYPES.CELEBRATION,
        oneOff:             true,
        status:             ORDER_STATUS.PENDING_CONFIRMATION,
        dietaryFlags:       [],
        deliveryAddress,
        bakerNotes:         notes || '',
        chargeAmount,
        wholesaleCost,
        deliveryDate:       admin.firestore.Timestamp.fromDate(deliveryDateObj),
        confirmationSentAt: null,
        confirmedAt:        null,
        routedAt:           null,
        deliveredAt:        null,
        stripeChargeId:     null,
        chargeStatus:       'pending',
        createdAt:          serverTimestamp(),
        createdBy:          req.user.uid,
        createdVia:         'company_oneoff',
      };

      const orderRef = await db
        .collection(COLLECTIONS.ORDERS)
        .add(newOrder);

      console.log(
        `🛒 One-off order created: ${orderRef.id} ` +
        `("${eventName}" — ${deliveryDateObj.toDateString()}) ` +
        `$${chargeAmount.toFixed(2)} CAD`
      );

      return res.status(200).json({
        success:      true,
        orderId:      orderRef.id,
        chargeAmount,
      });

    } catch (err) {
      console.error('One-off order error:', err);
      return res.status(500).json({
        error: 'Failed to create one-off order',
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/checkout-session
   Company user or admin
   Creates a Stripe Checkout session for approving
   an order from the dashboard (authenticated flow).
   Returns { url } — redirect the browser there.
   ═══════════════════════════════════════════════════ */

router.post('/:id/checkout-session',
  authenticate,
  async (req, res) => {
    try {

      const { id }   = req.params;
      const role     = req.user.role;
      const stripe   = require('stripe')(
        process.env.STRIPE_SECRET_KEY
      );


      // ── Get order ─────────────────────────────────
      const orderDoc = await db
        .collection(COLLECTIONS.ORDERS)
        .doc(id)
        .get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();

      // Company users can only pay for their company
      if (
        role === 'company_user' &&
        req.user.companyId !== order.companyId
      ) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      if (
        order.status !== ORDER_STATUS.PENDING_CONFIRMATION &&
        order.status !== ORDER_STATUS.SCHEDULED
      ) {
        return res.status(400).json({
          error: 'Order is not pending confirmation'
        });
      }


      // ── Get or create Stripe customer ──────────────
      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(order.companyId)
        .get();

      const company = companyDoc.exists
        ? companyDoc.data()
        : {};

      let stripeCustomerId = company.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer =
          await stripe.customers.create({
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
      }


      // ── Build Stripe line items ────────────────────
      const lineItems =
        order.lineItems && order.lineItems.length > 0
          ? order.lineItems.map(item => ({
              price_data: {
                currency:     'cad',
                product_data: {
                  name: item.productName ||
                        item.treatType,
                  description:
                    `🎂 For ${order.employeeName}` +
                    `'s birthday`,
                },
                unit_amount: Math.round(
                  (item.unitPrice || 0) * 100
                ),
              },
              quantity: item.qty || 1,
            }))
          : [{
              price_data: {
                currency:     'cad',
                product_data: {
                  name: order.productName ||
                        'Birthday Treat',
                  description:
                    `🎂 For ${order.employeeName}` +
                    `'s birthday`,
                },
                unit_amount: Math.round(
                  (order.chargeAmount || 0) * 100
                ),
              },
              quantity: 1,
            }];


      // ── Create Stripe Checkout session ─────────────
      // Caller (eg one-off order flow) can pass custom return URLs.
      const base    = process.env.APP_URL;
      const { successPath, cancelPath } = req.body || {};
      const successUrl = successPath
        ? `${base}${successPath}${successPath.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`
        : `${base}/approve/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl  = cancelPath
        ? `${base}${cancelPath}`
        : `${base}/company/approvals`;

      const session =
        await stripe.checkout.sessions.create({
          mode:     'payment',
          customer: stripeCustomerId,
          line_items: lineItems,
          success_url: successUrl,
          cancel_url:  cancelUrl,
          metadata: {
            orderId:   id,
            companyId: order.companyId,
            type:      'order_approval',
          },
          billing_address_collection: 'auto',
        });

      console.log(
        `🔀 Dashboard checkout session: ` +
        `${session.id} — order ${id}`
      );

      return res.status(200).json({
        success: true,
        url:     session.url,
      });

    } catch (err) {
      console.error(
        'Create checkout session error:', err
      );
      return res.status(500).json({
        error: 'Failed to create checkout session'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/orders/:id/confirm
   Confirm an order
   Company users and admin can confirm
   Also triggered by one-click email link
   ═══════════════════════════════════════════════════ */

router.patch('/:id/confirm',
  authenticate,
  async (req, res) => {
    try {

      const { id }  = req.params;
      const role    = req.user.role;

      const orderRef = db
        .collection(COLLECTIONS.ORDERS)
        .doc(id);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();


      // ── Check access ──────────────────────────────
      if (role === ROLES.COMPANY_USER &&
          order.companyId !== req.user.companyId) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }


      // ── Check order can be confirmed ──────────────
      if (order.status === ORDER_STATUS.CONFIRMED ||
          order.status === ORDER_STATUS.ROUTED     ||
          order.status === ORDER_STATUS.DELIVERED) {
        return res.status(400).json({
          error: `Order already ${order.status}`
        });
      }

      if (order.status === ORDER_STATUS.CANCELLED) {
        return res.status(400).json({
          error: 'Cannot confirm a cancelled order'
        });
      }


      // ── Confirm order ─────────────────────────────
      await orderRef.update({
        status:      ORDER_STATUS.CONFIRMED,
        confirmedAt: serverTimestamp(),
        confirmedBy: role,
      });


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'confirm_order',
        'order',
        id,
        { confirmedBy: role }
      );


      // ── Trigger email notification ────────────────
      // Fire and forget
      notifyOrderConfirmed(id, order)
        .catch(err => console.error(
          'Confirm notification failed:', err
        ));

      return res.status(200).json({
        success: true,
        message: 'Order confirmed',
      });

    } catch (err) {
      console.error('Confirm order error:', err);
      return res.status(500).json({
        error: 'Failed to confirm order'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/orders/:id/route
   Admin only
   Assign order to a bakery
   ═══════════════════════════════════════════════════ */

router.patch('/:id/route',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { id }              = req.params;
      const { bakerId, notes }  = req.body;

      if (!bakerId) {
        return res.status(400).json({
          error: 'Bakery ID required'
        });
      }


      // ── Verify bakery exists ──────────────────────
      const bakeryDoc = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakerId)
        .get();

      if (!bakeryDoc.exists) {
        return res.status(404).json({
          error: 'Bakery not found'
        });
      }


      // ── Get order ─────────────────────────────────
      const orderRef = db
        .collection(COLLECTIONS.ORDERS)
        .doc(id);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order  = orderDoc.data();
      const bakery = bakeryDoc.data();


      // ── Update order ──────────────────────────────
      await orderRef.update({
        bakerId,
        bakeryName: bakery.name || '',
        status:     ORDER_STATUS.ROUTED,
        routedAt:   serverTimestamp(),
        bakerNotes: notes || '',
      });


      // ── Notify baker ──────────────────────────────
      notifyBakerNewOrder(id, {
        ...order,
        bakerId,
        bakeryName: bakery.name,
        bakerNotes: notes || '',
      }, bakery).catch(err =>
        console.error('Baker notification failed:', err)
      );


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'route_order',
        'order',
        id,
        { bakerId, bakeryName: bakery.name }
      );

      return res.status(200).json({
        success: true,
        message: 'Order routed to baker',
      });

    } catch (err) {
      console.error('Route order error:', err);
      return res.status(500).json({
        error: 'Failed to route order'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/orders/:id/deliver
   Baker or Admin — mark order as delivered
   Triggers Stripe charge + company notification
   ═══════════════════════════════════════════════════ */

router.patch('/:id/deliver',
  authenticate,
  async (req, res) => {
    try {

      const { id }   = req.params;
      const role     = req.user.role;

      const orderRef = db
        .collection(COLLECTIONS.ORDERS)
        .doc(id);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();


      // ── Check access ──────────────────────────────
      if (role === ROLES.BAKER &&
          order.bakerId !== req.user.bakerId) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }


      // ── Check order state ─────────────────────────
      if (order.status === ORDER_STATUS.DELIVERED) {
        return res.status(400).json({
          error: 'Order already marked as delivered'
        });
      }

      if (order.status === ORDER_STATUS.CANCELLED) {
        return res.status(400).json({
          error: 'Cannot deliver a cancelled order'
        });
      }


      // ── Mark as delivered ─────────────────────────
      await orderRef.update({
        status:      ORDER_STATUS.DELIVERED,
        deliveredAt: serverTimestamp(),
        deliveredBy: role,
      });


      // ── Trigger Stripe charge ─────────────────────
      chargeCompanyForDelivery(id, order)
        .catch(err => console.error(
          'Stripe charge failed:', err
        ));


      // ── Notify company HR ─────────────────────────
      notifyDeliveryComplete(id, order)
        .catch(err => console.error(
          'Delivery notification failed:', err
        ));


      // ── Notify Colton ─────────────────────────────
      notifyAdminDelivery(id, order)
        .catch(err => console.error(
          'Admin delivery notification failed:', err
        ));


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'mark_delivered',
        'order',
        id,
        { deliveredBy: role }
      );

      return res.status(200).json({
        success: true,
        message: 'Order marked as delivered',
      });

    } catch (err) {
      console.error('Deliver order error:', err);
      return res.status(500).json({
        error: 'Failed to mark order as delivered'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/orders/:id/modify-bundle
   Admin or Company — update treat selection on a pending order
   ═══════════════════════════════════════════════════ */

router.patch('/:id/modify-bundle',
  authenticate,
  async (req, res) => {
    try {
      const { id }         = req.params;
      const { lineItems, companyNote } = req.body;
      const role           = req.user.role;

      if (!lineItems || lineItems.length === 0) {
        return res.status(400).json({
          error: 'At least one treat item required',
        });
      }

      const orderRef = db.collection(COLLECTIONS.ORDERS).doc(id);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orderDoc.data();

      // Company users can only modify their own company's orders
      if (role === 'company_user' &&
          req.user.companyId !== order.companyId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Only allow modification of pre-delivery statuses
      const editableStatuses = [
        ORDER_STATUS.SCHEDULED,
        ORDER_STATUS.PENDING_CONFIRMATION,
        ORDER_STATUS.CONFIRMED,
      ];
      if (!editableStatuses.includes(order.status)) {
        return res.status(400).json({
          error: 'Order cannot be modified at this stage',
        });
      }

      // ── Resolve each lineItem → price + name ──────
      let chargeAmount  = 0;
      let wholesaleCost = 0;
      const resolvedItems = [];

      for (const item of lineItems) {
        if (!item.bakeryId || !item.treatType) continue;

        let unitPrice     = 0;
        let wholesaleUnit = 0;
        let productName   = item.treatType;

        try {
          const productDoc = await db
            .collection(COLLECTIONS.BAKERIES)
            .doc(item.bakeryId)
            .collection('products')
            .doc(item.treatType)
            .get();

          if (productDoc.exists) {
            const p       = productDoc.data();
            unitPrice     = p.price || p.retailPrice || 0;
            wholesaleUnit = p.wholesaleCost || 0;
            productName   = p.name || item.treatType;
          }
        } catch (err) {
          console.warn(
            `modify-bundle: product lookup failed for ${item.treatType}:`,
            err.message
          );
        }

        const qty = item.qty || 1;
        resolvedItems.push({
          bakeryId:  item.bakeryId,
          treatType: item.treatType,
          productName,
          qty,
          unitPrice,
          lineTotal: unitPrice * qty,
          wholesaleCost: wholesaleUnit * qty,
        });

        chargeAmount  += unitPrice     * qty;
        wholesaleCost += wholesaleUnit * qty;
      }

      if (resolvedItems.length === 0) {
        return res.status(400).json({
          error: 'No valid treat items found',
        });
      }

      const productSummary = resolvedItems.length === 1
        ? resolvedItems[0].productName
        : `Birthday Bundle (${resolvedItems.length} items)`;

      const primaryBakerId = resolvedItems[0]?.bakeryId || null;

      const updates = {
        lineItems:    resolvedItems,
        productName:  productSummary,
        chargeAmount,
        wholesaleCost,
        bakerId:      primaryBakerId,
        updatedAt:    serverTimestamp(),
        modifiedBy:   role,
        ...(companyNote !== undefined && {
          companyNote,
        }),
      };

      await orderRef.update(updates);

      await writeAuditLog(
        req.user.uid,
        'modify_order_bundle',
        'order',
        id,
        { lineItems: resolvedItems, chargeAmount }
      );

      return res.status(200).json({
        success:      true,
        chargeAmount,
        wholesaleCost,
        productName:  productSummary,
      });

    } catch (err) {
      console.error('Modify bundle error:', err);
      return res.status(500).json({
        error: 'Failed to modify order',
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/orders/:id/cancel
   Admin or Company — cancel an order
   ═══════════════════════════════════════════════════ */

router.patch('/:id/cancel',
  authenticate,
  async (req, res) => {
    try {

      const { id }     = req.params;
      const { reason } = req.body;
      const role       = req.user.role;

      const orderRef = db
        .collection(COLLECTIONS.ORDERS)
        .doc(id);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();


      // ── Check access ──────────────────────────────
      if (role === ROLES.COMPANY_USER &&
          order.companyId !== req.user.companyId) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Bakers cannot cancel orders
      if (role === ROLES.BAKER) {
        return res.status(403).json({
          error: 'Bakers cannot cancel orders. ' +
                 'Contact Delightmaker support.'
        });
      }


      // ── Check order can be cancelled ──────────────
      if (order.status === ORDER_STATUS.DELIVERED) {
        return res.status(400).json({
          error: 'Cannot cancel a delivered order'
        });
      }

      if (order.status === ORDER_STATUS.CANCELLED) {
        return res.status(400).json({
          error: 'Order already cancelled'
        });
      }


      // ── Refund if already charged ─────────────────
      let refundId     = null;
      let refundStatus = null;
      let refundAmt    = null;

      console.log(`🔍 Cancel check — chargeStatus: ${order.chargeStatus}, stripeChargeId: ${order.stripeChargeId}`);

      if (order.chargeStatus === 'paid' &&
          order.stripeChargeId) {
        try {
          const stripe = require('stripe')(
            process.env.STRIPE_SECRET_KEY
          );

          const refund = await stripe.refunds.create({
            payment_intent: order.stripeChargeId,
            reason:         'requested_by_customer',
          });

          refundId     = refund.id;
          refundStatus = refund.status;   // 'succeeded' | 'pending'
          refundAmt    = refund.amount / 100; // Stripe stores cents

          console.log(
            `💸 Refund issued: ${refundId} ` +
            `(${refundStatus}) for order ${id}`
          );
        } catch (stripeErr) {
          // Log the error but don't block cancellation
          console.error(
            `⚠️  Stripe refund failed for order ${id}:`,
            stripeErr.message
          );
          refundStatus = 'failed';
        }
      }


      // ── Cancel order ──────────────────────────────
      await orderRef.update({
        status:       ORDER_STATUS.CANCELLED,
        cancelledAt:  serverTimestamp(),
        cancelledBy:  role,
        cancelReason: reason || '',
        ...(refundId && {
          refundId,
          refundStatus,
          refundAmount: refundAmt,
          refundedAt: serverTimestamp(),
        }),
      });


      // ── Notify baker if assigned ──────────────────
      console.log(`🔔 Cancel — bakerId: "${order.bakerId}", status was: "${order.status}"`);
      if (order.bakerId) {
        notifyBakerCancellation(id, order)
          .catch(err => console.error(
            '❌ Baker cancel notification failed:', err
          ));
      } else {
        console.warn(`⚠️  Cancel — no bakerId on order ${id}, skipping baker email`);
      }

      // ── Notify company HR ─────────────────────────
      notifyCompanyCancellation(id, order, refundId, refundAmt)
        .catch(err => console.error(
          'Company cancel notification failed:', err
        ));

      // ── Notify admin (Colton) ─────────────────────
      notifyAdminCancellation(id, order, refundId, refundAmt, role)
        .catch(err => console.error(
          'Admin cancel notification failed:', err
        ));


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'cancel_order',
        'order',
        id,
        { reason, cancelledBy: role, refundId, refundStatus }
      );

      return res.status(200).json({
        success:      true,
        message:      refundId
          ? `Order cancelled and refund issued (${refundStatus})`
          : 'Order cancelled',
        refundId,
        refundStatus,
      });

    } catch (err) {
      console.error('Cancel order error:', err);
      return res.status(500).json({
        error: 'Failed to cancel order'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/orders/:id
   Admin only — update order details
   ═══════════════════════════════════════════════════ */

router.patch('/:id',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { id } = req.params;
      const {
        productId,
        deliveryDate,
        deliveryAddress,
        customMessage,
        chargeAmount,
        wholesaleCost,
        bakerNotes,
      } = req.body;

      const orderRef = db
        .collection(COLLECTIONS.ORDERS)
        .doc(id);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      // Build update object — only changed fields
      const updates = { updatedAt: serverTimestamp() };

      if (productId) {
        // Verify product exists
        const productDoc = await db
          .collection(COLLECTIONS.PRODUCTS)
          .doc(productId)
          .get();
        if (!productDoc.exists) {
          return res.status(404).json({
            error: 'Product not found'
          });
        }
        updates.productId   = productId;
        updates.productName =
          productDoc.data().name || '';
      }

      if (deliveryDate) {
        updates.deliveryDate =
          admin.firestore.Timestamp.fromDate(
            new Date(deliveryDate)
          );
      }

      if (deliveryAddress) {
        updates.deliveryAddress = deliveryAddress;
      }
      if (customMessage !== undefined) {
        updates.customMessage = customMessage;
      }
      if (chargeAmount !== undefined) {
        updates.chargeAmount = chargeAmount;
      }
      if (wholesaleCost !== undefined) {
        updates.wholesaleCost = wholesaleCost;
      }
      if (bakerNotes !== undefined) {
        updates.bakerNotes = bakerNotes;
      }


      await orderRef.update(updates);


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'update_order',
        'order',
        id,
        updates
      );

      return res.status(200).json({
        success: true,
        message: 'Order updated',
      });

    } catch (err) {
      console.error('Update order error:', err);
      return res.status(500).json({
        error: 'Failed to update order'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/orders/approve/:token
   No auth required — one click email approval
   Verifies JWT token from email link
   ═══════════════════════════════════════════════════ */

router.post('/approve/:token',
  async (req, res) => {
    try {

      const { token } = req.params;

      // ── Verify signed token ───────────────────────
      let decoded;
      try {
        decoded = jwt.verify(
          token,
          process.env.JWT_SECRET
        );
      } catch (err) {
        return res.status(400).json({
          error: 'Invalid or expired approval link'
        });
      }

      const { orderId } = decoded;
      if (!orderId) {
        return res.status(400).json({
          error: 'Invalid token — no order ID'
        });
      }


      // ── Check token not already used ──────────────
      const tokenDocId = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      const tokenDoc = await db
        .collection('usedTokens')
        .doc(tokenDocId)
        .get();

      if (tokenDoc.exists) {
        return res.status(400).json({
          error: 'Approval link already used'
        });
      }


      // ── Get and confirm order ─────────────────────
      const orderRef = db
        .collection(COLLECTIONS.ORDERS)
        .doc(orderId);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();

      if (order.status !== ORDER_STATUS.PENDING_CONFIRMATION) {
        return res.status(400).json({
          error: `Order is already ${order.status}`
        });
      }

      // Mark token as used
      await db
        .collection('usedTokens')
        .doc(tokenDocId)
        .set({
          usedAt:  serverTimestamp(),
          orderId,
        });

      // Confirm order
      await orderRef.update({
        status:      ORDER_STATUS.CONFIRMED,
        confirmedAt: serverTimestamp(),
        confirmedBy: 'email_link',
      });


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        'email_approval',
        'confirm_order',
        'order',
        orderId,
        { method: 'one_click_email' }
      );


      return res.status(200).json({
        success: true,
        message: 'Order confirmed successfully',
      });

    } catch (err) {
      console.error('Email approval error:', err);
      return res.status(500).json({
        error: 'Failed to confirm order'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   GET /api/orders/stats/summary
   Admin only — dashboard KPI numbers
   ═══════════════════════════════════════════════════ */

router.get('/stats/summary',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      // Get current month start
      const now            = new Date();
      const monthStart     = new Date(
        now.getFullYear(), now.getMonth(), 1
      );
      const monthStartTs   =
        admin.firestore.Timestamp.fromDate(monthStart);


      // Run all queries in parallel
      const [
        allOrdersSnap,
        monthOrdersSnap,
        pendingSnap,
        unroutedSnap,
        companiesSnap,
      ] = await Promise.all([

        // All active orders
        db.collection(COLLECTIONS.ORDERS)
          .where('status', 'not-in', [
            ORDER_STATUS.CANCELLED
          ])
          .get(),

        // This month's delivered orders
        db.collection(COLLECTIONS.ORDERS)
          .where('status', '==',
            ORDER_STATUS.DELIVERED)
          .where('deliveredAt', '>=', monthStartTs)
          .get(),

        // Pending confirmation
        db.collection(COLLECTIONS.ORDERS)
          .where('status', '==',
            ORDER_STATUS.PENDING_CONFIRMATION)
          .get(),

        // Confirmed but not yet routed
        db.collection(COLLECTIONS.ORDERS)
          .where('status', '==',
            ORDER_STATUS.CONFIRMED)
          .get(),

        // All companies
        db.collection(COLLECTIONS.COMPANIES)
          .get(),
      ]);


      // Calculate revenue this month
      let monthRevenue   = 0;
      let monthCost      = 0;

      monthOrdersSnap.docs.forEach(doc => {
        const o = doc.data();
        monthRevenue += o.chargeAmount  || 0;
        monthCost    += o.wholesaleCost || 0;
      });

      const monthMargin = monthRevenue - monthCost;
      const marginPct   = monthRevenue > 0
        ? ((monthMargin / monthRevenue) * 100).toFixed(1)
        : 0;


      return res.status(200).json({
        success: true,
        stats: {
          activeClients:     companiesSnap.size,
          ordersThisMonth:   monthOrdersSnap.size,
          revenueThisMonth:  monthRevenue,
          costThisMonth:     monthCost,
          marginThisMonth:   monthMargin,
          marginPct:         parseFloat(marginPct),
          pendingConfirm:    pendingSnap.size,
          pendingRouting:    unroutedSnap.size,
          totalActiveOrders: allOrdersSnap.size,
        },
      });

    } catch (err) {
      console.error('Stats error:', err);
      return res.status(500).json({
        error: 'Failed to get stats'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/orders/import-employees
   Company user or admin
   Bulk-imports employees from a parsed CSV payload.
   Creates new employees or updates existing ones
   (matched by name + companyId).
   ═══════════════════════════════════════════════════ */

router.post('/import-employees',
  authenticate,
  async (req, res) => {
    try {

      const { companyId, employees } = req.body;

      if (!companyId) {
        return res.status(400).json({
          error: 'companyId is required',
        });
      }

      if (!Array.isArray(employees) ||
          employees.length === 0) {
        return res.status(400).json({
          error: 'employees array is required',
        });
      }

      // Company users can only import for their company
      if (req.user.role === 'company_user' &&
          req.user.companyId !== companyId) {
        return res.status(403).json({
          error: 'Access denied',
        });
      }

      // Verify company exists
      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(companyId)
        .get();

      if (!companyDoc.exists) {
        return res.status(404).json({
          error: 'Company not found',
        });
      }


      // ── Process each row ──────────────────────────
      const batch    = db.batch();
      let   created  = 0;
      let   updated  = 0;
      const errors   = [];
      let   rowNum   = 1; // 1-based, excludes header

      for (const row of employees) {
        rowNum++;

        // Normalise column names
        // (CSV headers lowercased by parseSimpleCSV)
        const toTitleCase = s =>
          s.trim().toLowerCase()
           .replace(/\b\w/g, c => c.toUpperCase());

        const firstName =
          toTitleCase(row['first name'] || row['firstname'] || '');
        const lastName  =
          toTitleCase(row['last name']  || row['lastname']  || '');
        const birthday  =
          (row['birthday'] || '').trim();
        const dietary   =
          (row['dietary restrictions'] ||
           row['dietary']              || '').trim();
        const address   =
          (row['delivery address'] ||
           row['address']          || '').trim();
        const email     =
          (row['email'] || '').trim();

        if (!firstName || !lastName) {
          errors.push(
            `Row ${rowNum}: Missing first or last name`
          );
          continue;
        }

        if (!birthday) {
          errors.push(
            `Row ${rowNum} (${firstName} ${lastName}): ` +
            `Missing birthday`
          );
          continue;
        }

        const birthdayDate = new Date(birthday);

        if (isNaN(birthdayDate.getTime())) {
          errors.push(
            `Row ${rowNum} (${firstName} ${lastName}): ` +
            `"${birthday}" is not a valid date — ` +
            `use YYYY-MM-DD format (e.g. 1990-04-15)`
          );
          continue;
        }

        // Build dietary flags array
        const dietaryFlags = dietary &&
          dietary.toLowerCase() !== 'none'
          ? dietary.split(/[,;]/).map(d => d.trim())
                                 .filter(Boolean)
          : [];

        const empData = {
          name:            `${firstName} ${lastName}`,
          firstName,
          lastName,
          birthday:        birthdayDate,
          dietaryFlags,
          deliveryAddress: address  || null,
          email:           email ? email.toLowerCase() : null,
          companyId,
          active:          true,
          removedAt:       null,   // clear if previously removed
          updatedAt:       admin.firestore
                             .FieldValue.serverTimestamp(),
        };

        // Check if employee already exists
        // Prefer email match (reliable), fall back to name match
        let existing = null;
        if (email) {
          const byEmail = await db
            .collection('employees')
            .where('companyId', '==', companyId)
            .where('email', '==', email.toLowerCase())
            .limit(1)
            .get();
          if (!byEmail.empty) existing = byEmail;
        }
        if (!existing || existing.empty) {
          const byName = await db
            .collection('employees')
            .where('companyId', '==', companyId)
            .where('name', '==', empData.name)
            .limit(1)
            .get();
          if (!byName.empty) existing = byName;
        }

        if (!existing.empty) {
          // Update existing
          batch.update(existing.docs[0].ref, empData);
          updated++;
        } else {
          // Create new
          const newRef = db.collection('employees').doc();
          batch.set(newRef, {
            ...empData,
            createdAt: admin.firestore
                         .FieldValue.serverTimestamp(),
          });
          created++;
        }
      }

      // Commit all writes
      await batch.commit();

      // Update company employee count
      await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(companyId)
        .update({
          'stats.employeeCount':
            admin.firestore.FieldValue.increment(created),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        });

      console.log(
        `✅ CSV import: ${created} created, ` +
        `${updated} updated — company ${companyId}`
      );

      return res.status(200).json({
        success: true,
        count:   created + updated,
        created,
        updated,
        errors,
      });

    } catch (err) {
      console.error('Import employees error:', err);
      return res.status(500).json({
        error: 'Failed to import employees',
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/orders/reschedule-employee
   Company user or admin
   When an employee's birthday changes, cancels all
   future unconfirmed/unscheduled orders for that
   employee and triggers a fresh scheduling scan.
   ═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════
   DELETE /api/orders/employees/:id
   Company user (own employee) or admin
   Hard-deletes the employee doc and cancels all
   future unpaid orders (scheduled or pending_confirmation).
   Paid/in-progress orders are preserved for accounting.
   ═══════════════════════════════════════════════════ */

router.delete('/employees/:id',
  authenticate,
  async (req, res) => {
    try {
      const { id: employeeId } = req.params;
      const role = req.user.role;

      const empRef = db.collection(COLLECTIONS.EMPLOYEES).doc(employeeId);
      const empDoc = await empRef.get();

      if (!empDoc.exists) {
        return res.status(404).json({ error: 'Employee not found' });
      }

      const employee = empDoc.data();

      // Company users can only delete their own employees
      if (role === 'company_user' &&
          req.user.companyId !== employee.companyId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (role !== 'company_user' && role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // 1) Cancel future unpaid orders for this employee
      const cancellableStatuses = ['scheduled', 'pending_confirmation'];
      const ordersSnap = await db
        .collection(COLLECTIONS.ORDERS)
        .where('employeeId', '==', employeeId)
        .where('status', 'in', cancellableStatuses)
        .get();

      let cancelledCount = 0;
      if (!ordersSnap.empty) {
        const batch = db.batch();
        ordersSnap.docs.forEach(d => {
          batch.update(d.ref, {
            status:       'cancelled',
            cancelledAt:  admin.firestore.FieldValue.serverTimestamp(),
            cancelReason: 'employee_removed',
          });
          cancelledCount++;
        });
        await batch.commit();
      }

      // 2) Hard delete the employee
      await empRef.delete();

      // 3) Update company employee count (best effort)
      try {
        await db.collection(COLLECTIONS.COMPANIES)
          .doc(employee.companyId)
          .update({
            'stats.employeeCount': admin.firestore.FieldValue.increment(-1),
          });
      } catch (_) { /* non-fatal */ }

      console.log(
        `🗑️  Employee deleted: ${employeeId} (${employee.name}) — ` +
        `${cancelledCount} future order(s) cancelled`
      );

      return res.status(200).json({
        success: true,
        cancelledOrders: cancelledCount,
      });

    } catch (err) {
      console.error('Delete employee error:', err);
      return res.status(500).json({ error: err.message || 'Delete failed' });
    }
  }
);


router.post('/reschedule-employee',
  authenticate,
  async (req, res) => {
    try {
      const { employeeId, companyId } = req.body;

      if (!employeeId || !companyId) {
        return res.status(400).json({
          error: 'employeeId and companyId are required',
        });
      }

      // Company users can only reschedule their own employees
      if (req.user.role === 'company_user' &&
          req.user.companyId !== companyId) {
        return res.status(403).json({
          error: 'Access denied',
        });
      }

      const now   = new Date();
      const nowTs = admin.firestore.Timestamp.fromDate(now);

      // Cancel future orders that haven't been paid for yet
      const CANCELLABLE = [
        ORDER_STATUS.SCHEDULED,
        ORDER_STATUS.PENDING_CONFIRMATION,
      ];

      let cancelled = 0;

      for (const status of CANCELLABLE) {
        const snap = await db
          .collection(COLLECTIONS.ORDERS)
          .where('employeeId',   '==', employeeId)
          .where('companyId',    '==', companyId)
          .where('status',       '==', status)
          .where('deliveryDate', '>',  nowTs)
          .get();

        if (!snap.empty) {
          const batch = db.batch();
          snap.docs.forEach(doc => {
            batch.update(doc.ref, {
              status:       ORDER_STATUS.CANCELLED,
              cancelledAt:  serverTimestamp(),
              cancelledBy:  'company_user',
              cancelReason: 'Birthday updated — order rescheduled',
            });
          });
          await batch.commit();
          cancelled += snap.size;
        }
      }

      // Trigger immediate rescan so the new birthday
      // order gets created right away
      try {
        const scheduler = require('../functions/scheduler');
        await scheduler.scanCompanyNow(companyId);
      } catch (err) {
        console.warn(
          'Reschedule scan failed (non-fatal):', err.message
        );
      }

      console.log(
        `🔄 Rescheduled employee ${employeeId}: ` +
        `${cancelled} order(s) cancelled, rescan triggered`
      );

      return res.json({
        success:   true,
        cancelled,
      });

    } catch (err) {
      console.error('Reschedule employee error:', err);
      return res.status(500).json({
        error: 'Failed to reschedule employee orders',
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   HELPER FUNCTIONS
   ═══════════════════════════════════════════════════ */

/**
 * Format order document for API response
 */
function formatOrder(doc) {
  const data = doc.data();
  return {
    id:              doc.id,
    companyId:       data.companyId,
    employeeId:      data.employeeId,
    employeeName:    data.employeeName   || '',
    productId:       data.productId,
    productName:     data.productName    || '',
    bakerId:         data.bakerId        || null,
    bakeryName:      data.bakeryName     || '',
    status:          data.status,
    eventType:       data.eventType,
    dietaryFlags:    data.dietaryFlags   || [],
    deliveryAddress: data.deliveryAddress|| '',
    customMessage:   data.customMessage  || '',
    bakerNotes:      data.bakerNotes     || '',
    chargeAmount:    data.chargeAmount   || 0,
    wholesaleCost:   data.wholesaleCost  || 0,
    stripeChargeId:  data.stripeChargeId || null,
    deliveryDate: data.deliveryDate
      ?.toDate()?.toISOString() || null,
    confirmationSentAt: data.confirmationSentAt
      ?.toDate()?.toISOString() || null,
    confirmedAt: data.confirmedAt
      ?.toDate()?.toISOString() || null,
    routedAt: data.routedAt
      ?.toDate()?.toISOString() || null,
    deliveredAt: data.deliveredAt
      ?.toDate()?.toISOString() || null,
    createdAt: data.createdAt
      ?.toDate()?.toISOString() || null,
  };
}


/**
 * Charge company via Stripe when order delivered
 */
async function chargeCompanyForDelivery(orderId, order) {
  try {
    // ── Skip if already paid (e.g. via Stripe Checkout) ──
    if (order.chargeStatus === 'paid' || order.stripeChargeId) {
      console.log(
        `ℹ️  Order ${orderId} already charged (${order.chargeStatus}) — skipping off-session charge`
      );
      return;
    }

    const stripe = require('stripe')(
      process.env.STRIPE_SECRET_KEY
    );

    // Get company Stripe customer ID
    const companyDoc = await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .get();

    if (!companyDoc.exists) return;

    const company = companyDoc.data();
    if (!company.stripeCustomerId) {
      console.warn(
        `No Stripe customer for company ${order.companyId}`
      );
      return;
    }

    // Get customer's default payment method
    const customer = await stripe.customers.retrieve(
      company.stripeCustomerId
    );

    const paymentMethodId =
      customer.invoice_settings?.default_payment_method ||
      company.stripePaymentMethodId;

    if (!paymentMethodId) {
      throw new Error(
        'No payment method on file for company ' +
        order.companyId
      );
    }

    // Charge the saved payment method off-session
    const paymentIntent =
      await stripe.paymentIntents.create({
        amount:         Math.round(order.chargeAmount * 100),
        currency:       'cad',
        customer:       company.stripeCustomerId,
        payment_method: paymentMethodId,
        confirm:        true,
        off_session:    true,
        metadata: {
          orderId:    orderId,
          companyId:  order.companyId,
          employeeId: order.employeeId,
          eventType:  order.eventType,
        },
        description:
          `Delightmaker delivery — ` +
          `${order.employeeName} ` +
          `(${order.eventType})`,
      });

    // Save charge ID to order
    await db
      .collection(COLLECTIONS.ORDERS)
      .doc(orderId)
      .update({
        stripeChargeId: paymentIntent.id,
        chargedAt:      serverTimestamp(),
      });

    console.log(
      `✅ Stripe charge: ${paymentIntent.id} ` +
      `— $${order.chargeAmount} CAD`
    );

  } catch (err) {
    console.error('Stripe charge error:', err);
    // Flag as exception for Colton to handle
    await db
      .collection(COLLECTIONS.ORDERS)
      .doc(orderId)
      .update({
        status:         ORDER_STATUS.EXCEPTION,
        exceptionReason:'Stripe charge failed: ' +
                        err.message,
        exceptionSince: serverTimestamp(),
        flaggedAt:      serverTimestamp(),
      });
  }
}


/**
 * Notify company HR that their order has been confirmed
 */
async function notifyOrderConfirmed(orderId, order) {
  if (!isResendConfigured()) {
    console.log(`📧 [skip] Order confirmed notification: ${orderId}`);
    return;
  }
  try {
    const companyDoc = await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .get();
    if (!companyDoc.exists) return;
    const company = companyDoc.data();

    const deliveryDate = order.deliveryDate
      ?.toDate()
      ?.toLocaleDateString('en-CA', {
        weekday: 'long', year: 'numeric',
        month: 'long',   day: 'numeric',
      }) || 'Upcoming';

    const resend = getResend();
    await resend.emails.send({
      from:    EMAIL_FROM(),
      to:      company.contactEmail,
      subject: `✅ Confirmed — ${order.employeeName}'s treat delivery`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#2D2D2D">Order Confirmed ✅</h2>
          <p>Hi ${company.contactName || 'there'},</p>
          <p>
            The delivery for <strong>${order.employeeName}</strong>
            on <strong>${deliveryDate}</strong> has been confirmed
            and is on its way to being prepared.
          </p>
          <p style="color:#888;font-size:0.85rem">
            Order #${orderId.slice(-8).toUpperCase()} ·
            ${order.productName}
          </p>
          <p style="margin-top:24px;font-size:0.8rem;color:#AAA">
            Delightmaker · Halifax, NS
          </p>
        </div>
      `,
    });
    console.log(`✅ Order confirmed notification sent: ${orderId}`);
  } catch (err) {
    console.error('notifyOrderConfirmed error:', err.message);
  }
}


/**
 * Notify baker of new routed order
 */
async function notifyBakerNewOrder(orderId, order, bakery) {
  if (!isResendConfigured()) {
    console.log(`📧 [skip] Baker notification: ${orderId} → ${bakery.name}`);
    return;
  }
  try {
    // Support both contactEmail (new) and contact (legacy field)
    const bakerEmail = bakery.contactEmail || bakery.contact || null;
    if (!bakerEmail) {
      console.warn(`⚠️  No email on bakery — skipping new order email for ${orderId}`);
      return;
    }

    // Fetch company name
    let companyName = order.companyName || order.companyId || 'Unknown Company';
    try {
      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(order.companyId)
        .get();
      if (companyDoc.exists) {
        companyName = companyDoc.data().name || companyName;
      }
    } catch (_) { /* non-fatal */ }

    const deliveryDate = order.deliveryDate
      ?.toDate()
      ?.toLocaleDateString('en-CA', {
        weekday: 'long', year: 'numeric',
        month: 'long',   day: 'numeric',
      }) || 'TBD';

    const dietaryHtml = order.dietaryFlags && order.dietaryFlags.length > 0
      ? `<div style="background:#FFF2F2;border:1px solid #FFCDD2;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:0.85rem;color:#C62828">
           🚨 <strong>DIETARY REQUIREMENTS:</strong>
           ${order.dietaryFlags.map(f => f.toUpperCase()).join(', ')}
         </div>`
      : '';

    // Build line items rows — one row per bundle item
    const lineItemRows = order.lineItems && order.lineItems.length > 0
      ? order.lineItems.map(item => `
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:8px 0;color:#888">
              ${item.productName}
            </td>
            <td style="padding:8px 0;font-weight:700">
              ×${item.qty}
            </td>
          </tr>
        `).join('')
      : `<tr style="border-bottom:1px solid #eee">
           <td style="padding:8px 0;color:#888">Treat</td>
           <td style="padding:8px 0;font-weight:700">${order.productName}</td>
         </tr>`;

    const resend = getResend();
    await resend.emails.send({
      from:    `${process.env.RESEND_FROM_NAME} <${process.env.EMAIL_ORDERS}>`,
      to:      bakerEmail,
      subject: `📦 New Order #${orderId.slice(-8).toUpperCase()} — ${deliveryDate}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#2D2D2D">📦 New Order — Action Required</h2>
          <p>Hi ${bakery.name} team,</p>
          <p>You have a new Delightmaker order. Please review and prepare.</p>
          ${dietaryHtml}
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Order ID</td>
              <td style="padding:8px 0;font-weight:600"
                  colspan="2">#${orderId.slice(-8).toUpperCase()}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Company</td>
              <td style="padding:8px 0;font-weight:600"
                  colspan="2">${companyName}</td>
            </tr>
            ${lineItemRows}
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Delivery Date</td>
              <td style="padding:8px 0;font-weight:600;color:#FF6B6B"
                  colspan="2">${deliveryDate}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Delivery Address</td>
              <td style="padding:8px 0;font-weight:600"
                  colspan="2">${order.deliveryAddress || '—'}</td>
            </tr>
            ${order.bakerNotes ? `
            <tr>
              <td style="padding:8px 0;color:#888">Notes from Colton</td>
              <td style="padding:8px 0" colspan="2">${order.bakerNotes}</td>
            </tr>` : ''}
          </table>
          <a href="${process.env.APP_URL}/baker/dashboard"
             style="display:block;background:#FF6B6B;color:white;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:700;text-align:center;margin:24px 0">
            View in Baker Portal →
          </a>
          <p style="font-size:0.8rem;color:#AAA">
            Questions? Contact Colton at
            <a href="mailto:${process.env.ADMIN_EMAIL}">${process.env.ADMIN_EMAIL}</a>
          </p>
        </div>
      `,
    });
    console.log(`✅ Baker notification sent: ${orderId} → ${bakerEmail}`);
  } catch (err) {
    console.error('notifyBakerNewOrder error:', err.message);
  }
}


/**
 * Notify company HR that delivery is complete
 */
async function notifyDeliveryComplete(orderId, order) {
  if (!isResendConfigured()) {
    console.log(`📧 [skip] Delivery complete notification: ${orderId}`);
    return;
  }
  try {
    const companyDoc = await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .get();
    if (!companyDoc.exists) return;
    const company = companyDoc.data();

    const today = new Date().toLocaleDateString('en-CA', {
      weekday: 'long', month: 'long', day: 'numeric',
    });

    const resend = getResend();
    await resend.emails.send({
      from:    EMAIL_FROM(),
      to:      company.contactEmail,
      subject: `🎉 Delivered! ${order.employeeName}'s treat arrived today`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;text-align:center">
          <div style="font-size:3rem">🎉</div>
          <h2 style="color:#2D2D2D;margin:16px 0 8px">Delivered!</h2>
          <p style="color:#555">
            ${order.employeeName}'s treat has been delivered to your office today.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;text-align:left">
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Employee</td>
              <td style="padding:8px 0;font-weight:600">${order.employeeName}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Treat</td>
              <td style="padding:8px 0;font-weight:600">${order.productName}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Delivered</td>
              <td style="padding:8px 0;font-weight:600">${today}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#888">Amount Charged</td>
              <td style="padding:8px 0;font-weight:600;color:#FF6B6B">$${order.chargeAmount} CAD</td>
            </tr>
          </table>
          <a href="${process.env.APP_URL}/company/spending"
             style="display:block;background:#FF6B6B;color:white;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:700;text-align:center;margin:24px 0">
            View Spending Report →
          </a>
          <p style="font-size:0.8rem;color:#AAA">Delightmaker · Halifax, NS 🇨🇦</p>
        </div>
      `,
    });
    console.log(`✅ Delivery confirmation sent: ${orderId} → ${company.contactEmail}`);
  } catch (err) {
    console.error('notifyDeliveryComplete error:', err.message);
  }
}


/**
 * Notify Colton (admin) when a delivery is marked complete
 */
async function notifyAdminDelivery(orderId, order) {
  if (!isResendConfigured()) {
    console.log(`📧 [skip] Admin delivery notification: ${orderId}`);
    return;
  }
  try {
    const resend = getResend();
    await resend.emails.send({
      from:    EMAIL_FROM(),
      to:      process.env.ADMIN_EMAIL,
      subject: `📦 Delivered — ${order.employeeName} @ ${order.companyName || order.companyId}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#2D2D2D">Delivery Complete 📦</h2>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Order ID</td>
              <td style="padding:8px 0;font-weight:600">#${orderId.slice(-8).toUpperCase()}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Employee</td>
              <td style="padding:8px 0;font-weight:600">${order.employeeName}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Company</td>
              <td style="padding:8px 0;font-weight:600">${order.companyName || order.companyId}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee">
              <td style="padding:8px 0;color:#888">Product</td>
              <td style="padding:8px 0;font-weight:600">${order.productName}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#888">Amount</td>
              <td style="padding:8px 0;font-weight:600;color:#FF6B6B">$${order.chargeAmount} CAD</td>
            </tr>
          </table>
          <a href="${process.env.APP_URL}/admin/dashboard"
             style="display:inline-block;background:#2D2D2D;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">
            View Admin Dashboard →
          </a>
        </div>
      `,
    });
    console.log(`✅ Admin delivery notification sent: ${orderId}`);
  } catch (err) {
    console.error('notifyAdminDelivery error:', err.message);
  }
}


/**
 * Notify baker that a routed order has been cancelled
 */
async function notifyBakerCancellation(orderId, order) {
  console.log(`📧 notifyBakerCancellation called — order: ${orderId}, bakerId: ${order.bakerId}`);

  if (!isResendConfigured()) {
    console.warn(`📧 [SKIP] Resend not configured — baker cancellation email skipped for ${orderId}`);
    return;
  }

  try {
    console.log(`📧 Fetching bakery doc: ${order.bakerId}`);
    const bakeryDoc = await db
      .collection(COLLECTIONS.BAKERIES)
      .doc(order.bakerId)
      .get();

    if (!bakeryDoc.exists) {
      console.warn(`⚠️  Bakery doc ${order.bakerId} does not exist — skipping cancellation email`);
      return;
    }

    const bakery = bakeryDoc.data();
    console.log(`📧 Bakery found: "${bakery.name}", contactEmail: "${bakery.contactEmail}", contact: "${bakery.contact}"`);

    // Support both contactEmail (new) and contact (legacy field)
    const bakerEmail = bakery.contactEmail || bakery.contact || null;
    if (!bakerEmail) {
      console.warn(`⚠️  No email on bakery ${order.bakerId} — skipping cancellation email`);
      return;
    }

    console.log(`📧 Sending cancellation email to: ${bakerEmail}`);
    const resend = getResend();
    const result = await resend.emails.send({
      from:    EMAIL_FROM(),
      to:      bakerEmail,
      subject: `❌ Order Cancelled — #${orderId.slice(-8).toUpperCase()}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#2D2D2D">Order Cancelled ❌</h2>
          <p>Hi ${bakery.name} team,</p>
          <p>
            Order <strong>#${orderId.slice(-8).toUpperCase()}</strong>
            has been cancelled. Please do not prepare this order.
          </p>
          ${order.cancelReason ? `<p style="color:#888">Reason: ${order.cancelReason}</p>` : ''}
          <p style="font-size:0.85rem;color:#888;margin-top:24px">
            Questions? Contact Colton at
            <a href="mailto:${process.env.ADMIN_EMAIL}">${process.env.ADMIN_EMAIL}</a>
          </p>
          <p style="font-size:0.8rem;color:#AAA;margin-top:16px">Delightmaker · Halifax, NS 🇨🇦</p>
        </div>
      `,
    });
    console.log(`✅ Baker cancellation email sent: ${orderId} → ${bakerEmail}`, result);
  } catch (err) {
    console.error(`❌ notifyBakerCancellation FAILED for ${orderId}:`, err);
  }
}


/**
 * Notify company HR that an order was cancelled
 * and a refund was issued (if applicable)
 */
async function notifyCompanyCancellation(orderId, order, refundId, refundAmt) {
  if (!isResendConfigured()) {
    console.log(`📧 [skip] Company cancellation notification: ${orderId}`);
    return;
  }
  try {
    const companyDoc = await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .get();
    if (!companyDoc.exists) return;
    const company = companyDoc.data();
    if (!company.contactEmail) return;

    const deliveryDate = order.deliveryDate
      ?.toDate()
      ?.toLocaleDateString('en-CA', {
        weekday: 'long', year: 'numeric',
        month:   'long', day:  'numeric',
      }) || 'the scheduled date';

    const refundHtml = refundId
      ? `<div style="background:#FFF2F2;border:1px solid #FFCDD2;border-radius:8px;padding:14px 18px;margin:20px 0">
           <p style="margin:0;color:#C62828;font-weight:600">💸 Refund Issued</p>
           <p style="margin:6px 0 0;color:#555;font-size:0.9rem">
             A full refund of <strong>$${Number(refundAmt || 0).toFixed(2)} CAD</strong>
             has been issued to the original payment method.
             It typically appears within 5–10 business days.
           </p>
         </div>`
      : `<p style="color:#888;font-size:0.85rem;margin-top:12px">
           No charge was applied for this order.
         </p>`;

    const resend = getResend();
    await resend.emails.send({
      from:    EMAIL_FROM(),
      to:      company.contactEmail,
      subject: `❌ Order Cancelled — ${order.employeeName}'s treat on ${
        order.deliveryDate?.toDate?.()
          ?.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
        || 'upcoming date'
      }`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#2D2D2D;margin-bottom:8px">Order Cancelled ❌</h2>
          <p>Hi ${company.contactName || 'there'},</p>
          <p style="margin-top:12px">
            The treat delivery for <strong>${order.employeeName}</strong>
            scheduled for <strong>${deliveryDate}</strong> has been cancelled.
          </p>
          <p style="color:#888;font-size:0.85rem;margin-top:8px">
            Order #${orderId.slice(-8).toUpperCase()} · ${order.productName || '—'}
            ${order.cancelReason ? ` · Reason: ${order.cancelReason}` : ''}
          </p>
          ${refundHtml}
          <p style="margin-top:24px;font-size:0.85rem;color:#888">
            Questions? Reply to this email or contact
            <a href="mailto:${process.env.ADMIN_EMAIL}" style="color:#FF6B6B">
              ${process.env.ADMIN_EMAIL}
            </a>.
          </p>
          <p style="margin-top:16px;font-size:0.8rem;color:#AAA">
            Delightmaker · Halifax, NS 🇨🇦
          </p>
        </div>
      `,
    });
    console.log(`✅ Company cancellation notification sent: ${orderId} → ${company.contactEmail}`);
  } catch (err) {
    console.error('notifyCompanyCancellation error:', err.message);
  }
}


/**
 * Notify admin (Colton) of a cancellation
 */
async function notifyAdminCancellation(orderId, order, refundId, refundAmt, cancelledBy) {
  if (!isResendConfigured()) {
    console.log(`📧 [skip] Admin cancellation notification: ${orderId}`);
    return;
  }
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  try {
    const deliveryDate = order.deliveryDate
      ?.toDate()
      ?.toLocaleDateString('en-CA', {
        weekday: 'short', month: 'short', day: 'numeric',
      }) || '—';

    const resend = getResend();
    await resend.emails.send({
      from:    EMAIL_FROM(),
      to:      adminEmail,
      subject: `🚨 Order Cancelled${refundId ? ' + Refund Issued' : ''} — #${orderId.slice(-8).toUpperCase()}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#2D2D2D;margin-bottom:4px">
            Order Cancelled${refundId ? ' + Refund' : ''} 🚨
          </h2>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:0.9rem">
            <tr>
              <td style="padding:8px 0;color:#888;width:38%">Order ID</td>
              <td style="padding:8px 0;font-weight:600">#${orderId.slice(-8).toUpperCase()}</td>
            </tr>
            <tr style="background:#FAFAFA">
              <td style="padding:8px 0;color:#888">Employee</td>
              <td style="padding:8px 0">${order.employeeName || '—'}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#888">Company</td>
              <td style="padding:8px 0">${order.companyId || '—'}</td>
            </tr>
            <tr style="background:#FAFAFA">
              <td style="padding:8px 0;color:#888">Product</td>
              <td style="padding:8px 0">${order.productName || '—'}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#888">Delivery Date</td>
              <td style="padding:8px 0">${deliveryDate}</td>
            </tr>
            <tr style="background:#FAFAFA">
              <td style="padding:8px 0;color:#888">Cancelled By</td>
              <td style="padding:8px 0">${cancelledBy || '—'}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#888">Reason</td>
              <td style="padding:8px 0">${order.cancelReason || 'Not specified'}</td>
            </tr>
            ${refundId ? `
            <tr style="background:#FFF2F2">
              <td style="padding:8px 0;color:#C62828;font-weight:600">Refund Amount</td>
              <td style="padding:8px 0;color:#C62828;font-weight:700">
                $${Number(refundAmt || 0).toFixed(2)} CAD
              </td>
            </tr>
            <tr style="background:#FFF2F2">
              <td style="padding:8px 0;color:#888">Stripe Refund ID</td>
              <td style="padding:8px 0;font-size:0.8rem;color:#888">${refundId}</td>
            </tr>
            ` : `
            <tr style="background:#FAFAFA">
              <td style="padding:8px 0;color:#888">Refund</td>
              <td style="padding:8px 0;color:#888">Not charged — no refund needed</td>
            </tr>
            `}
          </table>
          <p style="margin-top:24px;font-size:0.8rem;color:#AAA">
            Delightmaker Admin · ${new Date().toLocaleString('en-CA')}
          </p>
        </div>
      `,
    });
    console.log(`✅ Admin cancellation notification sent: ${orderId} → ${adminEmail}`);
  } catch (err) {
    console.error('notifyAdminCancellation error:', err.message);
  }
}


/* ═══════════════════════════════════════════════════
   POST /api/orders/sync-employee-bundle
   Company user or admin
   Called after an employee's treat override is saved.
   Finds all unpaid scheduled/pending orders for that
   employee and updates them with the current bundle
   (product names, prices, lineItems, bakerId).
   ═══════════════════════════════════════════════════ */

router.post('/sync-employee-bundle',
  authenticate,
  async (req, res) => {
    try {
      const { employeeId, companyId } = req.body;

      if (!employeeId || !companyId) {
        return res.status(400).json({
          error: 'employeeId and companyId required',
        });
      }

      // Company users can only sync their own company
      if (
        req.user.role === 'company_user' &&
        req.user.companyId !== companyId
      ) {
        return res.status(403).json({
          error: 'Access denied',
        });
      }

      // ── Fetch employee + rules ─────────────────
      const [empDoc, rulesDoc] = await Promise.all([
        db.collection('employees').doc(employeeId).get(),
        db.collection('giftingRules').doc(companyId).get(),
      ]);

      if (!empDoc.exists) {
        return res.status(404).json({
          error: 'Employee not found',
        });
      }

      const employee = empDoc.data();
      const rules    = rulesDoc.exists
        ? rulesDoc.data()
        : {};
      const bd       = rules.birthday || {};

      // Resolve bundle — employee override takes priority
      const bundle = (
        employee.birthdayBundle &&
        employee.birthdayBundle.length > 0
      )
        ? employee.birthdayBundle
        : bd.bundle?.length > 0
        ? bd.bundle
        : [];

      if (bundle.length === 0) {
        return res.status(200).json({
          success: true,
          updated: 0,
          message: 'No bundle configured — nothing to sync',
        });
      }

      // ── Resolve product prices ─────────────────
      const lineItems    = [];
      let   chargeAmount = 0;
      let   wholesaleCost = 0;

      for (const item of bundle) {
        if (!item.bakeryId || !item.treatType) continue;

        let unitPrice     = 0;
        let wholesaleUnit = 0;
        let productName   = item.treatType;

        try {
          const productDoc = await db
            .collection(COLLECTIONS.BAKERIES)
            .doc(item.bakeryId)
            .collection('products')
            .doc(item.treatType)
            .get();

          if (productDoc.exists) {
            const p       = productDoc.data();
            unitPrice     = p.price || p.retailPrice || 0;
            wholesaleUnit = p.wholesaleCost || 0;
            productName   = p.name || item.treatType;
          }
        } catch (err) {
          console.warn(
            `sync-employee-bundle: product lookup ` +
            `failed for ${item.treatType}:`,
            err.message
          );
        }

        const qty = item.qty || 1;
        lineItems.push({
          bakeryId:    item.bakeryId,
          treatType:   item.treatType,
          productName,
          qty,
          unitPrice,
          lineTotal:   unitPrice * qty,
        });
        chargeAmount  += unitPrice     * qty;
        wholesaleCost += wholesaleUnit * qty;
      }

      const productSummary = lineItems.length === 1
        ? lineItems[0].productName
        : `Birthday Bundle (${lineItems.length} items)`;

      const primaryBakerId =
        lineItems[0]?.bakeryId || null;

      // ── Find unpaid pending/scheduled orders ───
      const ordersSnap = await db
        .collection(COLLECTIONS.ORDERS)
        .where('employeeId', '==', employeeId)
        .where('companyId',  '==', companyId)
        .get();

      const toUpdate = ordersSnap.docs.filter(doc => {
        const o = doc.data();
        return (
          o.chargeStatus !== 'paid' &&
          o.status !== 'cancelled'  &&
          o.status !== 'delivered'
        );
      });

      if (toUpdate.length === 0) {
        return res.status(200).json({
          success: true,
          updated: 0,
          message: 'No pending orders to update',
        });
      }

      // ── Batch update all matching orders ───────
      const batch = db.batch();
      toUpdate.forEach(doc => {
        batch.update(doc.ref, {
          lineItems,
          productName:  productSummary,
          chargeAmount,
          wholesaleCost,
          bakerId:      primaryBakerId,
          updatedAt:    serverTimestamp(),
        });
      });
      await batch.commit();

      console.log(
        `✅ sync-employee-bundle: updated ` +
        `${toUpdate.length} orders for ` +
        `employee ${employeeId}`
      );

      return res.status(200).json({
        success: true,
        updated: toUpdate.length,
        productName:  productSummary,
        chargeAmount,
      });

    } catch (err) {
      console.error('sync-employee-bundle error:', err);
      return res.status(500).json({
        error: 'Failed to sync orders',
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;
module.exports.notifyBakerNewOrder = notifyBakerNewOrder;