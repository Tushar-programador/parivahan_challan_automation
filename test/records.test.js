const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestPool, foundResult } = require('./helpers/test-app');
const { createRecordStore } = require('../src/records');

let pool;
let store;
let u1;
let u2;

test.before(async () => {
  pool = await createTestPool();
  store = createRecordStore(pool);
  // Plain inserts: these tests are about records, not about password hashing.
  u1 = (await pool.query("insert into users (username, password_hash) values ('u1', 'x') returning id")).rows[0].id;
  u2 = (await pool.query("insert into users (username, password_hash) values ('u2', 'x') returning id")).rows[0].id;
});

test.beforeEach(async () => {
  await pool.query('delete from client_records');
  await pool.query('delete from records');
});

test.after(async () => {
  await pool.end();
});

async function count(table) {
  return (await pool.query(`select count(*) as n from ${table}`)).rows[0].n;
}

// Pins when a user last asked for a record, so ordering tests do not depend on the clock.
async function setRequestedAt(userId, recordId, iso) {
  await pool.query('update client_records set last_requested_at = $3 where user_id = $1 and record_id = $2', [userId, recordId, iso]);
}

const applicationNos = (items) => items.map((item) => item.applicationNo);

test('saveFound stores a FOUND result and get returns it', async () => {
  const result = foundResult('FNHR1', {
    transactionNo: 'T-1',
    paymentId: 'P-1',
    paymentDate: '01-10-2026',
    paymentConfirmationDate: '02-10-2026',
    paymentGateway: 'GW',
    bankRefNo: 'B-1',
    grn: 'G-1',
    cin: 'C-1'
  });
  const saved = await store.saveFound(result);

  assert.equal(typeof saved.id, 'number');
  assert.ok(saved.firstFoundAt instanceof Date);
  assert.ok(saved.lastFoundAt instanceof Date);
  assert.deepEqual(
    { ...saved, id: undefined, firstFoundAt: undefined, lastFoundAt: undefined },
    {
      id: undefined,
      applicationNo: 'FNHR1',
      vehicleNo: 'HR31V0031',
      transactionNo: 'T-1',
      paymentId: 'P-1',
      paymentDate: '01-10-2026',
      paymentConfirmationDate: '02-10-2026',
      paymentGateway: 'GW',
      bankRefNo: 'B-1',
      grn: 'G-1',
      cin: 'C-1',
      amount: '500',
      bankStatus: 'SUCCESS',
      statusDescription: 'Paid',
      firstFoundAt: undefined,
      lastFoundAt: undefined
    }
  );
  assert.deepEqual(Object.keys(saved).sort(), [
    'amount', 'applicationNo', 'bankRefNo', 'bankStatus', 'cin', 'firstFoundAt', 'grn', 'id', 'lastFoundAt',
    'paymentConfirmationDate', 'paymentDate', 'paymentGateway', 'paymentId', 'statusDescription', 'transactionNo', 'vehicleNo'
  ]);
  assert.deepEqual(await store.get('FNHR1'), saved);
  assert.equal(await count('records'), 1);
});

test('fields the portal did not send are stored as empty text', async () => {
  const saved = await store.saveFound({ status: 'FOUND', applicationNo: 'FNHR1', data: { vehicleNo: 'HR31V0031' } });
  assert.equal(saved.vehicleNo, 'HR31V0031');
  for (const field of ['transactionNo', 'paymentId', 'paymentDate', 'paymentConfirmationDate', 'paymentGateway', 'bankRefNo', 'grn', 'cin', 'amount', 'bankStatus', 'statusDescription']) {
    assert.equal(saved[field], '', field);
  }
});

test('saveFound stores nothing for any other status', async () => {
  for (const status of ['NOT_FOUND', 'INVALID_INPUT', 'TIMEOUT', 'WEBSITE_ERROR', 'CAPTCHA_REQUIRED', 'CANCELLED']) {
    assert.equal(await store.saveFound({ status, applicationNo: 'FNHR1' }), null, status);
    // Even with data attached, only the FOUND status is ever stored.
    assert.equal(await store.saveFound({ ...foundResult('FNHR1'), status }), null, `${status} with data`);
  }
  assert.equal(await count('records'), 0);
});

test('saveFound does not touch the database when there is nothing to store', async () => {
  const untouched = {
    query() { throw new Error('the database must not be used'); },
    connect() { throw new Error('the database must not be used'); }
  };
  const idle = createRecordStore(untouched);
  assert.equal(await idle.saveFound({ status: 'NOT_FOUND', applicationNo: 'FNHR1' }), null);
  assert.equal(await idle.saveFound({ status: 'FOUND', applicationNo: 'FNHR1' }), null);
  assert.equal(await idle.saveFound(null), null);
  assert.equal(await idle.saveFound(undefined), null);
});

