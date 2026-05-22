/* ═══════════════════════════════════════════════════
   invoiceGenerator.js
   Auto-generates monthly invoices for all active
   bakeries on the 1st of each month.

   For each bakery:
   – Queries all chargeStatus=paid orders delivered
     in the previous calendar month
   – Builds a full line-item invoice (company, employee,
     treat, amount)
   – Saves to Firestore invoices collection
   – Emails the baker their invoice
   – Emails Colton a copy so he knows to pay

   Invoice number format: DM-YYYY-MM-XXXX
   (XXXX = first 4 chars of bakery name, uppercase)
   ═══════════════════════════════════════════════════ */

'use strict';

const {
  db,
  admin,
  COLLECTIONS,
  serverTimestamp,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   MAIN EXPORT
   Called by cron job (0 9 1 * *) in server.js
   and by /api/admin/trigger-invoices endpoint
   ═══════════════════════════════════════════════════ */

async function generateMonthlyInvoices(options = {}) {
  const now = new Date();

  // Default: previous calendar month
  // options.year + options.month override for manual trigger
  let year, month;
  if (options.year && options.month) {
    year  = options.year;
    month = options.month; // 1-indexed
  } else {
    // 1st of current month → generate for previous month
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    year  = prev.getFullYear();
    month = prev.getMonth() + 1; // 1-indexed
  }

  const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const monthEnd   = new Date(year, month,     1, 0, 0, 0, 0); // exclusive

  const monthStartTs = admin.firestore.Timestamp.fromDate(monthStart);
  const monthEndTs   = admin.firestore.Timestamp.fromDate(monthEnd);

  const monthNames = [
    'January','February','March','April',
    'May','June','July','August',
    'September','October','November','December',
  ];
  const monthLabel = `${monthNames[month - 1]} ${year}`;

  console.log(
    `\n📋 Generating invoices for ${monthLabel}...`
  );

  const results = {
    invoicesCreated: 0,
    emailsSent:      0,
    skipped:         0,
    errors:          [],
  };

  try {
    // Get all active bakeries
    const bakeriesSnap = await db
      .collection(COLLECTIONS.BAKERIES)
      .where('active', '==', true)
      .get();

    if (bakeriesSnap.empty) {
      console.log('  No active bakeries found.');
      return results;
    }

    console.log(
      `  🥐 Found ${bakeriesSnap.size} active bakers`
    );

    for (const bakeryDoc of bakeriesSnap.docs) {
      const bakeryId = bakeryDoc.id;
      const bakery   = bakeryDoc.data();

      try {
        await generateInvoiceForBakery(
          bakeryId, bakery,
          year, month, monthLabel,
          monthStartTs, monthEndTs,
          results
        );
      } catch (err) {
        console.error(
          `  ❌ Invoice error for ${bakery.name || bakeryId}:`,
          err.message
        );
        results.errors.push({
          bakeryId,
          error: err.message,
        });
      }
    }

    console.log('\n📊 Invoice generation complete:');
    console.log(
      `  ✅ Invoices created: ${results.invoicesCreated}`
    );
    console.log(
      `  📧 Emails sent:      ${results.emailsSent}`
    );
    console.log(
      `  ⏭  Skipped:          ${results.skipped}`
    );
    if (results.errors.length > 0) {
      console.log(
        `  ❌ Errors:           ${results.errors.length}`
      );
    }

    return results;

  } catch (err) {
    console.error('❌ generateMonthlyInvoices failed:', err);
    throw err;
  }
}


/* ═══════════════════════════════════════════════════
   GENERATE INVOICE FOR ONE BAKERY
   ═══════════════════════════════════════════════════ */

async function generateInvoiceForBakery(
  bakeryId, bakery,
  year, month, monthLabel,
  monthStartTs, monthEndTs,
  results
) {
  const bakeryName = bakery.name || bakeryId;

  // ── Check if auto-invoice already exists ──────────
  const existingSnap = await db
    .collection(COLLECTIONS.INVOICES)
    .where('bakerId', '==', bakeryId)
    .where('month',   '==', month)
    .where('year',    '==', year)
    .where('type',    '==', 'auto')
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    console.log(
      `  ⏭  Auto-invoice already exists ` +
      `for ${bakeryName} ${monthLabel}`
    );
    results.skipped++;
    return;
  }

  // ── Get orders in that month for this bakery ───────
  // Query by bakerId + deliveryDate range, then filter
  // client-side for paid/delivered (Firestore can't OR)
  const ordersSnap = await db
    .collection(COLLECTIONS.ORDERS)
    .where('bakerId',      '==', bakeryId)
    .where('deliveryDate', '>=', monthStartTs)
    .where('deliveryDate', '<',  monthEndTs)
    .orderBy('deliveryDate', 'asc')
    .get();

  const orders = ordersSnap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(o =>
      o.chargeStatus === 'paid' ||
      o.status       === 'delivered'
    );

  if (orders.length === 0) {
    console.log(
      `  ⏭  No paid/delivered orders for ` +
      `${bakeryName} in ${monthLabel}`
    );
    results.skipped++;
    return;
  }

  // ── Build line items ──────────────────────────────
  const lineItems = orders.map(o => ({
    orderId:      o.id,
    deliveryDate: o.deliveryDate,
    companyName:  o.companyName  || o.companyId  || '—',
    employeeName: o.employeeName || '—',
    productName:  o.productName  || '—',
    amount:       typeof o.chargeAmount === 'number'
                    ? o.chargeAmount
                    : 0,
  }));

  const totalAmount = lineItems.reduce(
    (sum, li) => sum + li.amount, 0
  );

  // ── Invoice number: DM-YYYY-MM-XXXX ──────────────
  const bakeryCode = bakeryName
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, 'X');

  const invoiceNumber =
    `DM-${year}-${String(month).padStart(2,'0')}-${bakeryCode}`;

  // ── Save to Firestore ─────────────────────────────
  const invoiceRef = await db
    .collection(COLLECTIONS.INVOICES)
    .add({
      bakerId:      bakeryId,
      bakeryName:   bakeryName,
      month,
      year,
      invoiceNumber,
      type:         'auto',        // marks it as system-generated
      lineItems,
      totalAmount,
      orderCount:   orders.length,
      status:       'pending',     // pending → paid by Colton
      generatedAt:  serverTimestamp(),
    });

  console.log(
    `  ✅ Invoice ${invoiceNumber} — ` +
    `${orders.length} orders — ` +
    `$${totalAmount.toFixed(2)} — ` +
    `${bakeryName}`
  );
  results.invoicesCreated++;

  // ── Send emails ───────────────────────────────────
  await sendInvoiceEmails(
    invoiceRef.id,
    invoiceNumber,
    bakery,
    lineItems,
    totalAmount,
    monthLabel,
    results
  );
}


