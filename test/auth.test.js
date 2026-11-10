const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { inspect } = require('node:util');
const { startTestApp, createTestPool } = require('./helpers/test-app');
const { createApp } = require('../src/app');
const { createUserStore } = require('../src/users');
const { createSessionStore, createLoginThrottle, clientAddressKey } = require('../src/auth');

const PASSWORD = 'correct-horse-1';
const WRONG_MESSAGE = { status: 'UNAUTHORIZED', message: 'Invalid username or password.' };
const TOO_MANY_MESSAGE = { status: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' };
const BAD_REQUEST = { status: 'BAD_REQUEST', message: 'Invalid request.' };

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

// Runs fn while console.error / warn / log / info are recorded (and not printed). Resolves to every line written,
// with objects and errors expanded in full, so a secret hiding in an error's properties is found too.
async function captureConsole(fn) {
  const lines = [];
  const names = ['error', 'warn', 'log', 'info'];
  const original = Object.fromEntries(names.map((name) => [name, console[name]]));
  for (const name of names) {
    console[name] = (...args) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 8, maxStringLength: null, maxArrayLength: null }))).join(' '));
  }
  try {
    await fn();
  } finally {
    for (const name of names) console[name] = original[name];
  }
  return lines;
}

// A user who has just proved their password, as the login route sees them, and a session opened for that proof.
async function openSession(users, sessions, username = 'alice', password = PASSWORD) {
  const verified = await users.authenticate(username, password);
  return { verified, session: await sessions.create(verified.id, verified.passwordHash) };
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

test('the cookie has no Secure flag by default and has it when config.cookieSecure is true', async () => {
  for (const [config, secure] of [[{}, false], [{ cookieSecure: true }, true]]) {
    const t = await startTestApp({ config });
    try {
      const cookie = sidCookie(await login(t, 'alice', PASSWORD));
      assert.match(cookie, /; HttpOnly/);
      assert.equal(/; Secure/i.test(cookie), secure, `cookieSecure: ${JSON.stringify(config.cookieSecure)}`);
    } finally {
      await t.stop();
    }
  }
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

withApp('a broken or oversize login body is 400 or 413 BAD_REQUEST and does not put the password in the server log', {}, async (t) => {
  const url = `${t.baseUrl}/api/auth/login`;
  const headers = { 'content-type': 'application/json' };
  const lines = await captureConsole(async () => {
    const broken = await fetch(url, { method: 'POST', headers, body: '{"username":"alice","password":"leaky-secret-value"' });
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), BAD_REQUEST);

    const huge = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ username: 'alice', password: 'leaky-secret-value'.repeat(2000) }) });
    assert.equal(huge.status, 413);
    assert.deepEqual(await huge.json(), BAD_REQUEST);
  });
  assert.equal([...lines, ...t.logged].some((line) => line.includes('leaky-secret-value')), false, 'the password was logged');
  assert.equal(await sessionCount(t.pool), 0);
});

withApp('body-parser errors are client errors everywhere: 400 or 413 BAD_REQUEST, nothing logged, and no parsing for callers who are not signed in', { automation: searchStub }, async (t) => {
  const json = { 'content-type': 'application/json' };
  const threeMb = `{"applicationNo":"${'x'.repeat(3 * 1024 * 1024)}`; // broken JSON: the string never closes
  const cookie = await t.cookieFor('alice');

  const lines = await captureConsole(async () => {
    // Outside /api there is no body parser at all: a huge broken body is simply a 404.
    const stray = await fetch(`${t.baseUrl}/not-a-route`, { method: 'POST', headers: json, body: threeMb });
    assert.equal(stray.status, 404);

    // Inside /api the sign-in check comes before the parser.
    const anonymous = await fetch(`${t.baseUrl}/api/transaction/search`, { method: 'POST', headers: json, body: threeMb });
    assert.equal(anonymous.status, 401);

    // A signed-in caller with a broken or oversize body gets a client error, not a 500 and not a log line.
    const broken = await fetch(`${t.baseUrl}/api/transaction/search`, { method: 'POST', headers: { ...json, cookie }, body: '{"applicationNo": secret-in-body' });
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), BAD_REQUEST);

    const huge = await fetch(`${t.baseUrl}/api/transaction/search`, { method: 'POST', headers: { ...json, cookie }, body: `{"applicationNo":"${'x'.repeat(6 * 1024 * 1024)}"}` });
    assert.equal(huge.status, 413);
    assert.deepEqual(await huge.json(), BAD_REQUEST);
  });
  assert.deepEqual(lines, []);
  assert.deepEqual(t.logged, [], 'nothing went to the server log either');
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

