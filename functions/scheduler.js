/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — SCHEDULER
   Daily automated order scanning and creation
   Runs every morning at 8am Halifax time
   Called from server.js cron job
   ═══════════════════════════════════════════════════

   WHAT THIS DOES EVERY MORNING:
   1. Scans ALL employees across ALL companies
   2. Finds upcoming birthdays + anniversaries
   3. Creates orders for events in next 30 days
      (if order doesn't already exist)
   4. Sends confirmation emails for orders
      that are 7 days away
   5. Auto-confirms orders that have been
      waiting more than 48 hours
   6. Flags overdue orders as exceptions
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
  writeAuditLog,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   MAIN SCAN FUNCTION
   Called by cron job in server.js every morning
   ═══════════════════════════════════════════════════ */

async function runDailyScan(options = {}) {
  // force: true  →  force-scan all companies regardless of state (admin / testing)
  const force = options.force === true;

  console.log('\n🔍 Starting daily order scan...');
  console.log(`📅 Date: ${new Date().toDateString()}`);
  console.log(`⚙️  Force mode: ${force}`);
  console.log('─'.repeat(40));

  const results = {
    ordersCreated:   0,
    emailsSent:      0,
    autoConfirmed:   0,
    exceptions:      0,
    errors:          [],
    skipped:         [],   // companies skipped + why
  };

  try {

    // ── Step 1: Get companies ──────────────────────
    const companiesSnap = await db
      .collection(COLLECTIONS.COMPANIES)
      .get();
    console.log(
      `🏢 Scanning all ${companiesSnap.size} companies`
    );

    if (companiesSnap.empty) {
      console.log('No companies found. Scan complete.');
      return results;
    }


    // ── Step 2: Process each company ───────────────
    for (const companyDoc of companiesSnap.docs) {
      const companyId   = companyDoc.id;
      const company     = companyDoc.data();

      try {
        await processCompany(
          companyId,
          company,
          results
        );
      } catch (err) {
        console.error(
          `❌ Error processing company ` +
          `${companyId}:`, err.message
        );
        results.errors.push({
          companyId,
          error: err.message,
        });
      }
    }


    // ── Step 3: Auto-confirm pending orders ────────
    await processAutoConfirmations(results);


    // ── Step 4: Flag overdue orders ────────────────
    await processOverdueOrders(results);


    // ── Step 5: Print summary ──────────────────────
    console.log('\n📊 Daily scan complete:');
    console.log(
      `  ✅ Orders created:   ${results.ordersCreated}`
    );
    console.log(
      `  📧 Emails sent:      ${results.emailsSent}`
    );
    console.log(
      `  ✅ Auto-confirmed:   ${results.autoConfirmed}`
    );
    console.log(
      `  🚨 Exceptions:       ${results.exceptions}`
    );
    if (results.errors.length > 0) {
      console.log(
        `  ❌ Errors:           ${results.errors.length}`
      );
    }
    console.log('─'.repeat(40));

    return results;

  } catch (err) {
    console.error('❌ Daily scan failed:', err);
    throw err;
  }
}


/* ═══════════════════════════════════════════════════
   PROCESS SINGLE COMPANY
   Scans all employees for upcoming events
   Creates orders as needed
   ═══════════════════════════════════════════════════ */

async function processCompany(
  companyId, company, results
) {
  console.log(`  🏢 processCompany: ${companyId}`);

  // Get all active employees for this company
  const employeesSnap = await db
    .collection(COLLECTIONS.EMPLOYEES)
    .where('companyId', '==', companyId)
    .where('active',    '==', true)
    .get();

  console.log(`  👥 Active employees found: ${employeesSnap.size}`);

  if (employeesSnap.empty) {
    results.skipped.push({ companyId, reason: 'no active employees' });
    return;
  }

  // ── Gifting rules are stored as a single doc
  //    per company at giftingRules/{companyId}
  //    NOT a collection — fetch by doc ID directly
  const rulesDoc = await db
    .collection(COLLECTIONS.GIFTING_RULES)
    .doc(companyId)
    .get();

  let rules;

  if (!rulesDoc.exists) {
    // Create a safe default doc so the company is
    // not silently skipped on every scan
    const defaultRules = {
      birthday: {
        enabled:     false,
        bundle:      [],
        leadTimeDays: 7,
      },
      autoApprove: false,
      createdAt:   new Date(),
    };

    await db
      .collection(COLLECTIONS.GIFTING_RULES)
      .doc(companyId)
      .set(defaultRules);

    console.log(
      `  📋 Created default gifting rules for ` +
      `${companyId} — birthday gifting is OFF ` +
      `until enabled in the company dashboard`
    );

    rules = defaultRules;
  } else {
    rules = rulesDoc.data();
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Look ahead 30 days for upcoming events
  const lookAhead = new Date(today);
  lookAhead.setDate(lookAhead.getDate() + 30);


  // Process each employee
  for (const employeeDoc of employeesSnap.docs) {
    const employeeId = employeeDoc.id;
    const employee   = employeeDoc.data();

    try {
      await processEmployee(
        employeeId,
        employee,
        companyId,
        company,
        rules,
        today,
        lookAhead,
        results
      );
    } catch (err) {
      console.error(
        `  ❌ Employee ${employeeId}:`, err.message
      );
      results.errors.push({
        employeeId,
        companyId,
        error: err.message,
      });
    }
  }

  // Process company-wide celebrations
  try {
    await processCompanyCelebrations(
      companyId,
      company,
      rules,
      today,
      lookAhead,
      results
    );
  } catch (err) {
    console.error(
      `  ❌ Celebrations error for ${companyId}:`, err.message
    );
    results.errors.push({ companyId, error: err.message });
  }
}


/* ═══════════════════════════════════════════════════
   PROCESS SINGLE EMPLOYEE
   Checks all event types for this employee
   Creates orders for upcoming events
   ═══════════════════════════════════════════════════ */

async function processEmployee(
  employeeId,
  employee,
  companyId,
  company,
  rules,
  today,
  lookAhead,
  results
) {
  // ── Birthday check ─────────────────────────────
  const bd = rules.birthday || {};

  console.log(
    `  👤 ${employee.name} | ` +
    `bd.enabled: ${bd.enabled} | ` +
    `has birthday: ${!!employee.birthday} | ` +
    `bundle length: ${
      (employee.birthdayBundle?.length > 0
        ? employee.birthdayBundle
        : bd.bundle?.length > 0 ? bd.bundle : []
      ).length
    }`
  );

  if (!bd.enabled) {
    console.log(`  ⏭  Skipping ${employee.name} — birthday gifting is disabled in rules`);
    results.skipped = results.skipped || [];
    results.skipped.push({ name: employee.name, reason: 'birthday gifting disabled' });
    return;
  }

  if (!employee.birthday) {
    console.log(`  ⏭  Skipping ${employee.name} — no birthday set`);
    results.skipped = results.skipped || [];
    results.skipped.push({ name: employee.name, reason: 'no birthday on file' });
    return;
  }

  // Employee-level override takes priority over company default.
  // Fall back to bd.productId (single product from onboarding)
  // if no bundle array has been configured yet.
  const bundle = (employee.birthdayBundle &&
                  employee.birthdayBundle.length > 0)
    ? employee.birthdayBundle
    : bd.bundle?.length > 0
    ? bd.bundle
    : bd.productId
    ? [bd.productId]
    : [];

  if (bundle.length === 0) {
    console.log(
      `  ⚠️  No product/bundle configured for ` +
      `company ${companyId} — ` +
      `set one in the gifting rules page`
    );
    results.skipped.push({
      name:   employee.name,
      reason: 'no treat bundle configured in gifting rules',
    });
    return;
  }

  const birthday = employee.birthday.toDate
    ? employee.birthday.toDate()
    : new Date(employee.birthday);

  const nextBirthday = getNextOccurrence(birthday);

  console.log(`  🎂 ${employee.name} | Next birthday: ${nextBirthday.toDateString()} | today: ${today.toDateString()} | lookAhead: ${lookAhead.toDateString()}`);

  if (nextBirthday < today || nextBirthday > lookAhead) {
    console.log(`  ⏭  ${employee.name} birthday outside window — skipping`);
    results.skipped.push({
      name:   employee.name,
      reason: `birthday ${nextBirthday.toDateString()} outside 30-day window`,
    });
    return;
  }

  // ── Weekend adjustment ─────────────────────────
  const weekendPolicy  = bd.weekendPolicy  || 'friday_before';
  const weekendWarning = bd.weekendWarning !== false;
  const dayOfWeek      = nextBirthday.getDay(); // 0=Sun, 6=Sat
  const isWeekend      = dayOfWeek === 0 || dayOfWeek === 6;

  // Track if the date was shifted so we can show a badge in the UIs
  let weekendShiftInfo = null;

  if (isWeekend) {
    const originalDate = new Date(nextBirthday);
    const dayName      = dayOfWeek === 6 ? 'Saturday' : 'Sunday';

    if (weekendPolicy === 'friday_before') {
      // Saturday → −1 day (Friday), Sunday → −2 days (Friday)
      nextBirthday.setDate(
        nextBirthday.getDate() - (dayOfWeek === 6 ? 1 : 2)
      );
    } else {
      // monday_after: Saturday → +2 days, Sunday → +1 day
      nextBirthday.setDate(
        nextBirthday.getDate() + (dayOfWeek === 6 ? 2 : 1)
      );
    }

    weekendShiftInfo = {
      originalDate,                  // real birthday (the weekend day)
      originalDayName: dayName,      // "Saturday" or "Sunday"
      shiftPolicy:     weekendPolicy,
    };

    console.log(
      `  📅 Birthday on ${dayName} — shifted to ` +
      `${nextBirthday.toDateString()} (policy: ${weekendPolicy})`
    );

    // Send weekend warning email — only once per employee per birthday year
    // Guard: check weekendWarningSentYear to avoid re-sending every day
    const warnYear = nextBirthday.getFullYear();
    const alreadyWarned = employee.weekendWarningSentYear === warnYear;
    if (weekendWarning && !alreadyWarned) {
      await sendWeekendBirthdayWarning(
        employee,
        company,
        originalDate,
        nextBirthday,
        dayName
      );
      // Stamp the employee doc so we don't re-send tomorrow
      await db.collection(COLLECTIONS.EMPLOYEES).doc(employeeId).update({
        weekendWarningSentYear: warnYear,
      });
    }
  }

  await createOrderIfNotExists(
    employeeId,
    employee,
    companyId,
    company,
    {
      eventType:    EVENT_TYPES.BIRTHDAY,
      deliveryDate: nextBirthday,
      bundle,
      autoApprove:  rules.autoApprove || false,
      weekendShift: weekendShiftInfo,
    },
    results
  );
}


/* ═══════════════════════════════════════════════════
   PROCESS COMPANY CELEBRATIONS
   Scans the celebrations collection for this company
   and creates orders for upcoming dates
   ═══════════════════════════════════════════════════ */

async function processCompanyCelebrations(
  companyId,
  company,
  rules,
  today,
  lookAhead,
  results
) {
  const celebSnap = await db
    .collection(COLLECTIONS.CELEBRATIONS)
    .where('companyId', '==', companyId)
    .where('active',    '==', true)
    .get();

  if (celebSnap.empty) return;

  console.log(
    `  🎉 ${celebSnap.size} active celebration(s) for ${companyId}`
  );

  for (const celebDoc of celebSnap.docs) {
    const celebId   = celebDoc.id;
    const celeb     = celebDoc.data();

    if (!celeb.bundle || celeb.bundle.length === 0) {
      console.log(
        `  ⏭  Celebration "${celeb.name}" has no bundle — skipping`
      );
      continue;
    }

    // Compute next occurrence from month+day
    const nextDate = new Date(
      today.getFullYear(),
      (celeb.month || 1) - 1,
      celeb.day  || 1
    );
    nextDate.setHours(9, 0, 0, 0);

    // If already passed this year and it repeats → next year
    if (nextDate < today) {
      if (celeb.repeatYearly !== false) {
        nextDate.setFullYear(today.getFullYear() + 1);
      } else {
        console.log(
          `  ⏭  Celebration "${celeb.name}" is past and non-repeating — skipping`
        );
        continue;
      }
    }

    if (nextDate > lookAhead) {
      console.log(
        `  ⏭  Celebration "${celeb.name}" on ` +
        `${nextDate.toDateString()} is outside 30-day window`
      );
      continue;
    }

    // Duplicate check: has an order already been created for
    // this celebration + this specific delivery date?
    const deliveryTs = admin.firestore.Timestamp.fromDate(nextDate);

    const existingSnap = await db
      .collection(COLLECTIONS.ORDERS)
      .where('celebrationId', '==', celebId)
      .where('deliveryDate',  '==', deliveryTs)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      // Order exists — still check if confirmation email needed
      await checkConfirmationNeeded(
        existingSnap.docs[0].id,
        existingSnap.docs[0].data(),
        rules.autoApprove || false,
        nextDate,
        results
      );
      continue;
    }

    // ── Resolve product prices from bundle ──────────
    const lineItems    = [];
    let   chargeAmount  = 0;
    let   wholesaleCost = 0;

    for (const item of celeb.bundle) {
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
          `  ⚠️  Product lookup failed for celebration item:`,
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
        wholesaleCost: wholesaleUnit * qty,
      });

      chargeAmount  += unitPrice     * qty;
      wholesaleCost += wholesaleUnit * qty;
    }

    if (lineItems.length === 0) {
      console.warn(
        `  ⚠️  No valid bundle items for celebration "${celeb.name}" — skipping`
      );
      continue;
    }

    const productSummary = lineItems.length === 1
      ? lineItems[0].productName
      : `Celebration Bundle (${lineItems.length} items)`;

    const primaryBakerId = lineItems[0]?.bakeryId || null;

    // ── Create the celebration order ────────────────
    const newOrder = {
      companyId,
      companyName:     company.name || '',
      employeeId:      null,
      employeeName:    celeb.name,      // celebration name shows as "employee"
      celebrationId:   celebId,
      celebrationName: celeb.name,
      lineItems,
      productName:     productSummary,
      bakerId:         primaryBakerId,
      bakeryName:      '',
      eventType:       EVENT_TYPES.CELEBRATION,
      status:          ORDER_STATUS.SCHEDULED,
      dietaryFlags:    [],
      deliveryAddress: celeb.deliveryAddress ||
                       company.defaultDeliveryAddress || '',
      // Default card message for celebrations so the bakery always
      // has something to print (company can override via instructions).
      customMessage:   celeb.cardMessage ||
                       `Happy ${celeb.name}! 🎉`,
      bakerNotes:      celeb.specialInstructions || '',
      chargeAmount,
      wholesaleCost,
      deliveryDate:    deliveryTs,
      confirmationSentAt: null,
      confirmedAt:        null,
      routedAt:           null,
      deliveredAt:        null,
      stripeChargeId:     null,
      createdAt:          serverTimestamp(),
      createdBy:          'scheduler',
    };

    const orderRef = await db
      .collection(COLLECTIONS.ORDERS)
      .add(newOrder);

    results.ordersCreated++;
    console.log(
      `  ✅ Celebration order created: ${orderRef.id} ` +
      `("${celeb.name}" — ${nextDate.toDateString()})`
    );

    await checkConfirmationNeeded(
      orderRef.id,
      newOrder,
      rules.autoApprove || false,
      nextDate,
      results
    );
  }
}


