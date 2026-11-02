'use strict';

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const SERVICE = 'user-service';
const PORT = parseInt(process.env.PORT || '3001', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'userdb',
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

// ---------- health ----------
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

// ---------- auth helper ----------
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

// ---------- routes ----------
app.post('/api/users/register', async (req, res) => {
  const { name, email, password, phone, address } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, phone, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, phone, address, created_at`,
      [name, String(email).toLowerCase(), hash, phone || null, address || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email already registered' });
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/users/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone, address: user.address },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/users/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (Number(req.auth.sub) !== id) return res.status(403).json({ error: 'forbidden' });
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, phone, address, created_at FROM users WHERE id = $1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'user not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ---------- database bootstrap ----------
async function initDb() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const client = await pool.connect().catch((e) => {
      console.log(`db not reachable (attempt ${attempt}): ${e.message}`);
      return null;
    });
    if (client) {
      try {
        // advisory lock so that 2+ replicas starting together do not race on CREATE TABLE
        await client.query('SELECT pg_advisory_lock(42)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            name          VARCHAR(120) NOT NULL,
            email         VARCHAR(160) UNIQUE NOT NULL,
            password_hash VARCHAR(100) NOT NULL,
            phone         VARCHAR(20),
            address       TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