withApp('X-Forwarded-For is ignored when trustProxy is false', { config: { trustProxy: false } }, async (t) => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await login(t, 'alice', 'wrong-password-1')).status, 401);
  }
  // Claiming to be somebody else does not give a fresh set of attempts.
  for (const forwarded of ['198.51.100.9', '203.0.113.1, 198.51.100.10', '2001:db8::1']) {
    const response = await login(t, 'alice', PASSWORD, { 'x-forwarded-for': forwarded });
    assert.equal(response.status, 429, forwarded);
  }
});

withApp('Retry-After is how long until the last of the blocking limits is released', {
  throttle: {
    blocked: () => true,
    retryAfterSeconds: (key) => (key.startsWith('ip:') ? 700 : key.startsWith('user:') ? 300 : 100),
    fail() {},
    forgive() {},
    reset() {}
  }
}, async (t) => {
  const response = await login(t, 'alice', PASSWORD);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '700');
});

const retryClock = { now: 0 };
withApp('Retry-After counts down with the window', { throttle: createLoginThrottle({ now: () => retryClock.now }) }, async (t) => {
  for (let i = 0; i < 5; i += 1) assert.equal((await login(t, 'alice', 'wrong-password-1')).status, 401);
  retryClock.now += 100 * 1000;
  const blocked = await login(t, 'alice', PASSWORD);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '800');
});

withApp('one address cannot make more than 50 failed attempts in the window, whatever usernames it tries', {}, async (t) => {
  // Every one of these is a different username, so no single username or address+username key is anywhere near its limit.
  const failures = await Promise.all(Array.from({ length: 60 }, (_, i) => login(t, `guest${i}`, 'wrong-password-1')));
  const statuses = failures.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 401).length, 50);
  assert.equal(statuses.filter((status) => status === 429).length, 10);

  // From now on the address is blocked outright, even for a real account with the right password.
  const blocked = await login(t, 'alice', PASSWORD);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), TOO_MANY_MESSAGE);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(sidCookie(blocked), undefined);
  assert.equal(await sessionCount(t.pool), 0);
});

withApp('a successful login does not reset the per-address counter, and is not counted as a failure', {}, async (t) => {
  const failAs = (from, to) => Promise.all(Array.from({ length: to - from }, (_, i) => login(t, `guest${from + i}`, 'wrong-password-1')));
  assert.ok((await failAs(0, 30)).every((response) => response.status === 401));
  assert.equal((await login(t, 'alice', PASSWORD)).status, 200); // 30 failures stand, and the success is not a 31st
  assert.ok((await failAs(30, 50)).every((response) => response.status === 401)); // 50 failures in all
  assert.equal((await login(t, 'alice', PASSWORD)).status, 429); // had the success reset the counter this would be 200
});

// Different client addresses in these tests come from X-Forwarded-For, which is believed because one proxy hop is trusted.
withApp('one username cannot take more than 25 failed attempts in the window from all addresses together', { config: { trustProxy: 1 }, users: [['alice', PASSWORD], ['bob', PASSWORD]] }, async (t) => {
  const fromIp = (ip, username, password) => login(t, username, password, { 'x-forwarded-for': ip });
  const failFrom = (prefix, count) => Promise.all(Array.from({ length: count }, (_, i) => fromIp(`${prefix}.${i + 1}`, 'alice', 'wrong-password-1')));

  assert.ok((await failFrom('10.0.1', 20)).every((response) => response.status === 401));
  // A success (from yet another address) resets that username's counter ...
  assert.equal((await fromIp('10.0.9.9', 'alice', PASSWORD)).status, 200);
  // ... so another 25 failures are allowed. Without the reset, the 6th of these would already be refused.
  assert.ok((await failFrom('10.0.2', 25)).every((response) => response.status === 401));

  // The 26th failure from a fresh address is refused, and so is the right password from there.
  const blocked = await fromIp('10.0.3.1', 'alice', PASSWORD);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), TOO_MANY_MESSAGE);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(sidCookie(blocked), undefined);
  // Other usernames are not affected.
  assert.equal((await fromIp('10.0.3.1', 'bob', PASSWORD)).status, 200);
});

