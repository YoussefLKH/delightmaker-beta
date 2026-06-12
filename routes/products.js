/* ═══════════════════════════════════════════════════
   DELIGHTMAKER — PRODUCTS ROUTES
   Bakery menu/product management
   All routes: /api/products/...

   Stripe integration:
   - Creating a product → auto-creates Stripe Product + Price
   - Editing price     → archives old Price, creates new one
   - Deleting product  → archives Stripe Product
   ═══════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  db,
  COLLECTIONS,
  ROLES,
  serverTimestamp,
  authenticate,
  requireBaker,
  requireAdmin,
} = require('../firebase/config');

function getStripe() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}


/* ═══════════════════════════════════════════════════
   HELPER — create Stripe product + price
   Returns { stripeProductId, stripePriceId }
   ═══════════════════════════════════════════════════ */

async function createStripeProduct(name, description, priceCAD, bakeryName) {
  const stripe = getStripe();

  const product = await stripe.products.create({
    name,
    description: description || undefined,
    metadata: { bakery: bakeryName || '', platform: 'delightmaker' },
  });

  const price = await stripe.prices.create({
    product:    product.id,
    unit_amount: Math.round(priceCAD * 100), // cents
    currency:   'cad',
  });

  return {
    stripeProductId: product.id,
    stripePriceId:   price.id,
  };
}


/* ═══════════════════════════════════════════════════
   HELPER — archive old price, create new one
   Called when baker edits the price of an item
   ═══════════════════════════════════════════════════ */

async function updateStripePrice(stripeProductId, oldPriceId, newPriceCAD) {
  const stripe = getStripe();

  // Archive old price (Stripe doesn't allow editing prices)
  if (oldPriceId) {
    await stripe.prices.update(oldPriceId, { active: false })
      .catch(err => console.warn('⚠️ Could not archive old price:', err.message));
  }

  // Create new price on same product
  const price = await stripe.prices.create({
    product:     stripeProductId,
    unit_amount: Math.round(newPriceCAD * 100),
    currency:    'cad',
  });

  return price.id;
}


/* ═══════════════════════════════════════════════════
   GET /api/products/:bakeryId
   Get all active products for a bakery
   Public-ish: requires auth (any role)
   ═══════════════════════════════════════════════════ */

