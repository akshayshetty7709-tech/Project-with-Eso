'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { app, pool } = require('../server');

test('GET /health returns UP', async () => {
  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'UP');
  server.close();
  await pool.end();
});