withApp('addresses in the same IPv6 /64 share one failure counter', { config: { trustProxy: 1 } }, async (t) => {
  const failFrom = (ip, count) => Promise.all(Array.from({ length: count }, (_, i) => login(t, `guest${ip.length}-${i}`, 'wrong-password-1', { 'x-forwarded-for': ip })));
  assert.ok((await failFrom('2001:db8:1:2::1', 30)).every((response) => response.status === 401));
  assert.ok((await failFrom('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 20)).every((response) => response.status === 401));
  assert.equal((await login(t, 'alice', PASSWORD, { 'x-forwarded-for': '2001:db8:1:2:1234::99' })).status, 429);
  // A different /64 is a different client.
  assert.equal((await login(t, 'alice', PASSWORD, { 'x-forwarded-for': '2001:db8:1:3::1' })).status, 200);
});

// The attack on the username limit: guess, then flood the table with throwaway keys from many /64s so the username's
// count is pushed out, and guess again. The table is tiny here so the flood is large relative to it.
withApp('flooding the key table from many addresses does not reset a username\'s failure count', {
  config: { trustProxy: 1 },
  throttle: createLoginThrottle({ maxKeys: 40 })
}, async (t) => {
  const forwarded = (ip) => ({ 'x-forwarded-for': ip });
  let accepted = 0; // wrong guesses at alice that were let through to the password check
  let refused = 0;
  for (let round = 0; round < 6; round += 1) {
    const guesses = await Promise.all(Array.from({ length: 10 }, (_, i) => login(t, 'alice', 'wrong-password-1', forwarded(`10.${round}.0.${i + 1}`))));
    for (const response of guesses) {
      if (response.status === 401) accepted += 1;
      else if (response.status === 429) refused += 1;
      else assert.fail(`unexpected status ${response.status}`);
    }
    // 60 throwaway logins from 60 other /64s, each a new username with a non-string password (a plain failure with no
    // hashing), so each charges three fresh keys: far more than the table holds.
    const flood = await Promise.all(Array.from({ length: 60 }, (_, i) => postJson(`${t.baseUrl}/api/auth/login`, { username: `junk-${round}-${i}`, password: 1 }, forwarded(`2001:db8:${round}:${i}::1`))));
    assert.ok(flood.every((response) => response.status === 401));
  }
  assert.equal(accepted, 25, `${accepted} guesses at alice were let through in one window, against a limit of 25`);
  assert.equal(refused, 35);
  const blocked = await login(t, 'alice', PASSWORD, forwarded('10.9.9.9'));
  assert.equal(blocked.status, 429);
});

// A proxy may append the client's source port to X-Forwarded-For ("1.2.3.4:5678", "[2001:db8::1]:443").
withApp('addresses forwarded with a port are told apart, and a client changing port does not get fresh attempts', { config: { trustProxy: 1 }, users: [['alice', PASSWORD]] }, async (t) => {
  const junkFrom = (forwarded, n) => postJson(`${t.baseUrl}/api/auth/login`, { username: `junk-${n}`, password: 1 }, { 'x-forwarded-for': forwarded });
  for (let i = 0; i < 50; i += 1) {
    assert.equal((await junkFrom(`198.51.100.1:${40000 + i}`, i)).status, 401); // 50 failures, a different port each time
  }
  // Same address, new port: still that client, and it is over its limit.
  const blocked = await login(t, 'alice', PASSWORD, { 'x-forwarded-for': '198.51.100.1:55555' });
  assert.equal(blocked.status, 429);
  // A different address is a different client, whether or not it carries a port.
  assert.equal((await login(t, 'alice', PASSWORD, { 'x-forwarded-for': '198.51.100.2:40000' })).status, 200);
  assert.equal((await login(t, 'alice', PASSWORD, { 'x-forwarded-for': '[2001:db8::7]:443' })).status, 200);
});

// ---------- the credential a session is bound to ----------

withApp('a login that already verified the password cannot open a session after the password was changed', {}, async (t) => {
  const authenticate = t.stores.users.authenticate;
  t.stores.users.authenticate = async (...args) => {
    const verified = await authenticate(...args);
    await t.stores.users.setPassword('alice', 'another-password-2'); // commits between the check and the session insert
    return verified;
  };
  const response = await login(t, 'alice', PASSWORD);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), WRONG_MESSAGE);
  assert.equal(sidCookie(response), undefined);
  assert.equal(await sessionCount(t.pool), 0);

  t.stores.users.authenticate = authenticate;
  assert.equal((await login(t, 'alice', 'another-password-2')).status, 200);
});

withApp('a login that already verified the password cannot open a session after the user was disabled', {}, async (t) => {
  const authenticate = t.stores.users.authenticate;
  t.stores.users.authenticate = async (...args) => {
    const verified = await authenticate(...args);
    await t.stores.users.setActive('alice', false);
    return verified;
  };
  const response = await login(t, 'alice', PASSWORD);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), WRONG_MESSAGE);
  assert.equal(await sessionCount(t.pool), 0);
});