router.get('/:bakeryId',
  authenticate,
  async (req, res) => {
    try {
      const { bakeryId } = req.params;

      // Baker can only read their own products
      if (req.user.role === ROLES.BAKER &&
          req.user.bakerId !== bakeryId) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      const snap = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakeryId)
        .collection('products')
        .where('active', '==', true)
        .get();

      const products = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
      }));

      return res.json({ success: true, products });

    } catch (err) {
      console.error('GET /api/products/:bakeryId error:', err);
      return res.status(500).json({ error: 'Failed to load products' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   POST /api/products/:bakeryId
   Create a new product + Stripe Product + Price
   Baker only (their own bakery)
   ═══════════════════════════════════════════════════ */

router.post('/:bakeryId',
  authenticate,
  requireBaker,
  async (req, res) => {
    try {
      const { bakeryId } = req.params;

      // Must be their own bakery
      if (req.user.bakerId !== bakeryId) {
        return res.status(403).json({
          error: 'You can only add products to your own bakery'
        });
      }

      const { name, description, price, category } = req.body;

      // Validate
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Product name is required' });
      }
      if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
        return res.status(400).json({ error: 'Valid price is required' });
      }

      const priceNum = parseFloat(parseFloat(price).toFixed(2));

      // Fetch bakery name for Stripe metadata
      const bakeryDoc = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakeryId)
        .get();

      const bakeryName = bakeryDoc.exists
        ? bakeryDoc.data().name || bakeryId
        : bakeryId;

      // Create in Stripe
      let stripeProductId = null;
      let stripePriceId   = null;

      try {
        const stripeResult = await createStripeProduct(
          name.trim(),
          description?.trim() || null,
          priceNum,
          bakeryName
        );
        stripeProductId = stripeResult.stripeProductId;
        stripePriceId   = stripeResult.stripePriceId;
        console.log(`✅ Stripe product created: ${stripeProductId}`);
      } catch (stripeErr) {
        console.error('❌ Stripe product creation failed:', stripeErr.message);
        // Don't hard-fail — save to Firestore without Stripe IDs
        // Can be re-synced later
      }

      // Save to Firestore
      const productData = {
        name:        name.trim(),
        description: description?.trim() || '',
        price:       priceNum,
        category:    category?.trim() || 'Other',
        active:      true,
        bakeryId,
        bakeryName,
        stripeProductId,
        stripePriceId,
        createdBy:  req.user.uid,
        createdAt:  serverTimestamp(),
        updatedAt:  serverTimestamp(),
      };

      const docRef = await db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakeryId)
        .collection('products')
        .add(productData);

      console.log(`✅ Product saved: ${docRef.id} for bakery ${bakeryId}`);

      return res.status(201).json({
        success: true,
        product: { id: docRef.id, ...productData, createdAt: new Date().toISOString() },
        stripeProductId,
        stripePriceId,
      });

    } catch (err) {
      console.error('POST /api/products/:bakeryId error:', err);
      return res.status(500).json({ error: 'Failed to create product' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   PATCH /api/products/:bakeryId/:productId
   Edit a product (name, description, price, category)
   Baker only (their own bakery)
   ═══════════════════════════════════════════════════ */

router.patch('/:bakeryId/:productId',
  authenticate,
  requireBaker,
  async (req, res) => {
    try {
      const { bakeryId, productId } = req.params;

      if (req.user.bakerId !== bakeryId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const productRef = db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakeryId)
        .collection('products')
        .doc(productId);

      const productDoc = await productRef.get();
      if (!productDoc.exists) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const existing = productDoc.data();
      const { name, description, price, category } = req.body;

      const updates = { updatedAt: serverTimestamp() };
      if (name !== undefined)        updates.name        = name.trim();
      if (description !== undefined) updates.description = description.trim();
      if (category !== undefined)    updates.category    = category.trim();

      // Price change → new Stripe price
      if (price !== undefined) {
        const priceNum = parseFloat(parseFloat(price).toFixed(2));
        if (isNaN(priceNum) || priceNum <= 0) {
          return res.status(400).json({ error: 'Valid price is required' });
        }

        if (priceNum !== existing.price && existing.stripeProductId) {
          try {
            const newPriceId = await updateStripePrice(
              existing.stripeProductId,
              existing.stripePriceId,
              priceNum
            );
            updates.stripePriceId = newPriceId;
            console.log(`✅ Stripe price updated: ${newPriceId}`);
          } catch (stripeErr) {
            console.error('❌ Stripe price update failed:', stripeErr.message);
          }
        }

        updates.price = priceNum;
      }

      await productRef.update(updates);

      return res.json({ success: true, updates });

    } catch (err) {
      console.error('PATCH /api/products/:bakeryId/:productId error:', err);
      return res.status(500).json({ error: 'Failed to update product' });
    }
  }
);


/* ═══════════════════════════════════════════════════
   DELETE /api/products/:bakeryId/:productId
   Hard-delete from Firestore + archive Stripe product
   Baker only (their own bakery)
   ═══════════════════════════════════════════════════ */

router.delete('/:bakeryId/:productId',
  authenticate,
  requireBaker,
  async (req, res) => {
    try {
      const { bakeryId, productId } = req.params;

      if (req.user.bakerId !== bakeryId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const productRef = db
        .collection(COLLECTIONS.BAKERIES)
        .doc(bakeryId)
        .collection('products')
        .doc(productId);

      const productDoc = await productRef.get();
      if (!productDoc.exists) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const existing = productDoc.data();

      // Archive in Stripe
      if (existing.stripeProductId) {
        try {
          const stripe = getStripe();
          await stripe.products.update(existing.stripeProductId, {
            active: false
          });
          console.log(`✅ Stripe product archived: ${existing.stripeProductId}`);
        } catch (stripeErr) {
          console.error('❌ Stripe archive failed:', stripeErr.message);
        }
      }

      // Hard-delete from Firestore (the Stripe product is archived above
      // so historical orders that reference it still resolve in Stripe).
      await productRef.delete();

      return res.json({ success: true, message: 'Product removed' });

    } catch (err) {
      console.error('DELETE /api/products/:bakeryId/:productId error:', err);
      return res.status(500).json({ error: 'Failed to delete product' });
    }
  }
);


module.exports = router;
