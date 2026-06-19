/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — SUPPORT / REPORT AN ISSUE
   Company + baker users file tickets; admin manages them.
   Mount: /api/support
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  db,
  COLLECTIONS,
  admin,
  serverTimestamp,
  authenticate,
  requireAdmin,
  writeAuditLog,
} = require('../firebase/config');

const TICKETS = 'supportTickets';

const CATEGORIES = [
  'Bug', 'Billing', 'Delivery problem', 'Feature request', 'Other',
  'Account deletion',
];

const DELETION_REASONS = [
  'Switching providers', 'Too expensive', 'No longer needed',
  'Not satisfied', 'Other',
];


function isResendConfigured() {
  return process.env.RESEND_API_KEY &&
         process.env.RESEND_API_KEY !== 'your_resend_key_here';
}
function getResend() {
  const { Resend } = require('resend');
  return new Resend(process.env.RESEND_API_KEY);
}
function esc(s) {
  return String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


/* ═══════════════════════════════════════════════════
   POST /api/support/tickets
   Company user or baker — file a new ticket.
   ═══════════════════════════════════════════════════ */
router.post('/tickets', authenticate, async (req, res) => {
  try {
    const { role, uid, companyId, bakerId } = req.user;
    if (role !== 'company_user' && role !== 'baker' && role !== 'admin') {
      return res.status(403).json({ error: 'Not allowed' });
    }

    let { category, subject, description, page } = req.body || {};
    category    = (category || 'Other').trim();
    subject     = (subject || '').trim();
    description = (description || '').trim();
    page        = (page || '').trim();

    if (!CATEGORIES.includes(category)) category = 'Other';
    if (subject.length < 3) {
      return res.status(400).json({ error: 'Please add a short subject' });
    }
    if (description.length < 10) {
      return res.status(400).json({ error: 'Please describe the issue (at least 10 characters)' });
    }

    // ── Resolve reporter identity ─────────────────
    let reporterName = '', reporterEmail = '', orgName = '';
    try {
      const uDoc = await db.collection(COLLECTIONS.USERS).doc(uid).get();
      if (uDoc.exists) {
        reporterName  = uDoc.data().displayName || '';
        reporterEmail = uDoc.data().email || '';
      }
    } catch (_) {}

    try {
      if (role === 'company_user' && companyId) {
        const c = await db.collection(COLLECTIONS.COMPANIES).doc(companyId).get();
        if (c.exists) orgName = c.data().name || '';
      } else if (role === 'baker' && bakerId) {
        const b = await db.collection(COLLECTIONS.BAKERIES).doc(bakerId).get();
        if (b.exists) orgName = b.data().name || '';
      }
    } catch (_) {}

    // Short human reference, e.g. DM-7F3A9C
    const ref = 'DM-' + Math.random().toString(36).slice(2, 8).toUpperCase();

    const ticket = {
      ref,
      category,
      subject,
      description,
      page:          page || null,
      status:        'open',
      role,
      companyId:     companyId || null,
      bakerId:       bakerId   || null,
      orgName:       orgName   || null,
      reporterUid:   uid,
      reporterName:  reporterName || null,
      reporterEmail: reporterEmail || null,
      adminNote:     '',
      createdAt:     serverTimestamp(),
      resolvedAt:    null,
      resolvedBy:    null,
    };

    const docRef = await db.collection(TICKETS).add(ticket);

    // ── Emails (awaited so Vercel doesn't kill them on response) ──
    const emailJobs = [];
    if (isResendConfigured() && process.env.ADMIN_EMAIL) {
      const resend = getResend();
      emailJobs.push(resend.emails.send({
        from:    `${process.env.RESEND_FROM_NAME} <${process.env.EMAIL_SUPPORT || process.env.RESEND_FROM_EMAIL}>`,
        to:      process.env.ADMIN_EMAIL,
        replyTo: reporterEmail || undefined,
        subject: `🆘 ${category} — ${subject} (${ref})`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#FFFAF5">
            <div style="background:#2D2D2D;border-radius:12px 12px 0 0;padding:18px 24px;color:white;font-weight:700">🆘 New Support Ticket</div>
            <div style="background:white;border:1px solid #eee;padding:24px">
              <p style="margin:0 0 16px;color:#888;font-size:0.85rem">Ref <strong style="color:#2D2D2D">${ref}</strong></p>
              <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">From</td><td style="padding:7px 0;font-weight:700;text-align:right">${esc(reporterName) || 'Unknown'} ${orgName ? `· ${esc(orgName)}` : ''}</td></tr>
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Role</td><td style="padding:7px 0;font-weight:600;text-align:right">${role === 'company_user' ? 'Company' : role === 'baker' ? 'Bakery' : 'Admin'}</td></tr>
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Email</td><td style="padding:7px 0;font-weight:600;text-align:right">${esc(reporterEmail) || '—'}</td></tr>
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Category</td><td style="padding:7px 0;font-weight:700;text-align:right">${esc(category)}</td></tr>
                ${page ? `<tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Page</td><td style="padding:7px 0;font-size:0.8rem;text-align:right">${esc(page)}</td></tr>` : ''}
              </table>
              <h3 style="margin:20px 0 6px;color:#2D2D2D">${esc(subject)}</h3>
              <div style="background:#FFFAF5;border:1px solid #F0EBE3;border-radius:10px;padding:14px 16px;color:#444;font-size:0.92rem;white-space:pre-wrap;line-height:1.6">${esc(description)}</div>
              <a href="${process.env.APP_URL}/admin/support" style="display:inline-block;margin-top:20px;background:#FF6B6B;color:white;padding:12px 24px;border-radius:100px;text-decoration:none;font-weight:700">Open in Support →</a>
            </div>
          </div>
        `,
      }).catch(err => console.error('Support admin email failed:', err.message)));

      // ── Confirmation to reporter ────────────────
      if (reporterEmail) {
        emailJobs.push(resend.emails.send({
          from:    `${process.env.RESEND_FROM_NAME} <${process.env.EMAIL_SUPPORT || process.env.RESEND_FROM_EMAIL}>`,
          to:      reporterEmail,
          subject: `We got your report (${ref})`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#FFFAF5">
              <div style="background:#C4621D;border-radius:12px 12px 0 0;padding:18px 24px;color:white;font-weight:700">🧁 Delightmaker</div>
              <div style="background:white;border:1px solid #eee;padding:28px">
                <h2 style="margin:0 0 8px;color:#1A1008">Thanks${reporterName ? `, ${esc(reporterName.split(' ')[0])}` : ''}! 🙌</h2>
                <p style="color:#6B5444;margin:0 0 16px;line-height:1.6">We received your report and the team will take a look. Your reference is <strong style="color:#C4621D">${ref}</strong> — keep it handy if you need to follow up.</p>
                <div style="background:#FFFAF5;border:1px solid #EADBCB;border-radius:10px;padding:14px 16px;margin-bottom:16px">
                  <p style="margin:0 0 4px;font-size:0.78rem;color:#8B7260;text-transform:uppercase;letter-spacing:0.05em;font-weight:700">${esc(category)}</p>
                  <p style="margin:0;font-weight:700;color:#1A1008">${esc(subject)}</p>
                </div>
                <p style="color:#8B7260;font-size:0.85rem;margin:0">We'll reach out at ${esc(reporterEmail)} if we need more details.</p>
              </div>
              <div style="background:#F5F5F5;border:1px solid #eee;border-radius:0 0 12px 12px;padding:14px;text-align:center;font-size:0.75rem;color:#AAA">Delightmaker · Halifax, NS 🇨🇦</div>
            </div>
          `,
        }).catch(err => console.error('Support confirmation email failed:', err.message)));
      }
    } else {
      console.warn('🆘 Support emails skipped — Resend or ADMIN_EMAIL not configured');
    }

    // Wait for the emails to actually send before returning (Vercel
    // terminates the function as soon as the response is sent).
    if (emailJobs.length) await Promise.allSettled(emailJobs);

    console.log(`🆘 Support ticket ${ref} from ${role} (${reporterEmail || uid})`);
    return res.status(200).json({ success: true, ref, id: docRef.id });

  } catch (err) {
    console.error('Create support ticket error:', err);
    return res.status(500).json({ error: 'Failed to submit report' });
  }
});