test('a FOUND result without data is not stored', async () => {
  assert.equal(await store.saveFound({ status: 'FOUND', applicationNo: 'FNHR1' }), null);
  assert.equal(await store.saveFound({ status: 'FOUND', applicationNo: 'FNHR1', data: null }), null);
  assert.equal(await count('records'), 0);
});

test('saveFound takes the number from data.applicationNo when the result has none', async () => {
  const result = foundResult('', { applicationNo: ' fnhr9 ' });
  const saved = await store.saveFound(result);
  assert.equal(saved.applicationNo, 'FNHR9');
  assert.deepEqual(await store.get('FNHR9'), saved);
});

test('a FOUND result with no application number at all is not stored', async () => {
  assert.equal(await store.saveFound(foundResult('')), null);
  assert.equal(await store.saveFound(foundResult('   ')), null);
  assert.equal(await count('records'), 0);
});

test('get returns null for an unknown or empty number', async () => {
  assert.equal(await store.get('NOPE123'), null);
  assert.equal(await store.get(''), null);
  assert.equal(await store.get(undefined), null);
});

test('saving the same number again refreshes the row: amount 500 -> 600, one row, firstFoundAt kept, lastFoundAt >= firstFoundAt', async () => {
  const first = await store.saveFound(foundResult('FNHR1', { transactionNo: 'T-1', grn: 'G-1' }));
  assert.equal(first.amount, '500');
  await new Promise((resolve) => setTimeout(resolve, 25));

  const second = await store.saveFound(foundResult('FNHR1', { amount: '600', statusDescription: 'Paid again', grn: '' }));

  assert.equal(await count('records'), 1);
  assert.equal(second.id, first.id);
  assert.equal(second.amount, '600');
  assert.equal(second.statusDescription, 'Paid again');
  // Every field is overwritten, including one that is now empty.
  assert.equal(second.transactionNo, '');
  assert.equal(second.grn, '');
  assert.equal(second.firstFoundAt.getTime(), first.firstFoundAt.getTime());
  assert.ok(second.lastFoundAt >= second.firstFoundAt);
  assert.ok(second.lastFoundAt > first.lastFoundAt, 'lastFoundAt moves forward');
  assert.deepEqual(await store.get('FNHR1'), second);
});

test('" fnhr1 " and "FNHR1" are the same record, stored as FNHR1', async () => {
  const first = await store.saveFound(foundResult(' fnhr1 '));
  const second = await store.saveFound(foundResult('FNHR1', { amount: '700' }));

  assert.equal(first.applicationNo, 'FNHR1');
  assert.equal(second.id, first.id);
  assert.equal(await count('records'), 1);
  assert.equal((await pool.query('select application_no from records')).rows[0].application_no, 'FNHR1');
  assert.equal((await store.get(' fnhr1 ')).amount, '700');
  assert.equal((await store.get('FnHr1')).id, first.id);
});

test('two saveFound calls at the same moment for one number both resolve and leave one row', async () => {
  const result = foundResult('FNHR1');
  const [a, b] = await Promise.all([store.saveFound(result), store.saveFound(result)]);

  assert.equal(a.applicationNo, 'FNHR1');
  assert.equal(b.id, a.id);
  assert.equal(await count('records'), 1);
});

test("link makes the record appear in that user's list; linking twice leaves one entry", async () => {
  const saved = await store.saveFound(foundResult('FNHR1'));
  assert.deepEqual(await store.list(u1, {}), { items: [], total: 0 });

  assert.equal(await store.link(u1, saved.id), undefined);
  await store.link(u1, saved.id);

  assert.deepEqual(await store.list(u1, {}), { items: [saved], total: 1 });
  assert.deepEqual(await store.all(u1, {}), [saved]);
  assert.equal(await count('client_records'), 1);
});

test('linking again moves the record to the top of the list', async () => {
  const a = await store.saveFound(foundResult('FNHR1'));
  const b = await store.saveFound(foundResult('FNHR2'));
  await store.link(u1, a.id);
  await store.link(u1, b.id);
  await setRequestedAt(u1, a.id, '2026-01-01T00:00:00Z');
  await setRequestedAt(u1, b.id, '2026-01-02T00:00:00Z');
  assert.deepEqual(applicationNos((await store.list(u1, {})).items), ['FNHR2', 'FNHR1']);

  await store.link(u1, a.id);

  assert.deepEqual(applicationNos((await store.list(u1, {})).items), ['FNHR1', 'FNHR2']);
  const { rows } = await pool.query('select first_requested_at, last_requested_at from client_records where user_id = $1 and record_id = $2', [u1, a.id]);
  assert.ok(rows[0].last_requested_at > rows[0].first_requested_at, 'last_requested_at moved, first_requested_at stayed');
});

