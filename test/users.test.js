const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { createTestPool } = require('./helpers/test-app');
const passwords = require('../src/passwords');
const { createUserStore, UserError } = require('../src/users');
const { runUserCli } = require('../src/user-cli');

const PASSWORD = 'correct-horse-1';

// authenticate also hands back the stored hash (see below); most tests only care who the user is.
const identity = (user) => user && { id: user.id, username: user.username };

// Runs a test body with a fresh migrated database and a user store on it; the pool is always closed.
function withStore(name, body) {
  test(name, async (t) => {
    const pool = await createTestPool();
    try {
      await body({ pool, users: createUserStore(pool), t });
    } finally {
      await pool.end();
    }
  });
}

async function addSession(pool, userId, token) {
  await pool.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')", [token, userId]);
}

async function sessionCount(pool, userId) {
  return (await pool.query('select count(*) as n from sessions where user_id = $1', [userId])).rows[0].n;
}

function collector() {
  const lines = [];
  return { lines, print: (line) => lines.push(String(line)) };
}

withStore('create trims and lowercases the username; authenticate then works with any case', async ({ users }) => {
  const created = await users.create('  Alice.Smith  ', PASSWORD);
  assert.deepEqual(created, { id: created.id, username: 'alice.smith' });
  assert.equal(typeof created.id, 'number');
  for (const typed of ['alice.smith', 'ALICE.SMITH', '  Alice.Smith ']) {
    assert.deepEqual(identity(await users.authenticate(typed, PASSWORD)), created, typed);
  }
});

withStore('create rejects a short password and a bad username with UserError INVALID', async ({ users, pool }) => {
  const invalid = (error) => error instanceof UserError && error.code === 'INVALID';
  await assert.rejects(users.create('alice', 'short-pw9'), invalid); // 9 characters
  await users.create('bob', '0123456789'); // exactly 10 is fine
  for (const username of ['', '  ', 'ab', 'a'.repeat(41), 'has space', 'bad/name', 'bad@name', 'café', 'x\ny', undefined, null, 42]) {
    await assert.rejects(users.create(username, PASSWORD), invalid, JSON.stringify(username));
  }
  for (const password of [undefined, null, 12345678901, '']) {
    await assert.rejects(users.create('carol', password), invalid, JSON.stringify(password));
  }
  assert.equal((await pool.query('select count(*) as n from users')).rows[0].n, 1, 'only bob was created');
  assert.ok(new UserError('INVALID', 'x') instanceof Error);
});

withStore('create rejects a duplicate username, ignoring case, with UserError EXISTS', async ({ users, pool }) => {
  await users.create('alice', PASSWORD);
  for (const again of ['alice', 'ALICE', '  Alice  ']) {
    await assert.rejects(users.create(again, 'another-pass-1'), (error) => error instanceof UserError && error.code === 'EXISTS', again);
  }
  assert.equal((await pool.query('select count(*) as n from users')).rows[0].n, 1);
  assert.ok(await users.authenticate('alice', PASSWORD), 'the first account is untouched');
});

withStore('authenticate returns null for unknown user, wrong password and inactive user', async ({ users, pool }) => {
  await users.create('alice', PASSWORD);
  await users.create('bob', PASSWORD);
  await users.setActive('bob', false);
  assert.equal(await users.authenticate('nobody', PASSWORD), null);
  assert.equal(await users.authenticate('alice', 'wrong-password-1'), null);
  assert.equal(await users.authenticate('alice', ''), null);
  assert.equal(await users.authenticate('bob', PASSWORD), null);
  assert.equal(await users.authenticate('', PASSWORD), null);
  assert.equal(await users.authenticate(undefined, undefined), null);
  assert.equal(await users.authenticate('alice', undefined), null);
  assert.equal(await users.authenticate({ $ne: 'x' }, PASSWORD), null);
  const verified = await users.authenticate('alice', PASSWORD);
  assert.deepEqual(Object.keys(verified).sort(), ['id', 'passwordHash', 'username']);
  // passwordHash is the stored scrypt string, so a caller can later prove the password has not changed since.
  const { rows } = await pool.query('select password_hash from users where username = $1', ['alice']);
  assert.equal(verified.passwordHash, rows[0].password_hash);
});

