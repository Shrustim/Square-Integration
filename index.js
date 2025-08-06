require('dotenv/config');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Client, Environment } = require('square');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Square SDK client
// ─────────────────────────────────────────────────────────────
const client = new Client({
  environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

const { catalogApi, ordersApi, paymentsApi, checkoutApi } = client;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// ─────────────────────────────────────────────────────────────
// In-memory promo codes (for demo). Persist in DB in real apps.
// code -> { type: 'PERCENT'|'FIXED', value: number, name?: string }
// PERCENT: value=10 means 10% ; FIXED: value in currency's minor units
// ─────────────────────────────────────────────────────────────
const promoCodes = new Map();
 promoCodes.set("WELCOME10", {
    "code": "WELCOME10",
    "type": "PERCENT",
    "value": 10,
    "name": "Welcome 10%"
});

// Build a *seller-scoped* client per request using the seller's OAuth token.
// IMPORTANT: To collect app_fee_money, you MUST charge on behalf of the seller.
function buildSellerClient(sellerAccessToken) {
  if (!sellerAccessToken) throw new Error('sellerAccessToken missing (connected seller OAuth token required)');
  return new Client({
    environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
    accessToken: sellerAccessToken
  });
}

// Convenience: pull token from header or body
function getSellerToken(req) {
  // Prefer header so you can keep bodies clean
  return req.headers['x-seller-token'] || req.body?.sellerAccessToken;
}

// Reuse: how much is your platform fee?
function appFeeCents() {
  return Number(process.env.PLATFORM_APP_FEE_CENTS || 200);
}


// Helper: unify Square API error structure
function sqErr(e) {
  const details = e?.result?.errors || e?.errors || e?.response?.body?.errors || e?.message;
  return { error: true, details };
}

// Helper: fetch current order with latest version
async function getOrder(orderId) {
  try {
    const res = await ordersApi.retrieveOrder(orderId);
    return res.result.order;
  } catch (e) {
    throw sqErr(e);
  }
}

// Helper: make UpdateOrder with latest version (optimistic concurrency)
async function updateOrderWith(orderId, patchOrder, fieldsToClear = []) {
  const current = await getOrder(orderId);
  try {
    const res = await ordersApi.updateOrder(orderId, {
      order: { ...patchOrder, version: current.version, locationId: current.locationId || LOCATION_ID },
      fieldsToClear
    });
    return res.result.order;
  } catch (e) {
    throw sqErr(e);
  }
}
app.set('json replacer', (key, value) =>
  typeof value === 'bigint' ? value.toString() : value
);
// ─────────────────────────────────────────────────────────────
// 1) Create products (ITEM + ITEM_VARIATIONs)
// Body:
// {
//   "name":"T-Shirt",
//   "description":"Soft cotton",
//   "categoryId":"OPTIONAL_CATEGORY_ID",
//   "variations":[
//     {"name":"Small","price":1999,"currency":"USD","sku":"TS-S"},
//     {"name":"Large","price":2199,"currency":"USD","sku":"TS-L"}
//   ]
// }
// ─────────────────────────────────────────────────────────────
app.post('/api/catalog/items', async (req, res) => {
  try {
    const { name, description, categoryId, variations = [] } = req.body;

    if (!name || !variations.length) {
      return res.status(400).json({ error: 'name and at least one variation are required' });
    }

    const itemId = `#${uuidv4()}`; // temp client IDs (“#” required)
    const objects = [
      {
        type: 'ITEM',
        id: itemId,
        itemData: {
          name,
          description,
          categoryId,
        }
      },
      ...variations.map(v => ({
        type: 'ITEM_VARIATION',
        id: `#${uuidv4()}`,
        itemVariationData: {
          itemId,
          name: v.name,
          pricingType: 'FIXED_PRICING',
          priceMoney: v.price != null ? { amount: BigInt(v.price), currency: v.currency || 'USD' } : undefined,
          sku: v.sku
        }
      }))
    ];

    const resp = await catalogApi.batchUpsertCatalogObjects({
      idempotencyKey: uuidv4(),
      batches: [{ objects }]
    });

    res.json(resp.result);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 2) Get product list
// Query params: cursor, limit (optional)
// Uses SearchCatalogItems (items + variations, ready for shopping UIs)
// ─────────────────────────────────────────────────────────────
app.get('/api/catalog/items', async (req, res) => {
  try {
    const { cursor, limit } = req.query;
    const resp = await catalogApi.searchCatalogItems({
      cursor,
      limit: limit ? Number(limit) : undefined
    });
    res.json(resp.result);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 3) Promo codes (custom)
// 3a) Create promo code (admin)
// Body: { "code":"WELCOME10", "type":"PERCENT"|"FIXED", "value":10, "name":"Welcome 10%" }
// For FIXED, value is amount in minor units (e.g., 500 = $5.00)
// ─────────────────────────────────────────────────────────────
app.post('/api/promo-codes', (req, res) => {
  const { code, type, value, name } = req.body || {};
  if (!code || !['PERCENT', 'FIXED'].includes(type) || typeof value !== 'number') {
    return res.status(400).json({ error: 'code, type(PERCENT|FIXED), value required' });
  }
  promoCodes.set(code.toUpperCase(), { type, value, name: name || code.toUpperCase() });
  res.json({ ok: true, code: code.toUpperCase() });
});

// 3b) Validate promo code
app.get('/api/promo-codes/:code', (req, res) => {
  const data = promoCodes.get(req.params.code.toUpperCase());
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json({ code: req.params.code.toUpperCase(), ...data });
});

// ─────────────────────────────────────────────────────────────
// 4) Create cart (draft order)
// Body: { "locationId": "optional override" }
// Returns order (id to use for cart ops)
// ─────────────────────────────────────────────────────────────
app.post('/api/cart', async (req, res) => {
  try {
    const locationId = req.body?.locationId || LOCATION_ID;
    const resp = await ordersApi.createOrder({
      idempotencyKey: uuidv4(),
      order: { locationId, state: 'OPEN' }
    });
    res.json(resp.result.order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 5) Add line item to cart
// Body: { "variationId":"ITEM_VARIATION_OBJECT_ID", "quantity":2 }
// This uses catalog_object_id path so base price comes from Catalog.
// ─────────────────────────────────────────────────────────────
app.post('/api/cart/:orderId/line-items', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { variationId, quantity } = req.body || {};
    if (!variationId || !quantity) {
      return res.status(400).json({ error: 'variationId and quantity required' });
    }

    const order = await updateOrderWith(orderId, {
      lineItems: [
        {
          uid: uuidv4(),
          quantity: String(quantity),
          catalogObjectId: variationId
        }
      ]
    });

    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 6) Update quantity of an existing line item
// Body: { "quantity": 3 }
// Route param requires the line item UID (not the catalog id).
// ─────────────────────────────────────────────────────────────
app.put('/api/cart/:orderId/line-items/:lineItemUid', async (req, res) => {
  try {
    const { orderId, lineItemUid } = req.params;
    const { quantity } = req.body || {};
    if (!quantity) return res.status(400).json({ error: 'quantity required' });

    const current = await getOrder(orderId);
    const target = (current.lineItems || []).find(li => li.uid === lineItemUid);
    if (!target) return res.status(404).json({ error: 'line item uid not found' });

    // Replace that one LI with updated quantity
    const newItems = (current.lineItems || []).map(li =>
      li.uid === lineItemUid ? { uid: li.uid, quantity: String(quantity), catalogObjectId: li.catalogObjectId } : li
    );

    const order = await updateOrderWith(orderId, { lineItems: newItems });
    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 7) Remove a line item
// Square supports fields_to_clear with the LI UID path.
// ─────────────────────────────────────────────────────────────
app.delete('/api/cart/:orderId/line-items/:lineItemUid', async (req, res) => {
  try {
    const { orderId, lineItemUid } = req.params;
    // Clear by path: "line_items[UID]"
    const order = await updateOrderWith(orderId, {}, [`line_items[${lineItemUid}]`]);
    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 8) Apply discount
// A) By promo code: { "promoCode": "WELCOME10" }
// B) Direct: { "name":"Black Friday", "type":"PERCENT"|"FIXED", "value":10, "currency":"USD" }
// Adds an ORDER-level discount. For line-level, attach to lineItems[].discounts.
// ─────────────────────────────────────────────────────────────
app.post('/api/cart/:orderId/discounts', async (req, res) => {
  try {
    const { orderId } = req.params;
    let { promoCode, name, type, value, currency } = req.body || {};

    const order = await getOrder(orderId);
    const curr = currency || order?.totalMoney?.currency || 'USD';

    let discountObj = null;

    if (promoCode) {
      const pc = promoCodes.get(promoCode.toUpperCase());
      if (!pc) return res.status(404).json({ error: 'Invalid promo code' });

      if (pc.type === 'PERCENT') {
        discountObj = {
          uid: uuidv4(),
          name: pc.name || promoCode.toUpperCase(),
          percentage: String(pc.value),
          scope: 'ORDER'
        };
      } else {
        discountObj = {
          uid: uuidv4(),
          name: pc.name || promoCode.toUpperCase(),
          amountMoney: { amount: Number(pc.value), currency: curr },
          scope: 'ORDER'
        };
      }
    } else {
      if (!name || !['PERCENT', 'FIXED'].includes(type) || typeof value !== 'number') {
        return res.status(400).json({ error: 'promoCode or (name,type,value) required' });
      }
      discountObj = (type === 'PERCENT')
        ? { uid: uuidv4(), name, percentage: String(value), scope: 'ORDER' }
        : { uid: uuidv4(), name, amountMoney: { amount: Number(value), currency: curr }, scope: 'ORDER' };
    }

    // append to any existing discounts
    const updated = await updateOrderWith(orderId, {
      discounts: [ ...(order.discounts || []), discountObj ]
    });

    res.json(updated);
  } catch (e) {
    console.error('apply discount error', e);
    const details = e?.result?.errors || e?.details || e?.message;
    res.status(500).json({ error: true, details });
  }
});


app.delete('/api/cart/:orderId/discounts', async (req, res) => {
  try {
    const { orderId } = req.params;
    const updated = await updateOrderWith(orderId, {}, ['discounts']); // clear entire discounts array
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: true, details: e?.result?.errors || e?.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 9) Calculate totals (tax/discount rules)
// Returns calculated order; does not persist calculation.
// ─────────────────────────────────────────────────────────────
app.post('/api/orders/:orderId/calculate', async (req, res) => {
  try {
    const order = await getOrder(req.params.orderId);
    const resp = await ordersApi.calculateOrder({ order });
    res.json(resp.result.order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 10) Get order (debug/helper)
// ─────────────────────────────────────────────────────────────
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const order = await getOrder(req.params.orderId);
    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 11) Create payment (on-site checkout flow)
// Body: { "orderId":"...", "sourceId":"TOKEN_FROM_WEB_PAYMENTS_SDK" }
// Best practice: amount from Square order; use idempotencyKey.
// ─────────────────────────────────────────────────────────────
// app.post('/api/checkout/payment', async (req, res) => {
//   try {
//     const { orderId, sourceId, autocomplete = true, note } = req.body || {};
//     if (!orderId || !sourceId) return res.status(400).json({ error: 'orderId and sourceId required' });

//     const order = await getOrder(orderId);
//     if (!order?.totalMoney?.amount) {
//       return res.status(400).json({ error: 'Order has no total to charge' });
//     }

//     const resp = await paymentsApi.createPayment({
//       idempotencyKey: uuidv4(),
//       sourceId,                      // token from Web Payments SDK (frontend)
//       amountMoney: order.totalMoney, // charge exact cart total
//       orderId,
//       locationId: order.locationId || LOCATION_ID,
//       autocomplete,
//       note
//     });

//     res.json(resp.result.payment);
//   } catch (e) {
//     res.status(500).json(sqErr(e));
//   }
// });

// ─────────────────────────────────────────────────────────────
// 12) Hosted payment link (Checkout API)
// Body: { "orderId":"..." }
// Note: Payment Links cannot attach an existing order by ID,
// so we reconstruct an equivalent order body and let Square
// create it for the link.
// ─────────────────────────────────────────────────────────────
// app.post('/api/checkout/links', async (req, res) => {
//   try {
//     const { orderId } = req.body || {};
//     if (!orderId) return res.status(400).json({ error: 'orderId required' });

//     const order = await getOrder(orderId);
//     const lineItems = (order.lineItems || []).map(li => {
//       // For quick_pay we need name and base price; if not present, fall back.
//       const name = li.name || 'Item';
//       const quantity = li.quantity || '1';
//       // If base price not available (e.g., from catalog pricing), use totalMoney/quantity as approximation
//       const price = li.basePriceMoney?.amount
//         ?? (li.totalMoney?.amount && BigInt(li.totalMoney.amount) / BigInt(quantity));
//       if (!price) throw { error: true, details: 'Cannot infer line item price for payment link.' };
//       return {
//         name,
//         quantity,
//         basePriceMoney: { amount: BigInt(price), currency: (li.basePriceMoney?.currency || order.totalMoney?.currency || 'USD') }
//       };
//     });

//     const resp = await checkoutApi.createPaymentLink({
//       idempotencyKey: uuidv4(),
//       checkoutOptions: {
//         redirectUrl: 'https://example.com/thanks' // replace for your app
//       },
//       order: {
//         locationId: order.locationId || LOCATION_ID,
//         lineItems
//       }
//     });

//     res.json({ url: resp.result.paymentLink?.url, paymentLink: resp.result.paymentLink });
//   } catch (e) {
//     res.status(500).json(sqErr(e));
//   }
// });

app.post('/api/checkout/links', async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const sellerAccessToken = getSellerToken(req);               // <-- seller token
    const sellerClient = buildSellerClient(sellerAccessToken);
    const { ordersApi: sellerOrders, checkoutApi: sellerCheckout } = sellerClient;

    const order = await (async () => {
      const resp = await sellerOrders.retrieveOrder(orderId);    // fetch via seller
      return resp.result.order;
    })();

    // Build minimal order body for Payment Link (quick pay)
    const lineItems = (order.lineItems || []).map(li => {
      const name = li.name || 'Item';
      const quantity = li.quantity || '1';

      const price = li.basePriceMoney?.amount
        ?? (li.totalMoney?.amount && BigInt(li.totalMoney.amount) / BigInt(quantity || '1'));
      if (!price) throw { error: true, details: 'Cannot infer line item price for payment link.' };

      return {
        name,
        quantity,
        basePriceMoney: {
          amount: BigInt(price),
          currency: li.basePriceMoney?.currency || order.totalMoney?.currency || 'USD'
        }
      };
    });

    const currency = order.totalMoney?.currency || 'USD';

    const resp = await sellerCheckout.createPaymentLink({
      idempotencyKey: uuidv4(),
      order: {
        locationId: order.locationId || LOCATION_ID,
        lineItems
      },
      checkoutOptions: {
        redirectUrl: 'https://example.com/thanks',
        // <-- $2.00 application fee to your platform
        appFeeMoney: { amount: appFeeCents(), currency }
      }
    });

    res.json({ url: resp.result.paymentLink?.url, paymentLink: resp.result.paymentLink });
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});


// ─────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.send('Square E-commerce API (Sandbox) is running'));
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
