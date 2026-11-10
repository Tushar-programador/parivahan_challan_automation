const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestPool, foundResult } = require('./helpers/test-app');
const { createRecordStore } = require('../src/records');
const { createLookup } = require('../src/lookup');

let pool;
let store;
let u1;
let u2;

test.before(async () => {
  pool = await createTestPool();
  store = createRecordStore(pool);
  // Plain inserts: these tests are about lookups, not about password hashing.
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

// An async function that records its calls. `handler` is the answer (or a function that computes it).
function spy(handler) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return typeof handler === 'function' ? handler(...args) : handler;
  };
  fn.calls = calls;
  return fn;
}

function logSpy() {
  const calls = [];
  const fn = (...args) => { calls.push(args); };
  fn.calls = calls;
  return fn;
}

// The real store, with some methods replaced; every method that was called is recorded in `calls`.
function recordsWith(overrides = {}) {
  const calls = [];
  const wrapped = {};
  for (const [name, method] of Object.entries({ ...store, ...overrides })) {
    wrapped[name] = (...args) => {
      calls.push(name);
      return method(...args);
    };
  }
  wrapped.calls = calls;
  return wrapped;
}

const boom = (message) => async () => { throw new Error(message); };
const applicationNos = (items) => items.map((item) => item.applicationNo);

function lookupWith({ records = store, search, log = logSpy(), finalBankStatuses } = {}) {
  const options = { records, search, log };
  if (finalBankStatuses) options.finalBankStatuses = finalBankStatuses;
  return createLookup(options);
}

test('a stored record with a final status is answered from the store: source "stored", search never called, user linked', async () => {
  const saved = await store.saveFound(foundResult('FNHR10', { status: 'SUCCESS', amount: '500' }));
  const search = spy(foundResult('FNHR10', { amount: '999' }));
  const lookup = lookupWith({ search });

  const result = await lookup(u1, 'FNHR10');

  assert.equal(result.status, 'FOUND');
  assert.equal(result.source, 'stored');
  assert.equal(result.applicationNo, 'FNHR10');
  assert.deepEqual(result.record, saved);
  assert.equal(search.calls.length, 0);
  const listed = await store.list(u1);
  assert.deepEqual(listed.items, [saved]);
  assert.equal(listed.total, 1);
});

test('the final-status check ignores case and honours a custom list', async () => {
  const search = spy(foundResult('FNHR10', { status: 'PENDING' }));

  await store.saveFound(foundResult('FNHR10', { status: 'success' }));
  assert.equal((await lookupWith({ search })(u1, 'FNHR10')).source, 'stored');
  assert.equal(search.calls.length, 0);

  await store.saveFound(foundResult('FNHR11', { status: 'PAID' }));
  assert.equal((await lookupWith({ search, finalBankStatuses: ['PAID'] })(u1, 'FNHR11')).source, 'stored');
  assert.equal(search.calls.length, 0);

  // The configured list is compared the same way: trimmed and case-insensitive.
  await store.saveFound(foundResult('FNHR12', { status: ' Paid ' }));
  assert.equal((await lookupWith({ search, finalBankStatuses: [' paid'] })(u1, 'FNHR12')).source, 'stored');
  assert.equal(search.calls.length, 0);

  // PENDING is not final for the default list, so the source is asked.
  await store.saveFound(foundResult('FNHR13', { status: 'PENDING' }));
  const result = await lookupWith({ search })(u1, 'FNHR13');
  assert.equal(search.calls.length, 1);
  assert.equal(result.source, 'live');

  // SUCCESS is not final when the custom list does not name it.
  const searched = spy(foundResult('FNHR10', { status: 'SUCCESS' }));
  assert.equal((await lookupWith({ search: searched, finalBankStatuses: ['PAID'] })(u1, 'FNHR10')).source, 'live');
  assert.equal(searched.calls.length, 1);
});

