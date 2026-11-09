const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestApp, createTestPool } = require('./helpers/test-app');
const { createApp } = require('../src/app');
const { createUserStore } = require('../src/users');
const { createSessionStore, createLoginThrottle } = require('../src/auth');

const PASSWORD = 'correct-horse-1';
const WRONG_MESSAGE = { status: 'UNAUTHORIZED', message: 'Invalid username or password.' };
const TOO_MANY_MESSAGE = { status: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' };

// Runs a test body against a running app with a fresh database; the app is always stopped.
function withApp(name, deps, body) {
  test(name, async () => {
    const t = await startTestApp(deps);
    try {
      await body(t);
    } finally {
      await t.stop();
    }
  });
}

function login(t, username, password, headers = {}) {
  return fetch(`${t.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username, password })
  });
}

function postJson(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function sidCookie(response) {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith('sid='));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sessionCount(pool) {
  return (await pool.query('select count(*) as n from sessions')).rows[0].n;
}

const searchStub = { searchTransaction: async (no) => ({ status: 'NOT_FOUND', applicationNo: no }) };

// ---------- login ----------

withApp('login with the right password sets an HttpOnly SameSite=Lax sid cookie and returns the user', {}, async (t) => {
  const response = await login(t, 'alice', PASSWORD);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { user: { id: body.user.id, username: 'alice' } });
  assert.equal(typeof body.user.id, 'number');

  const cookie = sidCookie(response);
  assert.match(cookie, /^sid=[0-9a-f]{64};/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Max-Age=43200(;|$)/); // 12 hours, the default
  assert.equal(response.headers.get('cache-control'), 'no-store');

  // The token never appears in the body, and only its SHA-256 is stored.
  const token = cookie.slice('sid='.length, cookie.indexOf(';'));
  assert.equal(JSON.stringify(body).includes(token), false);
  const rows = (await t.pool.query('select token_hash from sessions')).rows;
  assert.deepEqual(rows, [{ token_hash: sha256(token) }]);
});

withApp('the cookie has no Secure flag by default and has it when config.cookieSecure is true', {}, async (t) => {
  assert.doesNotMatch(sidCookie(await login(t, 'alice', PASSWORD)), /Secure/i);
});

withApp('the cookie lifetime follows config.sessionTtlHours', { config: { sessionTtlHours: 1, cookieSecure: true } }, async (t) => {
  const cookie = sidCookie(await login(t, 'alice', PASSWORD));
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; Max-Age=3600(;|$)/);
  const { expires_at: expiresAt } = (await t.pool.query('select expires_at from sessions')).rows[0];
  const remaining = new Date(expiresAt).getTime() - Date.now();
  assert.ok(remaining > 3590 * 1000 && remaining <= 3600 * 1000, `expires in ${remaining} ms`);
});

withApp('wrong password, unknown user and inactive user all get the same 401 message', { users: [['alice', PASSWORD], ['bob', PASSWORD]] }, async (t) => {
  await t.stores.users.setActive('bob', false);
  const attempts = [
    await login(t, 'alice', 'not-the-password'),
    await login(t, 'nobody', PASSWORD),
    await login(t, 'bob', PASSWORD) // right password, but disabled
  ];
  for (const response of attempts) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), WRONG_MESSAGE);
    assert.equal(sidCookie(response), undefined);
  }
  assert.equal(await sessionCount(t.pool), 0);
});

// A generous limit, so that this test's many failures are not themselves throttled.
withApp('a non-string username or password, or an oversize one, is a plain failed login and never reaches the user store', { throttle: createLoginThrottle({ maxFailures: 1000 }) }, async (t) => {
  let authenticateCalls = 0;
  const authenticate = t.stores.users.authenticate;
  t.stores.users.authenticate = (...args) => {
    authenticateCalls += 1;
    return authenticate(...args);
  };

  const bodies = [
    { username: 123, password: PASSWORD },
    { username: ['alice'], password: PASSWORD },
    { username: { toString: 'alice' }, password: PASSWORD },
    { username: 'alice', password: 12345678901 },
    { username: 'alice', password: { value: PASSWORD } },
    { username: 'alice', password: null },
    { username: 'alice' },
    {},
    { username: 'alice', password: 'a'.repeat(1001) },
    { username: 'a'.repeat(101), password: PASSWORD }
  ];
  for (const body of bodies) {
    const response = await postJson(`${t.baseUrl}/api/auth/login`, body);
    assert.equal(response.status, 401, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await response.json(), WRONG_MESSAGE);
    assert.equal(sidCookie(response), undefined);
  }
  assert.equal(authenticateCalls, 0);

  // No JSON body at all, and a JSON array, are the same plain failure.
  for (const init of [{ method: 'POST' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' }]) {
    const response = await fetch(`${t.baseUrl}/api/auth/login`, init);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), WRONG_MESSAGE);
  }
  assert.equal(authenticateCalls, 0);

  // 1000 characters is the longest password that is still checked.
  const edge = await login(t, 'alice', 'a'.repeat(1000));
  assert.equal(edge.status, 401);
  assert.equal(authenticateCalls, 1);
});

withApp('malformed login attempts count towards the throttle', {}, async (t) => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await login(t, 'alice', 'a'.repeat(1001))).status, 401);
  }
  const blocked = await login(t, 'alice', PASSWORD);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), TOO_MANY_MESSAGE);

  // A non-string username shares one key per client address, and is throttled the same way.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await postJson(`${t.baseUrl}/api/auth/login`, { username: 42, password: PASSWORD })).status, 401);
  }
  assert.equal((await postJson(`${t.baseUrl}/api/auth/login`, { username: 42, password: PASSWORD })).status, 429);
});

withApp('a broken or oversize login body is a 4xx that does not put the password in the server log', {}, async (t) => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map((arg) => (arg instanceof Error ? `${arg.stack} ${JSON.stringify(arg)}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  try {
    const url = `${t.baseUrl}/api/auth/login`;
    const headers = { 'content-type': 'application/json' };
    const broken = await fetch(url, { method: 'POST', headers, body: '{"username":"alice","password":"leaky-secret-value"' });
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), { status: 'INVALID_INPUT', message: 'Invalid request.' });

    const huge = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ username: 'alice', password: 'leaky-secret-value'.repeat(2000) }) });
    assert.equal(huge.status, 413);
    assert.deepEqual(await huge.json(), { status: 'INVALID_INPUT', message: 'Invalid request.' });
  } finally {
    console.error = original;
  }
  assert.equal(logged.some((line) => line.includes('leaky-secret-value')), false, 'the password was logged');
  assert.equal(await sessionCount(t.pool), 0);
});

