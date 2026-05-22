/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — INVOICE ROUTES
   All routes: /api/invoices/...
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  db,
  COLLECTIONS,
  serverTimestamp,
  authenticate,
  requireAdmin,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   GET /api/invoices
   Admin only — list all invoices
   Optional query params: ?status=pending&bakerId=xxx
   ═══════════════════════════════════════════════════ */

router.get('/',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { status, bakerId } = req.query;

      let query = db.collection(COLLECTIONS.INVOICES);

      if (status)  query = query.where('status',  '==', status);
      if (bakerId) query = query.where('bakerId', '==', bakerId);

      const snap = await query.get();

      const invoices = snap.docs
        .map(doc => ({
          id: doc.id,
          ...doc.data(),
          // Convert Firestore timestamps to ISO strings
          generatedAt: doc.data().generatedAt?.toDate?.()
                         ?.toISOString() || null,
          submittedAt: doc.data().submittedAt?.toDate?.()
                         ?.toISOString() || null,
          paidAt: doc.data().paidAt?.toDate?.()
                    ?.toISOString() || null,
        }))
        // Sort client-side: most recent first
        .sort((a, b) => {
          const ta = a.generatedAt || a.submittedAt || '';
          const tb = b.generatedAt || b.submittedAt || '';
          return tb.localeCompare(ta);
        });

      return res.json({ success: true, invoices });

    } catch (err) {
      console.error('GET /api/invoices error:', err);
      return res.status(500).json({
        error: 'Failed to load invoices'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   GET /api/invoices/:id
   Baker (own invoice) or admin
   Returns full invoice with line items
   ═══════════════════════════════════════════════════ */

router.get('/:id',
  authenticate,
  async (req, res) => {
    try {
      const invoiceDoc = await db
        .collection(COLLECTIONS.INVOICES)
        .doc(req.params.id)
        .get();

      if (!invoiceDoc.exists) {
        return res.status(404).json({
          error: 'Invoice not found'
        });
      }

      const invoice = invoiceDoc.data();

      // Baker can only see their own invoice
      const isAdmin = req.user.role === 'admin';
      const isBaker = req.user.role === 'baker' &&
                      req.user.bakerId === invoice.bakerId;

      if (!isAdmin && !isBaker) {
        return res.status(403).json({
          error: 'Not authorised'
        });
      }

      return res.json({
        success: true,
        invoice: {
          id: invoiceDoc.id,
          ...invoice,
          generatedAt: invoice.generatedAt?.toDate?.()
                         ?.toISOString() || null,
          submittedAt: invoice.submittedAt?.toDate?.()
                         ?.toISOString() || null,
          paidAt: invoice.paidAt?.toDate?.()
                    ?.toISOString() || null,
        },
      });

    } catch (err) {
      console.error('GET /api/invoices/:id error:', err);
      return res.status(500).json({
        error: 'Failed to load invoice'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/invoices/:id/paid
   Admin only
   Marks an invoice as paid.
   Updates Firestore + notifies baker via email.
   ═══════════════════════════════════════════════════ */

router.patch('/:id/paid',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const invoiceRef = db
        .collection(COLLECTIONS.INVOICES)
        .doc(req.params.id);

      const invoiceDoc = await invoiceRef.get();

      if (!invoiceDoc.exists) {
        return res.status(404).json({
          error: 'Invoice not found'
        });
      }

      const invoice = invoiceDoc.data();

      if (invoice.status === 'paid') {
        return res.status(400).json({
          error: 'Invoice already marked as paid'
        });
      }

      // Mark as paid
      await invoiceRef.update({
        status: 'paid',
        paidAt: serverTimestamp(),
        paidBy: req.user.uid,
      });

      console.log(
        `✅ Invoice ${invoice.invoiceNumber || req.params.id} ` +
        `marked as paid by admin`
      );

      // ── Notify baker ──────────────────────────────
      const resendKey = process.env.RESEND_API_KEY;
      if (resendKey && resendKey !== 'your_resend_key_here') {
        try {
          const bakeryDoc = await db
            .collection(COLLECTIONS.BAKERIES)
            .doc(invoice.bakerId)
            .get();

          const bakery    = bakeryDoc.exists
            ? bakeryDoc.data()
            : {};
          const bakerEmail = bakery.contactEmail ||
                             bakery.contact || null;

          if (bakerEmail) {
            const { Resend } = require('resend');
            const resend = new Resend(resendKey);

            const monthNames = [
              'January','February','March','April',
              'May','June','July','August',
              'September','October','November','December',
            ];
            const monthLabel =
              `${monthNames[(invoice.month || 1) - 1]} ` +
              `${invoice.year}`;

            await resend.emails.send({
              from: `${process.env.RESEND_FROM_NAME} ` +
                    `<${process.env.RESEND_FROM_EMAIL}>`,
              to:      bakerEmail,
              subject: `✅ Payment sent — ` +
                       `${invoice.invoiceNumber} ` +
                       `(${monthLabel})`,
              html: `
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"/></head>
                <body style="font-family:Arial,sans-serif;
                             background:#FFFAF5;
                             margin:0;padding:24px">
                  <div style="max-width:520px;
                              margin:0 auto">

                    <div style="background:#2D2D2D;
                                border-radius:12px 12px 0 0;
                                padding:20px 24px;
                                text-align:center;
                                color:white;
                                font-size:1.1rem;
                                font-weight:700">
                      🧁 Delightmaker
                    </div>

                    <div style="background:white;
                                border:1px solid #eee;
                                padding:28px">

                      <div style="text-align:center;
                                  margin-bottom:20px">
                        <div style="font-size:3rem">💰</div>
                      </div>

                      <h2 style="margin:0 0 6px;
                                  color:#2D2D2D;
                                  text-align:center">
                        Payment Sent!
                      </h2>
                      <p style="color:#888;
                                 text-align:center;
                                 margin:0 0 20px;
                                 font-size:0.9rem">
                        Colton has marked your invoice
                        as paid.
                      </p>

                      <div style="background:#FFFAF5;
                                  border:2px solid #FFD93D;
                                  border-radius:10px;
                                  padding:16px 20px;
                                  margin-bottom:20px">
                        <table style="width:100%;
                                      border-collapse:collapse;
                                      font-size:0.9rem">
                          <tr style="border-bottom:
                                     1px solid #eee">
                            <td style="padding:7px 0;
                                        color:#888">
                              Invoice
                            </td>
                            <td style="padding:7px 0;
                                        font-weight:700;
                                        text-align:right">
                              ${invoice.invoiceNumber || '—'}
                            </td>
                          </tr>
                          <tr style="border-bottom:
                                     1px solid #eee">
                            <td style="padding:7px 0;
                                        color:#888">
                              Period
                            </td>
                            <td style="padding:7px 0;
                                        font-weight:700;
                                        text-align:right">
                              ${monthLabel}
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:7px 0;
                                        color:#888">
                              <strong>Amount</strong>
                            </td>
                            <td style="padding:7px 0;
                                        font-weight:700;
                                        text-align:right;
                                        font-size:1.05rem;
                                        color:#2E7D32">
                              $${(invoice.totalAmount || 0)
                                  .toFixed(2)} CAD
                            </td>
                          </tr>
                        </table>
                      </div>

                      <p style="color:#888;
                                 font-size:0.82rem;
                                 text-align:center;
                                 margin:0">
                        Check your baker portal to see
                        the updated invoice status.
                      </p>
                    </div>

                    <div style="background:#F5F5F5;
                                border:1px solid #eee;
                                border-top:none;
                                border-radius:0 0 12px 12px;
                                padding:14px;
                                text-align:center;
                                font-size:0.75rem;
                                color:#AAA">
                      Delightmaker · Halifax, NS 🇨🇦
                    </div>

                  </div>
                </body>
                </html>
              `,
            });

            console.log(
              `📧 Payment confirmation sent → ${bakerEmail}`
            );
          }
        } catch (emailErr) {
          // Email failure is non-fatal
          console.error(
            'Baker payment email failed:',
            emailErr.message
          );
        }
      }

      return res.json({
        success: true,
        message: 'Invoice marked as paid',
      });

    } catch (err) {
      console.error(
        'PATCH /api/invoices/:id/paid error:', err
      );
      return res.status(500).json({
        error: 'Failed to mark invoice as paid'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;
