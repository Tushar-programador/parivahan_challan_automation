const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { createUserStore } = require('../../src/users');
const { createSessionStore, createLoginThrottle } = require('../../src/auth');

const DEFAULT_USERS = [['alice', 'correct-horse-1']];

// Starts the app on a random local port, on its own in-memory database, with real user and session stores.
// `users` is a list of [username, password] to create first. `config` overrides fields of the default test config.
// `throttle` replaces the login throttle (for tests that need a different limit).
// cookieFor(username) signs in through the HTTP route and returns the "sid=..." string for a `cookie` request header.
async function startTestApp({ automation, users = DEFAULT_USERS, config = {}, throttle } = {}) {
  const pool = await createTestPool();
  let server;
  let closeCaptchaSessions = async () => {};
  try {
    const userStore = createUserStore(pool);
    for (const [username, password] of users) await userStore.create(username, password);
    const passwords = new Map(users.map(([username, password]) => [username.trim().toLowerCase(), password]));

    const appConfig = { ...loadConfig({ DATABASE_URL: 'postgres://unused.invalid/unused' }), ...config };
    const sessionStore = createSessionStore(pool, { ttlHours: appConfig.sessionTtlHours });
    const created = createApp({
      automation,
      users: userStore,
      sessions: sessionStore,
      throttle: throttle || createLoginThrottle(),
      config: appConfig
    });
    closeCaptchaSessions = created.closeCaptchaSessions;

    server = await new Promise((resolve, reject) => {
      const listening = created.app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.on('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    return {
      baseUrl,
      pool,
      stores: { users: userStore, sessions: sessionStore },
      async cookieFor(username) {
        const password = passwords.get(String(username).trim().toLowerCase());
        if (password === undefined) throw new Error(`cookieFor: no test user named "${username}"`);
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const cookie = response.headers.getSetCookie().find((value) => value.startsWith('sid='));
        if (response.status !== 200 || !cookie) throw new Error(`cookieFor: login as "${username}" answered ${response.status}`);
        return cookie.split(';')[0];
      },
      async stop() {
        await new Promise((resolve) => {
          server.close(() => resolve());
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        });
        await closeCaptchaSessions();
        await pool.end();
      }
    };
  } catch (error) {
    if (server) server.close();
    await closeCaptchaSessions();
    await pool.end().catch(() => {});
    throw error;
  }
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
