/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — CLAUDE API ROUTES
   AI powered features:
   - Bakery routing recommendations
   - CSV validation and cleaning
   - Email content generation
   - Exception detection and flagging
   - Monthly report generation
   All routes: /api/claude/...
   ═══════════════════════════════════════════════════ */

'use strict';

const express   = require('express');
const router    = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

const {
  db,
  COLLECTIONS,
  ORDER_STATUS,
  serverTimestamp,
  authenticate,
  requireAdmin,
} = require('../firebase/config');


/* ═══════════════════════════════════════════════════
   CLAUDE INITIALIZATION
   ═══════════════════════════════════════════════════ */

const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.CLAUDE_MODEL ||
              'claude-3-5-sonnet-20241022';

// Max tokens for different use cases
const TOKENS = {
  routing:    500,
  validation: 1000,
  email:      800,
  report:     1500,
  exception:  600,
};


/* ═══════════════════════════════════════════════════
   POST /api/claude/route-order
   Admin only
   Recommends which bakery to assign an order to
   Based on product type and dietary flags
   ═══════════════════════════════════════════════════ */

router.post('/route-order',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const {
        orderId,
        productName,
        dietaryFlags,
        quantity,
        deliveryArea,
      } = req.body;

      if (!orderId || !productName) {
        return res.status(400).json({
          error: 'Order ID and product name required'
        });
      }


      // ── Get active bakeries from Firestore ────────
      const bakeriesSnap = await db
        .collection(COLLECTIONS.BAKERIES)
        .where('active', '==', true)
        .get();

      const bakeries = bakeriesSnap.docs.map(doc => ({
        id:        doc.id,
        name:      doc.data().name,
        specialty: doc.data().specialty    || [],
        serviceArea: doc.data().serviceArea || 'HRM',
        allergenFree: doc.data().allergenFree || false,
        notes:     doc.data().wholesaleRateNotes || '',
      }));

      if (bakeries.length === 0) {
        return res.status(200).json({
          success:         true,
          recommendation:  null,
          reason:          'No active bakeries found',
          allOptions:      [],
        });
      }


      // ── Build Claude prompt ───────────────────────
      // NOTE: We anonymize — no PII sent to Claude
      const prompt = `
You are a bakery routing assistant for Delightmaker,
an employee gifting platform in Halifax, Nova Scotia.

Your job is to recommend the best bakery partner
for a delivery order based on the product type
and dietary requirements.

ORDER DETAILS:
- Product: ${productName}
- Quantity: ${quantity || 'standard'}
- Dietary flags: ${
  dietaryFlags && dietaryFlags.length > 0
    ? dietaryFlags.join(', ')
    : 'none'
}
- Delivery area: ${deliveryArea || 'Halifax HRM'}

AVAILABLE BAKERY PARTNERS:
${bakeries.map((b, i) => `
${i + 1}. ${b.name}
   Specialty: ${b.specialty.join(', ')}
   Allergen-free facility: ${b.allergenFree ? 'YES' : 'No'}
   Service area: ${b.serviceArea}
   Notes: ${b.notes || 'none'}
`).join('')}

ROUTING RULES:
- If dietary flag is "gluten-free" or "celiac":
  MUST use allergen-free facility bakery
- If dietary flag is "nut-free":
  prefer nut-free certified bakery
- If dietary flag is "kosher":
  use kosher-certified bakery
- If multiple dietary conflicts:
  flag as exception for manual routing
- Match product type to bakery specialty
- Consider service area for delivery

Respond in this exact JSON format:
{
  "recommendedBakeryId": "bakery_id_here",
  "recommendedBakeryName": "bakery name here",
  "confidence": "high|medium|low",
  "reason": "one sentence explanation",
  "isException": false,
  "exceptionReason": null,
  "alternativeIds": ["id1", "id2"]
}

If this is an exception that needs manual routing,
set isException to true and explain why.
Only return the JSON — no other text.
      `.trim();


      // ── Call Claude ───────────────────────────────
      const message = await claude.messages.create({
        model:      MODEL,
        max_tokens: TOKENS.routing,
        messages: [{
          role:    'user',
          content: prompt,
        }],
      });

      const responseText =
        message.content[0].text.trim();


      // ── Parse Claude response ─────────────────────
      let recommendation;
      try {
        // Extract JSON from response
        const jsonMatch =
          responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON in response');
        }
        recommendation = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error(
          'Claude response parse error:',
          parseErr
        );
        // Return raw response if parse fails
        return res.status(200).json({
          success:        true,
          recommendation: null,
          rawResponse:    responseText,
          error:          'Could not parse AI response',
          allOptions:     bakeries,
        });
      }


      // ── Log the routing suggestion ────────────────
      console.log(
        `🤖 Claude routing for order ${orderId}: ` +
        `${recommendation.recommendedBakeryName} ` +
        `(${recommendation.confidence} confidence)`
      );

      return res.status(200).json({
        success:        true,
        recommendation,
        allOptions:     bakeries,
      });

    } catch (err) {
      console.error('Route order AI error:', err);
      return res.status(500).json({
        error: 'AI routing failed. ' +
               'Please route manually.'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/claude/validate-csv
   Company user or admin
   Validates and cleans uploaded employee CSV data
   Returns errors, warnings, and cleaned rows
   ═══════════════════════════════════════════════════ */

router.post('/validate-csv',
  authenticate,
  async (req, res) => {
    try {

      const { rows } = req.body;

      if (!rows || !Array.isArray(rows)) {
        return res.status(400).json({
          error: 'CSV rows array required'
        });
      }

      if (rows.length === 0) {
        return res.status(400).json({
          error: 'No rows to validate'
        });
      }

      if (rows.length > 500) {
        return res.status(400).json({
          error: 'Maximum 500 rows per upload'
        });
      }


      // ── Anonymize before sending to Claude ────────
      // Replace real names with placeholders
      // We only send structure and dietary info
      const anonymizedRows = rows.map((row, i) => ({
        rowNumber:    i + 1,
        hasBirthday:  !!row.birthday,
        birthday:     row.birthday || null,
        hasStartDate: !!row.startDate,
        startDate:    row.startDate || null,
        dietary:      row.dietaryRestrictions || '',
        hasEmail:     !!row.email,
        hasAddress:   !!row.deliveryAddress,
      }));


      // ── Build Claude prompt ───────────────────────
      const prompt = `
You are a data validation assistant for an employee
gifting platform.

Validate these CSV rows and identify issues.
Names and emails have been anonymized for privacy.

ROWS TO VALIDATE:
${JSON.stringify(anonymizedRows, null, 2)}

VALIDATION RULES:
1. Birthday must be valid date format (YYYY-MM-DD)
   or common formats like MM/DD/YYYY, DD-MM-YYYY
2. Start date must be valid date format
3. Start date cannot be in the future
4. Birthday cannot be in the future
5. Dietary restrictions should be one or more of:
   gluten-free, nut-free, vegan, kosher,
   dairy-free, halal
   Flag unrecognized values with suggestions
6. All rows must have at least a birthday
   OR start date

For each problematic row, provide:
- The row number
- The issue found
- A suggested fix if possible

Also identify:
- Any dietary restriction values that look like
  common alternatives (e.g. "no nuts" → "nut-free")
- Date format inconsistencies

Respond in this exact JSON format:
{
  "validRows": 0,
  "invalidRows": 0,
  "warnings": 0,
  "issues": [
    {
      "rowNumber": 1,
      "severity": "error|warning",
      "field": "birthday|startDate|dietary",
      "issue": "description of the issue",
      "suggestion": "how to fix it",
      "autoFixable": true,
      "autoFixValue": "corrected value or null"
    }
  ],
  "dietaryMappings": [
    {
      "original": "no nuts",
      "suggested": "nut-free"
    }
  ],
  "summary": "one sentence summary"
}

Only return the JSON — no other text.
      `.trim();


      // ── Call Claude ───────────────────────────────
      const message = await claude.messages.create({
        model:      MODEL,
        max_tokens: TOKENS.validation,
        messages: [{
          role:    'user',
          content: prompt,
        }],
      });

      const responseText =
        message.content[0].text.trim();


      // ── Parse response ────────────────────────────
      let validation;
      try {
        const jsonMatch =
          responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON in response');
        }
        validation = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        // Fall back to basic validation
        validation = basicCsvValidation(rows);
      }

      return res.status(200).json({
        success:    true,
        totalRows:  rows.length,
        validation,
      });

    } catch (err) {
      console.error('CSV validation AI error:', err);

      // Fall back to basic validation
      const { rows } = req.body;
      const fallback = basicCsvValidation(rows || []);

      return res.status(200).json({
        success:    true,
        totalRows:  (rows || []).length,
        validation: fallback,
        usedFallback: true,
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/claude/generate-email
   Admin only
   Generates email content for orders
   Used for confirmation and baker notification emails
   ═══════════════════════════════════════════════════ */

router.post('/generate-email',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const {
        emailType,
        employeeFirstName,
        eventType,
        productName,
        deliveryDate,
        companyName,
        customMessage,
        quantity,
      } = req.body;

      const validTypes = [
        'confirmation',
        'baker_notification',
        'delivery_complete',
        'card_message',
      ];

      if (!emailType ||
          !validTypes.includes(emailType)) {
        return res.status(400).json({
          error: `Email type must be one of: ` +
                 validTypes.join(', ')
        });
      }


      // ── Build prompt based on email type ──────────
      let prompt = '';

      if (emailType === 'confirmation') {
        prompt = `
Write a warm, friendly one-click approval email
for an employee gifting platform called Delightmaker.

Context:
- Employee first name: ${employeeFirstName}
- Event: ${formatEventType(eventType)}
- Treat being sent: ${productName}
- Delivery date: ${deliveryDate}
- Company: ${companyName}

The email is sent to the HR manager 7 days before
the delivery. They need to approve with one click.

Write:
1. A subject line (warm and specific)
2. A short email body (3-4 sentences max)
   - Mention the employee's name and event
   - Mention what treat is being sent
   - Tell them to click approve
   - Friendly and professional tone

Format response as JSON:
{
  "subject": "subject line here",
  "body": "email body here",
  "previewText": "email preview text here"
}

Only return JSON. No other text.
        `.trim();

      } else if (emailType === 'baker_notification') {
        prompt = `
Write a clear, professional order notification
for a bakery partner receiving a new order
from Delightmaker.

Order details:
- Product: ${productName}
- Quantity: ${quantity || 'standard'}
- Delivery date: ${deliveryDate}
- Event type: ${formatEventType(eventType)}

Write a short, clear email body that:
- States this is a new Delightmaker order
- Lists the key order details clearly
- Reminds them to confirm receipt
- Professional but friendly tone

Format response as JSON:
{
  "subject": "subject line here",
  "body": "email body here"
}

Only return JSON. No other text.
        `.trim();

      } else if (emailType === 'delivery_complete') {
        prompt = `
Write a warm delivery confirmation email
for an employee gifting platform called Delightmaker.

Context:
- Employee first name: ${employeeFirstName}
- Event: ${formatEventType(eventType)}
- Treat delivered: ${productName}
- Company: ${companyName}

The email is sent to the HR manager
when the bakery confirms delivery.

Write:
1. A subject line
2. A short email body (2-3 sentences)
   - Confirm the delivery happened
   - Mention the employee and event
   - Warm, celebratory tone

Format response as JSON:
{
  "subject": "subject line here",
  "body": "email body here"
}

Only return JSON. No other text.
        `.trim();

      } else if (emailType === 'card_message') {
        prompt = `
Write a warm celebration message to include
on a physical card with a treat delivery
for an employee gifting platform.

Context:
- Employee first name: ${employeeFirstName}
- Event: ${formatEventType(eventType)}
- Company: ${companyName}
- Custom message from HR: ${customMessage || 'none'}

Write a short, warm card message (2-3 sentences max):
- Personal and celebratory
- Mentions the event
- Signed from "The [Company] Team"
- If custom message provided, incorporate it naturally

Format response as JSON:
{
  "cardMessage": "message here"
}

Only return JSON. No other text.
        `.trim();
      }


      // ── Call Claude ───────────────────────────────
      const message = await claude.messages.create({
        model:      MODEL,
        max_tokens: TOKENS.email,
        messages: [{
          role:    'user',
          content: prompt,
        }],
      });

      const responseText =
        message.content[0].text.trim();


      // ── Parse response ────────────────────────────
      let content;
      try {
        const jsonMatch =
          responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON in response');
        }
        content = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        return res.status(200).json({
          success:     true,
          content:     null,
          rawResponse: responseText,
          error:       'Could not parse AI response',
        });
      }

      return res.status(200).json({
        success: true,
        emailType,
        content,
      });

    } catch (err) {
      console.error('Generate email AI error:', err);
      return res.status(500).json({
        error: 'AI email generation failed'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/claude/scan-exceptions
   Admin only
   Scans upcoming orders for issues
   Returns flagged orders needing attention
   ═══════════════════════════════════════════════════ */

router.post('/scan-exceptions',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      // ── Get upcoming orders ───────────────────────
      const sevenDaysOut = new Date();
      sevenDaysOut.setDate(
        sevenDaysOut.getDate() + 7
      );

      const { admin: adminSDK } =
        require('../firebase/config');

      const ordersSnap = await db
        .collection(COLLECTIONS.ORDERS)
        .where('status', 'not-in', [
          ORDER_STATUS.DELIVERED,
          ORDER_STATUS.CANCELLED,
        ])
        .where('deliveryDate', '<=',
          adminSDK.firestore.Timestamp
            .fromDate(sevenDaysOut)
        )
        .get();

      const orders = ordersSnap.docs.map(doc => {
        const data = doc.data();
        return {
          id:           doc.id,
          status:       data.status,
          eventType:    data.eventType,
          dietaryFlags: data.dietaryFlags || [],
          hasBaker:     !!data.bakerId,
          deliveryDate: data.deliveryDate
            ?.toDate()
            ?.toISOString()
            ?.split('T')[0] || null,
          confirmationSentAt: data.confirmationSentAt
            ?.toDate()
            ?.toISOString() || null,
          confirmedAt: data.confirmedAt
            ?.toDate()
            ?.toISOString() || null,
          chargeAmount:  data.chargeAmount  || 0,
          wholesaleCost: data.wholesaleCost || 0,
        };
      });

      if (orders.length === 0) {
        return res.status(200).json({
          success:    true,
          exceptions: [],
          summary:    'No upcoming orders to scan',
        });
      }


      // ── Build Claude prompt ───────────────────────
      const today = new Date()
        .toISOString()
        .split('T')[0];

      const prompt = `
You are an operations assistant for Delightmaker,
an employee gifting platform.

Today's date: ${today}

Scan these upcoming orders and flag any that
need immediate attention from the operations team.

ORDERS:
${JSON.stringify(orders, null, 2)}

ORDER STATUS MEANINGS:
- scheduled: created, no action yet
- pending_confirmation: email sent to HR,
  waiting for approval
- confirmed: HR approved, needs bakery routing
- routed: assigned to bakery, in progress
- in_preparation: baker is preparing
- exception: already flagged

FLAG AN ORDER IF:
1. Delivery is within 3 days and status
   is still "scheduled" or "pending_confirmation"
2. Delivery is within 5 days and no baker assigned
   (status is "confirmed" but hasBaker is false)
3. Confirmation email was sent more than
   48 hours ago but not confirmed
4. Order has dietary flags AND no baker assigned
5. Charge amount is \$0 (billing error)
6. Delivery date has passed but not delivered

Respond in this exact JSON format:
{
  "exceptions": [
    {
      "orderId": "order_id_here",
      "severity": "critical|high|medium",
      "issue": "short description",
      "action": "what Colton should do",
      "autoResolvable": false
    }
  ],
  "summary": "X orders need attention. Brief summary."
}

Only flag real issues.
Only return JSON. No other text.
      `.trim();


      // ── Call Claude ───────────────────────────────
      const message = await claude.messages.create({
        model:      MODEL,
        max_tokens: TOKENS.exception,
        messages: [{
          role:    'user',
          content: prompt,
        }],
      });

      const responseText =
        message.content[0].text.trim();


      // ── Parse response ────────────────────────────
      let result;
      try {
        const jsonMatch =
          responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON in response');
        }
        result = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        return res.status(200).json({
          success:    true,
          exceptions: [],
          summary:    'Could not parse AI response',
        });
      }

      // ── Flag exception orders in Firestore ────────
      if (result.exceptions &&
          result.exceptions.length > 0) {
        const criticalExceptions =
          result.exceptions.filter(
            e => e.severity === 'critical'
          );

        for (const exception of criticalExceptions) {
          try {
            await db
              .collection(COLLECTIONS.ORDERS)
              .doc(exception.orderId)
              .update({
                status:          ORDER_STATUS.EXCEPTION,
                exceptionReason: exception.issue,
                flaggedAt:       serverTimestamp(),
              });
          } catch (updateErr) {
            console.error(
              'Failed to flag order:', exception.orderId
            );
          }
        }
      }

      console.log(
        `🤖 Exception scan complete: ` +
        `${result.exceptions?.length || 0} issues found`
      );

      return res.status(200).json({
        success:    true,
        exceptions: result.exceptions || [],
        summary:    result.summary || '',
      });

    } catch (err) {
      console.error('Exception scan AI error:', err);
      return res.status(500).json({
        error: 'AI exception scan failed'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/claude/generate-report
   Admin only
   Generates a natural language monthly summary
   for the revenue dashboard
   ═══════════════════════════════════════════════════ */

router.post('/generate-report',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {

      const {
        month,
        year,
        totalRevenue,
        totalCost,
        grossMargin,
        marginPercent,
        mrr,
        deliveryCount,
        activeClients,
        byCompany,
      } = req.body;


      // ── Build Claude prompt ───────────────────────
      const prompt = `
You are a business analyst for Delightmaker,
a B2B employee gifting platform in Halifax, Canada.

Generate a brief, insightful monthly summary
for the business owner.

MONTHLY DATA:
- Month/Year: ${month}/${year}
- Total delivery revenue: $${totalRevenue} CAD
- Total bakery costs: $${totalCost} CAD
- Gross margin: $${grossMargin} CAD (${marginPercent}%)
- Monthly recurring revenue (subscriptions): $${mrr} CAD
- Total deliveries: ${deliveryCount}
- Active clients: ${activeClients}

TOP COMPANIES BY REVENUE:
${(byCompany || [])
  .sort((a, b) => b.revenue - a.revenue)
  .slice(0, 5)
  .map(c =>
    `- Orders: ${c.orders}, ` +
    `Revenue: $${c.revenue.toFixed(2)}`
  )
  .join('\n')}

Write a 3-4 sentence business summary that:
1. Highlights overall performance
2. Notes any interesting trends
3. Mentions the margin health
4. Gives one actionable insight

Keep it conversational and encouraging.
This is read by the business owner (Colton).

Format response as JSON:
{
  "summary": "your summary here",
  "highlight": "one key positive metric",
  "insight": "one actionable recommendation"
}

Only return JSON. No other text.
      `.trim();


      // ── Call Claude ───────────────────────────────
      const message = await claude.messages.create({
        model:      MODEL,
        max_tokens: TOKENS.report,
        messages: [{
          role:    'user',
          content: prompt,
        }],
      });

      const responseText =
        message.content[0].text.trim();


      // ── Parse response ────────────────────────────
      let report;
      try {
        const jsonMatch =
          responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON in response');
        }
        report = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        return res.status(200).json({
          success:     true,
          report:      null,
          rawResponse: responseText,
        });
      }

      return res.status(200).json({
        success: true,
        report,
      });

    } catch (err) {
      console.error('Generate report AI error:', err);
      return res.status(500).json({
        error: 'AI report generation failed'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/claude/suggest-product
   Company user or admin
   Suggests best treat based on event type
   and team preferences
   ═══════════════════════════════════════════════════ */

router.post('/suggest-product',
  authenticate,
  async (req, res) => {
    try {

      const {
        eventType,
        teamSize,
        dietaryFlags,
        previousProducts,
        budget,
      } = req.body;

      if (!eventType) {
        return res.status(400).json({
          error: 'Event type required'
        });
      }


      // ── Get active products ───────────────────────
      const productsSnap = await db
        .collection(COLLECTIONS.PRODUCTS)
        .where('active', '==', true)
        .get();

      const products = productsSnap.docs.map(doc => ({
        id:           doc.id,
        name:         doc.data().name,
        retailPrice:  doc.data().retailPrice,
        allergenTags: doc.data().allergenTags || [],
        description:  doc.data().description  || '',
      }));


      // ── Build Claude prompt ───────────────────────
      const prompt = `
You are a gifting advisor for Delightmaker,
an employee gifting platform in Halifax, Canada.

Recommend the best treat for this situation.

SITUATION:
- Event: ${formatEventType(eventType)}
- Team size receiving: ${teamSize || 'small team'}
- Dietary flags: ${
  dietaryFlags && dietaryFlags.length > 0
    ? dietaryFlags.join(', ')
    : 'none'
}
- Budget per delivery: ${budget
  ? `
$$
{budget} CAD`
  : 'flexible'}
- Recently sent: ${
  previousProducts && previousProducts.length > 0
    ? previousProducts.join(', ')
    : 'nothing recently'
}

AVAILABLE PRODUCTS:
${products.map(p =>
  `- ${p.name} ($${p.retailPrice}) ` +
  `[${p.allergenTags.join(', ') || 'no restrictions'}]`
).join('\n')}

Recommend the best product considering:
1. Dietary requirements MUST be satisfied
2. Avoid repeating recent products if possible
3. Match occasion to product
   (milestone anniversaries deserve something special)
4. Stay within budget if specified

Format response as JSON:
{
  "recommendedProductId": "product_id_here",
  "recommendedProductName": "product name",
  "reason": "one sentence why this is best",
  "alternativeId": "backup product id or null"
}

Only return JSON. No other text.
      `.trim();


      // ── Call Claude ───────────────────────────────
      const message = await claude.messages.create({
        model:      MODEL,
        max_tokens: TOKENS.routing,
        messages: [{
          role:    'user',
          content: prompt,
        }],
      });

      const responseText =
        message.content[0].text.trim();


      // ── Parse response ────────────────────────────
      let suggestion;
      try {
        const jsonMatch =
          responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON in response');
        }
        suggestion = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        return res.status(200).json({
          success:    true,
          suggestion: null,
          products,
        });
      }

      return res.status(200).json({
        success:    true,
        suggestion,
        allProducts: products,
      });

    } catch (err) {
      console.error('Suggest product AI error:', err);
      return res.status(500).json({
        error: 'AI product suggestion failed'
      });
    }
  }
);


/* ═══════════════════════════════════════════════════
   HELPER FUNCTIONS
   ═══════════════════════════════════════════════════ */

/**
 * Format event type to human readable string
 */
function formatEventType(eventType) {
  const types = {
    birthday:        'Birthday',
    anniversary_1yr: '1 Year Work Anniversary',
    anniversary_2yr: '2 Year Work Anniversary',
    anniversary_3yr: '3 Year Work Anniversary',
    anniversary_5yr: '5 Year Work Anniversary',
    anniversary_10yr:'10 Year Work Anniversary',
  };
  return types[eventType] || eventType;
}


/**
 * Basic CSV validation fallback
 * Used if Claude API is unavailable
 */
function basicCsvValidation(rows) {
  const issues = [];
  let validRows   = 0;
  let invalidRows = 0;

  const knownDietary = [
    'gluten-free', 'nut-free', 'vegan',
    'kosher', 'dairy-free', 'halal',
  ];

  const dietaryMappings = [
    { original: 'no nuts',     suggested: 'nut-free'     },
    { original: 'nut free',    suggested: 'nut-free'     },
    { original: 'gluten free', suggested: 'gluten-free'  },
    { original: 'gf',          suggested: 'gluten-free'  },
    { original: 'dairy free',  suggested: 'dairy-free'   },
    { original: 'no dairy',    suggested: 'dairy-free'   },
  ];

  rows.forEach((row, i) => {
    const rowNum  = i + 1;
    let hasError  = false;

    // Check birthday
    if (row.birthday) {
      const d = new Date(row.birthday);
      if (isNaN(d.getTime())) {
        issues.push({
          rowNumber:    rowNum,
          severity:     'error',
          field:        'birthday',
          issue:        'Invalid date format',
          suggestion:   'Use YYYY-MM-DD format',
          autoFixable:  false,
          autoFixValue: null,
        });
        hasError = true;
      } else if (d > new Date()) {
        issues.push({
          rowNumber:    rowNum,
          severity:     'error',
          field:        'birthday',
          issue:        'Birthday cannot be in future',
          suggestion:   'Check the date',
          autoFixable:  false,
          autoFixValue: null,
        });
        hasError = true;
      }
    }

    // Check start date
    if (row.startDate) {
      const d = new Date(row.startDate);
      if (isNaN(d.getTime())) {
        issues.push({
          rowNumber:    rowNum,
          severity:     'error',
          field:        'startDate',
          issue:        'Invalid start date format',
          suggestion:   'Use YYYY-MM-DD format',
          autoFixable:  false,
          autoFixValue: null,
        });
        hasError = true;
      }
    }

    // Check dietary
    if (row.dietaryRestrictions) {
      const flags = row.dietaryRestrictions
        .split(',')
        .map(f => f.trim().toLowerCase());

      flags.forEach(flag => {
        if (flag &&
            !knownDietary.includes(flag)) {
          const mapping = dietaryMappings.find(
            m => m.original === flag
          );
          issues.push({
            rowNumber:    rowNum,
            severity:     'warning',
            field:        'dietary',
            issue:        `Unrecognized: "${flag}"`,
            suggestion:   mapping
              ? `Did you mean "${mapping.suggested}"?`
              : `Use one of: ${knownDietary.join(', ')}`,
            autoFixable:  !!mapping,
            autoFixValue: mapping?.suggested || null,
          });
        }
      });
    }

    if (hasError) {
      invalidRows++;
    } else {
      validRows++;
    }
  });

  const foundMappings = [];
  rows.forEach(row => {
    if (row.dietaryRestrictions) {
      const flags = row.dietaryRestrictions
        .split(',')
        .map(f => f.trim().toLowerCase());
      flags.forEach(flag => {
        const mapping = dietaryMappings.find(
          m => m.original === flag
        );
        if (mapping &&
            !foundMappings.find(
              m => m.original === flag
            )) {
          foundMappings.push(mapping);
        }
      });
    }
  });

  return {
    validRows,
    invalidRows,
    warnings: issues.filter(
      i => i.severity === 'warning'
    ).length,
    issues,
    dietaryMappings: foundMappings,
    summary: `${validRows} valid rows, ` +
             `${invalidRows} errors, ` +
             `${issues.filter(
               i => i.severity === 'warning'
             ).length} warnings`,
  };
}


/* ═══════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════ */

module.exports = router;