test("another user's list and export are empty even though the shared record exists", async () => {
  const saved = await store.saveFound(foundResult('FNHR1'));
  await store.link(u1, saved.id);

  assert.deepEqual(await store.list(u2, {}), { items: [], total: 0 });
  assert.deepEqual(await store.all(u2, {}), []);
  assert.equal(await store.get('FNHR1').then((record) => record.id), saved.id);

  await store.link(u2, (await store.saveFound(foundResult('FNHR2'))).id);
  assert.deepEqual(applicationNos((await store.list(u1, {})).items), ['FNHR1']);
  assert.deepEqual(applicationNos((await store.list(u2, {})).items), ['FNHR2']);
  assert.deepEqual(applicationNos(await store.all(u2, {})), ['FNHR2']);
});

test("unlink by a user who has no link returns false and the owner's entry survives", async () => {
  const saved = await store.saveFound(foundResult('FNHR1'));
  await store.link(u1, saved.id);

  assert.equal(await store.unlink(u2, saved.id), false);

  assert.deepEqual(await store.list(u1, {}), { items: [saved], total: 1 });
  assert.equal(await count('client_records'), 1);
});

test('unlink by the owner returns true, drops the list entry, and the shared record is still readable with get', async () => {
  const saved = await store.saveFound(foundResult('FNHR1'));
  const other = await store.saveFound(foundResult('FNHR2'));
  await store.link(u1, saved.id);
  await store.link(u1, other.id);
  await store.link(u2, saved.id);

  assert.equal(await store.unlink(u1, saved.id), true);

  assert.deepEqual(applicationNos((await store.list(u1, {})).items), ['FNHR2']);
  assert.deepEqual(applicationNos((await store.list(u2, {})).items), ['FNHR1'], "the other user's link is untouched");
  assert.deepEqual(await store.get('FNHR1'), saved);
  assert.equal(await count('records'), 2);
  assert.equal(await store.unlink(u1, saved.id), false, 'a second unlink finds nothing');
});

test('q matches vehicle and application number case-insensitively, and "%" matches nothing', async () => {
  const records = [
    await store.saveFound(foundResult('FNHR1', { vehicleNo: 'HR31V0031' })),
    await store.saveFound(foundResult('FNHR2', { vehicleNo: 'DL01AB1234' })),
    await store.saveFound(foundResult('XYZ-77', { vehicleNo: 'MH12ZZ9999' }))
  ];
  for (const record of records) await store.link(u1, record.id);
  const found = async (q) => applicationNos((await store.list(u1, { q })).items).sort();

  assert.deepEqual(await found(''), ['FNHR1', 'FNHR2', 'XYZ-77']);
  assert.deepEqual(await found('fnhr'), ['FNHR1', 'FNHR2'], 'application number, lower case');
  assert.deepEqual(await found('FnHr2'), ['FNHR2']);
  assert.deepEqual(await found('hr31v'), ['FNHR1'], 'vehicle number, lower case');
  assert.deepEqual(await found('01ab'), ['FNHR2'], 'a substring from the middle');
  assert.deepEqual(await found('xyz-'), ['XYZ-77']);
  assert.deepEqual(await found('nothing like this'), []);
  assert.deepEqual(await found('  fnhr1  '), ['FNHR1'], 'surrounding spaces are ignored');

  // "%" and "_" are plain characters, not wildcards; none of the stored values contain them.
  assert.deepEqual(await found('%'), []);
  assert.deepEqual(await found('FN%'), []);
  assert.deepEqual(await found('FNHR_'), []);
  assert.deepEqual(await found('_'), []);
  assert.deepEqual(await found('\\'), []);
  assert.deepEqual(await found("x' or '1'='1"), []);
  assert.deepEqual(await store.list(u1, { q: '%' }), { items: [], total: 0 });

  // The same filter applies to the export, and only to this user's links.
  assert.deepEqual(applicationNos(await store.all(u1, { q: 'fnhr' })).sort(), ['FNHR1', 'FNHR2']);
  assert.deepEqual(await store.all(u1, { q: '%' }), []);
  assert.deepEqual(await store.all(u2, { q: 'fnhr' }), []);
  assert.equal((await store.list(u1, { q: 'fnhr' })).total, 2, 'total counts the matches, not every link');
});

