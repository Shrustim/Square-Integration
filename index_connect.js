// server.js
require('dotenv/config');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Client, Environment } = require('square');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Main (platform) Square client (for your own account)
// ─────────────────────────────────────────────────────────────
const mainClient = new Client({
  environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
  accessToken: process.env.SQUARE_ACCESS_TOKEN, // MAIN platform account token
});
const { ordersApi: mainOrdersApi } = mainClient;
const MAIN_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
// ─────────────────────────────────────────────────────────────
// In-memory connected seller credentials (set once, used by all routes)
// ─────────────────────────────────────────────────────────────
const CONNECTED = {
  accessToken:  sellerAccessToken
  locationId: sellerLocationId
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function buildSellerClient(accessToken) {
  if (!accessToken) throw new Error('Connected seller access token not set. Call /api/set first.');
  return new Client({
    environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
    accessToken
  });
}

function appFeeCents() {
  return Number(process.env.PLATFORM_APP_FEE_CENTS || 200); // default $2.00
}

function sqErr(e) {
  const details = e?.result?.errors || e?.errors || e?.response?.body?.errors || e?.message;
  return { error: true, details };
}

// BigInt -> string for JSON responses
app.set('json replacer', (key, value) => (typeof value === 'bigint' ? value.toString() : value));

// ─────────────────────────────────────────────────────────────
// Demo promo codes (optional)
// ─────────────────────────────────────────────────────────────
const promoCodes = new Map();
promoCodes.set('WELCOME10', { code: 'WELCOME10', type: 'PERCENT', value: 10, name: 'Welcome 10%' });

// ─────────────────────────────────────────────────────────────
// Seller-aware order helpers
// ─────────────────────────────────────────────────────────────
async function getOrder(orderId) {
  try {
    if (!CONNECTED.accessToken) {
      // fallback – only if you created order on main (not recommended)
      const res = await mainOrdersApi.retrieveOrder(orderId);
      return res.result.order;
    }
    const seller = buildSellerClient(CONNECTED.accessToken);
    const { ordersApi } = seller;
    const res = await ordersApi.retrieveOrder(orderId);
    return res.result.order;
  } catch (e) {
    throw sqErr(e);
  }
}

async function updateOrderWith(orderId, patchOrder, fieldsToClear = []) {
  const current = await getOrder(orderId);
  const locationId = current.locationId || CONNECTED.locationId || MAIN_LOCATION_ID;
  try {
    if (!CONNECTED.accessToken) {
      const res = await mainOrdersApi.updateOrder(orderId, {
        order: { ...patchOrder, version: current.version, locationId },
        fieldsToClear
      });
      return res.result.order;
    }
    const seller = buildSellerClient(CONNECTED.accessToken);
    const { ordersApi } = seller;
    const res = await ordersApi.updateOrder(orderId, {
      order: { ...patchOrder, version: current.version, locationId },
      fieldsToClear
    });
    return res.result.order;
  } catch (e) {
    throw sqErr(e);
  }
}

// ─────────────────────────────────────────────────────────────
// 0) Set/Get connected seller credentials (once)
// ─────────────────────────────────────────────────────────────
app.post('/api/set', (req, res) => {
  const { sellerAccessToken, sellerLocationId } = req.body || {};
  if (!sellerAccessToken) return res.status(400).json({ error: 'sellerAccessToken required' });
  CONNECTED.accessToken = sellerAccessToken;
  CONNECTED.locationId = sellerLocationId || CONNECTED.locationId || MAIN_LOCATION_ID;
  res.json({ ok: true });
});

app.get('/api/get', (req, res) => {
  const masked = CONNECTED.accessToken
    ? CONNECTED.accessToken.slice(0, 6) + '...' + CONNECTED.accessToken.slice(-4)
    : null;
  res.json({ sellerAccessToken: masked, sellerLocationId: CONNECTED.locationId || null });
});

// ─────────────────────────────────────────────────────────────
// 1) Create products in CONNECTED seller account
// Body: { name, description?, categoryId?, variations:[{name,price,currency,sku}] }
// ─────────────────────────────────────────────────────────────
app.post('/api/catalog/items', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const { name, description, categoryId, variations = [] } = req.body || {};
    if (!name || !variations.length) return res.status(400).json({ error: 'name and variations[] required' });

    const seller = buildSellerClient(CONNECTED.accessToken);
    const { catalogApi } = seller;

    const itemId = `#${uuidv4()}`;
    const objects = [
      { type: 'ITEM', id: itemId, itemData: { name, description, categoryId } },
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

// 2) List products from CONNECTED seller
app.get('/api/catalog/items', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const { cursor, limit } = req.query;
    const seller = buildSellerClient(CONNECTED.accessToken);
    const { catalogApi } = seller;
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
// 3) Create cart (draft order) on CONNECTED seller
// Body: {}
// ─────────────────────────────────────────────────────────────
app.post('/api/cart', async (_req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });

    const seller = buildSellerClient(CONNECTED.accessToken);
    const { ordersApi } = seller;

    const resp = await ordersApi.createOrder({
      idempotencyKey: uuidv4(),
      order: { locationId: CONNECTED.locationId || MAIN_LOCATION_ID, state: 'OPEN' }
    });
    res.json(resp.result.order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// 4) Add line item to seller cart
app.post('/api/cart/:orderId/line-items', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const { orderId } = req.params;
    const { variationId, quantity } = req.body || {};
    if (!variationId || !quantity) return res.status(400).json({ error: 'variationId and quantity required' });

    const order = await updateOrderWith(orderId, {
      lineItems: [{ uid: uuidv4(), quantity: String(quantity), catalogObjectId: variationId }]
    });
    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// 5) Update quantity
app.put('/api/cart/:orderId/line-items/:lineItemUid', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const { orderId, lineItemUid } = req.params;
    const { quantity } = req.body || {};
    if (!quantity) return res.status(400).json({ error: 'quantity required' });

    const current = await getOrder(orderId);
    const target = (current.lineItems || []).find(li => li.uid === lineItemUid);
    if (!target) return res.status(404).json({ error: 'line item uid not found' });

    const newItems = (current.lineItems || []).map(li =>
      li.uid === lineItemUid ? { uid: li.uid, quantity: String(quantity), catalogObjectId: li.catalogObjectId } : li
    );

    const order = await updateOrderWith(orderId, { lineItems: newItems });
    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// 6) Remove line item
app.delete('/api/cart/:orderId/line-items/:lineItemUid', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const { orderId, lineItemUid } = req.params;
    const order = await updateOrderWith(orderId, {}, [`line_items[${lineItemUid}]`]);
    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// 7) Apply discount (order-level)
app.post('/api/cart/:orderId/discounts', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const { orderId } = req.params;
    let { promoCode, name, type, value, currency } = req.body || {};

    const order = await getOrder(orderId);
    const curr = currency || order?.totalMoney?.currency || 'USD';

    let discountObj = null;
    if (promoCode) {
      const pc = promoCodes.get(promoCode.toUpperCase());
      if (!pc) return res.status(404).json({ error: 'Invalid promo code' });
      discountObj = (pc.type === 'PERCENT')
        ? { uid: uuidv4(), name: pc.name || promoCode.toUpperCase(), percentage: String(pc.value), scope: 'ORDER' }
        : { uid: uuidv4(), name: pc.name || promoCode.toUpperCase(), amountMoney: { amount: Number(pc.value), currency: curr }, scope: 'ORDER' };
    } else {
      if (!name || !['PERCENT', 'FIXED'].includes(type) || typeof value !== 'number')
        return res.status(400).json({ error: 'promoCode or (name,type,value) required' });
      discountObj = (type === 'PERCENT')
        ? { uid: uuidv4(), name, percentage: String(value), scope: 'ORDER' }
        : { uid: uuidv4(), name, amountMoney: { amount: Number(value), currency: curr }, scope: 'ORDER' };
    }

    const updated = await updateOrderWith(orderId, {
      discounts: [ ...(order.discounts || []), discountObj ]
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

app.delete('/api/cart/:orderId/discounts', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const { orderId } = req.params;
    const updated = await updateOrderWith(orderId, {}, ['discounts']);
    res.json(updated);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// 8) Calculate totals
app.post('/api/orders/:orderId/calculate', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });

    const seller = buildSellerClient(CONNECTED.accessToken);
    const { ordersApi } = seller;

    const current = await getOrder(req.params.orderId);
    const resp = await ordersApi.calculateOrder({ order: current });
    res.json(resp.result.order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// 9) Get order
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });
    const order = await getOrder(req.params.orderId);
    res.json(order);
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
// 10) Create Payment Link on CONNECTED seller with $2 to MAIN
// Body: {}  (uses in-memory CONNECTED.*)
// ─────────────────────────────────────────────────────────────
app.post('/api/checkout/links', async (_req, res) => {
  try {
    if (!CONNECTED.accessToken) return res.status(400).json({ error: 'Set seller with /api/set' });

    const seller = buildSellerClient(CONNECTED.accessToken);
    const { ordersApi, checkoutApi } = seller;

    // In most cases you’ll pass orderId; creating here for demo simplicity:
    // If you already have an orderId, change this route to accept it and retrieve instead.
    // For now, expect client to send an existing orderId via query (?orderId=...)
    // but we’ll support both.
    const orderId = _req.query.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId query param required' });

    const r = await ordersApi.retrieveOrder(orderId);
    const order = r.result.order;

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
    const locId = order.locationId || CONNECTED.locationId || MAIN_LOCATION_ID;

    const resp = await checkoutApi.createPaymentLink({
      idempotencyKey: uuidv4(),
      order: { locationId: locId, lineItems },
      checkoutOptions: {
        redirectUrl: 'https://example.com/thanks',
        appFeeMoney: { amount: appFeeCents(), currency } // $2 goes to your MAIN account
      }
    });

    res.json({ url: resp.result.paymentLink?.url, paymentLink: resp.result.paymentLink });
  } catch (e) {
    res.status(500).json(sqErr(e));
  }
});

// ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('Square E-commerce API (Sandbox) is running'));
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
