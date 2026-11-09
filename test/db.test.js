const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPool, migrate } = require('../src/db');
const { createTestPool } = require('./helpers/test-app');

test('loadConfig requires DATABASE_URL', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test('loadConfig defaults', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x' });
  assert.equal(c.databaseUrl, 'postgres://x');
  assert.deepEqual(
    [c.port, c.host, c.databaseSsl, c.sessionTtlHours, c.cookieSecure, c.trustProxy, c.brandName, c.finalBankStatuses, c.enableManualCaptcha],
    [3000, '127.0.0.1', false, 12, false, false, 'Records', ['SUCCESS'], false]
  );
});

test('cookieSecure defaults to true in production; TRUST_PROXY=2 is the number 2; DATABASE_SSL=no-verify is kept', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  assert.equal(loadConfig({ ...base, NODE_ENV: 'production' }).cookieSecure, true);
  assert.equal(loadConfig({ ...base, NODE_ENV: 'development' }).cookieSecure, false);
  assert.equal(loadConfig({ ...base, TRUST_PROXY: '2' }).trustProxy, 2);
  assert.equal(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ ...base, TRUST_PROXY: '' }).trustProxy, false);
  assert.equal(loadConfig({ ...base, DATABASE_SSL: 'no-verify' }).databaseSsl, 'no-verify');
  assert.equal(loadConfig({ ...base, DATABASE_SSL: 'true' }).databaseSsl, true);
  assert.equal(loadConfig({ ...base, DATABASE_SSL: 'false' }).databaseSsl, false);
});

test('port, host, session lifetime and brand name come from the environment', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x', PORT: '8080', HOST: '0.0.0.0', SESSION_TTL_HOURS: '24', BRAND_NAME: 'Acme Records' });
  assert.deepEqual([c.port, c.host, c.sessionTtlHours, c.brandName], [8080, '0.0.0.0', 24, 'Acme Records']);
});

test('FINAL_BANK_STATUSES=" success , Paid " becomes ["SUCCESS","PAID"]; ENABLE_MANUAL_CAPTCHA=true turns it on', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  assert.deepEqual(loadConfig({ ...base, FINAL_BANK_STATUSES: ' success , Paid ' }).finalBankStatuses, ['SUCCESS', 'PAID']);
  assert.deepEqual(loadConfig({ ...base, FINAL_BANK_STATUSES: '' }).finalBankStatuses, ['SUCCESS']);
  assert.equal(loadConfig({ ...base, ENABLE_MANUAL_CAPTCHA: 'true' }).enableManualCaptcha, true);
  assert.equal(loadConfig({ ...base, ENABLE_MANUAL_CAPTCHA: 'yes' }).enableManualCaptcha, false);
});

const BASE_ENV = { DATABASE_URL: 'postgres://x' };

test('DATABASE_URL is trimmed, and blank counts as missing', () => {
  assert.equal(loadConfig({ DATABASE_URL: '  postgres://x  ' }).databaseUrl, 'postgres://x');
  for (const value of ['', ' ', '   \t ']) {
    assert.throws(() => loadConfig({ DATABASE_URL: value }), /DATABASE_URL/, JSON.stringify(value));
  }
});

test('DATABASE_SSL accepts only unset/empty, false, true and no-verify; anything else throws naming the variable', () => {
  assert.equal(loadConfig(BASE_ENV).databaseSsl, false);
  assert.equal(loadConfig({ ...BASE_ENV, DATABASE_SSL: '' }).databaseSsl, false);
  assert.equal(loadConfig({ ...BASE_ENV, DATABASE_SSL: 'false' }).databaseSsl, false);
  assert.equal(loadConfig({ ...BASE_ENV, DATABASE_SSL: 'true' }).databaseSsl, true);
  assert.equal(loadConfig({ ...BASE_ENV, DATABASE_SSL: 'no-verify' }).databaseSsl, 'no-verify');
  for (const value of ['TRUE', 'True', 'require', '1', 'yes', 'on', ' true', 'true ', 'No-Verify', ' ']) {
    assert.throws(() => loadConfig({ ...BASE_ENV, DATABASE_SSL: value }), /DATABASE_SSL/, JSON.stringify(value));
  }
});