withApp('the stored password hash never appears in a login response, a header or a log line', {}, async (t) => {
  const { password_hash: hash } = (await t.pool.query('select password_hash from users')).rows[0];
  assert.match(hash, /^scrypt\$/);
  const seen = [];
  const lines = await captureConsole(async () => {
    const ok = await login(t, 'alice', PASSWORD);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(Object.keys(body), ['user']);
    assert.deepEqual(Object.keys(body.user).sort(), ['id', 'username']);
    seen.push(JSON.stringify(body), JSON.stringify([...ok.headers]));

    for (const response of [
      await login(t, 'alice', 'wrong-password-1'),
      await login(t, 'nobody', PASSWORD),
      await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie: sidCookie(ok).split(';')[0] } })
    ]) {
      seen.push(await response.text(), JSON.stringify([...response.headers]));
    }
  });
  assert.equal(seen.length, 8);
  for (const text of [...seen, ...lines, ...t.logged]) {
    assert.equal(text.includes(hash), false);
    assert.equal(text.includes('scrypt$'), false);
  }
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
  const denied = await postJson(url, { applicationNo: 'FNHR100001' });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).status, 'UNAUTHORIZED');

  const allowed = await postJson(url, { applicationNo: 'FNHR100001' }, { cookie: await t.cookieFor('alice') });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { status: 'NOT_FOUND', applicationNo: 'FNHR100001' });
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
    const response = await postJson(url, { applicationNo: 'FNHR100001' }, { cookie, origin });
    assert.equal(response.status, 403, origin);
    assert.equal((await response.json()).status, 'FORBIDDEN');
  }

  // The same page's own origin, and requests with no Origin at all (scripts, curl), are fine.
  assert.equal((await postJson(url, { applicationNo: 'FNHR100001' }, { cookie, origin: t.baseUrl })).status, 200);
  assert.equal((await postJson(url, { applicationNo: 'FNHR100001' }, { cookie })).status, 200);
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
  const { session } = await openSession(users, sessions);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.ok(session.expiresAt instanceof Date);
  assert.ok(Math.abs(session.expiresAt.getTime() - (before + 12 * 3600 * 1000)) < 5000);

  const rows = (await pool.query('select token_hash, user_id from sessions')).rows;
  assert.deepEqual(rows, [{ token_hash: sha256(session.token), user_id: alice.id }]);

  const { session: other } = await openSession(users, sessions);
  assert.notEqual(other.token, session.token);
}));

test('resolve returns {id, username} for a live token and null for anything else', () => withStores(async ({ pool, users, sessions }) => {
  const alice = await users.create('alice', PASSWORD);
  const { session: { token } } = await openSession(users, sessions);
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
  await users.create('alice', PASSWORD);
  const { session: first } = await openSession(users, sessions);
  const { session: second } = await openSession(users, sessions);
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
  assert.deepEqual({ id: verified.id, username: verified.username }, alice);

  await users.setActive('alice', false); // commits between the password check and the session insert
  assert.equal(await sessions.create(verified.id, verified.passwordHash), null);
  assert.equal(await sessionCount(pool), 0);

  await users.setActive('alice', true);
  assert.notEqual(await sessions.create(verified.id, verified.passwordHash), null);
}));

