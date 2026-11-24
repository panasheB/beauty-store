require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const E = {
    ECOCASH_BASE_URL: 'https://developers.ecocash.co.zw/sandbox/payment/v1',
    ECOCASH_USERNAME: 'sbx_cfb1ea4fce06',
    ECOCASH_PASSWORD: 'h$DhZbtMNbDjdYGgG6yj',

    MERCHANT_CODE: '001535',
    MERCHANT_PIN: '0000',
    MERCHANT_NUMBER: '263771234567',
    TERMINAL_ID: 'SANDBOX01',
    LOCATION: 'Harare',
    MERCHANT_NAME: 'EcoCash Sandbox Merchant',
    SUPER_MERCHANT_NAME: 'EcoCash Sandbox',

    ADMIN_KEY: 'change-me'
};
const BASE = (E.ECOCASH_BASE_URL || 'https://developers.ecocash.co.zw/sandbox/payment/v1').replace(/\/+$/, '');
const AUTH = 'Basic ' + Buffer.from(`${E.ECOCASH_USERNAME}:${E.ECOCASH_PASSWORD}`).toString('base64');
const ADMIN_KEY = E.ADMIN_KEY || '';

// ---------- Catalogue (prices live on the server so they can't be tampered with) ----------
const PRODUCTS = [
  { id: 'serum-glow',   name: 'Glow Vitamin C Serum',     note: '30 ml',  price: 18.5, shape: 'dropper', color: '#E8A33D' },
  { id: 'cleanser-oat', name: 'Oat Milk Cleanser',        note: '150 ml', price: 9.0,  shape: 'tube',    color: '#D9C7A3' },
  { id: 'cream-shea',   name: 'Whipped Shea Body Butter', note: '200 g',  price: 12.0, shape: 'jar',     color: '#C98B6B' },
  { id: 'lip-rose',     name: 'Rosewood Lipstick',        note: 'Satin',  price: 7.5,  shape: 'stick',   color: '#B23A5A' },
  { id: 'lip-plum',     name: 'Plum Velvet Lipstick',     note: 'Matte',  price: 7.5,  shape: 'stick',   color: '#6B2D52' },
  { id: 'oil-marula',   name: 'Marula Face Oil',          note: '30 ml',  price: 15.0, shape: 'dropper', color: '#9BB07A' },
  { id: 'sun-spf50',    name: 'Sheer SPF 50 Sunscreen',   note: '50 ml',  price: 11.0, shape: 'tube',    color: '#F2C879' },
  { id: 'mask-clay',    name: 'Rhassoul Clay Mask',       note: '100 g',  price: 10.0, shape: 'jar',     color: '#A8846A' }
];

// ---------- Tiny JSON file "database" ----------
const DB_FILE = path.join(__dirname, 'data', 'orders.json');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
let orders = [];
try { orders = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { orders = []; }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
const findOrder = (id) => orders.find((o) => o.id === id);

// ---------- EcoCash helpers ----------
const newCorrelator = () => String(Date.now()) + crypto.randomInt(100, 999);

function basePayload(correlator, referenceCode, amount, phone) {
  return {
    clientCorrelator: correlator,
    referenceCode,
    tranType: 'MER',
    endUserId: phone, // the customer's EcoCash number -> they get the PIN prompt
    paymentAmount: {
      charginginformation: { amount, currency: 'USD', description: 'Beauty store online payment' },
      chargeMetaData: { channel: 'WEB', purchaseCategoryCode: 'Online Payment', onBeHalfOf: E.SUPER_MERCHANT_NAME || 'EcoCash Sandbox' }
    },
    merchantCode: E.MERCHANT_CODE || '001535',
    merchantPin: E.MERCHANT_PIN || '0000',
    merchantNumber: E.MERCHANT_NUMBER || '263771234567',
    countryCode: 'ZW',
    terminalID: E.TERMINAL_ID || 'SANDBOX01',
    location: E.LOCATION || 'Harare',
    superMerchantName: E.SUPER_MERCHANT_NAME || 'EcoCash Sandbox',
    merchantName: E.MERCHANT_NAME || 'EcoCash Sandbox Merchant',
    remarks: 'Beauty store order'
  };
}

async function ecocash(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, httpStatus: res.status, json };
}

// Find a key anywhere in a response (response shapes can be nested)
function deepFind(obj, regex) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (regex.test(k) && (typeof v === 'string' || typeof v === 'number')) return String(v);
    const inner = deepFind(v, regex);
    if (inner !== undefined) return inner;
  }
}

// Map whatever EcoCash says to PAID / FAILED / PENDING
function interpret(resp) {
  const word = (deepFind(resp.json, /^(transactionOperationStatus|transactionStatus|status)$/i) || '').toUpperCase();
  if (/(COMPLETED|SUCCESS|CHARGED|PAID|APPROVED)/.test(word)) return 'PAID';
  if (/(FAIL|DECLIN|CANCEL|REJECT|TIMEOUT|TIMED|EXPIRED|DENIED|INSUFFICIENT|ERROR)/.test(word)) return 'FAILED';
  if (!resp.ok && resp.httpStatus >= 400 && resp.httpStatus < 500 && !word) return 'FAILED';
  return 'PENDING';
}