test('SESSION_TTL_HOURS is a positive number (decimals allowed); empty means 12; anything else throws naming the variable', () => {
  assert.equal(loadConfig(BASE_ENV).sessionTtlHours, 12);
  assert.equal(loadConfig({ ...BASE_ENV, SESSION_TTL_HOURS: '' }).sessionTtlHours, 12);
  assert.equal(loadConfig({ ...BASE_ENV, SESSION_TTL_HOURS: '24' }).sessionTtlHours, 24);
  assert.equal(loadConfig({ ...BASE_ENV, SESSION_TTL_HOURS: '0.5' }).sessionTtlHours, 0.5);
  for (const value of ['2h', 'abc', '0', '0.0', '-1', 'NaN', 'Infinity', '1e3', '0x10', ' ', '1,5']) {
    assert.throws(() => loadConfig({ ...BASE_ENV, SESSION_TTL_HOURS: value }), /SESSION_TTL_HOURS must be a positive number/, JSON.stringify(value));
  }
});

test('TRUST_PROXY accepts unset/empty, true, false and a non-negative integer; anything else throws naming the variable', () => {
  assert.equal(loadConfig(BASE_ENV).trustProxy, false);
  assert.equal(loadConfig({ ...BASE_ENV, TRUST_PROXY: '' }).trustProxy, false);
  assert.equal(loadConfig({ ...BASE_ENV, TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(loadConfig({ ...BASE_ENV, TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ ...BASE_ENV, TRUST_PROXY: '0' }).trustProxy, 0);
  assert.equal(loadConfig({ ...BASE_ENV, TRUST_PROXY: '2' }).trustProxy, 2);
  for (const value of ['TRUE', 'True', 'yes', '1.5', '-1', 'abc', '1 hop', ' ', ' 2']) {
    assert.throws(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: value }), /TRUST_PROXY/, JSON.stringify(value));
  }
});

test('PORT is an integer from 1 to 65535; empty means 3000; anything else throws naming the variable', () => {
  assert.equal(loadConfig(BASE_ENV).port, 3000);
  assert.equal(loadConfig({ ...BASE_ENV, PORT: '' }).port, 3000);
  assert.equal(loadConfig({ ...BASE_ENV, PORT: '1' }).port, 1);
  assert.equal(loadConfig({ ...BASE_ENV, PORT: '8080' }).port, 8080);
  assert.equal(loadConfig({ ...BASE_ENV, PORT: '65535' }).port, 65535);
  for (const value of ['0', '65536', '70000', '80.5', '-1', 'abc', '80a', ' ', ' 80', '1e3']) {
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: value }), /PORT must be a whole number from 1 to 65535/, JSON.stringify(value));
  }
});

test('config errors never echo the rejected value', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, DATABASE_SSL: 'sekrit-value' }),
    (error) => /DATABASE_SSL/.test(error.message) && !error.message.includes('sekrit-value')
  );
});

test('migrate creates users, sessions, records, client_records and a second run applies nothing', async () => {
  const pool = await createTestPool({ migrate: false });
  try {
    assert.deepEqual(await migrate(pool), ['001_init.sql']);
    assert.deepEqual(await migrate(pool), []);
    for (const table of ['users', 'sessions', 'records', 'client_records']) {
      const { rows } = await pool.query(`select count(*) as n from ${table}`);
      assert.equal(rows[0].n, 0, `${table} should exist and be empty`);
    }
    const { rows } = await pool.query('select name from schema_migrations order by name');
    assert.deepEqual(rows.map((r) => r.name), ['001_init.sql']);
  } finally {
    await pool.end();
  }
});

test('createTestPool applies migrations by default', async () => {
  const pool = await createTestPool();
  try {
    assert.deepEqual(await migrate(pool), []);
  } finally {
    await pool.end();
  }
});

test('a second records row for the same application_no violates the unique key', async () => {
  const pool = await createTestPool();
  try {
    await pool.query("insert into records (application_no) values ('AP-1')");
    await assert.rejects(
      pool.query("insert into records (application_no) values ('AP-1')"),
      (error) => error.code === '23505'
    );
  } finally {
    await pool.end();
  }
});

