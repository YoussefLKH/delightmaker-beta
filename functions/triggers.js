/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — FIRESTORE TRIGGERS
   Event-driven functions that react to database
   changes in real time.

   These are NOT Firebase Cloud Functions.
   They run inside our Node.js server process
   and are called from routes when data changes.

   TRIGGERS INCLUDED:
   1. onOrderStatusChange   → fires when order status
                              changes
   2. onCompanyCreated      → fires when new company
                              is added
   3. onEmployeeAdded       → fires when new employee
                              is added
   4. onEmployeeUpdated     → fires when employee
                              data changes
   5. onEmployeeRemoved     → fires when employee
                              is deactivated
   6. onBakeryDeactivated   → fires when bakery
                              goes offline
   ═══════════════════════════════════════════════════ */

'use strict';

const {
  db,
  admin,
  COLLECTIONS,
  ORDER_STATUS,
  EVENT_TYPES,
  serverTimestamp,
  getNextOccurrence,
  yearsOfService,
  writeAuditLog,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   TRIGGER 1 — onOrderStatusChange
   Called from routes/orders.js whenever an order
   status is updated.

   Handles:
   → confirmed  : notifies admin dashboard
   → routed     : sends baker email
   → delivered  : charges Stripe + notifies HR
   → cancelled  : notifies baker if already routed
   → exception  : alerts Colton immediately
   ═══════════════════════════════════════════════════ */

async function onOrderStatusChange(
  orderId,
  newStatus,
  oldStatus,
  orderData,
  triggeredBy = 'system'
) {
  console.log(
    `🔔 Order status change: ${orderId} ` +
    `${oldStatus} → ${newStatus}`
  );

  try {

    switch (newStatus) {

      // ── Order confirmed ──────────────────────────
      case ORDER_STATUS.CONFIRMED: {
        await handleOrderConfirmed(
          orderId, orderData
        );
        break;
      }

      // ── Order routed to baker ────────────────────
      case ORDER_STATUS.ROUTED: {
        await handleOrderRouted(
          orderId, orderData
        );
        break;
      }

      // ── Order delivered ──────────────────────────
      case ORDER_STATUS.DELIVERED: {
        await handleOrderDelivered(
          orderId, orderData
        );
        break;
      }

      // ── Order cancelled ──────────────────────────
      case ORDER_STATUS.CANCELLED: {
        await handleOrderCancelled(
          orderId, orderData, oldStatus
        );
        break;
      }

      // ── Order flagged as exception ───────────────
      case ORDER_STATUS.EXCEPTION: {
        await handleOrderException(
          orderId, orderData
        );
        break;
      }

      default:
        // No action needed for other status changes
        break;
    }

  } catch (err) {
    console.error(
      `❌ Trigger error for order ${orderId}:`,
      err.message
    );
    // Don't throw — trigger failures should not
    // break the route that called them
  }
}


/* ── Handler: Order Confirmed ─────────────────────
   Called when HR approves or auto-confirm fires
   → Logs to console for Colton to see
   → Updates company's pending count
   → Order is now ready to be routed
   ─────────────────────────────────────────────── */

async function handleOrderConfirmed(
  orderId, order
) {
  console.log(
    `  ✅ Order confirmed: ${orderId} ` +
    `(${order.employeeName} — ${order.eventType})`
  );

  // Update company stats
  try {
    await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .update({
        'stats.pendingOrders':
          admin.firestore.FieldValue.increment(-1),
        'stats.confirmedOrders':
          admin.firestore.FieldValue.increment(1),
        updatedAt: serverTimestamp(),
      });
  } catch (err) {
    // Stats update failure is non-critical
    console.warn(
      '  ⚠️  Company stats update failed:', err.message
    );
  }
}


/* ── Handler: Order Routed ────────────────────────
   Called when Colton assigns order to a bakery
   → Sends email notification to baker
   → Updates bakery's order count
   ─────────────────────────────────────────────── */

async function handleOrderRouted(orderId, order) {
  console.log(
    `  🧁 Order routed: ${orderId} → ` +
    `${order.bakeryName || order.bakerId}`
  );

  // Send baker notification email
  try {
    await sendBakerNotificationEmail(
      orderId, order
    );
  } catch (err) {
    console.error(
      '  ❌ Baker email failed:', err.message
    );
  }

  // Update bakery stats
  if (order.bakerId) {
    try {
      await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(order.bakerId)
        .update({
          'stats.activeOrders':
            admin.firestore.FieldValue.increment(1),
          'stats.totalOrdersAllTime':
            admin.firestore.FieldValue.increment(1),
          updatedAt: serverTimestamp(),
        });
    } catch (err) {
      console.warn(
        '  ⚠️  Bakery stats update failed:',
        err.message
      );
    }
  }
}


/* ── Handler: Order Delivered ─────────────────────
   Called when baker marks order as delivered
   → Triggers Stripe charge
   → Sends delivery email to company HR
   → Sends notification to Colton
   → Updates all stats
   ─────────────────────────────────────────────── */

async function handleOrderDelivered(
  orderId, order
) {
  console.log(
    `  🎉 Order delivered: ${orderId} ` +
    `(${order.employeeName})`
  );

  // 1. Send delivery confirmation to company HR
  try {
    await sendDeliveryConfirmationEmail(
      orderId, order
    );
  } catch (err) {
    console.error(
      '  ❌ Delivery email failed:', err.message
    );
  }

  // 3. Update company stats
  try {
    await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .update({
        'stats.deliveredOrders':
          admin.firestore.FieldValue.increment(1),
        'stats.totalSpend':
          admin.firestore.FieldValue
            .increment(order.chargeAmount || 0),
        updatedAt: serverTimestamp(),
      });
  } catch (err) {
    console.warn(
      '  ⚠️  Company stats update failed:',
      err.message
    );
  }

  // 4. Update bakery stats
  if (order.bakerId) {
    try {
      await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(order.bakerId)
        .update({
          'stats.activeOrders':
            admin.firestore.FieldValue.increment(-1),
          'stats.deliveredOrders':
            admin.firestore.FieldValue.increment(1),
          'stats.totalEarned':
            admin.firestore.FieldValue
              .increment(order.wholesaleCost || 0),
          updatedAt: serverTimestamp(),
        });
    } catch (err) {
      console.warn(
        '  ⚠️  Bakery stats update failed:',
        err.message
      );
    }
  }
}


/* ── Handler: Order Cancelled ─────────────────────
   Called when order is cancelled by HR or admin
   → Notifies baker if already routed
   → Reverses stats if needed
   ─────────────────────────────────────────────── */

async function handleOrderCancelled(
  orderId, order, oldStatus
) {
  console.log(
    `  ❌ Order cancelled: ${orderId} ` +
    `(was: ${oldStatus})`
  );

  // Notify baker only if order was already routed
  if (
    oldStatus === ORDER_STATUS.ROUTED ||
    oldStatus === ORDER_STATUS.IN_PREPARATION
  ) {
    if (order.bakerId) {
      try {
        await sendBakerCancellationEmail(
          orderId, order
        );
      } catch (err) {
        console.error(
          '  ❌ Baker cancel email failed:',
          err.message
        );
      }

      // Update bakery active order count
      try {
        await db
          .collection(COLLECTIONS.BAKERIES)
          .doc(order.bakerId)
          .update({
            'stats.activeOrders':
              admin.firestore.FieldValue
                .increment(-1),
            updatedAt: serverTimestamp(),
          });
      } catch (err) {
        console.warn(
          '  ⚠️  Bakery stats update failed:',
          err.message
        );
      }
    }
  }
}


/* ── Handler: Order Exception ─────────────────────
   Called when order is flagged as exception
   → Sends immediate alert to Colton
   ─────────────────────────────────────────────── */

async function handleOrderException(
  orderId, order
) {
  console.log(
    `  🚨 Order exception: ${orderId} ` +
    `— ${order.exceptionReason || 'Unknown reason'}`
  );

  // Send alert to Colton
  try {
    await sendExceptionAlertEmail(orderId, order);
  } catch (err) {
    console.error(
      '  ❌ Exception alert email failed:',
      err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   TRIGGER 2 — onCompanyCreated
   Called from routes when Colton adds a new client
   → Scans their employees immediately
   → Creates orders for any upcoming events
   → Sets up default stats object
   ═══════════════════════════════════════════════════ */

async function onCompanyCreated(
  companyId, companyData
) {
  console.log(
    `🏢 New company trigger: ${companyId} ` +
    `(${companyData.name})`
  );

  try {

    // Initialize stats object
    await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(companyId)
      .update({
        stats: {
          employeeCount:    0,
          pendingOrders:    0,
          confirmedOrders:  0,
          deliveredOrders:  0,
          totalSpend:       0,
        },
        updatedAt: serverTimestamp(),
      });

    // Scan for upcoming events immediately
    // (Don't wait for 8am cron)
    const { scanCompanyNow } =
      require('./scheduler');

    const results = await scanCompanyNow(companyId);

    console.log(
      `  ✅ Initial scan complete: ` +
      `${results.ordersCreated} orders created`
    );

  } catch (err) {
    console.error(
      `❌ onCompanyCreated trigger error:`,
      err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   TRIGGER 3 — onEmployeeAdded
   Called when HR uploads CSV or adds one employee
   → Checks if any upcoming events exist
   → Creates orders if event within 30 days
   → Updates company employee count
   ═══════════════════════════════════════════════════ */

async function onEmployeeAdded(
  employeeId, employeeData, companyId
) {
  console.log(
    `👤 New employee trigger: ${employeeId} ` +
    `(${employeeData.name})`
  );

  try {

    // Update company employee count
    await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(companyId)
      .update({
        'stats.employeeCount':
          admin.firestore.FieldValue.increment(1),
        updatedAt: serverTimestamp(),
      });


    // Check for upcoming events immediately
    const today    = new Date();
    today.setHours(0, 0, 0, 0);

    const lookAhead = new Date(today);
    lookAhead.setDate(lookAhead.getDate() + 30);


    // Get company + gifting rules
    const [companyDoc, rulesSnap] = await Promise.all([
      db.collection(COLLECTIONS.COMPANIES)
        .doc(companyId).get(),
      db.collection(COLLECTIONS.GIFTING_RULES)
        .where('companyId', '==', companyId)
        .where('active', '==', true)
        .get(),
    ]);

    if (!companyDoc.exists || rulesSnap.empty) {
      console.log(
        '  ⚠️  No company or rules found — skipping'
      );
      return;
    }

    const company      = companyDoc.data();
    const rulesByEvent = {};

    rulesSnap.docs.forEach(doc => {
      const rule = doc.data();
      rulesByEvent[rule.eventType] = {
        id:            doc.id,
        productId:     rule.productId,
        customMessage: rule.customMessage || '',
      };
    });


    // Import processEmployee from scheduler
    // to avoid duplicating logic
    const scheduler = require('./scheduler');

    // Use internal results object
    const results = {
      ordersCreated: 0,
      emailsSent:    0,
      autoConfirmed: 0,
      exceptions:    0,
      errors:        [],
    };

    // Process this single employee
    // (reuses scheduler logic)
    await scheduler.scanCompanyNow(companyId);

    console.log(
      `  ✅ Employee scan complete: ` +
      `${results.ordersCreated} orders created`
    );

  } catch (err) {
    console.error(
      `❌ onEmployeeAdded trigger error:`,
      err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   TRIGGER 4 — onEmployeeUpdated
   Called when HR edits employee data
   → If dietary flags changed → flag pending orders
   → If delivery address changed → update orders
   → If birthday changed → reschedule orders
   ═══════════════════════════════════════════════════ */

async function onEmployeeUpdated(
  employeeId,
  newData,
  oldData,
  companyId
) {
  console.log(
    `✏️  Employee updated: ${employeeId} ` +
    `(${newData.name})`
  );

  try {

    const changes = [];


    // ── Check dietary flags changed ────────────────
    const oldDietary =
      JSON.stringify(oldData.dietaryFlags || []);
    const newDietary =
      JSON.stringify(newData.dietaryFlags || []);

    if (oldDietary !== newDietary) {
      changes.push('dietary');
      console.log(
        `  🍽️  Dietary flags changed: ` +
        `${oldData.dietaryFlags?.join(', ') || 'none'} ` +
        `→ ` +
        `${newData.dietaryFlags?.join(', ') || 'none'}`
      );

      // Flag all pending/confirmed orders
      // for this employee
      await flagOrdersForDietaryChange(
        employeeId, newData.dietaryFlags || []
      );
    }


    // ── Check delivery address changed ─────────────
    if (oldData.deliveryAddress !==
        newData.deliveryAddress) {
      changes.push('address');
      console.log(
        `  📍 Address changed for ${employeeId}`
      );

      // Update address on all upcoming orders
      await updateOrderAddresses(
        employeeId, newData.deliveryAddress
      );
    }


    // ── Check birthday changed ─────────────────────
    const oldBday = oldData.birthday?.toDate
      ? oldData.birthday.toDate().toISOString()
      : oldData.birthday;
    const newBday = newData.birthday?.toDate
      ? newData.birthday.toDate().toISOString()
      : newData.birthday;

    if (oldBday !== newBday) {
      changes.push('birthday');
      console.log(
        `  🎂 Birthday changed for ${employeeId}`
      );

      // Cancel old birthday orders
      // and reschedule
      await rescheduleBirthdayOrders(
        employeeId, newData
      );
    }


    if (changes.length === 0) {
      console.log('  ℹ️  No relevant changes detected');
    } else {
      console.log(
        `  ✅ Changes processed: ${changes.join(', ')}`
      );
    }

  } catch (err) {
    console.error(
      `❌ onEmployeeUpdated trigger error:`,
      err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   TRIGGER 5 — onEmployeeRemoved
   Called when HR deactivates an employee
   (Soft delete — employee marked inactive)
   → Cancels all future orders for this employee
   → Updates company employee count
   ═══════════════════════════════════════════════════ */

async function onEmployeeRemoved(
  employeeId, employeeData, companyId
) {
  console.log(
    `🗑️  Employee removed: ${employeeId} ` +
    `(${employeeData.name})`
  );

  try {

    const now   = new Date();
    const nowTs =
      admin.firestore.Timestamp.fromDate(now);


    // Find all future non-delivered orders
    const ordersSnap = await db
      .collection(COLLECTIONS.ORDERS)
      .where('employeeId', '==', employeeId)
      .where('deliveryDate', '>', nowTs)
      .where('status', 'not-in', [
        ORDER_STATUS.DELIVERED,
        ORDER_STATUS.CANCELLED,
      ])
      .get();

    if (!ordersSnap.empty) {
      const batch = db.batch();

      ordersSnap.docs.forEach(doc => {
        batch.update(doc.ref, {
          status:       ORDER_STATUS.CANCELLED,
          cancelledAt:  serverTimestamp(),
          cancelledBy:  'system',
          cancelReason: 'Employee deactivated',
        });
      });

      await batch.commit();

      console.log(
        `  ✅ Cancelled ${ordersSnap.size} ` +
        `future orders`
      );
    } else {
      console.log('  ℹ️  No future orders to cancel');
    }


    // Update company employee count
    try {
      await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(companyId)
        .update({
          'stats.employeeCount':
            admin.firestore.FieldValue.increment(-1),
          updatedAt: serverTimestamp(),
        });
    } catch (err) {
      console.warn(
        '  ⚠️  Company stats update failed:',
        err.message
      );
    }


    // Write audit log
    await writeAuditLog(
      'system',
      'cancel_employee_orders',
      'employee',
      employeeId,
      {
        companyId,
        ordersCancelled: ordersSnap.size,
        reason:          'Employee deactivated',
      }
    );

  } catch (err) {
    console.error(
      `❌ onEmployeeRemoved trigger error:`,
      err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   TRIGGER 6 — onBakeryDeactivated
   Called when Colton deactivates a bakery
   → Finds all routed orders for that bakery
   → Resets them back to "confirmed" status
   → Alerts Colton to re-route
   ═══════════════════════════════════════════════════ */

async function onBakeryDeactivated(
  bakeryId, bakeryData
) {
  console.log(
    `🚫 Bakery deactivated: ${bakeryId} ` +
    `(${bakeryData.name})`
  );

  try {

    // Find all active orders for this bakery
    const ordersSnap = await db
      .collection(COLLECTIONS.ORDERS)
      .where('bakerId', '==', bakeryId)
      .where('status',  '==', ORDER_STATUS.ROUTED)
      .get();

    if (ordersSnap.empty) {
      console.log(
        '  ℹ️  No active orders affected'
      );
      return;
    }

    console.log(
      `  ⚠️  ${ordersSnap.size} orders ` +
      `need re-routing`
    );


    // Reset orders to confirmed (needs re-routing)
    const batch = db.batch();

    ordersSnap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status:          ORDER_STATUS.CONFIRMED,
        bakerId:         null,
        bakeryName:      '',
        routedAt:        null,
        exceptionReason: `Bakery deactivated: ` +
                         `${bakeryData.name}. ` +
                         `Needs re-routing.`,
        updatedAt:       serverTimestamp(),
      });
    });

    await batch.commit();

    console.log(
      `  ✅ Reset ${ordersSnap.size} orders ` +
      `to confirmed status`
    );


    // Alert Colton
    await sendBakeryDeactivationAlert(
      bakeryId,
      bakeryData,
      ordersSnap.size
    );

  } catch (err) {
    console.error(
      `❌ onBakeryDeactivated trigger error:`,
      err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   INTERNAL HELPER FUNCTIONS
   ═══════════════════════════════════════════════════ */

/**
 * Flag pending/confirmed orders for an employee
 * when their dietary flags change
 * Marks them as exception for Colton to review
 */
async function flagOrdersForDietaryChange(
  employeeId, newDietaryFlags
) {
  const now   = new Date();
  const nowTs =
    admin.firestore.Timestamp.fromDate(now);

  const ordersSnap = await db
    .collection(COLLECTIONS.ORDERS)
    .where('employeeId', '==', employeeId)
    .where('deliveryDate', '>', nowTs)
    .where('status', 'not-in', [
      ORDER_STATUS.DELIVERED,
      ORDER_STATUS.CANCELLED,
    ])
    .get();

  if (ordersSnap.empty) return;

  const batch = db.batch();

  ordersSnap.docs.forEach(doc => {
    batch.update(doc.ref, {
      dietaryFlags:    newDietaryFlags,
      status:          ORDER_STATUS.EXCEPTION,
      exceptionReason: 'Dietary flags changed. ' +
                       'Please verify bakery can ' +
                       'accommodate: ' +
                       newDietaryFlags.join(', '),
      flaggedAt:       serverTimestamp(),
    });
  });

  await batch.commit();

  console.log(
    `  🍽️  Updated dietary flags on ` +
    `${ordersSnap.size} orders`
  );
}


/**
 * Update delivery address on all upcoming orders
 * for an employee
 */
async function updateOrderAddresses(
  employeeId, newAddress
) {
  if (!newAddress) return;

  const now   = new Date();
  const nowTs =
    admin.firestore.Timestamp.fromDate(now);

  const ordersSnap = await db
    .collection(COLLECTIONS.ORDERS)
    .where('employeeId', '==', employeeId)
    .where('deliveryDate', '>', nowTs)
    .where('status', 'not-in', [
      ORDER_STATUS.DELIVERED,
      ORDER_STATUS.CANCELLED,
    ])
    .get();

  if (ordersSnap.empty) return;

  const batch = db.batch();

  ordersSnap.docs.forEach(doc => {
    batch.update(doc.ref, {
      deliveryAddress: newAddress,
      updatedAt:       serverTimestamp(),
    });
  });

  await batch.commit();

  console.log(
    `  📍 Updated address on ` +
    `${ordersSnap.size} orders`
  );
}


/**
 * Cancel existing birthday orders and
 * trigger reschedule when birthday date changes
 */
async function rescheduleBirthdayOrders(
  employeeId, newEmployeeData
) {
  const now   = new Date();
  const nowTs =
    admin.firestore.Timestamp.fromDate(now);

  // Cancel all future birthday orders
  const ordersSnap = await db
    .collection(COLLECTIONS.ORDERS)
    .where('employeeId', '==', employeeId)
    .where('eventType',  '==', EVENT_TYPES.BIRTHDAY)
    .where('deliveryDate', '>', nowTs)
    .where('status', 'not-in', [
      ORDER_STATUS.DELIVERED,
      ORDER_STATUS.CANCELLED,
    ])
    .get();

  if (!ordersSnap.empty) {
    const batch = db.batch();

    ordersSnap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status:       ORDER_STATUS.CANCELLED,
        cancelledAt:  serverTimestamp(),
        cancelledBy:  'system',
        cancelReason: 'Birthday date updated — ' +
                      'rescheduled automatically',
      });
    });

    await batch.commit();

    console.log(
      `  🎂 Cancelled ${ordersSnap.size} ` +
      `old birthday orders`
    );
  }

  // The scheduler's next morning run will
  // automatically create a new birthday order
  // with the correct date
  // But we can also trigger it immediately:
  try {
    const scheduler = require('./scheduler');
    await scheduler.scanCompanyNow(
      newEmployeeData.companyId
    );
  } catch (err) {
    console.warn(
      '  ⚠️  Immediate rescan failed:', err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   EMAIL HELPER FUNCTIONS
   Called internally by triggers
   Uses Resend directly (not via HTTP routes)
   ═══════════════════════════════════════════════════ */

/**
 * Send baker notification email
 * Called when order is routed to bakery
 */
async function sendBakerNotificationEmail(
  orderId, order
) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey ||
      resendKey === 'your_resend_key_here') {
    console.log(
      `  📧 Baker email skipped (not configured)`
    );
    return;
  }

  // Get bakery contact email
  const bakeryDoc = await db
    .collection(COLLECTIONS.BAKERIES)
    .doc(order.bakerId)
    .get();

  if (!bakeryDoc.exists) return;

  const bakery = bakeryDoc.data();
  if (!bakery.contactEmail) return;

  const deliveryDate = order.deliveryDate?.toDate
    ? order.deliveryDate.toDate()
        .toLocaleDateString('en-CA', {
          weekday: 'long',
          month:   'long',
          day:     'numeric',
        })
    : 'TBD';

  const dietaryAlert =
    order.dietaryFlags &&
    order.dietaryFlags.length > 0
    ? `<div style="
         background: #FFEBEE;
         border:     1px solid #FFCDD2;
         padding:    10px 14px;
         border-radius: 8px;
         color:      #C62828;
         font-weight: 700;
         margin:     12px 0;
       ">
         🚨 DIETARY REQUIREMENTS: 
         ${order.dietaryFlags
           .map(f => f.toUpperCase())
           .join(', ')}
       </div>`
    : '';

  const { Resend } = require('resend');
  const resend     = new Resend(resendKey);

  await resend.emails.send({
    from:    `${process.env.RESEND_FROM_NAME} ` +
             `<${process.env.RESEND_FROM_EMAIL}>`,
    to:      bakery.contactEmail,
    subject: `📦 New Order #${
      orderId.slice(-8).toUpperCase()
    } — Due ${deliveryDate}`,
    html: `
      <div style="
        font-family: Arial, sans-serif;
        max-width:   580px;
        margin:      0 auto;
        padding:     24px;
      ">
        <div style="
          background:    #2D2D2D;
          color:         white;
          padding:       20px;
          border-radius: 12px 12px 0 0;
          text-align:    center;
          font-weight:   700;
          font-size:     1.1rem;
        ">
          🧁 Delightmaker — New Order
        </div>

        <div style="
          background:  white;
          padding:     24px;
          border:      1px solid #eee;
        ">
          <h2 style="margin:0 0 12px">
            📦 New Order — ${bakery.name}
          </h2>
          <p>You have a new order to prepare
             and deliver.</p>

          ${dietaryAlert}

          <table style="
            width:           100%;
            border-collapse: collapse;
            margin:          12px 0;
          ">
            <tr style="
              background: #FFFAF5;
              border:     2px solid #FFD93D;
            ">
              <th style="
                padding:    10px 14px;
                text-align: left;
                color:      #888;
                font-size:  0.85rem;
              ">Detail</th>
              <th style="
                padding:    10px 14px;
                text-align: right;
              ">Value</th>
            </tr>
            <tr>
              <td style="padding:8px 14px;
                         color:#888;
                         font-size:0.9rem">
                Order ID
              </td>
              <td style="padding:8px 14px;
                         text-align:right;
                         font-weight:700;
                         font-size:0.85rem">
                #${orderId.slice(-8).toUpperCase()}
              </td>
            </tr>
            <tr style="background:#fafafa">
              <td style="padding:8px 14px;
                         color:#888;
                         font-size:0.9rem">
                Product
              </td>
              <td style="padding:8px 14px;
                         text-align:right;
                         font-weight:700">
                ${order.productName}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 14px;
                         color:#888;
                         font-size:0.9rem">
                Deliver By
              </td>
              <td style="padding:8px 14px;
                         text-align:right;
                         font-weight:700;
                         color:#FF6B6B">
                ${deliveryDate}
              </td>
            </tr>
            <tr style="background:#fafafa">
              <td style="padding:8px 14px;
                         color:#888;
                         font-size:0.9rem">
                Delivery Address
              </td>
              <td style="padding:8px 14px;
                         text-align:right;
                         font-weight:700">
                ${order.deliveryAddress || 'TBD'}
              </td>
            </tr>
            ${order.customMessage ? `
            <tr>
              <td style="padding:8px 14px;
                         color:#888;
                         font-size:0.9rem">
                Card Message
              </td>
              <td style="padding:8px 14px;
                         text-align:right;
                         font-style:italic">
                "${order.customMessage}"
              </td>
            </tr>
            ` : ''}
            ${order.bakerNotes ? `
            <tr style="background:#fafafa">
              <td style="padding:8px 14px;
                         color:#888;
                         font-size:0.9rem">
                Notes from Colton
              </td>
              <td style="padding:8px 14px;
                         text-align:right">
                ${order.bakerNotes}
              </td>
            </tr>
            ` : ''}
          </table>

          <a href="${process.env.APP_URL}/baker/dashboard"
             style="
               display:         block;
               background:      #FF6B6B;
               color:           white;
               padding:         14px;
               border-radius:   100px;
               text-decoration: none;
               font-weight:     700;
               text-align:      center;
               margin:          20px 0;
             ">
            View in Baker Portal →
          </a>

          <p style="
            text-align: center;
            font-size:  0.8rem;
            color:      #AAA;
          ">
            Please mark as delivered in the portal
            when the order is complete.
          </p>
        </div>

        <div style="
          background:    #F5F5F5;
          padding:       16px;
          border-radius: 0 0 12px 12px;
          text-align:    center;
          font-size:     0.78rem;
          color:         #AAA;
          border:        1px solid #eee;
        ">
          Questions? Contact Colton at
          <a href="mailto:${process.env.ADMIN_EMAIL}"
             style="color:#FF6B6B">
            ${process.env.ADMIN_EMAIL}
          </a>
        </div>
      </div>
    `,
  });

  console.log(
    `  📧 Baker notification sent → ` +
    `${bakery.contactEmail}`
  );
}


/**
 * Send delivery confirmation email to company HR
 * Called when order is marked delivered
 */
async function sendDeliveryConfirmationEmail(
  orderId, order
) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey ||
      resendKey === 'your_resend_key_here') {
    console.log(
      `  📧 Delivery email skipped (not configured)`
    );
    return;
  }

  // Get company contact email
  const companyDoc = await db
    .collection(COLLECTIONS.COMPANIES)
    .doc(order.companyId)
    .get();

  if (!companyDoc.exists) return;

  const company = companyDoc.data();
  if (!company.contactEmail) return;

  const eventLabels = {
    birthday:         'Birthday',
    anniversary_1yr:  '1 Year Anniversary',
    anniversary_2yr:  '2 Year Anniversary',
    anniversary_3yr:  '3 Year Anniversary',
    anniversary_5yr:  '5 Year Anniversary',
    anniversary_10yr: '10 Year Anniversary',
  };

  const { Resend } = require('resend');
  const resend     = new Resend(resendKey);

  await resend.emails.send({
    from:    `${process.env.RESEND_FROM_NAME} ` +
             `<${process.env.RESEND_FROM_EMAIL}>`,
    to:      company.contactEmail,
    subject: `🎉 Delivered! ` +
             `${order.employeeName}'s treat ` +
             `arrived today`,
    html: `
      <div style="
        font-family: Arial, sans-serif;
        max-width:   580px;
        margin:      0 auto;
        padding:     24px;
        background:  #FFFAF5;
      ">
        <div style="
          background:    #2D2D2D;
          color:         white;
          padding:       20px;
          border-radius: 12px 12px 0 0;
          text-align:    center;
          font-weight:   700;
          font-size:     1.1rem;
        ">
          🧁 Delightmaker
        </div>

        <div style="
          background:  white;
          padding:     32px;
          border:      1px solid #eee;
          text-align:  center;
        ">
          <div style="font-size:3rem;
                      margin-bottom:12px">
            🎉
          </div>
          <h2 style="color:#2D2D2D;
                     margin-bottom:8px">
            Delivered!
          </h2>
          <p style="color:#555;
                    margin-bottom:20px">
            ${order.employeeName}'s
            ${eventLabels[order.eventType]
              || 'celebration'} treat has been
            delivered to your office.
          </p>

          <div style="
            background:    #FFFAF5;
            border:        2px solid #FFD93D;
            border-radius: 10px;
            padding:       16px 20px;
            text-align:    left;
            margin:        20px 0;
          ">
            <div style="
              display:         flex;
              justify-content: space-between;
              padding:         6px 0;
              border-bottom:   1px solid #eee;
              font-size:       0.9rem;
            ">
              <span style="color:#888">Employee</span>
              <span style="font-weight:700">
                ${order.employeeName}
              </span>
            </div>
            <div style="
              display:         flex;
              justify-content: space-between;
              padding:         6px 0;
              border-bottom:   1px solid #eee;
              font-size:       0.9rem;
            ">
              <span style="color:#888">Treat</span>
              <span style="font-weight:700">
                ${order.productName}
              </span>
            </div>
            <div style="
              display:         flex;
              justify-content: space-between;
              padding:         6px 0;
              font-size:       0.9rem;
            ">
              <span style="color:#888">Charged</span>
              <span style="font-weight:700;
                           color:#FF6B6B">
                $${order.chargeAmount} CAD
              </span>
            </div>
          </div>

          <a href="${process.env.APP_URL}/company/spending"
             style="
               display:         block;
               background:      #FF6B6B;
               color:           white;
               padding:         13px;
               border-radius:   100px;
               text-decoration: none;
               font-weight:     700;
               margin:          16px 0;
             ">
            View Spending Report →
          </a>
        </div>

        <div style="
          background:    #F5F5F5;
          padding:       14px;
          border-radius: 0 0 12px 12px;
          text-align:    center;
          font-size:     0.78rem;
          color:         #AAA;
          border:        1px solid #eee;
        ">
          Delightmaker · Halifax, NS 🇨🇦
        </div>
      </div>
    `,
  });

  console.log(
    `  📧 Delivery confirmation sent → ` +
    `${company.contactEmail}`
  );
}


/**
 * Send baker cancellation notification
 * Called when routed order is cancelled
 */
async function sendBakerCancellationEmail(
  orderId, order
) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey ||
      resendKey === 'your_resend_key_here') {
    return;
  }

  const bakeryDoc = await db
    .collection(COLLECTIONS.BAKERIES)
    .doc(order.bakerId)
    .get();

  if (!bakeryDoc.exists) return;

  const bakery = bakeryDoc.data();
  if (!bakery.contactEmail) return;

  const { Resend } = require('resend');
  const resend     = new Resend(resendKey);

  await resend.emails.send({
    from:    `${process.env.RESEND_FROM_NAME} ` +
             `<${process.env.RESEND_FROM_EMAIL}>`,
    to:      bakery.contactEmail,
    subject: `❌ Order Cancelled — #${
      orderId.slice(-8).toUpperCase()
    }`,
    html: `
      <div style="
        font-family: Arial, sans-serif;
        max-width:   500px;
        margin:      0 auto;
        padding:     24px;
      ">
        <h2>❌ Order Cancelled</h2>
        <p>
          Order <strong>#${
            orderId.slice(-8).toUpperCase()
          }</strong>
          has been cancelled.
        </p>
        <p>
          <strong>Product:</strong>
          ${order.productName}<br/>
          <strong>Reason:</strong>
          ${order.cancelReason || 'Not specified'}
        </p>
        <p>
          Please do not prepare this order.
          Contact Colton if you have questions.
        </p>
        <p style="color:#888;font-size:0.85rem">
          <a href="mailto:${process.env.ADMIN_EMAIL}"
             style="color:#FF6B6B">
            ${process.env.ADMIN_EMAIL}
          </a>
        </p>
      </div>
    `,
  });

  console.log(
    `  📧 Cancellation notice sent → ` +
    `${bakery.contactEmail}`
  );
}


/**
 * Send exception alert to Colton
 * Called when order is flagged as exception
 */
async function sendExceptionAlertEmail(
  orderId, order
) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey ||
      resendKey === 'your_resend_key_here') {
    return;
  }

  const { Resend } = require('resend');
  const resend     = new Resend(resendKey);

  await resend.emails.send({
    from:    `${process.env.RESEND_FROM_NAME} ` +
             `<${process.env.RESEND_FROM_EMAIL}>`,
    to:      process.env.ADMIN_EMAIL,
    subject: `🚨 Order Exception — #${
      orderId.slice(-8).toUpperCase()
    } needs attention`,
    html: `
      <div style="
        font-family: Arial, sans-serif;
        max-width:   500px;
        margin:      0 auto;
        padding:     24px;
      ">
        <h2>🚨 Order Exception</h2>
        <p>
          Order <strong>#${
            orderId.slice(-8).toUpperCase()
          }</strong>
          has been flagged and needs your attention.
        </p>
        <table style="width:100%;
                      border-collapse:collapse;
                      margin:12px 0">
          <tr>
            <td style="padding:8px;
                       color:#888;
                       font-size:0.9rem">
              Employee
            </td>
            <td style="padding:8px;
                       font-weight:700">
              ${order.employeeName}
            </td>
          </tr>
          <tr style="background:#fafafa">
            <td style="padding:8px;
                       color:#888;
                       font-size:0.9rem">
              Product
            </td>
            <td style="padding:8px;
                       font-weight:700">
              ${order.productName}
            </td>
          </tr>
          <tr>
            <td style="padding:8px;
                       color:#888;
                       font-size:0.9rem">
              Issue
            </td>
            <td style="padding:8px;
                       color:#C62828;
                       font-weight:700">
              ${order.exceptionReason ||
                'No reason provided'}
            </td>
          </tr>
        </table>
        <a href="${process.env.APP_URL}/admin/orders"
           style="
             display:         inline-block;
             background:      #FF6B6B;
             color:           white;
             padding:         12px 24px;
             border-radius:   100px;
             text-decoration: none;
             font-weight:     700;
             margin-top:      16px;
           ">
          Review in Dashboard →
        </a>
      </div>
    `,
  });

  console.log(
    `  📧 Exception alert sent to Colton`
  );
}


/**
 * Alert Colton when a bakery is deactivated
 * and orders need re-routing
 */
async function sendBakeryDeactivationAlert(
  bakeryId, bakery, affectedOrderCount
) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey ||
      resendKey === 'your_resend_key_here') {
    return;
  }

  const { Resend } = require('resend');
  const resend     = new Resend(resendKey);

  await resend.emails.send({
    from:    `${process.env.RESEND_FROM_NAME} ` +
             `<${process.env.RESEND_FROM_EMAIL}>`,
    to:      process.env.ADMIN_EMAIL,
    subject: `⚠️ Bakery deactivated — ` +
             `${affectedOrderCount} order(s) ` +
             `need re-routing`,
    html: `
      <div style="
        font-family: Arial, sans-serif;
        max-width:   500px;
        margin:      0 auto;
        padding:     24px;
      ">
        <h2>⚠️ Bakery Deactivated</h2>
        <p>
          <strong>${bakery.name}</strong>
          has been deactivated.
        </p>
        <p>
          <strong>${affectedOrderCount}</strong>
          active order(s) have been reset and
          need to be re-routed to a different bakery.
        </p>
        <a href="${process.env.APP_URL}/admin/orders"
           style="
             display:         inline-block;
             background:      #FF6B6B;
             color:           white;
             padding:         12px 24px;
             border-radius:   100px;
             text-decoration: none;
             font-weight:     700;
             margin-top:      16px;
           ">
          Route Orders Now →
        </a>
      </div>
    `,
  });
}


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = {
  onOrderStatusChange,
  onCompanyCreated,
  onEmployeeAdded,
  onEmployeeUpdated,
  onEmployeeRemoved,
  onBakeryDeactivated,
};