const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { createUserStore } = require('../../src/users');
const { createRecordStore } = require('../../src/records');
const { createSessionStore, createLoginThrottle } = require('../../src/auth');

const DEFAULT_USERS = [['alice', 'correct-horse-1']];

// Nothing a client can see may name the source. SOURCE_WORDS is the word list alone: use it for response headers and
// static files, where a URL (for example the Google Fonts links in a Content-Security-Policy) is legitimate. LEAK adds
// "any URL" and is for JSON bodies and export files.
const SOURCE_WORDS = /parivahan|vahan|portal|captcha|gov\.in|playwright|chromium|ddddocr/i;
const LEAK = /parivahan|vahan|portal|captcha|gov\.in|playwright|chromium|ddddocr|https?:\/\//i;

// Starts the app on a random local port, on its own in-memory database, with real user, session and record stores.
// `users` is a list of [username, password] to create first. `config` overrides fields of the default test config.
// `throttle` replaces the login throttle (for tests that need a different limit).
// `lookup` replaces the lookup service the routes call (by default the real one, built on `automation.searchTransaction`).
// `log` replaces the server log; by default it is a silent spy: every message is kept in `logged` (and returned as `log`).
// cookieFor(username) signs in through the HTTP route and returns the "sid=..." string for a `cookie` request header.
async function startTestApp({ automation, users = DEFAULT_USERS, config = {}, throttle, lookup, log } = {}) {
  const pool = await createTestPool();
  let server;
  let closeCaptchaSessions = async () => {};
  try {
    const userStore = createUserStore(pool);
    for (const [username, password] of users) await userStore.create(username, password);
    const passwords = new Map(users.map(([username, password]) => [username.trim().toLowerCase(), password]));

    const appConfig = { ...loadConfig({ DATABASE_URL: 'postgres://unused.invalid/unused' }), ...config };
    const sessionStore = createSessionStore(pool, { ttlHours: appConfig.sessionTtlHours });
    const recordStore = createRecordStore(pool);
    const logged = [];
    const serverLog = log || ((message) => { logged.push(message); });
    const created = createApp({
      automation,
      users: userStore,
      sessions: sessionStore,
      records: recordStore,
      lookup,
      throttle: throttle || createLoginThrottle(),
      config: appConfig,
      log: serverLog
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
      log: serverLog,
      logged,
      stores: { users: userStore, sessions: sessionStore, records: recordStore },
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

// A FOUND lookup result as the automation returns it, for tests that store or serve records.
// `overrides` replace fields of `data` (for example { amount: '600' }).
function foundResult(applicationNo, overrides = {}) {
  return {
    status: 'FOUND',
    applicationNo,
    data: { vehicleNo: 'HR31V0031', amount: '500', status: 'SUCCESS', statusDescription: 'Paid', ...overrides },
    rawStatus: 'SUCCESS'
  };
}

module.exports = { startTestApp, createTestPool, foundResult, SOURCE_WORDS, LEAK };