test('deleting a user removes their sessions and client_records but keeps the shared records', async () => {
  const pool = await createTestPool();
  try {
    const user = (await pool.query("insert into users (username, password_hash) values ('alice', 'x') returning id")).rows[0];
    const record = (await pool.query("insert into records (application_no) values ('AP-1') returning id")).rows[0];
    await pool.query("insert into sessions (token_hash, user_id, expires_at) values ('t', $1, now() + interval '1 hour')", [user.id]);
    await pool.query('insert into client_records (user_id, record_id) values ($1, $2)', [user.id, record.id]);

    await pool.query('delete from users where id = $1', [user.id]);

    assert.equal((await pool.query('select count(*) as n from sessions')).rows[0].n, 0);
    assert.equal((await pool.query('select count(*) as n from client_records')).rows[0].n, 0);
    assert.equal((await pool.query('select count(*) as n from records')).rows[0].n, 1);
  } finally {
    await pool.end();
  }
});

// pg-mem already returns numbers for bigint, so the test below cannot prove the parser. This one can, with no database.
test('src/db.js registers a parser that turns int8 text into a JS number', () => {
  const { types } = require('pg');
  assert.strictEqual(types.getTypeParser(types.builtins.INT8)('42'), 42);
  assert.strictEqual(types.getTypeParser(types.builtins.INT8, 'text')('9007199254740991'), 9007199254740991);
});

test('ids and counts come back as numbers', async () => {
  const pool = await createTestPool();
  try {
    const { rows } = await pool.query("insert into users (username, password_hash) values ('bob', 'x') returning id");
    assert.equal(typeof rows[0].id, 'number');
    const count = (await pool.query('select count(*) as n from users')).rows[0].n;
    assert.equal(typeof count, 'number');
    assert.equal(count, 1);
  } finally {
    await pool.end();
  }
});

test('records and client_records default their text and timestamp columns', async () => {
  const pool = await createTestPool();
  try {
    const user = (await pool.query("insert into users (username, password_hash) values ('carol', 'x') returning id, is_active, created_at")).rows[0];
    assert.equal(user.is_active, true);
    assert.ok(user.created_at instanceof Date);
    const record = (await pool.query("insert into records (application_no) values ('AP-2') returning *")).rows[0];
    for (const column of ['vehicle_no', 'transaction_no', 'payment_id', 'payment_date', 'payment_confirmation_date', 'payment_gateway', 'bank_ref_no', 'grn', 'cin', 'amount', 'bank_status', 'status_description']) {
      assert.equal(record[column], '', `${column} defaults to an empty string`);
    }
    assert.ok(record.first_found_at instanceof Date);
    assert.ok(record.last_found_at instanceof Date);
    const link = (await pool.query('insert into client_records (user_id, record_id) values ($1, $2) returning *', [user.id, record.id])).rows[0];
    assert.ok(link.first_requested_at instanceof Date);
    assert.ok(link.last_requested_at instanceof Date);
    await assert.rejects(
      pool.query('insert into client_records (user_id, record_id) values ($1, $2)', [user.id, record.id]),
      (error) => error.code === '23505'
    );
  } finally {
    await pool.end();
  }
});

test('createPool maps databaseSsl to the pg ssl option', async () => {
  const options = [false, true, 'no-verify'].map((databaseSsl) => {
    const pool = createPool({ databaseUrl: 'postgres://u:p@127.0.0.1:1/db', databaseSsl });
    const ssl = pool.options.ssl;
    pool.end();
    return ssl;
  });
  assert.deepEqual(options, [undefined, { rejectUnauthorized: true }, { rejectUnauthorized: false }]);
});

test('migrate applies files in name order, ignores non-sql files and leaves nothing behind from a failing file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrations-'));
  const pool = await createTestPool({ migrate: false });
  try {
    await fs.writeFile(path.join(dir, '002_second.sql'), 'create table second_t (id bigint);');
    await fs.writeFile(path.join(dir, '001_first.sql'), 'create table first_t (id bigint);');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not a migration');
    assert.deepEqual(await migrate(pool, dir), ['001_first.sql', '002_second.sql']);

    await fs.writeFile(path.join(dir, '003_broken.sql'), 'insert into first_t (id) values (1); insert into missing_table values (1);');
    await assert.rejects(migrate(pool, dir));
    assert.deepEqual((await pool.query('select name from schema_migrations order by name')).rows.map((r) => r.name), ['001_first.sql', '002_second.sql']);
    assert.equal((await pool.query('select count(*) as n from first_t')).rows[0].n, 0, 'the failing migration must leave nothing behind');

    await fs.writeFile(path.join(dir, '003_broken.sql'), 'insert into first_t (id) values (1);');
    assert.deepEqual(await migrate(pool, dir), ['003_broken.sql']);
  } finally {
    await pool.end();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