// pg-mem's LIKE has no escape support (a backslash is just a character to it), so searching for stored values that
// contain "%", "_" or a backslash can only be checked on real Postgres. The "%" and "_" cases above pass on both.
const REAL_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);
test('q finds stored values that contain "%", "_" or a backslash, and only those', { skip: REAL_POSTGRES ? false : 'needs real Postgres (TEST_DATABASE_URL): pg-mem LIKE has no escape' }, async () => {
  const odd = await store.saveFound(foundResult('ODD%_\\1', { vehicleNo: '50%' }));
  const plain = await store.saveFound(foundResult('ODDXY1', { vehicleNo: '500' }));
  await store.link(u1, odd.id);
  await store.link(u1, plain.id);
  const found = async (q) => applicationNos((await store.list(u1, { q })).items);

  assert.deepEqual(await found('ODD%_\\1'), ['ODD%_\\1']);
  assert.deepEqual(await found('%_'), ['ODD%_\\1']);
  assert.deepEqual(await found('50%'), ['ODD%_\\1']);
  assert.deepEqual((await found('odd')).sort(), ['ODD%_\\1', 'ODDXY1']);
  assert.deepEqual(await found('%'), ['ODD%_\\1'], 'only the record that really contains a percent sign');
});

test('limit/offset page newest-requested first and total is the full count', async () => {
  const a = await store.saveFound(foundResult('FNHR1'));
  const b = await store.saveFound(foundResult('FNHR2'));
  const c = await store.saveFound(foundResult('FNHR3'));
  // Linked in an order that differs from the record ids, so the ordering is by request time.
  await store.link(u1, b.id);
  await store.link(u1, c.id);
  await store.link(u1, a.id);
  await setRequestedAt(u1, b.id, '2026-01-01T00:00:00Z');
  await setRequestedAt(u1, c.id, '2026-01-02T00:00:00Z');
  await setRequestedAt(u1, a.id, '2026-01-03T00:00:00Z');

  const firstPage = await store.list(u1, { limit: 2, offset: 0 });
  assert.deepEqual(applicationNos(firstPage.items), ['FNHR1', 'FNHR3']);
  assert.equal(firstPage.total, 3);

  const lastPage = await store.list(u1, { limit: 2, offset: 2 });
  assert.deepEqual(applicationNos(lastPage.items), ['FNHR2']);
  assert.equal(lastPage.total, 3);

  const past = await store.list(u1, { limit: 2, offset: 10 });
  assert.deepEqual(past, { items: [], total: 3 });

  assert.deepEqual(applicationNos(await store.all(u1, {})), ['FNHR1', 'FNHR3', 'FNHR2']);
  assert.deepEqual(applicationNos(await store.all(u1, { limit: 2 })), ['FNHR1', 'FNHR3']);
});

test('list defaults to 50 items and requests with the same time come back highest record id first', async () => {
  const saved = [];
  for (let i = 1; i <= 3; i += 1) saved.push(await store.saveFound(foundResult(`FNHR${i}`)));
  for (const record of saved) await store.link(u1, record.id);
  for (const record of saved) await setRequestedAt(u1, record.id, '2026-01-01T00:00:00Z');

  assert.deepEqual(applicationNos((await store.list(u1)).items), ['FNHR3', 'FNHR2', 'FNHR1']);
  assert.deepEqual(applicationNos((await store.list(u1, {})).items), ['FNHR3', 'FNHR2', 'FNHR1']);
  assert.deepEqual(applicationNos(await store.all(u1)), ['FNHR3', 'FNHR2', 'FNHR1']);
  assert.deepEqual(applicationNos((await store.list(u1, { limit: 1, offset: 1 })).items), ['FNHR2']);
});

test('list and all handle limits that are not usable numbers by using the defaults', async () => {
  const saved = await store.saveFound(foundResult('FNHR1'));
  await store.link(u1, saved.id);

  for (const limit of [-1, 1.5, NaN, 'abc', null]) {
    assert.deepEqual(applicationNos((await store.list(u1, { limit })).items), ['FNHR1'], `limit ${limit}`);
    assert.deepEqual(applicationNos(await store.all(u1, { limit })), ['FNHR1'], `limit ${limit}`);
  }
  assert.deepEqual(applicationNos((await store.list(u1, { offset: -5 })).items), ['FNHR1']);
});

test('a missing or unknown user sees nothing and cannot unlink', async () => {
  const saved = await store.saveFound(foundResult('FNHR1'));
  await store.link(u1, saved.id);

  for (const who of [undefined, null, 0, 999999]) {
    assert.deepEqual(await store.list(who, {}), { items: [], total: 0 });
    assert.deepEqual(await store.all(who, {}), []);
    assert.equal(await store.unlink(who, saved.id), false);
  }
  assert.equal(await count('client_records'), 1);
});