test('create returns null, and stores nothing, when the password was changed after it was checked', () => withStores(async ({ pool, users, sessions }) => {
  await users.create('alice', PASSWORD);
  const verified = await users.authenticate('alice', PASSWORD);

  await users.setPassword('alice', 'another-password-2'); // commits between the password check and the session insert
  assert.equal(await sessions.create(verified.id, verified.passwordHash), null);
  assert.equal(await sessionCount(pool), 0);

  // The proof of the new password works, the old one never will again.
  const fresh = await users.authenticate('alice', 'another-password-2');
  assert.notEqual(await sessions.create(fresh.id, fresh.passwordHash), null);
  assert.equal(await sessions.create(verified.id, verified.passwordHash), null);
  assert.equal(await sessionCount(pool), 1);
}));

test('create needs the stored credential: a missing, empty, wrong or non-string one gives null', () => withStores(async ({ pool, users, sessions }) => {
  const alice = await users.create('alice', PASSWORD);
  const bob = await users.create('bob', PASSWORD);
  const verifiedBob = await users.authenticate('bob', PASSWORD);
  for (const hash of [undefined, null, '', 'scrypt$', 123, {}, [], verifiedBob.passwordHash]) { // the last one is bob's, not alice's
    assert.equal(await sessions.create(alice.id, hash), null, String(hash));
  }
  assert.equal(await sessions.create(alice.id), null);
  assert.equal(await sessionCount(pool), 0);
  assert.notEqual(await sessions.create(bob.id, verifiedBob.passwordHash), null);
}));

test('create returns null for a user that does not exist or an id that is not an id', () => withStores(async ({ pool, users, sessions }) => {
  await users.create('alice', PASSWORD);
  const { passwordHash } = await users.authenticate('alice', PASSWORD);
  for (const id of [999999, 0, -1, 1.5, NaN, 'abc', '1', null, undefined, {}]) {
    assert.equal(await sessions.create(id, passwordHash), null, String(id));
  }
  assert.equal(await sessionCount(pool), 0);
}));

test('createSessionStore rejects a ttl that is not a positive number of hours', () => withStores(async ({ pool }) => {
  for (const ttlHours of [0, -1, NaN, Infinity, '12', null]) {
    assert.throws(() => createSessionStore(pool, { ttlHours }), TypeError, String(ttlHours));
  }
}));

