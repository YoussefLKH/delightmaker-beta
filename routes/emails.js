/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — EMAIL ROUTES
   All transactional emails via Resend
   All routes: /api/emails/...
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');

const {
  db,
  admin,
  COLLECTIONS,
  ORDER_STATUS,
  serverTimestamp,
  writeAuditLog,
  authenticate,
  requireAdmin,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   RESEND INITIALIZATION
   ═══════════════════════════════════════════════════ */

const { Resend } = require('resend');

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Check if Resend is configured
function isResendConfigured() {
  return process.env.RESEND_API_KEY &&
         process.env.RESEND_API_KEY !==
         'your_resend_key_here';
}

// Pass a specific address or fall back to hello@
const FROM = (address) =>
  `${process.env.RESEND_FROM_NAME} ` +
  `<${address || process.env.RESEND_FROM_EMAIL}>`;


/* ═══════════════════════════════════════════════════
   EMAIL BRAND STYLES
   Reusable CSS for all emails
   ═══════════════════════════════════════════════════ */

const EMAIL_STYLES = `
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', Arial, sans-serif;
      background:  #FFFAF5;
      color:       #2D2D2D;
      line-height: 1.6;
    }
    .wrapper {
      max-width:  600px;
      margin:     0 auto;
      padding:    24px;
    }
    .header {
      background:    #2D2D2D;
      border-radius: 16px 16px 0 0;
      padding:       28px 32px;
      text-align:    center;
    }
    .header-logo {
      font-size:     1.4rem;
      font-weight:   700;
      color:         white;
      letter-spacing: -0.02em;
    }
    .header-logo span {
      color: #FF6B6B;
    }
    .body {
      background:    white;
      padding:       32px;
      border-left:   1px solid #eee;
      border-right:  1px solid #eee;
    }
    .footer {
      background:    #F5F5F5;
      border-radius: 0 0 16px 16px;
      padding:       20px 32px;
      text-align:    center;
      border:        1px solid #eee;
    }
    h1 {
      font-size:     1.5rem;
      font-weight:   700;
      color:         #2D2D2D;
      margin-bottom: 8px;
      line-height:   1.2;
    }
    h2 {
      font-size:     1.2rem;
      font-weight:   700;
      color:         #2D2D2D;
      margin-bottom: 8px;
    }
    p {
      font-size:     0.95rem;
      color:         #555;
      margin-bottom: 16px;
      line-height:   1.6;
    }
    .highlight-box {
      background:    #FFFAF5;
      border:        2px solid #FFD93D;
      border-radius: 12px;
      padding:       20px 24px;
      margin:        20px 0;
    }
    .detail-row {
      display:         flex;
      justify-content: space-between;
      padding:         8px 0;
      border-bottom:   1px solid #eee;
      font-size:       0.9rem;
    }
    .detail-label {
      color:       #888;
      font-weight: 500;
    }
    .detail-value {
      color:       #2D2D2D;
      font-weight: 600;
      text-align:  right;
    }
    .btn {
      display:         block;
      background:      #FF6B6B;
      color:           white !important;
      padding:         14px 28px;
      border-radius:   100px;
      text-decoration: none;
      font-weight:     700;
      font-size:       1rem;
      text-align:      center;
      margin:          24px 0;
    }
    .btn:hover {
      background: #E85555;
    }
    .btn-outline {
      display:         block;
      background:      white;
      color:           #FF6B6B !important;
      padding:         12px 28px;
      border-radius:   100px;
      text-decoration: none;
      font-weight:     700;
      font-size:       0.9rem;
      text-align:      center;
      border:          2px solid #FF6B6B;
      margin:          12px 0;
    }
    .alert-box {
      background:    #FFF2F2;
      border:        1px solid #FFCDD2;
      border-radius: 8px;
      padding:       12px 16px;
      margin:        16px 0;
      font-size:     0.85rem;
      color:         #C62828;
    }
    .dietary-badge {
      display:       inline-block;
      background:    #FFEBEE;
      color:         #C62828;
      padding:       4px 10px;
      border-radius: 100px;
      font-size:     0.78rem;
      font-weight:   700;
      margin-right:  4px;
    }
    .footer p {
      font-size: 0.78rem;
      color:     #AAA;
    }
    .footer a {
      color: #FF6B6B;
    }
  </style>
`;


/* ═══════════════════════════════════════════════════
   POST /api/emails/send-confirmation
   Admin only (or internal from scheduler)
   Sends one-click approval email to HR contact
   7 days before delivery
   ═══════════════════════════════════════════════════ */

router.post('/send-confirmation',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { orderId } = req.body;

      if (!orderId) {
        return res.status(400).json({
          error: 'Order ID required'
        });
      }


      // ── Get order ─────────────────────────────────
      const orderDoc = await db
        .collection(COLLECTIONS.ORDERS)
        .doc(orderId)
        .get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();


      // ── Get company and HR contact ────────────────
      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(order.companyId)
        .get();

      if (!companyDoc.exists) {
        return res.status(404).json({
          error: 'Company not found'
        });
      }

      const company = companyDoc.data();


      // ── Generate signed approval token ────────────
      const token = jwt.sign(
        {
          orderId,
          companyId: order.companyId,
          type:      'order_approval',
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRY || '7d' }
      );

      const approveUrl =
        `${process.env.APP_URL}/approve/${token}`;
      const dashboardUrl =
        `${process.env.APP_URL}/company/approvals`;


      // ── Format delivery date ──────────────────────
      const deliveryDate = order.deliveryDate
        ?.toDate()
        ?.toLocaleDateString('en-CA', {
          weekday: 'long',
          year:    'numeric',
          month:   'long',
          day:     'numeric',
        }) || 'Upcoming';


      // ── Format event type ─────────────────────────
      const eventLabels = {
        birthday: '🎂 Birthday',
      };
      const eventLabel =
        eventLabels[order.eventType] ||
        order.eventType;


      // ── Build email HTML ──────────────────────────
      const dietaryHtml = order.dietaryFlags &&
        order.dietaryFlags.length > 0
        ? `<div style="margin: 8px 0">
            ${order.dietaryFlags.map(f =>
              `<span class="dietary-badge">
                ⚠️ ${f}
              </span>`
            ).join('')}
           </div>`
        : '';

      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8"/>
          <meta name="viewport"
                content="width=device-width,
                         initial-scale=1.0"/>
          ${EMAIL_STYLES}
        </head>
        <body>
          <div class="wrapper">

            <div class="header">
              <div class="header-logo">
                🧁 Delight<span>maker</span>
              </div>
            </div>

            <div class="body">
              <h1>
                ${order.employeeName.split(' ')[0]}'s
                ${eventLabels[order.eventType]
                  ?.replace(/🎂|🎉|🏆|⭐/g, '')
                  .trim()}
                is coming up!
              </h1>

              <p>
                Hi ${company.contactName || 'there'},
              </p>

              <p>
                We're getting ready to send a treat
                to celebrate
                <strong>${order.employeeName}</strong>.
                Please confirm the delivery below.
              </p>

              <div class="highlight-box">
                <div class="detail-row">
                  <span class="detail-label">
                    Employee
                  </span>
                  <span class="detail-value">
                    ${order.employeeName}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Occasion
                  </span>
                  <span class="detail-value">
                    ${eventLabel}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Treat
                  </span>
                  <span class="detail-value">
                    ${order.productName}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Delivery Date
                  </span>
                  <span class="detail-value">
                    ${deliveryDate}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Delivery Address
                  </span>
                  <span class="detail-value">
                    ${order.deliveryAddress}
                  </span>
                </div>
                <div class="detail-row"
                     style="border:none">
                  <span class="detail-label">
                    Amount
                  </span>
                  <span class="detail-value"
                        style="color:#FF6B6B">
                    
$$
{order.chargeAmount} CAD
                  </span>
                </div>
                ${dietaryHtml}
              </div>

              <a href="${approveUrl}" class="btn">
                ✅ Approve This Delivery
              </a>

              <a href="${dashboardUrl}"
                 class="btn-outline">
                View or Modify in Dashboard
              </a>

              <p style="
                font-size:  0.82rem;
                color:      #AAA;
                text-align: center;
                margin-top: 8px;
              ">
                This order will auto-confirm in
                48 hours if no action is taken.
                <br/>
                Approval link expires in 7 days.
              </p>

            </div>

            <div class="footer">
              <p>
                Delightmaker · Halifax, NS 🇨🇦
              </p>
              <p>
                <a href="${dashboardUrl}">
                  Manage your account
                </a>
                &nbsp;·&nbsp;
                <a href="mailto:hello@delightmaker.ca">
                  Contact support
                </a>
              </p>
            </div>

          </div>
        </body>
        </html>
      `;


      // ── Send email ────────────────────────────────
      if (!isResendConfigured()) {
        console.log(
          `📧 Confirmation email skipped — ` +
          `Resend not configured`
        );
        console.log(
          `Would send to: ${company.contactEmail}`
        );

        // Still update order status
        await orderDoc.ref.update({
          status:             ORDER_STATUS
                                .PENDING_CONFIRMATION,
          confirmationSentAt: serverTimestamp(),
          approvalToken:      token,
        });

        return res.status(200).json({
          success:     true,
          message:     'Email skipped (not configured)',
          approveUrl,
        });
      }

      const resend = getResend();
      const result = await resend.emails.send({
        from:    FROM(process.env.EMAIL_SUPPORT),
        to:      company.contactEmail,
        subject: `🎂 ${order.employeeName}'s birthday is in 7 days — confirm delivery`,
        html:    emailHtml,
      });


      // ── Update order status ───────────────────────
      await orderDoc.ref.update({
        status:             ORDER_STATUS
                              .PENDING_CONFIRMATION,
        confirmationSentAt: serverTimestamp(),
        approvalToken:      token,
        resendEmailId:      result.id || null,
      });


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'send_confirmation_email',
        'order',
        orderId,
        { sentTo: company.contactEmail }
      );

      console.log(
        `✅ Confirmation email sent: ${orderId} ` +
        `→ ${company.contactEmail}`
      );

      return res.status(200).json({
        success:    true,
        message:    'Confirmation email sent',
        emailId:    result.id,
        approveUrl,
      });

    } catch (err) {
      console.error(
        'Send confirmation email error:', err
      );
      return res.status(500).json({
        error: 'Failed to send confirmation email'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/emails/notify-baker
   Admin only
   Sends order details email to bakery partner
   ═══════════════════════════════════════════════════ */

router.post('/notify-baker',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { orderId } = req.body;

      if (!orderId) {
        return res.status(400).json({
          error: 'Order ID required'
        });
      }


      // ── Get order ─────────────────────────────────
      const orderDoc = await db
        .collection(COLLECTIONS.ORDERS)
        .doc(orderId)
        .get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();

      if (!order.bakerId) {
        return res.status(400).json({
          error: 'Order has no bakery assigned'
        });
      }


      // ── Get bakery ────────────────────────────────
      const bakeryDoc = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(order.bakerId)
        .get();

      if (!bakeryDoc.exists) {
        return res.status(404).json({
          error: 'Bakery not found'
        });
      }

      const bakery = bakeryDoc.data();


      // ── Format dates ──────────────────────────────
      const deliveryDate = order.deliveryDate
        ?.toDate()
        ?.toLocaleDateString('en-CA', {
          weekday: 'long',
          year:    'numeric',
          month:   'long',
          day:     'numeric',
        }) || 'TBD';


      // ── Dietary alert HTML ────────────────────────
      const dietaryAlertHtml =
        order.dietaryFlags &&
        order.dietaryFlags.length > 0
        ? `
          <div class="alert-box">
            🚨 <strong>DIETARY REQUIREMENTS:</strong>
            ${order.dietaryFlags
              .map(f => f.toUpperCase())
              .join(', ')}
            <br/>
            Please ensure this order meets
            all dietary requirements.
          </div>
        `
        : '';


      // ── Baker portal URL ──────────────────────────
      const bakerPortalUrl =
        `${process.env.APP_URL}/baker/dashboard`;


      // ── Build email HTML ──────────────────────────
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8"/>
          <meta name="viewport"
                content="width=device-width,
                         initial-scale=1.0"/>
          ${EMAIL_STYLES}
        </head>
        <body>
          <div class="wrapper">

            <div class="header">
              <div class="header-logo">
                🧁 Delight<span>maker</span>
              </div>
              <p style="
                color:     rgba(255,255,255,0.7);
                font-size: 0.85rem;
                margin:    8px 0 0;
              ">
                New Order for ${bakery.name}
              </p>
            </div>

            <div class="body">

              <h1>📦 New Order — Action Required</h1>

              <p>
                Hi ${bakery.name} team,
              </p>
              <p>
                You have a new Delightmaker order.
                Please review the details below
                and confirm receipt.
              </p>

              ${dietaryAlertHtml}

              <div class="highlight-box">
                <div class="detail-row">
                  <span class="detail-label">
                    Order ID
                  </span>
                  <span class="detail-value"
                        style="font-size:0.85rem">
                    #${orderId.slice(-8).toUpperCase()}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Product
                  </span>
                  <span class="detail-value">
                    ${order.productName}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Delivery Date
                  </span>
                  <span class="detail-value"
                        style="color:#FF6B6B">
                    ${deliveryDate}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Delivery Address
                  </span>
                  <span class="detail-value">
                    ${order.deliveryAddress}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Card Message
                  </span>
                  <span class="detail-value"
                        style="font-style:italic">
                    "${order.customMessage ||
                      (order.eventType === 'birthday'
                        ? 'Happy Birthday from the whole team! 🎂'
                        : 'Enjoy the treats! 🎉')}"
                  </span>
                </div>
                ${order.bakerNotes ? `
                <div class="detail-row"
                     style="border:none">
                  <span class="detail-label">
                    Notes from Colton
                  </span>
                  <span class="detail-value">
                    ${order.bakerNotes}
                  </span>
                </div>
                ` : ''}
              </div>

              <a href="${bakerPortalUrl}" class="btn">
                View in Baker Portal →
              </a>

              <p style="
                font-size:  0.82rem;
                color:      #AAA;
                text-align: center;
              ">
                Please log in to the baker portal
                to confirm receipt and mark as
                delivered when complete.
              </p>

            </div>

            <div class="footer">
              <p>Delightmaker · Halifax, NS 🇨🇦</p>
              <p>
                Questions? Email
                <a href="mailto:${
                  process.env.EMAIL_ORDERS
                }">
                  ${process.env.EMAIL_ORDERS}
                </a>
              </p>
            </div>

          </div>
        </body>
        </html>
      `;


      // ── Send email ────────────────────────────────
      if (!isResendConfigured()) {
        console.log(
          `📧 Baker notification skipped ` +
          `— Resend not configured`
        );
        return res.status(200).json({
          success: true,
          message: 'Email skipped (not configured)',
        });
      }

      const resend = getResend();
      const result = await resend.emails.send({
        from:    FROM(process.env.EMAIL_ORDERS),
        to:      bakery.contactEmail,
        subject: `📦 New Order #${
          orderId.slice(-8).toUpperCase()
        } — ${deliveryDate}`,
        html:    emailHtml,
      });


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'send_baker_notification',
        'order',
        orderId,
        { sentTo: bakery.contactEmail }
      );

      console.log(
        `✅ Baker notification sent: ${orderId} ` +
        `→ ${bakery.contactEmail}`
      );

      return res.status(200).json({
        success: true,
        message: 'Baker notification sent',
        emailId: result.id,
      });

    } catch (err) {
      console.error(
        'Send baker notification error:', err
      );
      return res.status(500).json({
        error: 'Failed to send baker notification'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/emails/delivery-confirmed
   Admin or baker
   Sends delivery confirmation to HR contact
   Triggered when baker marks delivered
   ═══════════════════════════════════════════════════ */

router.post('/delivery-confirmed',
  authenticate,
  async (req, res) => {
    try {

      const { orderId } = req.body;

      if (!orderId) {
        return res.status(400).json({
          error: 'Order ID required'
        });
      }


      // ── Get order ─────────────────────────────────
      const orderDoc = await db
        .collection(COLLECTIONS.ORDERS)
        .doc(orderId)
        .get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderDoc.data();


      // ── Get company ───────────────────────────────
      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(order.companyId)
        .get();

      if (!companyDoc.exists) {
        return res.status(404).json({
          error: 'Company not found'
        });
      }

      const company = companyDoc.data();


      // ── Format date ───────────────────────────────
      const deliveryDate = new Date()
        .toLocaleDateString('en-CA', {
          weekday: 'long',
          month:   'long',
          day:     'numeric',
        });

      const spendUrl =
        `${process.env.APP_URL}/company/spending`;

      const eventLabels = {
        birthday: 'Birthday',
      };


      // ── Build email HTML ──────────────────────────
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8"/>
          <meta name="viewport"
                content="width=device-width,
                         initial-scale=1.0"/>
          ${EMAIL_STYLES}
        </head>
        <body>
          <div class="wrapper">

            <div class="header">
              <div class="header-logo">
                🧁 Delight<span>maker</span>
              </div>
            </div>

            <div class="body">

              <div style="text-align:center;
                          margin-bottom:20px">
                <div style="font-size:3rem">🎉</div>
              </div>

              <h1 style="text-align:center">
                Delivered!
              </h1>

              <p style="text-align:center">
                ${order.employeeName}'s
                ${eventLabels[order.eventType]
                  || 'celebration'}
                treat has been delivered to your
                office today.
              </p>

              <div class="highlight-box">
                <div class="detail-row">
                  <span class="detail-label">
                    Employee
                  </span>
                  <span class="detail-value">
                    ${order.employeeName}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Treat
                  </span>
                  <span class="detail-value">
                    ${order.productName}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">
                    Delivered
                  </span>
                  <span class="detail-value">
                    ${deliveryDate}
                  </span>
                </div>
                <div class="detail-row"
                     style="border:none">
                  <span class="detail-label">
                    Amount Charged
                  </span>
                  <span class="detail-value"
                        style="color:#FF6B6B">
$$
{order.chargeAmount} CAD
                  </span>
                </div>
              </div>

              <p style="text-align:center;
                        font-size:0.9rem;
                        color:#888">
                Payment has been processed
                automatically. View your full
                spending history below.
              </p>

              <a href="${spendUrl}" class="btn">
                View Spending Report →
              </a>

            </div>

            <div class="footer">
              <p>Delightmaker · Halifax, NS 🇨🇦</p>
              <p>
                <a href="mailto:hello@delightmaker.ca">
                  Contact support
                </a>
              </p>
            </div>

          </div>
        </body>
        </html>
      `;


      // ── Send email ────────────────────────────────
      if (!isResendConfigured()) {
        console.log(
          `📧 Delivery confirmation skipped ` +
          `— Resend not configured`
        );
        return res.status(200).json({
          success: true,
          message: 'Email skipped (not configured)',
        });
      }

      const resend = getResend();
      const result = await resend.emails.send({
        from:    FROM(process.env.EMAIL_SUPPORT),
        to:      company.contactEmail,
        subject: `🎉 Delivered! ` +
                 `${order.employeeName}'s treat ` +
                 `arrived today`,
        html:    emailHtml,
      });


      // ── Write audit log ───────────────────────────
      await writeAuditLog(
        req.user.uid,
        'send_delivery_confirmation',
        'order',
        orderId,
        { sentTo: company.contactEmail }
      );

      console.log(
        `✅ Delivery confirmation sent: ${orderId} ` +
        `→ ${company.contactEmail}`
      );

      return res.status(200).json({
        success: true,
        message: 'Delivery confirmation sent',
        emailId: result.id,
      });

    } catch (err) {
      console.error(
        'Delivery confirmation email error:', err
      );
      return res.status(500).json({
        error: 'Failed to send delivery confirmation'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/emails/payment-failed
   Admin only
   Sends payment failed alert to company HR
   ═══════════════════════════════════════════════════ */

router.post('/payment-failed',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { companyId } = req.body;

      if (!companyId) {
        return res.status(400).json({
          error: 'Company ID required'
        });
      }

      const companyDoc = await db
        .collection(COLLECTIONS.COMPANIES)
        .doc(companyId)
        .get();

      if (!companyDoc.exists) {
        return res.status(404).json({
          error: 'Company not found'
        });
      }

      const company = companyDoc.data();

      const billingUrl =
        `${process.env.APP_URL}/company/dashboard`;


      // ── Build email HTML ──────────────────────────
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8"/>
          <meta name="viewport"
                content="width=device-width,
                         initial-scale=1.0"/>
          ${EMAIL_STYLES}
        </head>
        <body>
          <div class="wrapper">

            <div class="header">
              <div class="header-logo">
                🧁 Delight<span>maker</span>
              </div>
            </div>

            <div class="body">

              <h1>⚠️ Payment Issue</h1>

              <p>
                Hi ${company.contactName || 'there'},
              </p>

              <p>
                We had trouble processing your
                payment for Delightmaker.
                This may affect upcoming deliveries.
              </p>

              <div class="alert-box">
                ⚠️ Your account has been temporarily
                paused due to a payment failure.
                Upcoming deliveries will be held
                until billing is updated.
              </div>

              <p>
                To fix this, please update your
                payment method in your dashboard.
                It only takes a minute.
              </p>

              <a href="${billingUrl}" class="btn">
                Update Payment Method →
              </a>

              <p style="
                font-size:  0.82rem;
                color:      #AAA;
                text-align: center;
              ">
                Questions? Contact us at
                <a href="mailto:${process.env.EMAIL_BILLING}">
                  ${process.env.EMAIL_BILLING}
                </a>
              </p>

            </div>

            <div class="footer">
              <p>Delightmaker · Halifax, NS 🇨🇦</p>
            </div>

          </div>
        </body>
        </html>
      `;


      // ── Send email ────────────────────────────────
      if (!isResendConfigured()) {
        console.log(
          `📧 Payment failed email skipped ` +
          `— Resend not configured`
        );
        return res.status(200).json({
          success: true,
          message: 'Email skipped (not configured)',
        });
      }

      const resend = getResend();
      const result = await resend.emails.send({
        from:    FROM(process.env.EMAIL_BILLING),
        to:      company.contactEmail,
        subject: `⚠️ Action required — ` +
                 `payment issue on your ` +
                 `Delightmaker account`,
        html:    emailHtml,
      });

      console.log(
        `✅ Payment failed email sent → ` +
        `${company.contactEmail}`
      );

      return res.status(200).json({
        success: true,
        message: 'Payment failed email sent',
        emailId: result.id,
      });

    } catch (err) {
      console.error(
        'Payment failed email error:', err
      );
      return res.status(500).json({
        error: 'Failed to send payment failed email'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/emails/baker-invoice
   Baker or admin
   Called when baker manually submits an invoice.
   Fetches all paid/delivered orders for that baker
   + month, builds a full line-item invoice, and
   emails Colton so he knows to pay the baker.
   ═══════════════════════════════════════════════════ */

router.post('/baker-invoice',
  authenticate,
  async (req, res) => {
    try {
      const { bakerId, month, year } = req.body;

      // Must be the baker themselves or an admin
      const isAdmin  = req.user.role === 'admin';
      const isBaker  = req.user.role === 'baker' &&
                       req.user.bakerId === bakerId;

      if (!isAdmin && !isBaker) {
        return res.status(403).json({
          error: 'Not authorised'
        });
      }

      if (!bakerId || !month || !year) {
        return res.status(400).json({
          error: 'bakerId, month and year are required'
        });
      }

      // ── Fetch bakery ──────────────────────────────
      const bakeryDoc = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakerId)
        .get();

      const bakery = bakeryDoc.exists
        ? bakeryDoc.data()
        : { name: bakerId };

      const bakeryName = bakery.name || bakerId;

      // ── Date range for the month ──────────────────
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd   = new Date(year, month,     1);

      const monthStartTs =
        admin.firestore.Timestamp.fromDate(monthStart);
      const monthEndTs   =
        admin.firestore.Timestamp.fromDate(monthEnd);

      // ── Fetch paid/delivered orders ───────────────
      const ordersSnap = await db
        .collection(COLLECTIONS.ORDERS)
        .where('bakerId',      '==', bakerId)
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

      // ── Build line items ──────────────────────────
      const lineItems = orders.map(o => ({
        orderId:      o.id,
        deliveryDate: o.deliveryDate,
        companyName:  o.companyName  || o.companyId  || '—',
        employeeName: o.employeeName || '—',
        productName:  o.productName  || '—',
        amount: typeof o.chargeAmount === 'number'
          ? o.chargeAmount : 0,
      }));

      const totalAmount = lineItems.reduce(
        (sum, li) => sum + li.amount, 0
      );

      const monthNames = [
        'January','February','March','April',
        'May','June','July','August',
        'September','October','November','December',
      ];
      const monthLabel = `${monthNames[month - 1]} ${year}`;

      // ── Build invoice number ──────────────────────
      const bakeryCode = bakeryName
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .slice(0, 4)
        .padEnd(4, 'X');

      const invoiceNumber =
        `DM-${year}-${String(month).padStart(2,'0')}-${bakeryCode}`;

      // ── Build email HTML ──────────────────────────
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
                       font-weight:600">
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

      const appUrl = process.env.APP_URL ||
                     'https://delightmaker.ca';

      const invoicesUrl = `${appUrl}/admin/invoices`;

      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"/></head>
        <body style="font-family:Arial,sans-serif;
                     background:#FFFAF5;
                     margin:0;padding:24px">
          <div style="max-width:620px;margin:0 auto">

            <table style="width:100%;
                          background:#2D2D2D;
                          border-radius:12px 12px 0 0">
              <tr>
                <td style="padding:22px 28px;
                           color:white;font-size:1.1rem;
                           font-weight:700">
                  🧁 Delightmaker
                </td>
                <td style="padding:22px 28px;
                           text-align:right">
                  <p style="color:#FFD93D;
                             font-size:0.7rem;
                             font-weight:700;margin:0;
                             text-transform:uppercase;
                             letter-spacing:0.08em">
                    Invoice Submitted
                  </p>
                  <p style="color:white;
                             font-size:0.88rem;
                             font-weight:700;
                             margin:3px 0 0">
                    ${invoiceNumber}
                  </p>
                </td>
              </tr>
            </table>

            <div style="background:white;
                        border:1px solid #eee;
                        border-top:none;
                        padding:28px">

              <h2 style="margin:0 0 6px;
                          color:#2D2D2D">
                💰 ${bakeryName} submitted an invoice
              </h2>
              <p style="color:#888;
                         margin:0 0 20px;
                         font-size:0.9rem">
                Period: ${monthLabel} ·
                ${lineItems.length} order${
                  lineItems.length !== 1 ? 's' : ''
                }
              </p>

              <div style="background:#FFFAF5;
                          border:2px solid #FFD93D;
                          border-radius:10px;
                          padding:16px 20px;
                          margin-bottom:20px">
                <p style="font-size:0.7rem;
                           font-weight:700;
                           text-transform:uppercase;
                           letter-spacing:0.08em;
                           color:#888;margin:0 0 6px">
                  Amount owed to baker
                </p>
                <p style="font-size:2rem;
                           font-weight:700;
                           color:#2D2D2D;margin:0">
                  $${totalAmount.toFixed(2)}
                  <span style="font-size:0.8rem;
                                font-weight:400;
                                color:#888">CAD</span>
                </p>
              </div>

              <table style="width:100%;
                            border-collapse:collapse;
                            margin-bottom:20px">
                <thead>
                  <tr style="border-bottom:2px solid #F0F0F0;
                              background:#FAFAFA">
                    <th style="padding:8px;font-size:0.7rem;
                                font-weight:700;
                                text-transform:uppercase;
                                color:#888;text-align:left">
                      Date
                    </th>
                    <th style="padding:8px;font-size:0.7rem;
                                font-weight:700;
                                text-transform:uppercase;
                                color:#888;text-align:left">
                      Company
                    </th>
                    <th style="padding:8px;font-size:0.7rem;
                                font-weight:700;
                                text-transform:uppercase;
                                color:#888;text-align:left">
                      Employee
                    </th>
                    <th style="padding:8px;font-size:0.7rem;
                                font-weight:700;
                                text-transform:uppercase;
                                color:#888;text-align:left">
                      Treat
                    </th>
                    <th style="padding:8px;font-size:0.7rem;
                                font-weight:700;
                                text-transform:uppercase;
                                color:#888;text-align:right">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${lineItemRows}
                </tbody>
                <tfoot>
                  <tr style="border-top:2px solid #2D2D2D">
                    <td colspan="4"
                        style="padding:12px 8px;
                               font-weight:700;
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

              <a href="${invoicesUrl}"
                 style="display:block;
                        background:#FF6B6B;
                        color:white;
                        padding:14px;
                        border-radius:100px;
                        text-decoration:none;
                        font-weight:700;
                        text-align:center;
                        font-size:0.95rem">
                Review &amp; Mark as Paid →
              </a>

            </div>

            <div style="background:#F5F5F5;
                        border:1px solid #eee;
                        border-top:none;
                        border-radius:0 0 12px 12px;
                        padding:14px 20px;
                        text-align:center">
              <p style="font-size:0.77rem;
                         color:#AAA;margin:0">
                Delightmaker · Halifax, NS 🇨🇦 ·
                <a href="${appUrl}"
                   style="color:#FF6B6B">
                  delightmaker.ca
                </a>
              </p>
            </div>

          </div>
        </body>
        </html>
      `;

      // ── Send email ────────────────────────────────
      if (!isResendConfigured()) {
        console.log(
          `📧 Baker invoice email skipped ` +
          `(Resend not configured)`
        );
        return res.status(200).json({
          success: true,
          message: 'Email skipped (not configured)',
        });
      }

      const resend = getResend();
      const bakerEmail = bakery.contactEmail ||
                         bakery.contact || null;

      // Email Colton
      await resend.emails.send({
        from:    FROM(process.env.RESEND_FROM_EMAIL),
        to:      process.env.ADMIN_EMAIL,
        subject: `💰 Invoice from ${bakeryName} — ` +
                 `${monthLabel} — ` +
                 `$${totalAmount.toFixed(2)} CAD`,
        html:    emailHtml,
      });

      console.log(
        `✅ Baker invoice emailed to Colton ← ` +
        `${bakeryName} (${monthLabel})`
      );

      // CC the baker
      if (bakerEmail) {
        await resend.emails.send({
          from:    FROM(process.env.RESEND_FROM_EMAIL),
          to:      bakerEmail,
          subject: `🧾 Your Invoice — ${monthLabel} ` +
                   `(${invoiceNumber})`,
          html:    emailHtml,
        });
        console.log(
          `✅ Baker invoice copy sent → ${bakerEmail}`
        );
      }

      return res.status(200).json({
        success: true,
        message: 'Invoice emailed to Colton',
        invoiceNumber,
        totalAmount,
      });

    } catch (err) {
      console.error('Baker invoice email error:', err);
      return res.status(500).json({
        error: 'Failed to send invoice email: ' +
               err.message,
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/emails/test
   Admin only
   Sends a test email to verify Resend is working
   ═══════════════════════════════════════════════════ */

router.post('/test',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const { to } = req.body;

      const recipient = to || process.env.ADMIN_EMAIL;

      if (!isResendConfigured()) {
        return res.status(400).json({
          error: 'Resend not configured. ' +
                 'Add RESEND_API_KEY to .env'
        });
      }

      const resend = getResend();
      const result = await resend.emails.send({
        from:    FROM(),
        to:      recipient,
        subject: '✅ Delightmaker email test',
        html: `
          <div style="
            font-family: sans-serif;
            max-width:   500px;
            margin:      0 auto;
            padding:     32px;
            text-align:  center;
          ">
            <div style="font-size:3rem">🧁</div>
            <h2 style="margin:16px 0 8px">
              Delightmaker emails are working!
            </h2>
            <p style="color:#888">
              If you received this email,
              Resend is configured correctly
              and emails will deliver properly.
            </p>
            <p style="
              margin-top:  24px;
              font-size:   0.8rem;
              color:       #AAA;
            ">
              Sent from Delightmaker
              · ${new Date().toLocaleString()}
            </p>
          </div>
        `,
      });

      console.log(
        `✅ Test email sent to ${recipient}`
      );

      return res.status(200).json({
        success:   true,
        message:   `Test email sent to ${recipient}`,
        emailId:   result.id,
      });

    } catch (err) {
      console.error('Test email error:', err);
      return res.status(500).json({
        error:   'Failed to send test email',
        details: err.message,
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;