/* ═══════════════════════════════════════════════════
   POST /api/support/deletion-request
   Company user or baker — request that their account be
   deleted. Does NOT delete anything; creates a support
   ticket (category 'Account deletion') + emails Colton +
   confirms to the requester. Colton fulfils it manually.
   ═══════════════════════════════════════════════════ */
router.post('/deletion-request', authenticate, async (req, res) => {
  try {
    const { role, uid, companyId, bakerId } = req.user;
    if (role !== 'company_user' && role !== 'baker') {
      return res.status(403).json({ error: 'Not allowed' });
    }

    let reason  = (req.body?.reason || '').trim();
    let details = (req.body?.details || '').trim();
    let contactEmail = (req.body?.contactEmail || '').trim().toLowerCase();

    if (!DELETION_REASONS.includes(reason)) reason = 'Other';

    // Resolve identity + org
    let reporterName = '', accountEmail = '', orgName = '';
    try {
      const uDoc = await db.collection(COLLECTIONS.USERS).doc(uid).get();
      if (uDoc.exists) {
        reporterName = uDoc.data().displayName || '';
        accountEmail = uDoc.data().email || '';
      }
    } catch (_) {}
    if (!contactEmail) contactEmail = accountEmail;

    try {
      if (role === 'company_user' && companyId) {
        const c = await db.collection(COLLECTIONS.COMPANIES).doc(companyId).get();
        if (c.exists) orgName = c.data().name || '';
      } else if (role === 'baker' && bakerId) {
        const b = await db.collection(COLLECTIONS.BAKERIES).doc(bakerId).get();
        if (b.exists) orgName = b.data().name || '';
      }
    } catch (_) {}

    const roleLabel = role === 'company_user' ? 'Company' : 'Bakery';
    const ref = 'DEL-' + Math.random().toString(36).slice(2, 8).toUpperCase();

    // Store as a support ticket so it shows in the Support queue
    const ticket = {
      ref,
      category:      'Account deletion',
      subject:       `Account deletion request — ${orgName || roleLabel}`,
      description:   `Reason: ${reason}${details ? `\n\nDetails: ${details}` : ''}`,
      page:          null,
      status:        'open',
      role,
      companyId:     companyId || null,
      bakerId:       bakerId   || null,
      orgName:       orgName   || null,
      reporterUid:   uid,
      reporterName:  reporterName || null,
      reporterEmail: contactEmail || null,
      deletionRequest: true,
      deletionReason:  reason,
      adminNote:     '',
      createdAt:     serverTimestamp(),
      resolvedAt:    null,
      resolvedBy:    null,
    };
    const docRef = await db.collection(TICKETS).add(ticket);

    if (isResendConfigured() && process.env.ADMIN_EMAIL) {
      const resend = getResend();

      // Alert Colton
      await resend.emails.send({
        from:    `${process.env.RESEND_FROM_NAME} <${process.env.EMAIL_SUPPORT || process.env.RESEND_FROM_EMAIL}>`,
        to:      process.env.ADMIN_EMAIL,
        replyTo: contactEmail || undefined,
        subject: `🗑️ Account deletion request — ${orgName || roleLabel} (${ref})`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#FFFAF5">
            <div style="background:#C62828;border-radius:12px 12px 0 0;padding:18px 24px;color:white;font-weight:700">🗑️ Account Deletion Request</div>
            <div style="background:white;border:1px solid #eee;padding:24px">
              <p style="margin:0 0 16px;color:#888;font-size:0.85rem">Ref <strong style="color:#2D2D2D">${ref}</strong> — nothing has been deleted. Review and action from the admin portal.</p>
              <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Account</td><td style="padding:7px 0;font-weight:700;text-align:right">${esc(orgName) || '—'} (${roleLabel})</td></tr>
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Requested by</td><td style="padding:7px 0;font-weight:600;text-align:right">${esc(reporterName) || '—'}</td></tr>
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Contact</td><td style="padding:7px 0;font-weight:600;text-align:right">${esc(contactEmail) || '—'}</td></tr>
                <tr style="border-bottom:1px solid #eee"><td style="padding:7px 0;color:#888">Reason</td><td style="padding:7px 0;font-weight:700;text-align:right">${esc(reason)}</td></tr>
              </table>
              ${details ? `<div style="background:#FFFAF5;border:1px solid #F0EBE3;border-radius:10px;padding:14px 16px;margin-top:16px;color:#444;font-size:0.92rem;white-space:pre-wrap;line-height:1.6">${esc(details)}</div>` : ''}
              <a href="${process.env.APP_URL}/admin/${role === 'company_user' ? 'clients' : 'bakeries'}" style="display:inline-block;margin-top:20px;background:#C62828;color:white;padding:12px 24px;border-radius:100px;text-decoration:none;font-weight:700">Review in Admin →</a>
            </div>
          </div>`,
      }).catch(err => console.error('Deletion-request admin email failed:', err.message));

      // Confirm to the requester
      if (contactEmail) {
        await resend.emails.send({
          from:    `${process.env.RESEND_FROM_NAME} <${process.env.EMAIL_SUPPORT || process.env.RESEND_FROM_EMAIL}>`,
          to:      contactEmail,
          subject: `We received your account deletion request (${ref})`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#FFFAF5">
              <div style="background:#C4621D;border-radius:12px 12px 0 0;padding:18px 24px;color:white;font-weight:700">🧁 Delightmaker</div>
              <div style="background:white;border:1px solid #eee;padding:28px">
                <h2 style="margin:0 0 8px;color:#1A1008">Request received</h2>
                <p style="color:#6B5444;margin:0 0 16px;line-height:1.6">We've received your request to delete <strong>${esc(orgName) || 'your account'}</strong> (ref <strong style="color:#C4621D">${ref}</strong>). Nothing has been deleted yet — a team member will reach out to confirm before anything is removed.</p>
                <p style="color:#8B7260;font-size:0.85rem;margin:0">Changed your mind? Just reply to this email and we'll cancel the request.</p>
              </div>
              <div style="background:#F5F5F5;border:1px solid #eee;border-radius:0 0 12px 12px;padding:14px;text-align:center;font-size:0.75rem;color:#AAA">Delightmaker · Halifax, NS 🇨🇦</div>
            </div>`,
        }).catch(err => console.error('Deletion-request confirmation email failed:', err.message));
      }
    }

    console.log(`🗑️  Account deletion request ${ref} from ${role} (${contactEmail || uid})`);
    return res.status(200).json({ success: true, ref, id: docRef.id });

  } catch (err) {
    console.error('Deletion-request error:', err);
    return res.status(500).json({ error: 'Failed to submit deletion request' });
  }
});


