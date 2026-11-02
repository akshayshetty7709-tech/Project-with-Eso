'use strict';

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const SERVICE = 'order-service';
const PORT = parseInt(process.env.PORT || '3003', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret';
const RESTAURANT_URL = process.env.RESTAURANT_SERVICE_URL || 'http://localhost:3002';
const PAYMENT_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3004';
const METHODS = ['COD', 'UPI', 'CARD'];
const HTTP_TIMEOUT_MS = 5000;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'orderdb',
  user: process.env.DB_USER || 'slhadmin',
  password: process.env.DB_PASSWORD || 'slhpassword',
  max: 10,
});

let ready = false;

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, method: req.method, path: req.url }));
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'UP', service: SERVICE }));
app.get('/ready', async (_req, res) => {
  if (!ready) return res.status(503).json({ status: 'STARTING' });
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'READY' });
  } catch (_e) {
    return res.status(503).json({ status: 'DB_UNAVAILABLE' });
  }
});

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

async function loadOrder(orderId, userId) {
  const o = await pool.query(
    `SELECT id, user_id, restaurant_id, total_amount::float AS total_amount, status,
            payment_method, payment_txn, delivery_address, created_at, updated_at
     FROM orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  if (!o.rows[0]) return null;
  const items = await pool.query(
    `SELECT menu_item_id, name, unit_price::float AS unit_price, quantity
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  return { ...o.rows[0], items: items.rows };
}

// ---------- place an order ----------
app.post('/api/orders', authenticate, async (req, res) => {
  const userId = Number(req.auth.sub);
  const { restaurantId, items, paymentMethod, deliveryAddress } = req.body || {};
  const method = paymentMethod || 'COD';

  if (!Number.isInteger(Number(restaurantId)) || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'restaurantId and a non-empty items array are required' });
  }
  if (!METHODS.includes(method)) {
    return res.status(400).json({ error: `paymentMethod must be one of ${METHODS.join(', ')}` });
  }

  // 1) Re-price every item from the restaurant-service (never trust prices sent by the browser)
  const priced = [];
  let total = 0;
  try {
    for (const it of items) {
      const qty = Number(it.quantity);
      if (!Number.isInteger(Number(it.menuItemId)) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
        return res.status(400).json({ error: 'each item needs menuItemId and quantity between 1 and 20' });
      }
      const r = await fetch(`${RESTAURANT_URL}/api/menu-items/${Number(it.menuItemId)}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!r.ok) return res.status(400).json({ error: `menu item ${it.menuItemId} not found` });
      const menu = await r.json();
      if (!menu.available) return res.status(400).json({ error: `${menu.name} is not available` });
      if (Number(menu.restaurant_id) !== Number(restaurantId)) {
        return res.status(400).json({ error: 'all items must belong to the same restaurant' });
      }
      priced.push({ menuItemId: menu.id, name: menu.name, unitPrice: menu.price, quantity: qty });
      total += menu.price * qty;
    }
  } catch (err) {
    console.error('restaurant-service call failed:', err.message);
    return res.status(502).json({ error: 'restaurant-service unavailable' });
  }
  total = Math.round(total * 100) / 100;

  // 2) Persist order + items in one transaction
  const client = await pool.connect();
  let orderId;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO orders (user_id, restaurant_id, total_amount, status, payment_method, delivery_address)
       VALUES ($1, $2, $3, 'PLACED', $4, $5) RETURNING id`,
      [userId, Number(restaurantId), total, method, deliveryAddress || null]
    );
    orderId = ins.rows[0].id;
    for (const p of priced) {
      await client.query(
        'INSERT INTO order_items (order_id, menu_item_id, name, unit_price, quantity) VALUES ($1,$2,$3,$4,$5)',
        [orderId, p.menuItemId, p.name, p.unitPrice, p.quantity]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    return res.status(500).json({ error: 'could not create order' });
  } finally {
    client.release();
  }

  // 3) Take payment (synchronous call to payment-service)
  let newStatus = 'CONFIRMED';
  let txn = null;
  try {
    const pr = await fetch(`${PAYMENT_URL}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, amount: total, method }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const payment = await pr.json();
    if (!pr.ok || payment.status !== 'SUCCESS') newStatus = 'PAYMENT_FAILED';
    txn = payment.transaction_id || null;
  } catch (err) {
    console.error('payment-service call failed:', err.message);
    newStatus = 'PAYMENT_FAILED';
  }

  try {
    await pool.query('UPDATE orders SET status = $1, payment_txn = $2, updated_at = NOW() WHERE id = $3', [
      newStatus,
      txn,
      orderId,
    ]);
    return res.status(201).json(await loadOrder(orderId, userId));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'order created but status update failed' });
  }
});

// ---------- list / get / cancel ----------
app.get('/api/orders', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, restaurant_id, total_amount::float AS total_amount, status, payment_method, created_at
       FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [Number(req.auth.sub)]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/orders/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const order = await loadOrder(id, Number(req.auth.sub));
    if (!order) return res.status(404).json({ error: 'order not found' });
    return res.json(order);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/orders/:id/cancel', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE orders SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('PLACED', 'CONFIRMED', 'PAYMENT_FAILED')`,
      [id, Number(req.auth.sub)]
    );
    if (rowCount === 0) return res.status(409).json({ error: 'order not found or can no longer be cancelled' });
    return res.json(await loadOrder(id, Number(req.auth.sub)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

async function initDb() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const client = await pool.connect().catch((e) => {
      console.log(`db not reachable (attempt ${attempt}): ${e.message}`);
      return null;
    });
    if (client) {
      try {
        await client.query('SELECT pg_advisory_lock(42)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS orders (
            id               SERIAL PRIMARY KEY,
            user_id          INT NOT NULL,
            restaurant_id    INT NOT NULL,
            total_amount     NUMERIC(10,2) NOT NULL,
            status           VARCHAR(30) NOT NULL DEFAULT 'PLACED',
            payment_method   VARCHAR(10) NOT NULL,
            payment_txn      VARCHAR(40),
            delivery_address TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS order_items (
            id           SERIAL PRIMARY KEY,
            order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            menu_item_id INT NOT NULL,
            name         VARCHAR(160) NOT NULL,
            unit_price   NUMERIC(8,2) NOT NULL,
            quantity     INT NOT NULL
          )`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id)');
        await client.query('SELECT pg_advisory_unlock(42)');
        client.release();
        ready = true;
        console.log(`${SERVICE}: database ready`);
        return;
      } catch (err) {
        console.log(`db init failed (attempt ${attempt}): ${err.message}`);
        client.release(true);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`${SERVICE}: could not initialise database, exiting`);
  process.exit(1);
}

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`${SERVICE} listening on ${PORT}`));
  initDb();
  const shutdown = () => {
    console.log(`${SERVICE}: shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { app, pool };
