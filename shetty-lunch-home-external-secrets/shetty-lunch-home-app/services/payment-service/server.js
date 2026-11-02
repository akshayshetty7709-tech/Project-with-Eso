'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const SERVICE = 'payment-service';
const PORT = parseInt(process.env.PORT || '3004', 10);
const METHODS = ['COD', 'UPI', 'CARD'];
// Simulated gateway rule: online payments above this amount are declined (lets you practise the failure path)
const ONLINE_LIMIT = parseFloat(process.env.ONLINE_PAYMENT_LIMIT || '20000');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'paymentdb',
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

// Internal API: called by order-service only (not exposed via nginx / ingress).
app.post('/api/payments', async (req, res) => {
  const { orderId, amount, method } = req.body || {};
  const amt = Number(amount);
  if (!Number.isInteger(Number(orderId)) || !(amt > 0) || !METHODS.includes(method)) {
    return res.status(400).json({ error: `orderId, amount > 0 and method (${METHODS.join('/')}) are required` });
  }
  const status = method !== 'COD' && amt > ONLINE_LIMIT ? 'FAILED' : 'SUCCESS';
  const txn = `TXN-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO payments (order_id, amount, method, status, transaction_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, order_id, amount::float AS amount, method, status, transaction_id, created_at`,
      [Number(orderId), amt, method, status, txn]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/payments/order/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'invalid order id' });
  try {
    const { rows } = await pool.query(
      `SELECT id, order_id, amount::float AS amount, method, status, transaction_id, created_at
       FROM payments WHERE order_id = $1 ORDER BY id DESC`,
      [orderId]
    );
    return res.json(rows);
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
          CREATE TABLE IF NOT EXISTS payments (
            id             SERIAL PRIMARY KEY,
            order_id       INT NOT NULL,
            amount         NUMERIC(10,2) NOT NULL,
            method         VARCHAR(10) NOT NULL,
            status         VARCHAR(10) NOT NULL,
            transaction_id VARCHAR(40) NOT NULL,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`);
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