withApp('after 5 wrong passwords the 6th attempt, even with the right password, is 429 with Retry-After', { users: [['alice', PASSWORD], ['bob', PASSWORD]] }, async (t) => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await login(t, 'alice', 'wrong-password-1')).status, 401);
  }
  const blocked = await login(t, 'alice', PASSWORD);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), TOO_MANY_MESSAGE);
  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 900, `Retry-After was ${blocked.headers.get('retry-after')}`);
  assert.equal(sidCookie(blocked), undefined);
  assert.equal(await sessionCount(t.pool), 0);

  // The throttle is per username (and address), so another account is unaffected.
  assert.equal((await login(t, 'bob', PASSWORD)).status, 200);
  // The username in the key is case-insensitive.
  assert.equal((await login(t, 'ALICE', PASSWORD)).status, 429);
});

withApp('parallel wrong passwords cannot overshoot the limit', {}, async (t) => {
  const responses = await Promise.all(Array.from({ length: 9 }, () => login(t, 'alice', 'wrong-password-1')));
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429, 429]);
});

withApp('a successful login resets the failure count', {}, async (t) => {
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await login(t, 'alice', 'wrong-password-1')).status, 401);
  }
  assert.equal((await login(t, 'alice', PASSWORD)).status, 200);
  // Four more failures are fine only if the success cleared the earlier four.
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await login(t, 'alice', 'wrong-password-1')).status, 401);
  }
  assert.equal((await login(t, 'alice', PASSWORD)).status, 200);
});

// ---------- sessions over HTTP ----------

withApp('GET /api/auth/me is 401 without a cookie and 200 with one', {}, async (t) => {
  const denied = await fetch(`${t.baseUrl}/api/auth/me`);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { status: 'UNAUTHORIZED', message: 'Sign in to continue.' });

  const cookie = await t.cookieFor('alice');
  assert.match(cookie, /^sid=[0-9a-f]{64}$/);
  const allowed = await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.deepEqual(body, { user: { id: body.user.id, username: 'alice' } });
});