/* ═══════════════════════════════════════════════════
   SEND INVOICE EMAILS
   Emails baker + Colton (admin)
   ═══════════════════════════════════════════════════ */

async function sendInvoiceEmails(
  invoiceId,
  invoiceNumber,
  bakery,
  lineItems,
  totalAmount,
  monthLabel,
  results
) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || resendKey === 'your_resend_key_here') {
    console.log(
      '  📧 Invoice emails skipped ' +
      '(Resend not configured)'
    );
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(resendKey);

  const bakerEmail = bakery.contactEmail ||
                     bakery.contact      ||
                     null;
  const adminEmail = process.env.ADMIN_EMAIL;

  const invoiceHtml = buildInvoiceHtml(
    invoiceNumber,
    bakery.name || bakery.id,
    lineItems,
    totalAmount,
    monthLabel
  );

  // ── Baker email ───────────────────────────────────
  if (bakerEmail) {
    try {
      await resend.emails.send({
        from:    `${process.env.RESEND_FROM_NAME} ` +
                 `<${process.env.RESEND_FROM_EMAIL}>`,
        to:      bakerEmail,
        subject: `🧾 Your Invoice — ${monthLabel} ` +
                 `(${invoiceNumber})`,
        html:    invoiceHtml,
      });
      console.log(
        `  📧 Baker invoice emailed → ${bakerEmail}`
      );
      results.emailsSent++;
    } catch (err) {
      console.error(
        `  ❌ Baker email failed: ${err.message}`
      );
    }
  } else {
    console.log(
      `  ⚠️  No baker email on ` +
      `${bakery.name} — add contactEmail in bakeries page`
    );
  }

  // ── Admin (Colton) copy ───────────────────────────
  if (adminEmail) {
    try {
      await resend.emails.send({
        from:    `${process.env.RESEND_FROM_NAME} ` +
                 `<${process.env.RESEND_FROM_EMAIL}>`,
        to:      adminEmail,
        subject: `📋 Baker Invoice — ` +
                 `${bakery.name || 'Baker'} — ${monthLabel}`,
        html:    invoiceHtml,
      });
      console.log(
        `  📧 Admin copy emailed → ${adminEmail}`
      );
      results.emailsSent++;
    } catch (err) {
      console.error(
        `  ❌ Admin email failed: ${err.message}`
      );
    }
  }
}