/* ═══════════════════════════════════════════════════
   CREATE ORDER IF NOT EXISTS
   Checks for duplicate before creating
   Gets product details
   Sends confirmation email if 7 days away
   ═══════════════════════════════════════════════════ */

async function createOrderIfNotExists(
  employeeId,
  employee,
  companyId,
  company,
  event,
  results
) {
  const {
    eventType,
    deliveryDate,
    bundle,
    autoApprove,
    weekendShift,
  } = event;

  // Set delivery time to 9am
  deliveryDate.setHours(9, 0, 0, 0);

  const deliveryTs =
    admin.firestore.Timestamp
      .fromDate(deliveryDate);


  // ── Check if order already exists ─────────────
  const existingSnap = await db
    .collection(COLLECTIONS.ORDERS)
    .where('employeeId',   '==', employeeId)
    .where('eventType',    '==', eventType)
    .where('deliveryDate', '==', deliveryTs)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const existingOrder = existingSnap.docs[0];
    await checkConfirmationNeeded(
      existingOrder.id,
      existingOrder.data(),
      autoApprove,
      deliveryDate,
      results
    );
    return;
  }


  // ── Build line items from bundle ───────────────
  // Each bundle item: { bakeryId, treatType, qty }
  // Try to look up retail price from Firestore products.
  // Falls back to $0 if product not yet seeded —
  // prices can be corrected once products are in Firestore.
  const lineItems    = [];
  let   chargeAmount = 0;
  let   wholesaleCost = 0;

  for (const item of bundle) {
    if (!item.bakeryId || !item.treatType) continue;

    let unitPrice     = 0;
    let wholesaleUnit = 0;
    let productName   = item.treatType;

    try {
      // Products are stored as a subcollection under each bakery
      // bakeries/{bakeryId}/products/{productId}
      const productDoc = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(item.bakeryId)
        .collection('products')
        .doc(item.treatType)
        .get();

      if (productDoc.exists) {
        const p       = productDoc.data();
        // Bakery menu uses 'price' (what company pays)
        unitPrice     = p.price         || p.retailPrice   || 0;
        wholesaleUnit = p.wholesaleCost || 0;
        productName   = p.name          || item.treatType;
        console.log(
          `  📦 Product found: "${productName}" ` +
          `$${unitPrice}`
        );
      } else {
        console.warn(
          `  ⚠️  Product not found: ` +
          `bakeries/${item.bakeryId}/products/${item.treatType}`
        );
      }
    } catch (err) {
      console.warn(
        `  ⚠️  Product lookup failed: ${item.treatType}:`,
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

  if (lineItems.length === 0) {
    console.warn(
      `  ⚠️  No valid bundle items for ` +
      `${employee.name} — skipping`
    );
    return;
  }

  // Human-readable summary shown in emails + dashboard
  const productSummary = lineItems.length === 1
    ? lineItems[0].productName
    : `Birthday Bundle (${lineItems.length} items)`;

  // Primary baker comes from the first bundle item
  const primaryBakerId = lineItems[0]?.bakeryId || null;


  // ── Create the order ───────────────────────────
  const newOrder = {
    companyId,
    companyName:     company.name || '',
    employeeId,
    employeeName:    employee.name || '',
    lineItems,                        // bundle items array
    productName:     productSummary,  // readable summary
    bakerId:         primaryBakerId,
    bakeryName:      '',
    eventType,
    status:          ORDER_STATUS.SCHEDULED,
    dietaryFlags:    employee.dietaryFlags || [],
    deliveryAddress: employee.deliveryAddress ||
                     company.defaultDeliveryAddress || '',
    bakerNotes:      '',
    chargeAmount,
    wholesaleCost,
    deliveryDate:    deliveryTs,
    // Weekend-shift metadata (null when delivery date == actual birthday)
    weekendShifted:  !!weekendShift,
    originalDate:    weekendShift
                       ? admin.firestore.Timestamp.fromDate(weekendShift.originalDate)
                       : null,
    originalDayName: weekendShift ? weekendShift.originalDayName : null,
    shiftPolicy:     weekendShift ? weekendShift.shiftPolicy     : null,
    confirmationSentAt: null,
    confirmedAt:        null,
    routedAt:           null,
    deliveredAt:        null,
    stripeChargeId:     null,
    createdAt:          serverTimestamp(),
    createdBy:          'scheduler',
  };

  const orderRef = await db
    .collection(COLLECTIONS.ORDERS)
    .add(newOrder);

  results.ordersCreated++;

  console.log(
    `  ✅ Order created: ${orderRef.id} ` +
    `(${employee.name} — ${eventType})`
  );


  // ── Check if confirmation email needed ─────────
  await checkConfirmationNeeded(
    orderRef.id,
    newOrder,
    autoApprove,
    deliveryDate,
    results
  );
}


/* ═══════════════════════════════════════════════════
   CHECK IF CONFIRMATION EMAIL NEEDED
   Sends confirmation email if delivery is
   7 days away and email not yet sent
   ═══════════════════════════════════════════════════ */

async function checkConfirmationNeeded(
  orderId,
  order,
  autoApprove,   // from rules.autoApprove — NOT company doc
  deliveryDate,
  results
) {
  // Only send for scheduled orders
  if (order.status !== ORDER_STATUS.SCHEDULED) {
    return;
  }

  // Already sent confirmation
  if (order.confirmationSentAt) {
    return;
  }

  // ── Auto-approve: send confirmation email ─────────
  if (autoApprove === true) {
    await sendConfirmationEmail(orderId);
    results.emailsSent++;
    return;
  }


  // Calculate days until delivery
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const delivery = new Date(deliveryDate);
  delivery.setHours(0, 0, 0, 0);
  const daysUntil = Math.ceil(
    (delivery - today) / (1000 * 60 * 60 * 24)
  );


  // Send confirmation email if 7 days or less away
  if (daysUntil <= 7 && daysUntil > 0) {
    try {
      await sendConfirmationEmail(orderId);
      results.emailsSent++;
      console.log(
        `  📧 Confirmation sent: ${orderId} ` +
        `(${daysUntil} days away)`
      );
    } catch (err) {
      console.error(
        `  ❌ Confirmation email failed ` +
        `for ${orderId}:`, err.message
      );
    }
  }
}


/* ═══════════════════════════════════════════════════
   PROCESS AUTO-CONFIRMATIONS
   Auto-confirms orders where:
   - Confirmation email was sent 48+ hours ago
   - HR has not responded
   ═══════════════════════════════════════════════════ */

async function processAutoConfirmations(results) {
  console.log('\n⏰ Processing auto-confirmations...');

  // 48 hours ago
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 48);
  const cutoffTs =
    admin.firestore.Timestamp.fromDate(cutoff);


  // Get all pending confirmation orders
  // where email was sent more than 48 hours ago
  const pendingSnap = await db
    .collection(COLLECTIONS.ORDERS)
    .where('status', '==',
      ORDER_STATUS.PENDING_CONFIRMATION)
    .where('confirmationSentAt', '<=', cutoffTs)
    .get();

  if (pendingSnap.empty) {
    console.log('  No orders to auto-confirm');
    return;
  }

  console.log(
    `  Found ${pendingSnap.size} ` +
    `orders to auto-confirm`
  );

  const { chargeCompanyOffSession } = require('../routes/orders');
  const { autoRouteToBaker }        = require('./autoRoute');

  let count = 0;

  // Process each: confirm → charge the saved card UPFRONT → route to baker.
  // If the charge fails (e.g. no card on file), chargeCompanyOffSession
  // flags the order as an exception and we skip routing — money is always
  // collected before the bakery is told to make anything.
  for (const doc of pendingSnap.docs) {
    const order = { id: doc.id, ...doc.data() };

    await doc.ref.update({
      status:      ORDER_STATUS.CONFIRMED,
      confirmedAt: serverTimestamp(),
      confirmedBy: 'auto_confirm_48hr',
    });

    const paid = await chargeCompanyOffSession(doc.id, order);
    if (!paid) {
      console.log(`  ⚠️  Auto-confirm charge failed for ${doc.id} — flagged, not routed`);
      continue; // chargeCompanyOffSession already flagged it as exception
    }

    // Paid upfront → now safe to route to the bakery
    await autoRouteToBaker(doc.id, { ...order, status: ORDER_STATUS.CONFIRMED })
      .catch(err => console.error(`  ❌ Auto-route failed for ${doc.id}:`, err.message));

    count++;
    console.log(`  ✅ Auto-confirmed + charged + routed: ${doc.id}`);
  }

  if (count > 0) {
    results.autoConfirmed += count;
    console.log(`  ✅ Auto-confirmed ${count} orders`);
  }
}


/* ═══════════════════════════════════════════════════
   PROCESS OVERDUE ORDERS
   Flags orders where:
   - Delivery date has passed
   - Status is not delivered or cancelled
   ═══════════════════════════════════════════════════ */

async function processOverdueOrders(results) {
  console.log('\n🚨 Checking for overdue orders...');

  const now   = new Date();
  const nowTs = admin.firestore.Timestamp.fromDate(now);

  // Grace period: a paid order stays the baker's responsibility (they can
  // still deliver it late from their dashboard) until it's overdue by more
  // than this many days. Only then do we escalate it to an admin exception.
  const GRACE_DAYS = 1;
  const graceCutoff = new Date(now);
  graceCutoff.setDate(graceCutoff.getDate() - GRACE_DAYS);
  const graceTs = admin.firestore.Timestamp.fromDate(graceCutoff);

  // Statuses that were never approved/paid — safe to auto-cancel
  const unapprovedStatuses = [
    ORDER_STATUS.SCHEDULED,
    ORDER_STATUS.PENDING_CONFIRMATION,
  ];

  // Statuses that were approved/paid but not delivered — flag as exception
  const paidStatuses = [
    ORDER_STATUS.CONFIRMED,
    ORDER_STATUS.ROUTED,
    ORDER_STATUS.IN_PREPARATION,
  ];

  const overdueSnap = await db
    .collection(COLLECTIONS.ORDERS)
    .where('deliveryDate', '<', nowTs)
    .where('status', 'not-in', [
      ORDER_STATUS.DELIVERED,
      ORDER_STATUS.CANCELLED,
      ORDER_STATUS.EXCEPTION,
    ])
    .get();

  if (overdueSnap.empty) {
    console.log('  No overdue orders found');
    return;
  }

  console.log(`  ⚠️  Found ${overdueSnap.size} overdue orders`);

  const batch        = db.batch();
  let   cancelCount  = 0;
  let   exceptionCount = 0;

  overdueSnap.docs.forEach(doc => {
    const order = doc.data();

    if (unapprovedStatuses.includes(order.status)) {
      // Never approved — auto-cancel silently, no charge
      batch.update(doc.ref, {
        status:       ORDER_STATUS.CANCELLED,
        cancelledAt:  serverTimestamp(),
        cancelledBy:  'system_auto',
        cancelReason: `Delivery date passed without approval (was: ${order.status})`,
      });
      cancelCount++;
      console.log(
        `  🗑  Auto-cancelled unapproved order ` +
        `${doc.id} for ${order.employeeName}`
      );
    } else if (paidStatuses.includes(order.status)) {
      // Was approved and paid. Within the grace window, leave it alone so
      // the baker can still deliver it late (it shows in their Overdue
      // section). Only escalate to an exception once it's past the grace
      // cutoff and the baker still hasn't delivered.
      const dd = order.deliveryDate;
      const isPastGrace = dd && dd.toMillis &&
        dd.toMillis() < graceTs.toMillis();

      if (!isPastGrace) {
        console.log(
          `  ⏳ Overdue but within ${GRACE_DAYS}-day grace — ` +
          `leaving with baker: ${doc.id} (${order.employeeName})`
        );
        return; // skip — still the baker's to deliver
      }

      batch.update(doc.ref, {
        status:          ORDER_STATUS.EXCEPTION,
        exceptionReason: 'Not marked as delivered — the delivery date passed and the bakery never confirmed it was completed.',
        flaggedAt:       serverTimestamp(),
        exceptionSince:  serverTimestamp(),
      });
      exceptionCount++;
      console.log(
        `  🚨 Flagged paid overdue order ` +
        `${doc.id} for ${order.employeeName}`
      );
    }
  });

  await batch.commit();

  if (cancelCount > 0) {
    console.log(`  🗑  Auto-cancelled ${cancelCount} unapproved overdue orders`);
  }
  if (exceptionCount > 0) {
    results.exceptions += exceptionCount;
    console.log(`  🚨 Flagged ${exceptionCount} paid overdue orders as exceptions`);
    await notifyAdminOfExceptions(exceptionCount);
  }
}


/* ═══════════════════════════════════════════════════
   SEND CONFIRMATION EMAIL
   Calls the emails route internally
   ═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════
   SEND WEEKEND BIRTHDAY WARNING EMAIL
   Fires once when we first detect a weekend birthday
   and shift the delivery date
   ═══════════════════════════════════════════════════ */

async function sendWeekendBirthdayWarning(
  employee,
  company,
  originalDate,
  adjustedDate,
  dayName
) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey || !company.contactEmail) return;

    const fmt = d => d.toLocaleDateString('en-CA', {
      weekday: 'long', year: 'numeric',
      month:   'long', day:  'numeric',
    });

    const { Resend } = require('resend');
    const resend     = new Resend(resendKey);

    await resend.emails.send({
      from:    `${process.env.RESEND_FROM_NAME} <${process.env.EMAIL_SUPPORT}>`,
      to:      company.contactEmail,
      subject: `📅 Heads up — ${employee.name}'s birthday falls on a ${dayName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;padding:0;background:#FAF7F2;font-family:'Helvetica Neue',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

            <div style="background:#C66228;padding:32px 40px;text-align:center">
              <div style="font-size:2.5rem">📅</div>
              <h1 style="color:#fff;margin:12px 0 4px;font-size:1.4rem;font-weight:700">
                Weekend Birthday Alert
              </h1>
              <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.95rem">
                ${company.name || 'Your company'}
              </p>
            </div>

            <div style="padding:36px 40px">
              <p style="color:#333;font-size:1rem;line-height:1.6;margin-top:0">
                Just a heads up — <strong>${employee.name}</strong>'s birthday
                falls on a <strong>${dayName}</strong> this year.
              </p>

              <div style="background:#FFF3E0;border:1.5px solid #FF9800;border-radius:10px;padding:20px 24px;margin:24px 0">
                <div style="display:flex;justify-content:space-between;margin-bottom:10px">
                  <span style="color:#888;font-size:0.85rem">Birthday</span>
                  <span style="color:#BF360C;font-weight:600;font-size:0.9rem">
                    ${fmt(originalDate)} (${dayName})
                  </span>
                </div>
                <div style="display:flex;justify-content:space-between">
                  <span style="color:#888;font-size:0.85rem">Delivery rescheduled to</span>
                  <span style="color:#2E7D32;font-weight:600;font-size:0.9rem">
                    ${fmt(adjustedDate)}
                  </span>
                </div>
              </div>

              <p style="color:#555;font-size:0.9rem;line-height:1.6">
                We've automatically adjusted the delivery date so the treat
                arrives when your team is in. You'll receive the usual
                confirmation email closer to the delivery date.
              </p>
              <p style="color:#555;font-size:0.9rem;line-height:1.6">
                You can update your weekend delivery preference anytime
                in your <a href="${process.env.APP_URL || 'http://localhost:3000'}/company/rules.html"
                style="color:#C66228">Gifting Rules</a>.
              </p>
            </div>

            <div style="background:#FAF7F2;padding:20px 40px;text-align:center">
              <p style="color:#aaa;font-size:0.78rem;margin:0">
                Delightmaker · Halifax, NS
              </p>
            </div>

          </div>
        </body>
        </html>
      `,
    });

    console.log(
      `  📧 Weekend birthday warning sent for ` +
      `${employee.name} → ${company.contactEmail}`
    );
  } catch (err) {
    console.error('Weekend birthday warning email failed:', err);
  }
}


