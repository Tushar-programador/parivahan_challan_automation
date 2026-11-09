const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('../src/passwords');

test('verifies the right password and rejects a wrong one', async () => {
  const stored = await hashPassword('correct-horse-1');
  assert.equal(await verifyPassword('correct-horse-1', stored), true);
  assert.equal(await verifyPassword('correct-horse-2', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('two hashes of the same password differ', async () => {
  const a = await hashPassword('correct-horse-1');
  const b = await hashPassword('correct-horse-1');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct-horse-1', a), true);
  assert.equal(await verifyPassword('correct-horse-1', b), true);
});

test('verifyPassword is false for a malformed stored value', async () => assert.equal(await verifyPassword('x', 'garbage'), false));

test('the stored format is scrypt$N$r$p$salt$hash with a 16-byte random salt and the password nowhere in it', async () => {
  const stored = await hashPassword('correct-horse-1');
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '16384', '8', '1']);
  assert.equal(Buffer.from(parts[4], 'base64').length, 16);
  assert.ok(Buffer.from(parts[5], 'base64').length >= 32);
  assert.ok(!stored.includes('correct-horse-1'));
});

test('passwords with spaces, symbols and non-ASCII characters round-trip exactly', async () => {
  const password = '  päss wörd ☃ !  ';
  const stored = await hashPassword(password);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword(password.trim(), stored), false);
});

test('verifyPassword is false, never a throw, for any malformed stored value or non-string password', async () => {
  const good = await hashPassword('correct-horse-1');
  const [, n, r, p, salt, hash] = good.split('$');
  const malformed = [
    '',
    'garbage',
    'scrypt$',
    'scrypt$16384$8$1$AAAA',
    `scrypt$16384$8$1$${salt}`,
    `scrypt$16384$8$1$${salt}$${hash}$extra`,
    `bcrypt$${n}$${r}$${p}$${salt}$${hash}`,
    `scrypt$abc$${r}$${p}$${salt}$${hash}`,
    `scrypt$${n}$${r}$-1$${salt}$${hash}`,
    `scrypt$${n}$${r}$0$${salt}$${hash}`,
    `scrypt$1000$${r}$${p}$${salt}$${hash}`, // N is not a power of two
    `scrypt$${n}$${r}$${p}$$${hash}`, // empty salt
    `scrypt$${n}$${r}$${p}$${salt}$`, // empty hash
    `scrypt$${n}$${r}$${p}$!!!!$${hash}`, // not base64
    `scrypt$${n}$${r}$${p}$${salt}$!!!!`,
    `scrypt$999999999999$${r}$${p}$${salt}$${hash}`, // not a sane cost value
    `scrypt$1073741824$${r}$${p}$${salt}$${hash}`, // a power of two, but would need far too much memory
    null,
    undefined,
    42,
    {}
  ];
  for (const stored of malformed) {
    assert.equal(await verifyPassword('correct-horse-1', stored), false, String(stored));
  }
  for (const plain of [undefined, null, 42, {}, ['correct-horse-1']]) {
    assert.equal(await verifyPassword(plain, good), false);
  }
});

test('hashPassword refuses a non-string password', async () => {
  await assert.rejects(hashPassword(undefined), TypeError);
  await assert.rejects(hashPassword(12345678901), TypeError);
});

test('hashes are compared with crypto.timingSafeEqual', async (t) => {
  const compare = t.mock.method(crypto, 'timingSafeEqual');
  const stored = await hashPassword('correct-horse-1');
  assert.equal(await verifyPassword('correct-horse-1', stored), true);
  assert.equal(await verifyPassword('wrong-password-1', stored), false);
  assert.equal(compare.mock.callCount(), 2);
});