test('purgeExpired removes only expired rows and returns how many', () => withStores(async ({ pool, users, sessions }) => {
  await users.create('alice', PASSWORD);
  const { session: live } = await openSession(users, sessions);
  const { session: expiredA } = await openSession(users, sessions);
  const { session: expiredB } = await openSession(users, sessions);
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

test('the login throttle forgive takes back one failure and drops the key at zero', () => {
  const throttle = createLoginThrottle({ maxFailures: 3 });
  throttle.fail('k');
  throttle.fail('k');
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), true);
  throttle.forgive('k');
  assert.equal(throttle.blocked('k'), false);
  throttle.fail('k');
  assert.equal(throttle.blocked('k'), true);
  throttle.forgive('k');
  throttle.forgive('k');
  throttle.forgive('k');
  assert.equal(throttle.size(), 0);
  throttle.forgive('never-seen'); // harmless
  assert.equal(throttle.size(), 0);
});

test('address keys allow 50 failures and username keys 25 by default; other keys keep maxFailures', () => {
  const throttle = createLoginThrottle();
  const failures = (key) => {
    let n = 0;
    while (!throttle.blocked(key)) {
      throttle.fail(key);
      n += 1;
    }
    return n;
  };
  assert.equal(failures('ip:203.0.113.7'), 50);
  assert.equal(failures('user:alice'), 25);
  assert.equal(failures('203.0.113.7|alice'), 5);

  const custom = createLoginThrottle({ maxFailures: 4, maxFailuresPerIp: 3, maxFailuresPerUsername: 2 });
  for (const [key, limit] of [['ip:x', 3], ['user:x', 2], ['x|x', 4]]) {
    for (let i = 0; i < limit - 1; i += 1) custom.fail(key);
    assert.equal(custom.blocked(key), false, key);
    custom.fail(key);
    assert.equal(custom.blocked(key), true, key);
  }
});

test('a blocked key survives any number of new junk keys', () => {
  const throttle = createLoginThrottle();
  for (let i = 0; i < 5; i += 1) throttle.fail('203.0.113.7|alice');
  assert.equal(throttle.blocked('203.0.113.7|alice'), true);

  for (let i = 0; i < 10200; i += 1) throttle.fail(`203.0.113.7|junk${i}`); // more than the default table size
  assert.equal(throttle.blocked('203.0.113.7|alice'), true);
  assert.ok(throttle.size() <= 10000, `size was ${throttle.size()}`);

  // The same with a small table, where a flood is far larger than it.
  const small = createLoginThrottle({ maxFailures: 2, maxKeys: 20 });
  small.fail('a');
  small.fail('a');
  small.fail('ip:b'); // counting, not blocked
  for (let i = 0; i < 500; i += 1) small.fail(`junk${i}`);
  assert.equal(small.blocked('a'), true);
  assert.ok(small.size() <= 20, `size was ${small.size()}`);
});

test('when only blocked keys are left to evict the oldest goes, and the key just recorded is always kept', () => {
  const throttle = createLoginThrottle({ maxFailures: 1, maxKeys: 3 });
  for (const key of ['k1', 'k2', 'k3', 'k4']) throttle.fail(key); // every key is blocked at once
  assert.equal(throttle.size(), 3);
  assert.equal(throttle.blocked('k1'), false); // the oldest
  for (const key of ['k2', 'k3', 'k4']) assert.equal(throttle.blocked(key), true, key);

  // Keys that are only being counted go before any blocked key, even when they are newer.
  const mixed = createLoginThrottle({ maxFailures: 2, maxKeys: 3 });
  mixed.fail('old-blocked');
  mixed.fail('old-blocked');
  mixed.fail('counting-1');
  mixed.fail('counting-2');
  mixed.fail('counting-3');
  assert.equal(mixed.size(), 3);
  assert.equal(mixed.blocked('old-blocked'), true);
  assert.equal(mixed.retryAfterSeconds('counting-1'), 0); // evicted first
  assert.ok(mixed.retryAfterSeconds('counting-3') > 0); // the newest is tracked

  // A new key that is only counting is still recorded when every other key is blocked: the oldest blocked key goes instead.
  const crowded = createLoginThrottle({ maxFailures: 2, maxKeys: 3 });
  for (const key of ['b1', 'b2', 'b3']) {
    crowded.fail(key);
    crowded.fail(key);
  }
  crowded.fail('new');
  assert.equal(crowded.size(), 3);
  assert.ok(crowded.retryAfterSeconds('new') > 0, 'the new key must be tracked, or its failures would never add up');
  assert.equal(crowded.blocked('b1'), false);
  assert.equal(crowded.blocked('b2'), true);
  assert.equal(crowded.blocked('b3'), true);
});

test('keys are evicted by fill ratio: a junk key goes before a nearly full one, and counting keys go before blocked ones', () => {
  const alive = (throttle, key) => throttle.retryAfterSeconds(key) > 0;
  // Limits here: 5 for plain keys, 50 for ip: keys, 25 for user: keys.
  const throttle = createLoginThrottle({ maxKeys: 4 });
  for (let i = 0; i < 5; i += 1) throttle.fail('blocked-old'); // blocked, and the oldest key
  for (let i = 0; i < 20; i += 1) throttle.fail('user:alice'); // 20/25 = 0.8
  for (let i = 0; i < 2; i += 1) throttle.fail('1.2.3.4|bob'); // 2/5 = 0.4
  for (let i = 0; i < 10; i += 1) throttle.fail('ip:1.2.3.4'); // 10/50 = 0.2
  assert.equal(throttle.size(), 4);

  throttle.fail('junk-1'); // 1/5 = 0.2 would tie with ip:1.2.3.4, but is the key just recorded
  assert.equal(throttle.size(), 4);
  assert.equal(alive(throttle, 'ip:1.2.3.4'), false, 'the lowest ratio of the others goes first');
  for (const key of ['blocked-old', 'user:alice', '1.2.3.4|bob', 'junk-1']) assert.equal(alive(throttle, key), true, key);

  throttle.fail('junk-2'); // junk-1 (0.2) is now the lowest, however recent
  assert.equal(alive(throttle, 'junk-1'), false);
  throttle.fail('junk-3');
  assert.equal(alive(throttle, 'junk-2'), false);
  throttle.fail('junk-4');
  assert.equal(alive(throttle, 'junk-3'), false);
  // the 0.4 key follows only when a lower one is not around, and the 0.8 key after it
  for (const key of ['blocked-old', 'user:alice', '1.2.3.4|bob', 'junk-4']) assert.equal(alive(throttle, key), true, key);
  assert.equal(throttle.size(), 4);

  // Equal ratios: the oldest goes first.
  const ties = createLoginThrottle({ maxKeys: 3 });
  ties.fail('t1');
  ties.fail('t2');
  ties.fail('t3');
  ties.fail('t4');
  assert.equal(alive(ties, 't1'), false);
  for (const key of ['t2', 't3', 't4']) assert.equal(alive(ties, key), true, key);

  // Blocked keys are the last resort, oldest first, and a counting key (even a newer, emptier one) is given up first.
  const last = createLoginThrottle({ maxKeys: 3, maxFailures: 2 });
  for (const key of ['b1', 'b2']) {
    last.fail(key);
    last.fail(key);
  }
  last.fail('counting');
  assert.equal(alive(last, 'counting'), true);
  last.fail('newest'); // counting goes, both blocked keys stay
  assert.equal(alive(last, 'counting'), false);
  assert.equal(last.blocked('b1'), true);
  assert.equal(last.blocked('b2'), true);
  last.fail('b3'); // recording b3 pushes out the other counting key, 'newest'
  last.fail('b3'); // and now b3 is blocked too
  assert.equal(alive(last, 'newest'), false);
  last.fail('last-in'); // only blocked keys left besides the new one: the oldest blocked goes
  assert.equal(last.blocked('b1'), false);
  assert.equal(alive(last, 'b1'), false);
  assert.equal(last.blocked('b2'), true);
  assert.equal(last.blocked('b3'), true);
  assert.equal(alive(last, 'last-in'), true);
  assert.equal(last.size(), 3);
});

test('a username key at 24 of 25 survives a flood of fresh junk keys from many addresses', () => {
  // Small table, so the flood is far larger than it: 10,001 junk logins, each charging three fresh keys.
  const throttle = createLoginThrottle({ maxKeys: 100 });
  for (let i = 0; i < 24; i += 1) throttle.fail('user:alice');
  assert.equal(throttle.blocked('user:alice'), false);
  for (let i = 0; i < 10001; i += 1) {
    const address = `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::/64`;
    throttle.fail(`${address}|junk${i}`);
    throttle.fail(`ip:${address}`);
    throttle.fail(`user:junk${i}`);
  }
  assert.ok(throttle.size() <= 100, `size was ${throttle.size()}`);
  throttle.fail('user:alice'); // the 25th failure: still counted on top of the 24 if the key survived
  assert.equal(throttle.blocked('user:alice'), true, 'the 24 earlier failures were forgotten');

  // The same on a table of the default size, filled well past its limit.
  const big = createLoginThrottle();
  for (let i = 0; i < 24; i += 1) big.fail('user:alice');
  for (let i = 0; i < 10100; i += 1) big.fail(['ip:', 'user:', '203.0.113.9|'][i % 3] + `junk${i}`);
  assert.ok(big.size() <= 10000, `size was ${big.size()}`);
  big.fail('user:alice');
  assert.equal(big.blocked('user:alice'), true, 'the 24 earlier failures were forgotten');
});

test('the login throttle does not grow without bound', () => {
  let now = 0;
  const throttle = createLoginThrottle({ windowMs: 1000, now: () => now });
  for (let i = 0; i < 25000; i += 1) {
    throttle.fail(`ip|user${i}`);
    now += 1; // every window is long over before the table fills up
  }
  assert.ok(throttle.size() <= 10000, `size was ${throttle.size()}`);

  // Even when nothing has expired and every key is blocked the table stays capped, and a key that was just recorded is kept.
  now = 0;
  const busy = createLoginThrottle({ maxFailures: 1, windowMs: 1e12, now: () => now });
  for (let i = 0; i < 12000; i += 1) busy.fail(`ip|user${i}`);
  assert.ok(busy.size() <= 10000, `size was ${busy.size()}`);
  assert.equal(busy.blocked('ip|user11999'), true);
});

test('clientAddressKey keys IPv4 by address, IPv4-mapped IPv6 by its IPv4 address and other IPv6 by /64', () => {
  assert.equal(clientAddressKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientAddressKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientAddressKey('::FFFF:203.0.113.7'), '203.0.113.7');
  assert.equal(clientAddressKey('::ffff:cb00:7107'), '203.0.113.7');
  assert.equal(clientAddressKey('0:0:0:0:0:ffff:203.0.113.7'), '203.0.113.7');

  const sixtyFour = clientAddressKey('2001:db8:1:2::1');
  assert.equal(sixtyFour, '2001:db8:1:2::/64');
  for (const same of ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:0DB8:0001:0002:0:0:0:9', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::', '2001:db8:1:2:0:0:1.2.3.4']) {
    assert.equal(clientAddressKey(same), sixtyFour, same);
  }
  for (const other of ['2001:db8:1:3::1', '2001:db8:1::1', '2001:db9:1:2::1', '2001:db8:0:1:2::1']) {
    assert.notEqual(clientAddressKey(other), sixtyFour, other);
  }
  assert.equal(clientAddressKey('::1'), '0:0:0:0::/64');
  assert.equal(clientAddressKey('::'), '0:0:0:0::/64');
  assert.equal(clientAddressKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(clientAddressKey('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');

  // Anything that is not an address shares one key, so inventing values does not give a fresh set of attempts.
  for (const junk of [undefined, null, '', 'not an ip', '999.1.1.1', '1.2.3', '2001:db8::zz', 42, {}, 'x'.repeat(5000)]) {
    assert.equal(clientAddressKey(junk), 'unknown', String(junk).slice(0, 20));
  }
});

test('clientAddressKey strips a port from ipv4:port and [ipv6]:port, and leaves plain addresses alone', () => {
  // plain
  assert.equal(clientAddressKey('1.2.3.4'), '1.2.3.4');
  assert.equal(clientAddressKey('2001:db8::1'), '2001:db8:0:0::/64');
  // with a port
  assert.equal(clientAddressKey('1.2.3.4:5678'), '1.2.3.4');
  assert.equal(clientAddressKey('1.2.3.4:1'), '1.2.3.4');
  assert.equal(clientAddressKey('[2001:db8::1]:443'), '2001:db8:0:0::/64');
  assert.equal(clientAddressKey('[2001:db8:1:2:aaaa:bbbb:cccc:dddd]:65535'), '2001:db8:1:2::/64');
  assert.equal(clientAddressKey('[::ffff:203.0.113.7]:8080'), '203.0.113.7');
  assert.equal(clientAddressKey('[::1]'), '0:0:0:0::/64'); // brackets without a port
  // the port does not matter, the address does
  assert.equal(clientAddressKey('1.2.3.4:80'), clientAddressKey('1.2.3.4:81'));
  assert.equal(clientAddressKey('1.2.3.4:80'), clientAddressKey('1.2.3.4'));
  assert.notEqual(clientAddressKey('1.2.3.4:80'), clientAddressKey('1.2.3.5:80'));
  assert.equal(clientAddressKey('[2001:db8::1]:443'), clientAddressKey('2001:db8::2'));
  assert.notEqual(clientAddressKey('[2001:db8::1]:443'), clientAddressKey('[2001:db8:0:1::1]:443'));

  // not an address plus a port: one shared key, as for any other junk
  for (const junk of ['1.2.3.4:', '1.2.3.4:abc', '1.2.3.4:123456', '1.2.3.4:80:80', '999.1.1.1:80', '[1.2.3.4]:80', '[2001:db8::1', '2001:db8::1]:443', '[2001:db8::1]:', '[2001:db8::zz]:443', '[]:80', ':80', '2001:db8::1:443:x']) {
    assert.equal(clientAddressKey(junk), 'unknown', junk);
  }
});

// ---------- wiring ----------

test('createApp refuses to start without the stores that protect /api', () => {
  assert.throws(() => createApp({ automation: {} }), /users, sessions, throttle and config/);
});