/* ═══════════════════════════════════════════════════
   GET /api/support/tickets   (admin)
   Optional ?status=open|resolved
   ═══════════════════════════════════════════════════ */
router.get('/tickets', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    // Single-field order; filter status in JS to avoid composite index
    const snap = await db.collection(TICKETS)
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();

    let tickets = snap.docs.map(d => {
      const t = d.data();
      return {
        id: d.id,
        ...t,
        createdAt:  t.createdAt?.toDate?.()?.toISOString() || null,
        resolvedAt: t.resolvedAt?.toDate?.()?.toISOString() || null,
      };
    });

    if (status) tickets = tickets.filter(t => t.status === status);

    const openCount = tickets.filter(t => t.status === 'open').length;
    return res.json({ success: true, tickets, openCount });
  } catch (err) {
    console.error('List support tickets error:', err);
    return res.status(500).json({ error: 'Failed to load tickets' });
  }
});


/* ═══════════════════════════════════════════════════
   GET /api/support/open-count   (admin) — for nav badge
   ═══════════════════════════════════════════════════ */
router.get('/open-count', authenticate, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection(TICKETS)
      .where('status', '==', 'open')
      .get();
    return res.json({ success: true, openCount: snap.size });
  } catch (err) {
    return res.json({ success: true, openCount: 0 });
  }
});


/* ═══════════════════════════════════════════════════
   PATCH /api/support/tickets/:id   (admin)
   Update status (open|resolved) and/or admin note.
   ═══════════════════════════════════════════════════ */
router.patch('/tickets/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body || {};

    const ref = db.collection(TICKETS).doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Ticket not found' });

    const update = {};
    if (status === 'open' || status === 'resolved') {
      update.status = status;
      update.resolvedAt = status === 'resolved' ? serverTimestamp() : null;
      update.resolvedBy = status === 'resolved' ? req.user.uid : null;
    }
    if (typeof adminNote === 'string') update.adminNote = adminNote;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    await ref.update(update);
    await writeAuditLog(req.user.uid, 'update_support_ticket', 'ticket', id, {
      status: update.status,
    }).catch(() => {});

    return res.json({ success: true });
  } catch (err) {
    console.error('Update support ticket error:', err);
    return res.status(500).json({ error: 'Failed to update ticket' });
  }
});


module.exports = router;