function normalisePhone(input) {
  let p = String(input || '').replace(/[\s+()-]/g, '');
  if (p.startsWith('0')) p = '263' + p.slice(1);
  return /^263\d{9}$/.test(p) ? p : null;
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', (_req, res) => res.json(PRODUCTS));

// 1) CHARGE — customer gets a PIN prompt on their phone
app.post('/api/checkout', async (req, res) => {
  try {
    const phone = normalisePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid EcoCash number, e.g. 0771234567.' });

    const items = [];
    let total = 0;
    for (const line of req.body.items || []) {
      const p = PRODUCTS.find((x) => x.id === line.id);
      const qty = Math.min(20, Math.max(1, parseInt(line.qty, 10) || 0));
      if (!p) continue;
      items.push({ id: p.id, name: p.name, price: p.price, qty });
      total += p.price * qty;
    }
    if (!items.length) return res.status(400).json({ error: 'Your bag is empty.' });
    total = Math.round(total * 100) / 100;

    const id = newCorrelator();
    const payload = basePayload(id, `ORD_${id}`, total, phone);
    const r = await ecocash('POST', `${BASE}/transactions/amount/`, payload);
    console.log('[charge]', id, r.httpStatus, JSON.stringify(r.json));

   const initialStatus = interpret(r);

const order = {
    id,
    phone,
    items,
    total,
    status: 'PENDING',
    initialChargeStatus: initialStatus,
    ecocashReference: deepFind(r.json, /ecocashReference/i) || null,
    createdAt: new Date().toISOString(),
    chargeResponse: r.json
};

orders.unshift(order);
save();

console.log('[charge]', id, 'Initial response:', initialStatus);

res.json({
    orderId: id,
    status: 'PENDING',
    total,
    message: 'Payment initiated. Please check your phone and enter your EcoCash PIN.'
});

} catch (e) {
    console.error(e);

    res.json({
        status: 'PENDING',
        message: 'Please check your phone and enter your EcoCash PIN.'
    });
}
});

// 2) TRANSACTION LOOKUP — the page polls this until the customer has entered their PIN
// app.get('/api/orders/:id/status', async (req, res) => {
//   const order = findOrder(req.params.id);
//   if (!order) return res.status(404).json({ error: 'Order not found.' });
//   if (order.status === 'PENDING') {
//     try {
//       const r = await ecocash('GET', `${BASE}/transactions/amount/${order.id}`);
//       const next = interpret(r);
//       order.lookupResponse = r.json;
//       order.ecocashReference = order.ecocashReference || deepFind(r.json, /ecocashReference/i) || null;
//       if (next !== 'PENDING') order.status = next;
//       save();
//     } catch (e) { console.error(e); }
//   }
//   res.json({ orderId: order.id, status: order.status, total: order.total });
// });



app.get('/api/orders/:id/status', async (req, res) => {
    const order = findOrder(req.params.id);

    if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
    }

    if (order.status === 'PENDING') {
        try {
            const r = await ecocash(
                'GET',
                `${BASE}/transactions/amount/${order.id}`
            );

            const next = interpret(r);

            order.lookupResponse = r.json;

            order.ecocashReference =
                order.ecocashReference ||
                deepFind(r.json, /ecocashReference/i) ||
                null;

            if (next !== 'PENDING') {
                order.status = next;
            }

            save();

            console.log('[poll]', order.id, 'Status:', order.status);

        } catch (e) {
            console.error('[poll error]', e);
        }
    }

    res.json({
        orderId: order.id,
        status: order.status,
        total: order.total
    });
});
// ---------- Admin ----------
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || '';
  const ok = ADMIN_KEY && key.length === ADMIN_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
  if (!ok) return res.status(401).json({ error: 'Wrong admin key.' });
  next();
}

app.get('/api/admin/orders', requireAdmin, (_req, res) => res.json(orders));

// Re-check an order with EcoCash
app.post('/api/admin/orders/:id/refresh', requireAdmin, async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const r = await ecocash('GET', `${BASE}/transactions/amount/${order.id}`);
  order.lookupResponse = r.json;
  order.ecocashReference = order.ecocashReference || deepFind(r.json, /ecocashReference/i) || null;
  const next = interpret(r);
  if (order.status === 'PENDING' && next !== 'PENDING') order.status = next;
  save(); res.json(order);
});

// 3) REFUND
app.post('/api/admin/orders/:id/refund', requireAdmin, async (req, res) => {
  try {
    const order = findOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'PAID') return res.status(400).json({ error: `Only PAID orders can be refunded (this one is ${order.status}).` });

    const original = (req.body.originalEcocashReference || order.ecocashReference || '').trim();
    if (!original) return res.status(400).json({ error: 'No EcoCash reference stored for this order. Enter it manually.' });

    const rid = newCorrelator();
    const payload = { ...basePayload(rid, `REF_${order.id}`, order.total, order.phone), originalEcocashReference: original };
    const r = await ecocash('POST', `${BASE}/transactions/refund/`, payload);
    console.log('[refund]', order.id, r.httpStatus, JSON.stringify(r.json));

    order.refundResponse = r.json;
    const result = interpret(r);
    if (result === 'PAID') { order.status = 'REFUNDED'; order.refundedAt = new Date().toISOString(); }
    save();
    if (result === 'FAILED') return res.status(402).json({ error: 'EcoCash rejected the refund.', details: r.json });
    res.json(order);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not reach EcoCash.' });
  }
});

const port = E.PORT || 3000;
app.listen(port, () => console.log(`Store running on http://localhost:${port}  (admin: /admin.html)`));