/* ═══════════════════════════════════════════════════
   BUILD INVOICE HTML
   Branded email-safe HTML invoice
   ═══════════════════════════════════════════════════ */

function buildInvoiceHtml(
  invoiceNumber,
  bakeryName,
  lineItems,
  totalAmount,
  monthLabel
) {
  const lineItemRows = lineItems.map(li => {
    const dateStr = li.deliveryDate
      ? (li.deliveryDate.toDate
          ? li.deliveryDate.toDate()
          : new Date(li.deliveryDate)
        ).toLocaleDateString('en-CA', {
          month: 'short',
          day:   'numeric',
        })
      : '—';

    return `
      <tr style="border-bottom:1px solid #F5F5F5">
        <td style="padding:9px 8px;font-size:0.83rem;
                   color:#888;white-space:nowrap">
          ${dateStr}
        </td>
        <td style="padding:9px 8px;font-size:0.83rem;
                   font-weight:600;color:#2D2D2D">
          ${li.companyName}
        </td>
        <td style="padding:9px 8px;font-size:0.83rem;
                   color:#555">
          ${li.employeeName}
        </td>
        <td style="padding:9px 8px;font-size:0.83rem;
                   color:#555">
          ${li.productName}
        </td>
        <td style="padding:9px 8px;font-size:0.88rem;
                   font-weight:700;text-align:right;
                   white-space:nowrap;color:#2E7D32">
          $${li.amount.toFixed(2)}
        </td>
      </tr>
    `;
  }).join('');

  const tableHeaders = `
    <tr style="border-bottom:2px solid #F0F0F0;
               background:#FAFAFA">
      <th style="padding:8px;font-size:0.7rem;
                 font-weight:700;text-transform:uppercase;
                 letter-spacing:0.07em;color:#888;
                 text-align:left">Date</th>
      <th style="padding:8px;font-size:0.7rem;
                 font-weight:700;text-transform:uppercase;
                 letter-spacing:0.07em;color:#888;
                 text-align:left">Company</th>
      <th style="padding:8px;font-size:0.7rem;
                 font-weight:700;text-transform:uppercase;
                 letter-spacing:0.07em;color:#888;
                 text-align:left">Employee</th>
      <th style="padding:8px;font-size:0.7rem;
                 font-weight:700;text-transform:uppercase;
                 letter-spacing:0.07em;color:#888;
                 text-align:left">Treat</th>
      <th style="padding:8px;font-size:0.7rem;
                 font-weight:700;text-transform:uppercase;
                 letter-spacing:0.07em;color:#888;
                 text-align:right">Amount</th>
    </tr>
  `;

  const appUrl = process.env.APP_URL || 'https://delightmaker.ca';

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"/></head>
    <body style="font-family:Arial,sans-serif;
                 background:#FFFAF5;margin:0;padding:24px">
      <div style="max-width:620px;margin:0 auto">

        <!-- Header -->
        <table style="width:100%;background:#2D2D2D;
                      border-radius:12px 12px 0 0">
          <tr>
            <td style="padding:24px;color:white;
                       font-size:1.2rem;font-weight:700">
              🧁 Delightmaker
            </td>
            <td style="padding:24px;text-align:right">
              <p style="color:#FFD93D;font-size:0.72rem;
                        font-weight:700;margin:0;
                        text-transform:uppercase;
                        letter-spacing:0.08em">
                Invoice
              </p>
              <p style="color:white;font-size:0.9rem;
                        font-weight:700;margin:4px 0 0">
                ${invoiceNumber}
              </p>
            </td>
          </tr>
        </table>

        <!-- Body -->
        <div style="background:white;
                    border:1px solid #eee;
                    border-top:none;
                    padding:28px">

          <!-- Bill to / From -->
          <table style="width:100%;margin-bottom:24px">
            <tr>
              <td style="vertical-align:top">
                <p style="font-size:0.7rem;font-weight:700;
                           text-transform:uppercase;
                           letter-spacing:0.08em;
                           color:#888;margin:0 0 4px">
                  Bill to
                </p>
                <p style="font-size:1rem;font-weight:700;
                           color:#2D2D2D;margin:0">
                  Delightmaker
                </p>
                <p style="font-size:0.82rem;color:#888;
                           margin:3px 0 0">
                  Halifax, NS 🇨🇦
                </p>
              </td>
              <td style="vertical-align:top;text-align:right">
                <p style="font-size:0.7rem;font-weight:700;
                           text-transform:uppercase;
                           letter-spacing:0.08em;
                           color:#888;margin:0 0 4px">
                  From
                </p>
                <p style="font-size:1rem;font-weight:700;
                           color:#2D2D2D;margin:0">
                  ${bakeryName}
                </p>
                <p style="font-size:0.82rem;color:#888;
                           margin:3px 0 0">
                  Period: ${monthLabel}
                </p>
              </td>
            </tr>
          </table>

          <!-- Total owed highlight box -->
          <div style="background:#FFFAF5;
                      border:2px solid #FFD93D;
                      border-radius:10px;
                      padding:18px 20px;
                      margin-bottom:24px">
            <p style="font-size:0.7rem;font-weight:700;
                       text-transform:uppercase;
                       letter-spacing:0.08em;
                       color:#888;margin:0 0 6px">
              Total Owed
            </p>
            <p style="font-size:2rem;font-weight:700;
                       color:#2D2D2D;margin:0 0 4px">
              $${totalAmount.toFixed(2)}
              <span style="font-size:0.8rem;
                            font-weight:400;color:#888">
                CAD
              </span>
            </p>
            <p style="font-size:0.82rem;color:#888;
                       margin:0">
              ${lineItems.length} order${
                lineItems.length !== 1 ? 's' : ''
              } delivered in ${monthLabel}
            </p>
          </div>

          <!-- Line items table -->
          <table style="width:100%;border-collapse:collapse">
            <thead>
              ${tableHeaders}
            </thead>
            <tbody>
              ${lineItemRows}
            </tbody>
            <tfoot>
              <tr style="border-top:2px solid #2D2D2D">
                <td colspan="4"
                    style="padding:12px 8px;
                           font-weight:700;
                           font-size:0.95rem;
                           color:#2D2D2D">
                  Total
                </td>
                <td style="padding:12px 8px;
                            font-weight:700;
                            font-size:1rem;
                            color:#2E7D32;
                            text-align:right">
                  $${totalAmount.toFixed(2)} CAD
                </td>
              </tr>
            </tfoot>
          </table>

        </div>

        <!-- Footer -->
        <div style="background:#F5F5F5;
                    border:1px solid #eee;
                    border-top:none;
                    border-radius:0 0 12px 12px;
                    padding:14px 20px;
                    text-align:center">
          <p style="font-size:0.77rem;color:#AAA;margin:0">
            Delightmaker · Halifax, NS 🇨🇦 ·
            <a href="${appUrl}"
               style="color:#FF6B6B">
              delightmaker.ca
            </a>
          </p>
          <p style="font-size:0.73rem;color:#BBB;
                    margin:5px 0 0">
            ${invoiceNumber} ·
            Auto-generated on the 1st of each month
          </p>
        </div>

      </div>
    </body>
    </html>
  `;
}


module.exports = { generateMonthlyInvoices };