test('an empty or missing bankStatus is never final', async () => {
  const search = spy(foundResult('FNHR10', { status: 'SUCCESS' }));

  await store.saveFound(foundResult('FNHR10', { status: '' }));
  assert.equal((await lookupWith({ search, finalBankStatuses: [''] })(u1, 'FNHR10')).source, 'live');
  assert.equal(search.calls.length, 1);

  for (const bankStatus of [undefined, null, '   ']) {
    const records = recordsWith({ get: async () => ({ id: 7, applicationNo: 'FNHR10', bankStatus }), link: async () => {} });
    const asked = spy({ status: 'TIMEOUT', applicationNo: 'FNHR10' });
    const result = await lookupWith({ records, search: asked, finalBankStatuses: ['', 'undefined', 'null'] })(u1, 'FNHR10');
    assert.equal(asked.calls.length, 1, `bankStatus ${JSON.stringify(bankStatus)} must trigger a live search`);
    assert.equal(result.source, 'stale');
  }
});

test('a stored record with a non-final status is searched again; a live FOUND updates the shared row and returns source "live"', async () => {
  const seeded = await store.saveFound(foundResult('FNHR10', { status: 'PENDING', amount: '500' }));
  const search = spy(foundResult('FNHR10', { status: 'SUCCESS', amount: '600' }));
  const lookup = lookupWith({ search });

  const result = await lookup(u1, 'FNHR10');

  assert.equal(search.calls.length, 1);
  assert.equal(result.status, 'FOUND');
  assert.equal(result.source, 'live');
  assert.equal(result.record.id, seeded.id);
  assert.equal(result.record.amount, '600');
  assert.equal(result.record.bankStatus, 'SUCCESS');
  assert.deepEqual(result.record.firstFoundAt, seeded.firstFoundAt);
  assert.deepEqual(result.record, await store.get('FNHR10'));
  assert.equal(await count('records'), 1);
  assert.deepEqual(applicationNos((await store.list(u1)).items), ['FNHR10']);
});

test('nothing stored: live FOUND is saved, linked and returned; live NOT_FOUND stores and links nothing', async () => {
  const found = lookupWith({ search: spy(foundResult('FNHR10')) });
  const result = await found(u1, 'FNHR10');

  assert.equal(result.status, 'FOUND');
  assert.equal(result.source, 'live');
  assert.equal(result.applicationNo, 'FNHR10');
  assert.equal(typeof result.record.id, 'number');
  assert.equal(result.record.vehicleNo, 'HR31V0031');
  assert.equal(result.record.bankStatus, 'SUCCESS');
  assert.deepEqual(result.record, await store.get('FNHR10'));
  assert.deepEqual(applicationNos((await store.list(u1)).items), ['FNHR10']);

  const log = logSpy();
  const missing = { status: 'NOT_FOUND', applicationNo: 'FNHR11', message: 'No record found' };
  const notFound = lookupWith({ search: spy(missing), log });
  assert.deepEqual(await notFound(u1, 'FNHR11'), missing);
  assert.equal(await count('records'), 1);
  assert.equal(await count('client_records'), 1);
  assert.equal(log.calls.length, 0);
});

test('live TIMEOUT, WEBSITE_ERROR and CAPTCHA_REQUIRED return the stored record as source "stale" when one exists, else the raw status', async () => {
  const seeded = await store.saveFound(foundResult('FNHR10', { status: 'PENDING' }));

  for (const status of ['TIMEOUT', 'WEBSITE_ERROR', 'CAPTCHA_REQUIRED']) {
    await pool.query('delete from client_records');
    const raw = { status, applicationNo: 'FNHR10', message: `raw ${status}` };
    const result = await lookupWith({ search: spy(raw) })(u1, 'FNHR10');

    assert.equal(result.status, 'FOUND', status);
    assert.equal(result.source, 'stale', status);
    assert.equal(result.applicationNo, 'FNHR10');
    assert.deepEqual(result.record, seeded, status);
    assert.deepEqual(applicationNos((await store.list(u1)).items), ['FNHR10'], `${status} still links the stored record`);

    const absent = { status, applicationNo: 'FNHR99', message: `raw ${status}` };
    assert.deepEqual(await lookupWith({ search: spy(absent) })(u1, 'FNHR99'), absent, status);
  }
  assert.equal(await count('records'), 1);
  assert.deepEqual(applicationNos((await store.list(u1)).items), ['FNHR10']);
});