withStore('authenticate checks the password against a dummy hash when the user does not exist, so timing does not reveal usernames', async ({ users, t }) => {
  await users.create('alice', PASSWORD);
  const verify = t.mock.method(passwords, 'verifyPassword');

  await users.authenticate('alice', 'wrong-password-1');
  assert.equal(verify.mock.callCount(), 1);

  await users.authenticate('nobody', 'wrong-password-1');
  assert.equal(verify.mock.callCount(), 2, 'an unknown user costs the same hash work as a known one');
  const dummyStored = verify.mock.calls[1].arguments[1];
  assert.match(dummyStored, /^scrypt\$16384\$8\$1\$/);

  await users.authenticate('', 'wrong-password-1'); // not even a valid username
  assert.equal(verify.mock.callCount(), 3);
});

withStore('an inactive user costs the same hash work as an active one, so timing does not reveal who is disabled', async ({ users, t }) => {
  await users.create('bob', PASSWORD);
  await users.setActive('bob', false);
  const verify = t.mock.method(passwords, 'verifyPassword');
  assert.equal(await users.authenticate('bob', PASSWORD), null);
  assert.equal(verify.mock.callCount(), 1);
});

withStore("setActive(false) deletes that user's sessions and getById returns null", async ({ users, pool }) => {
  const alice = await users.create('alice', PASSWORD);
  const bob = await users.create('bob', PASSWORD);
  await addSession(pool, alice.id, 'alice-1');
  await addSession(pool, alice.id, 'alice-2');
  await addSession(pool, bob.id, 'bob-1');
  assert.deepEqual(await users.getById(alice.id), alice);

  assert.equal(await users.setActive('alice', false), true);

  assert.equal(await sessionCount(pool, alice.id), 0);
  assert.equal(await sessionCount(pool, bob.id), 1, 'other users keep their sessions');
  assert.equal(await users.getById(alice.id), null);
  assert.deepEqual(await users.getById(bob.id), bob);
});

withStore('setActive(true) lets the user in again; setActive and setPassword return false for an unknown user', async ({ users }) => {
  const alice = await users.create('alice', PASSWORD);
  await users.setActive('alice', false);
  assert.equal(await users.authenticate('alice', PASSWORD), null);
  assert.equal(await users.setActive('  ALICE ', true), true);
  assert.deepEqual(identity(await users.authenticate('alice', PASSWORD)), alice);
  assert.deepEqual(await users.getById(alice.id), alice);

  assert.equal(await users.setActive('nobody', false), false);
  assert.equal(await users.setActive('nobody', true), false);
  assert.equal(await users.setPassword('nobody', 'brand-new-pass-1'), false);
  await assert.rejects(users.setActive('alice', 'false'), TypeError, 'a string is not a boolean');
  assert.deepEqual(identity(await users.authenticate('alice', PASSWORD)), alice);
});

withStore("setActive(true) also deletes the user's sessions, so one opened while the user was disabled cannot come back to life", async ({ users, pool }) => {
  const alice = await users.create('alice', PASSWORD);
  const bob = await users.create('bob', PASSWORD);
  await users.setActive('alice', false);
  await addSession(pool, alice.id, 'alice-late'); // a login that raced the disabling: inserted between its DELETE and its COMMIT
  await addSession(pool, bob.id, 'bob-1');
  assert.equal(await sessionCount(pool, alice.id), 1);

  assert.equal(await users.setActive('alice', true), true);

  assert.equal(await sessionCount(pool, alice.id), 0);
  assert.equal(await sessionCount(pool, bob.id), 1, 'other users keep their sessions');
});

withStore('setPassword revokes sessions; the old password fails, the new one works', async ({ users, pool }) => {
  const alice = await users.create('alice', PASSWORD);
  const bob = await users.create('bob', PASSWORD);
  await addSession(pool, alice.id, 'alice-1');
  await addSession(pool, bob.id, 'bob-1');

  assert.equal(await users.setPassword('Alice', 'brand-new-pass-1'), true);

  assert.equal(await sessionCount(pool, alice.id), 0);
  assert.equal(await sessionCount(pool, bob.id), 1);
  assert.equal(await users.authenticate('alice', PASSWORD), null);
  assert.deepEqual(identity(await users.authenticate('alice', 'brand-new-pass-1')), alice);
  assert.deepEqual(identity(await users.authenticate('bob', PASSWORD)), bob, 'other users are unaffected');
});

withStore('setPassword with a short password throws INVALID and changes nothing', async ({ users, pool }) => {
  const alice = await users.create('alice', PASSWORD);
  await addSession(pool, alice.id, 'alice-1');
  await assert.rejects(users.setPassword('alice', 'short'), (error) => error instanceof UserError && error.code === 'INVALID');
  assert.deepEqual(identity(await users.authenticate('alice', PASSWORD)), alice);
  assert.equal(await sessionCount(pool, alice.id), 1);
});