withApp('a missing, malformed, unknown or JSON-looking cookie is 401, never a server error', {}, async (t) => {
  const cookies = [
    'sid=',
    'sid=abc',
    `sid=${'0'.repeat(64)}`, // well formed but unknown
    `sid=${'A'.repeat(64)}`,
    'sid=j:{"a":1}', // cookie-parser turns this into an object
    'sid=j:%5B%5D',
    `sid=${'a'.repeat(5000)}`,
    'other=1'
  ];
  for (const cookie of cookies) {
    const response = await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal(response.status, 401, cookie.slice(0, 40));
    assert.equal((await response.json()).status, 'UNAUTHORIZED');
  }
});

withApp('POST /api/transaction/search is 401 without a cookie and 200 with one', { automation: searchStub }, async (t) => {
  const url = `${t.baseUrl}/api/transaction/search`;
  const denied = await postJson(url, { applicationNo: 'FNHR1' });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).status, 'UNAUTHORIZED');

  const allowed = await postJson(url, { applicationNo: 'FNHR1' }, { cookie: await t.cookieFor('alice') });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { status: 'NOT_FOUND', applicationNo: 'FNHR1' });
});

withApp('every /api route except /api/auth/* needs a cookie', { automation: {} }, async (t) => {
  const calls = [
    ['POST', '/api/transaction/search'],
    ['POST', '/api/transaction/search-stream'],
    ['POST', '/api/transaction/bulk'],
    ['POST', '/api/export'],
    ['POST', '/api/captcha/session'],
    ['POST', '/api/captcha/session/x/refresh'],
    ['POST', '/api/captcha/session/x/search'],
    ['DELETE', '/api/captcha/session/x'],
    ['GET', '/api/anything-else']
  ];
  for (const [method, path] of calls) {
    const response = await fetch(`${t.baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal((await response.json()).status, 'UNAUTHORIZED');
  }
});

withApp('/health stays open without a cookie', {}, async (t) => {
  const response = await fetch(`${t.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

withApp('logout returns 204 and the cookie no longer works', {}, async (t) => {
  const cookie = await t.cookieFor('alice');
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 200);

  const response = await fetch(`${t.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(response.status, 204);
  const cleared = sidCookie(response);
  assert.match(cleared, /^sid=;/);
  assert.match(cleared, /; Path=\//);
  assert.match(cleared, /; Expires=Thu, 01 Jan 1970/);
  assert.match(cleared, /; HttpOnly/);
  assert.match(cleared, /; SameSite=Lax/);

  assert.equal(await sessionCount(t.pool), 0);
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
});

withApp('the logout cookie clear carries the Secure flag when config.cookieSecure is true', { config: { cookieSecure: true } }, async (t) => {
  const cookie = await t.cookieFor('alice');
  const response = await fetch(`${t.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.match(sidCookie(response), /; Secure/);
});

withApp('logout without a cookie is still 204, and ends only its own session', {}, async (t) => {
  const first = await t.cookieFor('alice');
  const second = await t.cookieFor('alice');
  assert.equal((await fetch(`${t.baseUrl}/api/auth/logout`, { method: 'POST' })).status, 204);
  assert.equal((await fetch(`${t.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: 'sid=j:{"a":1}' } })).status, 204);
  assert.equal(await sessionCount(t.pool), 2);

  assert.equal((await fetch(`${t.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: first } })).status, 204);
  assert.equal(await sessionCount(t.pool), 1);
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie: first } })).status, 401);
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie: second } })).status, 200);
});

withApp('an expired session is 401', {}, async (t) => {
  const cookie = await t.cookieFor('alice');
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 200);
  await t.pool.query('update sessions set expires_at = $1', [new Date(Date.now() - 60 * 1000)]);
  const response = await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).status, 'UNAUTHORIZED');
});

withApp('disabling the user kills a cookie that was already issued', {}, async (t) => {
  const cookie = await t.cookieFor('alice');
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 200);
  await t.stores.users.setActive('alice', false);
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
  // Enabling the user again does not bring the old cookie back.
  await t.stores.users.setActive('alice', true);
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
});