test('live NOT_FOUND for a number we hold with a non-final status returns the stored record as "stale"', async () => {
  const seeded = await store.saveFound(foundResult('FNHR10', { status: 'PENDING' }));
  const log = logSpy();
  const search = spy({ status: 'NOT_FOUND', applicationNo: 'FNHR10', message: 'No record found' });

  const result = await lookupWith({ search, log })(u1, 'FNHR10');

  assert.equal(result.status, 'FOUND');
  assert.equal(result.source, 'stale');
  assert.deepEqual(result.record, seeded);
  assert.deepEqual((await store.list(u1)).items, [seeded]);
  assert.equal(log.calls.length, 0, 'NOT_FOUND is not a failure');
});

test('an invalid number returns INVALID_INPUT without touching the store or the search', async () => {
  const records = recordsWith();
  const search = spy(foundResult('FNHR10'));
  const log = logSpy();
  const lookup = lookupWith({ records, search, log });

  for (const input of ['', '   ', 'FNHR1', 'abc def', 'FN/HR10', 'x'.repeat(51), undefined, null, 12]) {
    const result = await lookup(u1, input);
    assert.equal(result.status, 'INVALID_INPUT', JSON.stringify(input));
    assert.equal(result.record, undefined);
  }
  assert.deepEqual(await lookup(u1, ' ab-1 '), { status: 'INVALID_INPUT', applicationNo: 'AB-1' });
  assert.deepEqual(records.calls, []);
  assert.equal(search.calls.length, 0);
  assert.equal(log.calls.length, 0);
});

test('a second client asking for a number the first client found is served from the store, and each client lists only what they asked for', async () => {
  const search = spy((applicationNo) => foundResult(applicationNo));
  const lookup = lookupWith({ search });

  const first = await lookup(u1, 'FNHR10');
  assert.equal(first.source, 'live');
  await lookup(u1, 'FNHR11');
  assert.equal(search.calls.length, 2);

  const second = await lookup(u2, 'FNHR10');
  assert.equal(second.status, 'FOUND');
  assert.equal(second.source, 'stored');
  assert.equal(second.record.id, first.record.id);
  assert.equal(search.calls.length, 2, 'the source is not asked for a number we hold');

  assert.equal(await count('records'), 2);
  assert.deepEqual(applicationNos((await store.list(u1)).items).sort(), ['FNHR10', 'FNHR11']);
  assert.deepEqual(applicationNos((await store.list(u2)).items), ['FNHR10']);
});

