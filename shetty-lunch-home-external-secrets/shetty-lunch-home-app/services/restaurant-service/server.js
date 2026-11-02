'use strict';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const SERVICE = 'restaurant-service';
const PORT = parseInt(process.env.PORT || '3002', 10);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'restaurantdb',
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

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const RESTAURANT_COLS = 'id, name, cuisine, rating::float AS rating, address, is_open';
const MENU_COLS = 'id, restaurant_id, name, description, price::float AS price, is_veg, available';

app.get('/api/restaurants', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${RESTAURANT_COLS} FROM restaurants ORDER BY rating DESC, name`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/restaurants/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await pool.query(`SELECT ${RESTAURANT_COLS} FROM restaurants WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'restaurant not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/restaurants/:id/menu', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await pool.query(
      `SELECT ${MENU_COLS} FROM menu_items WHERE restaurant_id = $1 AND available = TRUE ORDER BY id`,
      [id]
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// Internal endpoint: used by order-service to get the authoritative price of an item.
// It is deliberately NOT exposed through the frontend nginx / ingress.
app.get('/api/menu-items/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await pool.query(`SELECT ${MENU_COLS} FROM menu_items WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'menu item not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ---------- database bootstrap + seed data ----------
const SEED = [
  {
    name: 'Shetty Lunch Home - Mangalore Kitchen',
    cuisine: 'Coastal Karnataka',
    rating: 4.6,
    address: 'Hampankatta, Mangaluru',
    items: [
      ['Chicken Ghee Roast', 'Fiery Kundapur-style roast finished with ghee', 280, false],
      ['Kori Rotti', 'Crisp rice wafers with spicy chicken curry', 260, false],
      ['Neer Dosa (3 pcs)', 'Lacy rice crepes, served with coconut chutney', 90, true],
      ['Mangalorean Veg Meals', 'Rice, sambar, rasam, 2 palya, kosambari, payasa', 150, true],
      ['Gadbad Ice Cream', 'Layered ice cream, fruits and nuts', 120, true],
    ],
  },
  {
    name: 'Kundapura Fish Corner',
    cuisine: 'Seafood',
    rating: 4.5,
    address: 'Kundapura, Udupi District',
    items: [
      ['Fish Thali', 'Fried fish, fish curry, rice, solkadhi', 240, false],
      ['Bangude Fry', 'Mackerel rava fry', 220, false],
      ['Prawn Sukka', 'Dry prawn masala with coconut', 300, false],
      ['Anjal Tawa Fry', 'King fish tawa fry, 2 pieces', 340, false],
      ['Sol Kadhi', 'Kokum and coconut milk digestive', 50, true],
    ],
  },
  {
    name: 'Udupi Sagar Bhavan',
    cuisine: 'South Indian Vegetarian',
    rating: 4.4,
    address: 'Car Street, Udupi',
    items: [
      ['Masala Dosa', 'Crisp dosa with potato palya', 100, true],
      ['Idli Vada Combo', '2 idli + 1 vada with sambar', 80, true],
      ['Bisi Bele Bath', 'Spiced lentil rice with ghee', 110, true],
      ['Kesari Bath', 'Sweet semolina with saffron', 60, true],
      ['Filter Coffee', 'South Indian decoction coffee', 40, true],
    ],
  },
];

async function createSchemaAndSeed(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id      SERIAL PRIMARY KEY,
      name    VARCHAR(160) NOT NULL,
      cuisine VARCHAR(80),
      rating  NUMERIC(2,1) NOT NULL DEFAULT 4.0,
      address TEXT,
      is_open BOOLEAN NOT NULL DEFAULT TRUE
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id            SERIAL PRIMARY KEY,
      restaurant_id INT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name          VARCHAR(160) NOT NULL,
      description   TEXT,
      price         NUMERIC(8,2) NOT NULL,
      is_veg        BOOLEAN NOT NULL DEFAULT TRUE,
      available     BOOLEAN NOT NULL DEFAULT TRUE
    )`);
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM restaurants');
  if (rows[0].n === 0) {
    for (const r of SEED) {
      const ins = await client.query(
        'INSERT INTO restaurants (name, cuisine, rating, address) VALUES ($1,$2,$3,$4) RETURNING id',
        [r.name, r.cuisine, r.rating, r.address]
      );
      for (const [name, description, price, isVeg] of r.items) {
        await client.query(
          'INSERT INTO menu_items (restaurant_id, name, description, price, is_veg) VALUES ($1,$2,$3,$4,$5)',
          [ins.rows[0].id, name, description, price, isVeg]
        );
      }
    }
    console.log(`${SERVICE}: seeded ${SEED.length} restaurants`);
  }
}

async function initDb() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const client = await pool.connect().catch((e) => {
      console.log(`db not reachable (attempt ${attempt}): ${e.message}`);
      return null;
    });
    if (client) {
      try {
        await client.query('SELECT pg_advisory_lock(42)');
        await createSchemaAndSeed(client);
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