withStore('the password is stored only as a scrypt hash and no query result exposes it', async ({ users, pool }) => {
  const alice = await users.create('alice', PASSWORD);
  const { rows } = await pool.query('select password_hash from users where id = $1', [alice.id]);
  assert.match(rows[0].password_hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!rows[0].password_hash.includes(PASSWORD));

  const everything = JSON.stringify([alice, await users.list(), await users.getById(alice.id), identity(await users.authenticate('alice', PASSWORD))]);
  assert.ok(!everything.includes('scrypt'));
  assert.ok(!everything.includes(PASSWORD));
});

withStore('list returns id, username, isActive and createdAt in creation order', async ({ users }) => {
  assert.deepEqual(await users.list(), []);
  const alice = await users.create('alice', PASSWORD);
  const bob = await users.create('bob', PASSWORD);
  await users.setActive('bob', false);
  const listed = await users.list();
  assert.deepEqual(listed.map((u) => [u.id, u.username, u.isActive]), [[alice.id, 'alice', true], [bob.id, 'bob', false]]);
  for (const user of listed) {
    assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'id', 'isActive', 'username']);
    assert.ok(user.createdAt instanceof Date);
  }
});

withStore('getById is null for an unknown or malformed id', async ({ users }) => {
  await users.create('alice', PASSWORD);
  for (const id of [99999, 0, -1, 1.5, 'abc', '', null, undefined, NaN, {}]) {
    assert.equal(await users.getById(id), null, String(id));
  }
});

withStore('runUserCli create prints a 16 character password once and the user can log in with it', async ({ users }) => {
  const { lines, print } = collector();
  assert.equal(await runUserCli(['create', 'Alice'], { users, print }), 0);

  const passwordLines = lines.filter((line) => /^Password: \S{16}$/.test(line));
  assert.equal(passwordLines.length, 1, lines.join('\n'));
  const password = passwordLines[0].slice('Password: '.length);
  assert.equal(lines.filter((line) => line.includes(password)).length, 1, 'the password appears on exactly one line');
  assert.ok(lines.some((line) => line.includes('alice')), 'the created username is shown');
  assert.ok(await users.authenticate('alice', password));
});

withStore('runUserCli create generates a different password each time', async ({ users }) => {
  const seen = new Set();
  for (const name of ['alice', 'bob', 'carol']) {
    const { lines, print } = collector();
    assert.equal(await runUserCli(['create', name], { users, print }), 0);
    seen.add(lines.find((line) => line.startsWith('Password: ')));
  }
  assert.equal(seen.size, 3);
});

withStore('runUserCli create --password uses that password and never prints it', async ({ users }) => {
  const { lines, print } = collector();
  assert.equal(await runUserCli(['create', 'alice', '--password', 'chosen-pass-123'], { users, print }), 0);
  assert.ok(!lines.join('\n').includes('chosen-pass-123'));
  assert.ok(!lines.some((line) => line.startsWith('Password:')));
  assert.ok(await users.authenticate('alice', 'chosen-pass-123'));
});

withStore('runUserCli create with a short password, a bad username or an existing user exits 1 with a message and no password', async ({ users }) => {
  await users.create('alice', PASSWORD);
  for (const args of [
    ['create', 'bob', '--password', 'short'],
    ['create', 'a b', '--password', 'chosen-pass-123'],
    ['create', 'ALICE', '--password', 'chosen-pass-123'],
    ['create', 'ab']
  ]) {
    const { lines, print } = collector();
    assert.equal(await runUserCli(args, { users, print }), 1, args.join(' '));
    assert.ok(lines.length > 0 && lines.every((line) => !line.startsWith('Password:')), lines.join('\n'));
    assert.ok(!lines.join('\n').includes('chosen-pass-123'));
  }
  assert.equal((await users.list()).length, 1);
});

withStore('runUserCli list shows every user with its status and never a hash', async ({ users }) => {
  await users.create('alice', PASSWORD);
  await users.create('bob', PASSWORD);
  await users.setActive('bob', false);
  const { lines, print } = collector();
  assert.equal(await runUserCli(['list'], { users, print }), 0);
  const text = lines.join('\n');
  assert.match(lines.find((line) => line.includes('alice')), /\bactive\b/);
  assert.match(lines.find((line) => line.includes('bob')), /\bdisabled\b/);
  assert.ok(!text.includes('scrypt'));

  const empty = collector();
  assert.equal(await runUserCli(['list'], { users: { list: async () => [] }, print: empty.print }), 0);
  assert.ok(empty.lines.length > 0, 'an empty list still says something');
});

