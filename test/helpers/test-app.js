const { createApp } = require('../../src/app');

// Starts the app on a random local port. Used by the HTTP tests; later tasks extend it.
async function startTestApp(deps = {}) {
  const { app, closeCaptchaSessions } = createApp(deps);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      await closeCaptchaSessions();
    }
  };
}

// A database pool for tests. By default an in-memory pg-mem database, so tests need no server.
// With TEST_DATABASE_URL set it is real Postgres instead, and the public schema is wiped first.
// pg-mem is required lazily: this file is also run by `node --test` and must do nothing when loaded.
async function createTestPool({ migrate = true } = {}) {
  const { migrate: applyMigrations } = require('../../src/db'); // also registers the int8 -> number parser
  let pool;
  if (process.env.TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query('drop schema public cascade');
    await pool.query('create schema public');
  } else {
    const { newDb } = require('pg-mem');
    const { Pool } = newDb().adapters.createPg();
    pool = new Pool();
  }
  if (migrate) await applyMigrations(pool);
  return pool;
}

module.exports = { startTestApp, createTestPool };