async function sendConfirmationEmail(orderId) {
  try {

    // Get order details
    const orderDoc = await db
      .collection(COLLECTIONS.ORDERS)
      .doc(orderId)
      .get();

    if (!orderDoc.exists) return;

    const order = orderDoc.data();

    // Get company contact email
    const companyDoc = await db
      .collection(COLLECTIONS.COMPANIES)
      .doc(order.companyId)
      .get();

    if (!companyDoc.exists) return;

    const company = companyDoc.data();
    const jwt     = require('jsonwebtoken');


    // Generate signed approval token
    const token = jwt.sign(
      {
        orderId,
        companyId: order.companyId,
        type:      'order_approval',
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const approveUrl =
      `${process.env.APP_URL}/approve/${token}`;


    // Check if Resend is configured
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey ||
        resendKey === 'your_resend_key_here') {
      console.log(
        `    📧 Email skipped (not configured): ` +
        `${orderId}`
      );

      // Still update order status
      await orderDoc.ref.update({
        status:             ORDER_STATUS
                              .PENDING_CONFIRMATION,
        confirmationSentAt: serverTimestamp(),
        approvalToken:      token,
      });
      return;
    }


    // Format delivery date
    const deliveryDate = order.deliveryDate
      ?.toDate()
      ?.toLocaleDateString('en-CA', {
        weekday: 'long',
        month:   'long',
        day:     'numeric',
      }) || 'Upcoming';

    const eventLabels = {
      birthday: '🎂 Birthday',
    };


    // Dietary flags HTML — prominent banner if restrictions exist
    const hasDietary = order.dietaryFlags &&
                       order.dietaryFlags.length > 0 &&
                       !order.dietaryFlags
                         .map(f => f.toLowerCase())
                         .includes('none');

    const dietaryHtml = hasDietary
      ? `<div style="
           background:    #FFF3E0;
           border:        2px solid #FF9800;
           border-radius: 12px;
           padding:       16px 20px;
           margin:        20px 0;
         ">
           <p style="
             margin:      0 0 6px;
             font-weight: 700;
             font-size:   0.95rem;
             color:       #E65100;
           ">
             ⚠️ DIETARY RESTRICTION — Action may be required
           </p>
           <p style="
             margin:      0 0 8px;
             font-size:   0.88rem;
             color:       #BF360C;
           ">
             <strong>${order.employeeName}</strong>
             has the following dietary requirement(s):
             <strong>
               ${order.dietaryFlags.join(', ')}
             </strong>
           </p>
           <p style="
             margin:      0;
             font-size:   0.82rem;
             color:       #BF360C;
             font-style:  italic;
           ">
             Please confirm the selected treats are
             compatible before approving, or set a custom
             treat for this employee in your Rules page.
           </p>
         </div>`
      : '';

    // Line items HTML — shows each treat in the bundle
    const lineItemsHtml =
      order.lineItems && order.lineItems.length > 0
      ? order.lineItems.map(item => `
          <div class="row">
            <span class="label">
              ${item.productName}
              &nbsp;×${item.qty}
            </span>
            <span class="value">
              ${item.unitPrice > 0
                ? '$' + (item.unitPrice * item.qty).toFixed(2)
                : 'TBD'
              }
            </span>
          </div>
        `).join('')
      : `<div class="row">
           <span class="label">Treat</span>
           <span class="value">${order.productName}</span>
         </div>`;


    // Send email via Resend
    const { Resend } = require('resend');
    const resend = new Resend(resendKey);

    await resend.emails.send({
      from:    `${process.env.RESEND_FROM_NAME} ` +
               `<${process.env.EMAIL_SUPPORT}>`,
      to:      company.contactEmail,
      subject: `🎂 ${order.employeeName}'s birthday is coming up — confirm delivery`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8"/>
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width:   600px;
              margin:      0 auto;
              padding:     24px;
              color:       #2D2D2D;
              background:  #FFFAF5;
            }
            .header {
              background:    #2D2D2D;
              padding:       24px;
              border-radius: 12px 12px 0 0;
              text-align:    center;
              color:         white;
              font-size:     1.2rem;
              font-weight:   700;
            }
            .body {
              background:  white;
              padding:     28px;
              border:      1px solid #eee;
            }
            .details {
              background:    #FFFAF5;
              border:        2px solid #FFD93D;
              border-radius: 10px;
              padding:       16px 20px;
              margin:        16px 0;
            }
            .row {
              display:         flex;
              justify-content: space-between;
              padding:         6px 0;
              border-bottom:   1px solid #eee;
              font-size:       0.9rem;
            }
            .label { color: #888; }
            .value { font-weight: 700; }
            .btn {
              display:         block;
              background:      #FF6B6B;
              color:           white;
              padding:         14px;
              border-radius:   100px;
              text-decoration: none;
              font-weight:     700;
              text-align:      center;
              margin:          20px 0;
              font-size:       1rem;
            }
            .footer {
              text-align:    center;
              padding:       16px;
              font-size:     0.78rem;
              color:         #AAA;
              border-radius: 0 0 12px 12px;
              background:    #F5F5F5;
              border:        1px solid #eee;
            }
          </style>
        </head>
        <body>

          <div class="header">
            🧁 Delightmaker
          </div>

          <div class="body">
            <h2>
              ${order.employeeName.split(' ')[0]}'s
              celebration is in 7 days!
            </h2>

            <p>Hi ${company.contactName || 'there'},</p>
            <p>
              Please confirm the upcoming delivery
              for <strong>${order.employeeName}</strong>.
            </p>

            ${dietaryHtml}

            <div class="details">
              <div class="row">
                <span class="label">Employee</span>
                <span class="value">
                  ${order.employeeName}
                </span>
              </div>
              <div class="row">
                <span class="label">Occasion</span>
                <span class="value">
                  ${eventLabels[order.eventType]
                    || order.eventType}
                </span>
              </div>

              ${lineItemsHtml}

              <div class="row">
                <span class="label">Delivery date</span>
                <span class="value">
                  ${deliveryDate}
                </span>
              </div>
              <div class="row">
                <span class="label">Address</span>
                <span class="value">
                  ${order.deliveryAddress || 'See dashboard'}
                </span>
              </div>
              <div class="row"
                   style="border:none">
                <span class="label">
                  <strong>Total</strong>
                </span>
                <span class="value"
                      style="color:#FF6B6B">
                  ${order.chargeAmount > 0
                    ? '$' + order.chargeAmount.toFixed(2) + ' CAD'
                    : 'TBD — products not yet priced'
                  }
                </span>
              </div>
            </div>

            <a href="${approveUrl}" class="btn">
              ✅ Approve This Delivery
            </a>

            <p style="
              text-align: center;
              font-size:  0.8rem;
              color:      #AAA;
            ">
              Auto-confirms in 48 hours.
              Link expires in 7 days.
            </p>
          </div>

          <div class="footer">
            Delightmaker · Halifax, NS 🇨🇦<br/>
            <a href="${process.env.APP_URL}/login"
               style="color:#FF6B6B">
              Manage in dashboard
            </a>
          </div>

        </body>
        </html>
      `,
    });


    // Update order status
    await orderDoc.ref.update({
      status:             ORDER_STATUS
                            .PENDING_CONFIRMATION,
      confirmationSentAt: serverTimestamp(),
      approvalToken:      token,
    });

  } catch (err) {
    throw err;
  }
}


/* ═══════════════════════════════════════════════════
   NOTIFY ADMIN OF EXCEPTIONS
   Sends Colton a summary when exceptions are found
   ═══════════════════════════════════════════════════ */

async function notifyAdminOfExceptions(count) {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey ||
        resendKey === 'your_resend_key_here') {
      console.log(
        `  📧 Admin exception alert skipped ` +
        `(Resend not configured)`
      );
      return;
    }

    const { Resend } = require('resend');
    const resend = new Resend(resendKey);

    await resend.emails.send({
      from:    `${process.env.RESEND_FROM_NAME} ` +
               `<${process.env.RESEND_FROM_EMAIL}>`,
      to:      process.env.ADMIN_EMAIL,
      subject: `🚨 ${count} overdue order(s) ` +
               `need attention — Delightmaker`,
      html: `
        <div style="
          font-family: sans-serif;
          max-width:   500px;
          margin:      0 auto;
          padding:     24px;
        ">
          <h2>🚨 Overdue Orders Alert</h2>
          <p>
            The daily scan found
            <strong>${count} overdue order(s)</strong>
            that have passed their delivery date
            without being marked as delivered.
          </p>
          <p>
            These have been flagged as exceptions
            in your dashboard.
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
             ">
            Review in Dashboard →
          </a>
        </div>
      `,
    });

  } catch (err) {
    console.error(
      'Admin exception notification failed:',
      err.message
    );
  }
}


/* ═══════════════════════════════════════════════════
   MANUAL TRIGGER HELPERS
   Can be called from admin dashboard
   to run specific parts of the scan
   ═══════════════════════════════════════════════════ */

/**
 * Manually create orders for a specific company
 * Called when a new company is onboarded
 */
async function scanCompanyNow(companyId) {
  console.log(
    `🔍 Manual scan for company: ${companyId}`
  );

  const companyDoc = await db
    .collection(COLLECTIONS.COMPANIES)
    .doc(companyId)
    .get();

  if (!companyDoc.exists) {
    throw new Error('Company not found');
  }

  const results = {
    ordersCreated: 0,
    emailsSent:    0,
    autoConfirmed: 0,
    exceptions:    0,
    errors:        [],
  };

  await processCompany(
    companyId,
    companyDoc.data(),
    results
  );

  console.log(
    `✅ Manual scan complete: ` +
    `${results.ordersCreated} orders created`
  );

  return results;
}


/**
 * Manually send confirmation email for one order
 * Called from admin dashboard
 */
async function sendConfirmationNow(orderId) {
  await sendConfirmationEmail(orderId);
  return { success: true };
}


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = {
  runDailyScan,
  scanCompanyNow,
  sendConfirmationNow,
};