withStore('runUserCli passwd sets the given password and signs the user out; without --password it prints a new one once', async ({ users, pool }) => {
  const alice = await users.create('alice', PASSWORD);
  await addSession(pool, alice.id, 'alice-1');

  const given = collector();
  assert.equal(await runUserCli(['passwd', 'alice', '--password', 'chosen-pass-123'], { users, print: given.print }), 0);
  assert.ok(!given.lines.join('\n').includes('chosen-pass-123'));
  assert.equal(await sessionCount(pool, alice.id), 0);
  assert.equal(await users.authenticate('alice', PASSWORD), null);
  assert.ok(await users.authenticate('alice', 'chosen-pass-123'));

  const generated = collector();
  assert.equal(await runUserCli(['passwd', 'ALICE'], { users, print: generated.print }), 0);
  const passwordLines = generated.lines.filter((line) => /^Password: \S{16}$/.test(line));
  assert.equal(passwordLines.length, 1);
  assert.ok(await users.authenticate('alice', passwordLines[0].slice('Password: '.length)));
  assert.equal(await users.authenticate('alice', 'chosen-pass-123'), null);
});

withStore('runUserCli passwd, disable and enable exit 1 for an unknown user and 0 otherwise', async ({ users, pool }) => {
  const alice = await users.create('alice', PASSWORD);
  await addSession(pool, alice.id, 'alice-1');
  for (const args of [['passwd', 'nobody'], ['disable', 'nobody'], ['enable', 'nobody'], ['passwd', 'alice', '--password', 'short']]) {
    const { lines, print } = collector();
    assert.equal(await runUserCli(args, { users, print }), 1, args.join(' '));
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => !line.startsWith('Password:')));
  }
  assert.ok(await users.authenticate('alice', PASSWORD), 'a failed passwd changes nothing');
  assert.equal(await sessionCount(pool, alice.id), 1);

  assert.equal(await runUserCli(['disable', 'ALICE'], { users, print: collector().print }), 0);
  assert.equal(await users.authenticate('alice', PASSWORD), null);
  assert.equal(await sessionCount(pool, alice.id), 0);
  assert.equal(await runUserCli(['enable', 'alice'], { users, print: collector().print }), 0);
  assert.ok(await users.authenticate('alice', PASSWORD));
});

withStore('runUserCli exits 1 with a message for an unknown command', async ({ users }) => {
  for (const args of [['frobnicate'], []]) {
    const { lines, print } = collector();
    assert.equal(await runUserCli(args, { users, print }), 1, JSON.stringify(args));
    assert.ok(lines.some((line) => /usage/i.test(line)), lines.join('\n'));
  }
  for (const args of [['--help'], ['-h'], ['help']]) {
    const { lines, print } = collector();
    assert.equal(await runUserCli(args, { users, print }), 0, JSON.stringify(args));
    assert.ok(lines.some((line) => /usage/i.test(line)));
  }
  const { lines, print } = collector();
  assert.equal(await runUserCli(['frobnicate'], { users, print }), 1);
  assert.ok(lines.some((line) => line.includes('frobnicate')), 'the unknown command is named');
});

withStore('runUserCli rejects a missing username, extra arguments, a missing --password value and unknown options', async ({ users }) => {
  for (const args of [
    ['create'],
    ['create', 'alice', 'bob'],
    ['create', 'alice', '--password'],
    ['create', 'alice', '--passwrod', 'chosen-pass-123'],
    ['list', 'alice'],
    ['disable'],
    ['enable', 'alice', 'bob'],
    ['passwd']
  ]) {
    const { lines, print } = collector();
    assert.equal(await runUserCli(args, { users, print }), 1, args.join(' '));
    assert.ok(lines.some((line) => /usage/i.test(line)), args.join(' '));
  }
  assert.deepEqual(await users.list(), [], 'nothing was created');
});

test('user-cli.js does nothing when required; run directly without DATABASE_URL it exits 1 naming the variable', async () => {
  const script = path.join(__dirname, '..', 'src', 'user-cli.js');
  const env = { ...process.env, DATABASE_URL: '' };
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [script, 'list'], { env, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DATABASE_URL/);
  assert.ok(!/at .*\.js:\d+/.test(result.stderr), 'no stack trace');
});