withApp('a session row of a user flagged inactive is rejected even if the row survived', {}, async (t) => {
  const cookie = await t.cookieFor('alice');
  await t.pool.query('update users set is_active = false');
  assert.equal(await sessionCount(t.pool), 1);
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
});

withApp('changing the password signs out a cookie that was already issued', {}, async (t) => {
  const cookie = await t.cookieFor('alice');
  await t.stores.users.setPassword('alice', 'another-password-2');
  assert.equal((await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
});

// ---------- cross-origin writes ----------

withApp('a POST with a foreign Origin header and a valid cookie is 403', { automation: searchStub }, async (t) => {
  const cookie = await t.cookieFor('alice');
  const url = `${t.baseUrl}/api/transaction/search`;

  for (const origin of ['https://evil.example', 'http://127.0.0.1:1', 'null', 'not a url']) {
    const response = await postJson(url, { applicationNo: 'FNHR1' }, { cookie, origin });
    assert.equal(response.status, 403, origin);
    assert.equal((await response.json()).status, 'FORBIDDEN');
  }

  // The same page's own origin, and requests with no Origin at all (scripts, curl), are fine.
  assert.equal((await postJson(url, { applicationNo: 'FNHR1' }, { cookie, origin: t.baseUrl })).status, 200);
  assert.equal((await postJson(url, { applicationNo: 'FNHR1' }, { cookie })).status, 200);
  // Reads are not state changing.
  const me = await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(me.status, 200);
});

withApp('a login or logout from a foreign Origin is 403 and sets nothing', {}, async (t) => {
  const response = await login(t, 'alice', PASSWORD, { origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  assert.equal(sidCookie(response), undefined);
  assert.equal(await sessionCount(t.pool), 0);

  const cookie = await t.cookieFor('alice');
  const logout = await fetch(`${t.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(logout.status, 403);
  assert.equal(await sessionCount(t.pool), 1);
});

// ---------- the session store ----------

async function withStores(body, { ttlHours = 12 } = {}) {
  const pool = await createTestPool();
  try {
    const users = createUserStore(pool);
    const sessions = createSessionStore(pool, { ttlHours });
    await body({ pool, users, sessions });
  } finally {
    await pool.end();
  }
}

test('create returns a 64-hex token and an expiry ttlHours ahead, and stores only the SHA-256 of the token', () => withStores(async ({ pool, users, sessions }) => {
  const alice = await users.create('alice', PASSWORD);
  const before = Date.now();
  const session = await sessions.create(alice.id);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.ok(session.expiresAt instanceof Date);
  assert.ok(Math.abs(session.expiresAt.getTime() - (before + 12 * 3600 * 1000)) < 5000);

  const rows = (await pool.query('select token_hash, user_id from sessions')).rows;
  assert.deepEqual(rows, [{ token_hash: sha256(session.token), user_id: alice.id }]);

  const other = await sessions.create(alice.id);
  assert.notEqual(other.token, session.token);
}));

test('resolve returns {id, username} for a live token and null for anything else', () => withStores(async ({ pool, users, sessions }) => {
  const alice = await users.create('alice', PASSWORD);
  const { token } = await sessions.create(alice.id);
  assert.deepEqual(await sessions.resolve(token), { id: alice.id, username: 'alice' });

  assert.equal(await sessions.resolve('0'.repeat(64)), null);
  for (const bad of [undefined, null, '', 'abc', 123, {}, [], token.toUpperCase(), `${token} `, sha256(token)]) {
    assert.equal(await sessions.resolve(bad), null, String(bad));
  }

  // The stored hash is not itself a working token.
  const [{ token_hash: hash }] = (await pool.query('select token_hash from sessions')).rows;
  assert.equal(await sessions.resolve(hash), null);
}));

test('destroy removes only that session, and ignores values that are not tokens', () => withStores(async ({ pool, users, sessions }) => {
  const alice = await users.create('alice', PASSWORD);
  const first = await sessions.create(alice.id);
  const second = await sessions.create(alice.id);
  assert.equal(await sessions.destroy(first.token), undefined);
  assert.equal(await sessions.resolve(first.token), null);
  assert.notEqual(await sessions.resolve(second.token), null);
  await sessions.destroy(undefined);
  await sessions.destroy({});
  await sessions.destroy('nonsense');
  assert.equal(await sessionCount(pool), 1);
}));

test('create returns null, and stores nothing, when the user was disabled after the password was checked', () => withStores(async ({ pool, users, sessions }) => {
  const alice = await users.create('alice', PASSWORD);
  const verified = await users.authenticate('alice', PASSWORD);
  assert.deepEqual(verified, alice);

  await users.setActive('alice', false); // commits between the password check and the session insert
  assert.equal(await sessions.create(verified.id), null);
  assert.equal(await sessionCount(pool), 0);

  await users.setActive('alice', true);
  assert.notEqual(await sessions.create(verified.id), null);
}));

test('create returns null for a user that does not exist or an id that is not an id', () => withStores(async ({ pool, sessions }) => {
  for (const id of [999999, 0, -1, 1.5, NaN, 'abc', '1', null, undefined, {}]) {
    assert.equal(await sessions.create(id), null, String(id));
  }
  assert.equal(await sessionCount(pool), 0);
}));

test('createSessionStore rejects a ttl that is not a positive number of hours', () => withStores(async ({ pool }) => {
  for (const ttlHours of [0, -1, NaN, Infinity, '12', null]) {
    assert.throws(() => createSessionStore(pool, { ttlHours }), TypeError, String(ttlHours));
  }
}));

test('purgeExpired removes only expired rows and returns how many', () => withStores(async ({ pool, users, sessions }) => {
  const alice = await users.create('alice', PASSWORD);
  const live = await sessions.create(alice.id);
  const expiredA = await sessions.create(alice.id);
  const expiredB = await sessions.create(alice.id);
  const past = new Date(Date.now() - 60 * 1000);
  await pool.query('update sessions set expires_at = $1 where token_hash = $2 or token_hash = $3', [past, sha256(expiredA.token), sha256(expiredB.token)]);

  assert.equal(await sessions.purgeExpired(), 2);
  assert.deepEqual((await pool.query('select token_hash from sessions')).rows, [{ token_hash: sha256(live.token) }]);
  assert.equal(await sessions.purgeExpired(), 0);
  assert.notEqual(await sessions.resolve(live.token), null);
}));

// ---------- the login throttle ----------

test('the login throttle blocks a key after maxFailures and releases it when the window has passed', () => {
  let now = 1000000;
  const throttle = createLoginThrottle({ maxFailures: 3, windowMs: 60000, now: () => now });
  assert.equal(throttle.blocked('k'), false);
  throttle.fail('k');
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), false);
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), true);
  assert.equal(throttle.blocked('other'), false);

  now += 59999;
  assert.equal(throttle.blocked('k'), true);
  assert.equal(throttle.retryAfterSeconds('k'), 1);
  now += 1;
  assert.equal(throttle.blocked('k'), false);

  // A fresh window starts with the next failure.
  throttle.fail('k');
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), false);
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), true);
  assert.equal(throttle.retryAfterSeconds('k'), 60);
});

test('the login throttle reset clears a key, and the defaults are 5 failures in 15 minutes', () => {
  let now = 0;
  const throttle = createLoginThrottle({ now: () => now });
  for (let i = 0; i < 4; i += 1) throttle.fail('k');
  assert.equal(throttle.blocked('k'), false);
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), true);
  assert.equal(throttle.retryAfterSeconds('k'), 900);
  throttle.reset('k');
  assert.equal(throttle.blocked('k'), false);
  throttle.reset('never-seen'); // harmless
});

test('the login throttle does not grow without bound', () => {
  let now = 0;
  const throttle = createLoginThrottle({ windowMs: 1000, now: () => now });
  for (let i = 0; i < 25000; i += 1) {
    throttle.fail(`ip|user${i}`);
    now += 1; // every window is long over before the table fills up
  }
  assert.ok(throttle.size() <= 10000, `size was ${throttle.size()}`);

  // Even when nothing has expired the table stays capped, and a key that was just recorded is kept.
  now = 0;
  const busy = createLoginThrottle({ maxFailures: 1, windowMs: 1e12, now: () => now });
  for (let i = 0; i < 12000; i += 1) busy.fail(`ip|user${i}`);
  assert.ok(busy.size() <= 10000, `size was ${busy.size()}`);
  assert.equal(busy.blocked('ip|user11999'), true);
});

// ---------- wiring ----------

test('createApp refuses to start without the stores that protect /api', () => {
  assert.throws(() => createApp({ automation: {} }), /users, sessions, throttle and config/);
});