// A search that does not answer until `parties` searches are waiting on it. A lookup only searches after its read found
// nothing stored, so once all of them are waiting every lookup has read an empty store, and they then all save at the
// same moment. Without it, a real database (where each query takes a network round trip) lets one lookup finish before
// the other has read, and no race happens. The timeout turns a lookup that never reaches the search into a failed
// assertion instead of a hang.
function searchAfterAll(parties) {
  let waiting = 0;
  let release;
  const everyoneIsWaiting = new Promise((resolve) => { release = resolve; });
  return spy(async (applicationNo) => {
    waiting += 1;
    if (waiting === parties) release();
    let timer;
    await Promise.race([everyoneIsWaiting, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    return foundResult(applicationNo);
  });
}

test('two lookups of the same new number at the same time both return FOUND and leave one record', async () => {
  // Both lookups find nothing stored, both go live and both save: the upsert must leave one row.
  const search = searchAfterAll(2);
  const lookup = lookupWith({ search });

  const [a, b] = await Promise.all([lookup(u1, 'FNHR10'), lookup(u2, 'FNHR10')]);

  assert.equal(search.calls.length, 2, 'both lookups really raced past the empty store');
  assert.equal(a.status, 'FOUND');
  assert.equal(b.status, 'FOUND');
  assert.equal(a.source, 'live');
  assert.equal(b.source, 'live');
  assert.equal(a.record.id, b.record.id);
  assert.equal(await count('records'), 1);
  assert.equal(await count('client_records'), 2);
  assert.deepEqual(applicationNos((await store.list(u1)).items), ['FNHR10']);
  assert.deepEqual(applicationNos((await store.list(u2)).items), ['FNHR10']);

  // The same client asking twice at once is also one link.
  await pool.query('delete from client_records');
  await pool.query('delete from records');
  const again = searchAfterAll(2);
  const lookupAgain = lookupWith({ search: again });
  const [c, d] = await Promise.all([lookupAgain(u1, 'FNHR11'), lookupAgain(u1, 'FNHR11')]);
  assert.equal(again.calls.length, 2, 'both lookups really raced past the empty store');
  assert.equal(c.status, 'FOUND');
  assert.equal(d.status, 'FOUND');
  assert.equal(await count('records'), 1);
  assert.equal(await count('client_records'), 1);
});

test('when records.get throws, the lookup still searches live; when saveFound throws, it still returns FOUND (log called once each)', async () => {
  // get throws: treated as nothing stored.
  const getLog = logSpy();
  const getSearch = spy(foundResult('FNHR10', { amount: '700' }));
  const getResult = await lookupWith({
    records: recordsWith({ get: boom('db down on get') }),
    search: getSearch,
    log: getLog
  })(u1, 'FNHR10');
  assert.equal(getSearch.calls.length, 1);
  assert.equal(getResult.status, 'FOUND');
  assert.equal(getResult.source, 'live');
  assert.equal(getResult.record.amount, '700');
  assert.equal(getLog.calls.length, 1);
  assert.match(String(getLog.calls[0][0]), /db down on get/);

  // saveFound throws: the live answer is still returned, built from the live data, without an id.
  await pool.query('delete from client_records');
  await pool.query('delete from records');
  const saveLog = logSpy();
  const saveRecords = recordsWith({ saveFound: boom('db down on save') });
  const before = Date.now();
  const saveResult = await lookupWith({
    records: saveRecords,
    search: spy(
      foundResult('FNHR11', {
        vehicleNo: 'HR31V0032', transactionNo: 'T-1', paymentId: 'P-1', paymentDate: '01-10-2026',
        paymentConfirmationDate: '02-10-2026', paymentGateway: 'GW', bankRefNo: 'B-1', grn: 'G-1', cin: 'C-1',
        amount: '800', status: 'SUCCESS', statusDescription: 'Paid'
      })
    ),
    log: saveLog
  })(u1, 'fnhr11');
  assert.equal(saveResult.status, 'FOUND');
  assert.equal(saveResult.source, 'live');
  assert.equal(saveResult.applicationNo, 'FNHR11');
  assert.equal('id' in saveResult.record, false);
  assert.ok(saveResult.record.firstFoundAt instanceof Date);
  assert.ok(saveResult.record.lastFoundAt instanceof Date);
  assert.ok(saveResult.record.lastFoundAt.getTime() >= before);
  assert.deepEqual(
    { ...saveResult.record, firstFoundAt: undefined, lastFoundAt: undefined },
    {
      applicationNo: 'FNHR11',
      vehicleNo: 'HR31V0032',
      transactionNo: 'T-1',
      paymentId: 'P-1',
      paymentDate: '01-10-2026',
      paymentConfirmationDate: '02-10-2026',
      paymentGateway: 'GW',
      bankRefNo: 'B-1',
      grn: 'G-1',
      cin: 'C-1',
      amount: '800',
      bankStatus: 'SUCCESS',
      statusDescription: 'Paid',
      firstFoundAt: undefined,
      lastFoundAt: undefined
    }
  );
  assert.equal(saveLog.calls.length, 1);
  assert.match(String(saveLog.calls[0][0]), /db down on save/);
  assert.equal(saveRecords.calls.includes('link'), false, 'nothing to link when the record was not saved');
  assert.equal(await count('records'), 0);
});

test('when link throws, the answer is still FOUND and the failure is logged once', async () => {
  // Live find: saved, link fails -> still FOUND from the live data.
  const liveLog = logSpy();
  const live = await lookupWith({
    records: recordsWith({ link: boom('db down on link') }),
    search: spy(foundResult('FNHR10', { amount: '700' })),
    log: liveLog
  })(u1, 'FNHR10');
  assert.equal(live.status, 'FOUND');
  assert.equal(live.source, 'live');
  assert.equal(live.record.amount, '700');
  assert.equal('id' in live.record, false);
  assert.equal(liveLog.calls.length, 1);
  assert.match(String(liveLog.calls[0][0]), /db down on link/);

  // Stored final record: we hold the data, so it is still served.
  const stored = await store.saveFound(foundResult('FNHR11', { status: 'SUCCESS' }));
  const storedLog = logSpy();
  const storedSearch = spy(foundResult('FNHR11'));
  const fromStore = await lookupWith({
    records: recordsWith({ link: boom('db down on link') }),
    search: storedSearch,
    log: storedLog
  })(u1, 'FNHR11');
  assert.equal(fromStore.status, 'FOUND');
  assert.equal(fromStore.source, 'stored');
  assert.deepEqual(fromStore.record, stored);
  assert.equal(storedSearch.calls.length, 0);
  assert.equal(storedLog.calls.length, 1);

  // Stale record: same.
  const stale = await store.saveFound(foundResult('FNHR12', { status: 'PENDING' }));
  const staleLog = logSpy();
  const fromStale = await lookupWith({
    records: recordsWith({ link: boom('db down on link') }),
    search: spy({ status: 'NOT_FOUND', applicationNo: 'FNHR12' }),
    log: staleLog
  })(u1, 'FNHR12');
  assert.equal(fromStale.status, 'FOUND');
  assert.equal(fromStale.source, 'stale');
  assert.deepEqual(fromStale.record, stale);
  assert.equal(staleLog.calls.length, 1);
});

test('a thrown search becomes WEBSITE_ERROR and lookup does not throw', async () => {
  const log = logSpy();
  const records = recordsWith();
  const lookup = lookupWith({ records, search: boom('browser crashed'), log });

  const result = await lookup(u1, 'fnhr10');

  assert.deepEqual(result, { status: 'WEBSITE_ERROR', applicationNo: 'FNHR10' });
  assert.equal(log.calls.length, 1);
  assert.match(String(log.calls[0][0]), /browser crashed/);
  assert.equal(await count('records'), 0);

  // A synchronous throw from search is handled the same way.
  const syncLog = logSpy();
  const syncResult = await lookupWith({
    search: () => { throw new Error('sync boom'); },
    log: syncLog
  })(u1, 'FNHR10');
  assert.deepEqual(syncResult, { status: 'WEBSITE_ERROR', applicationNo: 'FNHR10' });
  assert.equal(syncLog.calls.length, 1);

  // When we hold the number, the failed source is just a failed source: the stored record is served as stale.
  const seeded = await store.saveFound(foundResult('FNHR11', { status: 'PENDING' }));
  const staleLog = logSpy();
  const stale = await lookupWith({ search: boom('browser crashed'), log: staleLog })(u1, 'FNHR11');
  assert.equal(stale.status, 'FOUND');
  assert.equal(stale.source, 'stale');
  assert.deepEqual(stale.record, seeded);
  assert.equal(staleLog.calls.length, 1);
});

test('lookup never throws, whatever fails', async () => {
  const dead = {
    get: boom('down'),
    saveFound: boom('down'),
    link: boom('down'),
    list: boom('down'),
    all: boom('down'),
    unlink: boom('down')
  };
  const throwingLog = () => { throw new Error('log is broken'); };

  const cases = [
    { search: spy(foundResult('FNHR10')) },
    { search: spy({ status: 'NOT_FOUND', applicationNo: 'FNHR10' }) },
    { search: spy({ status: 'TIMEOUT', applicationNo: 'FNHR10', message: 'slow' }) },
    { search: boom('crash') },
    { search: spy(undefined) },
    { search: spy(null) },
    { search: spy('nonsense') }
  ];
  for (const { search } of cases) {
    const result = await lookupWith({ records: dead, search, log: throwingLog })(u1, 'FNHR10');
    assert.equal(typeof result.status, 'string');
  }

  const noOptions = await createLookup({ records: dead, search: spy(foundResult('FNHR10')), log: logSpy() })(u1, 'FNHR10', null);
  assert.equal(noOptions.status, 'FOUND');
});

test('a live FOUND without data is a failure, not a record', async () => {
  const log = logSpy();
  const search = spy({ status: 'FOUND', applicationNo: 'FNHR10' });

  const result = await lookupWith({ search, log })(u1, 'FNHR10');

  assert.deepEqual(result, { status: 'WEBSITE_ERROR', applicationNo: 'FNHR10' });
  assert.equal(await count('records'), 0);
  assert.equal(await count('client_records'), 0);
  assert.equal(log.calls.length, 1);
});

test('"fnhr10 " and "FNHR10" are the same number', async () => {
  const search = spy((applicationNo) => foundResult(applicationNo));
  const lookup = lookupWith({ search });

  const first = await lookup(u1, 'fnhr10 ');
  assert.equal(first.status, 'FOUND');
  assert.equal(first.applicationNo, 'FNHR10');
  assert.equal(first.record.applicationNo, 'FNHR10');
  assert.deepEqual(search.calls.map((call) => call[0]), ['FNHR10']);

  const second = await lookup(u1, 'FNHR10');
  assert.equal(second.source, 'stored');
  assert.equal(second.record.id, first.record.id);
  assert.equal(search.calls.length, 1);
  assert.equal(await count('records'), 1);
  assert.equal(await count('client_records'), 1);
});

test('cancelled and owner are passed through to search', async () => {
  const search = spy(foundResult('FNHR10'));
  const cancelled = () => false;
  const owner = { id: 'tab-1' };
  const lookup = lookupWith({ search });

  await lookup(u1, '  fnhr10', { cancelled, owner });

  assert.equal(search.calls.length, 1);
  const [applicationNo, options] = search.calls[0];
  assert.equal(applicationNo, 'FNHR10');
  assert.equal(options.cancelled, cancelled);
  assert.equal(options.owner, owner);
});

test('each raw failure is logged once with its raw message', async () => {
  for (const status of ['TIMEOUT', 'WEBSITE_ERROR', 'CAPTCHA_REQUIRED', 'CANCELLED']) {
    const log = logSpy();
    const raw = { status, applicationNo: 'FNHR10', message: `raw message for ${status}` };
    const result = await lookupWith({ search: spy(raw), log })(u1, 'FNHR10');

    assert.deepEqual(result, raw);
    assert.equal(log.calls.length, 1, status);
    assert.match(log.calls[0].join(' '), new RegExp(`raw message for ${status}`), status);
  }

  // A failure with a stored record behind it is still a failure of the source and is logged once.
  await store.saveFound(foundResult('FNHR11', { status: 'PENDING' }));
  const staleLog = logSpy();
  await lookupWith({ search: spy({ status: 'TIMEOUT', applicationNo: 'FNHR11', message: 'raw timeout' }), log: staleLog })(u1, 'FNHR11');
  assert.equal(staleLog.calls.length, 1);
  assert.match(staleLog.calls[0].join(' '), /raw timeout/);

  // A failure without a message is still logged once.
  const bareLog = logSpy();
  await lookupWith({ search: spy({ status: 'TIMEOUT', applicationNo: 'FNHR12' }), log: bareLog })(u1, 'FNHR12');
  assert.equal(bareLog.calls.length, 1);
  assert.match(bareLog.calls[0].join(' '), /TIMEOUT/);

  // FOUND, NOT_FOUND and INVALID_INPUT are not failures.
  const quietLog = logSpy();
  const quiet = lookupWith({
    search: spy((applicationNo) => (applicationNo === 'FNHR13' ? foundResult('FNHR13') : { status: 'NOT_FOUND', applicationNo, message: 'No record found' })),
    log: quietLog
  });
  await quiet(u1, 'FNHR13');
  await quiet(u1, 'FNHR14');
  await quiet(u1, 'ab');
  assert.equal(quietLog.calls.length, 0);
});
