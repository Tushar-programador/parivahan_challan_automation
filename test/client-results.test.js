const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const { startTestApp, foundResult, SOURCE_WORDS, LEAK } = require('./helpers/test-app');
const { toClientResult, createClientSearch } = require('../src/present');
const { createApp, defaultLog } = require('../src/app');
const { createXlsx, parseApplicationNumbers, InvalidInputError } = require('../src/bulk');

// The fixed texts, written out in full on purpose: a change to them must be a visible change to this file.
const UNAVAILABLE_TEXT = 'We could not get this one right now. Please try again in a little while.';
const INVALID_INPUT_TEXT = 'Enter 6-50 letters, numbers or hyphens.';
const WENT_WRONG = { status: 'ERROR', message: 'Something went wrong. Please try again.' };
const NOT_FOUND_API = { status: 'NOT_FOUND', message: 'Not found.' };
const CLIENT_STATUSES = ['FOUND', 'NOT_FOUND', 'INVALID_INPUT', 'UNAVAILABLE'];

// What the source says when it fails: a URL, its name and the browser's own error text.
const SOURCE_FAILURE = 'page.goto: net::ERR_X at https://vahan.parivahan.gov.in/eTransPgi/transactionStatus';
const failingSearch = async (applicationNo) => ({ status: 'WEBSITE_ERROR', applicationNo, message: SOURCE_FAILURE });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function withApp(deps, body) {
  const t = await startTestApp(deps);
  try {
    await body(t);
  } finally {
    await t.stop();
  }
}

function post(t, path, body, cookie, { signal, headers } = {}) {
  return fetch(`${t.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
    signal
  });
}

async function streamLines(response) {
  return (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// Every part of an .xlsx file (it is a zip), as one string: the sheet, the shared strings, the document properties.
// A minimal reader: it takes the entries from the zip's central directory, which is all a file written by exceljs needs.
function xlsxParts(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // the end-of-central-directory record
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const parts = [];
  for (let i = 0; i < entries; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    parts.push(`${name}\n${(method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8')}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return parts.join('\n');
}

async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

const headerText = (response) => [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n');

const FULL_RECORD = {
  id: 7,
  applicationNo: 'FNHR100001',
  vehicleNo: 'HR31V0031',
  transactionNo: 'TXN1',
  paymentId: 'PAY1',
  paymentDate: '01-Nov-2026',
  paymentConfirmationDate: '02-Nov-2026',
  paymentGateway: 'GATE',
  bankRefNo: 'BANK1',
  grn: 'GRN1',
  cin: 'CIN1',
  amount: '500',
  bankStatus: 'SUCCESS',
  statusDescription: 'Paid',
  firstFoundAt: new Date('2026-10-01T00:00:00.000Z'),
  lastFoundAt: new Date('2026-11-09T10:20:30.123Z'),
  internalNote: 'do not show'
};
const FULL_DATA = {
  vehicleNo: 'HR31V0031',
  transactionNo: 'TXN1',
  paymentId: 'PAY1',
  paymentDate: '01-Nov-2026',
  paymentConfirmationDate: '02-Nov-2026',
  paymentGateway: 'GATE',
  bankRefNo: 'BANK1',
  grn: 'GRN1',
  cin: 'CIN1',
  amount: '500',
  bankStatus: 'SUCCESS',
  statusDescription: 'Paid'
};

// ---------- the presenter ----------

test('toClientResult keeps only the whitelisted fields for FOUND and formats asOf as ISO', () => {
  const result = toClientResult({
    status: 'FOUND',
    applicationNo: 'FNHR100001',
    record: FULL_RECORD,
    source: 'stored',
    rawStatus: 'SUCCESS',
    message: 'raw message',
    id: 7
  });
  assert.deepEqual(result, { status: 'FOUND', applicationNo: 'FNHR100001', data: FULL_DATA, asOf: '2026-11-09T10:20:30.123Z' });
  assert.deepEqual(Object.keys(result.data), Object.keys(FULL_DATA));

  const text = JSON.stringify(result);
  for (const dropped of ['internalNote', 'do not show', 'rawStatus', '"source"', 'firstFoundAt', 'lastFoundAt', '"id"', 'raw message']) {
    assert.equal(text.includes(dropped), false, dropped);
  }

  // A date that arrives as text (or a number) is read, and still comes out as ISO.
  assert.equal(toClientResult({ status: 'FOUND', applicationNo: 'X', record: { ...FULL_RECORD, lastFoundAt: '2026-11-09T10:20:30.123Z' } }).asOf, '2026-11-09T10:20:30.123Z');
  assert.equal(toClientResult({ status: 'FOUND', applicationNo: 'X', record: { ...FULL_RECORD, lastFoundAt: Date.parse('2026-11-09T10:20:30.123Z') } }).asOf, '2026-11-09T10:20:30.123Z');
});

test('toClientResult gives every data field as text, an empty string when the record has none', () => {
  const result = toClientResult({ status: 'FOUND', applicationNo: 'FNHR100001', record: { vehicleNo: 'HR31V0031', amount: 500, lastFoundAt: new Date('2026-11-09T00:00:00Z') } });
  assert.deepEqual(result.data, {
    vehicleNo: 'HR31V0031',
    transactionNo: '',
    paymentId: '',
    paymentDate: '',
    paymentConfirmationDate: '',
    paymentGateway: '',
    bankRefNo: '',
    grn: '',
    cin: '',
    amount: '500',
    bankStatus: '',
    statusDescription: ''
  });
});

test('a FOUND without a record or without a usable lastFoundAt is UNAVAILABLE: a date is never invented for it', () => {
  const unavailable = { status: 'UNAVAILABLE', applicationNo: 'FNHR100001', message: UNAVAILABLE_TEXT };
  assert.deepEqual(toClientResult({ status: 'FOUND', applicationNo: 'FNHR100001' }), unavailable);
  assert.deepEqual(toClientResult({ status: 'FOUND', applicationNo: 'FNHR100001', record: null }), unavailable);
  assert.deepEqual(toClientResult({ status: 'FOUND', applicationNo: 'FNHR100001', record: 'text' }), unavailable);
  // The old raw shape (data instead of record) is not a lookup result.
  assert.deepEqual(toClientResult({ status: 'FOUND', applicationNo: 'FNHR100001', data: FULL_DATA }), unavailable);
  for (const lastFoundAt of [undefined, null, '', 'yesterday', new Date('nope'), {}, true]) {
    assert.deepEqual(toClientResult({ status: 'FOUND', applicationNo: 'FNHR100001', record: { ...FULL_RECORD, lastFoundAt } }), unavailable, String(lastFoundAt));
  }
});

test('TIMEOUT, WEBSITE_ERROR, CAPTCHA_REQUIRED, CANCELLED and an unknown status all become UNAVAILABLE with the fixed message and no raw message', () => {
  for (const status of ['TIMEOUT', 'WEBSITE_ERROR', 'CAPTCHA_REQUIRED', 'CAPTCHA_WRONG', 'CANCELLED', 'ERROR', 'UNAVAILABLE', 'found', 'Not_Found', 'SOMETHING_NEW', '', undefined, null, 42]) {
    const result = toClientResult({ status, applicationNo: 'FNHR100001', message: SOURCE_FAILURE, record: FULL_RECORD, data: FULL_DATA, source: 'live' });
    assert.deepEqual(result, { status: 'UNAVAILABLE', applicationNo: 'FNHR100001', message: UNAVAILABLE_TEXT }, String(status));
  }
  for (const input of [null, undefined, 'FOUND', 42, [], {}]) {
    assert.deepEqual(toClientResult(input), { status: 'UNAVAILABLE', applicationNo: '', message: UNAVAILABLE_TEXT }, String(input));
  }
});

test('INVALID_INPUT gets the fixed message; NOT_FOUND has no message', () => {
  assert.deepEqual(
    toClientResult({ status: 'INVALID_INPUT', applicationNo: 'AB', message: 'Application/Challan number must contain 6-50 letters, numbers, or hyphens.' }),
    { status: 'INVALID_INPUT', applicationNo: 'AB', message: INVALID_INPUT_TEXT }
  );
  const notFound = toClientResult({ status: 'NOT_FOUND', applicationNo: 'FNHR100001', message: `No record found on ${SOURCE_FAILURE}`, source: 'live' });
  assert.deepEqual(notFound, { status: 'NOT_FOUND', applicationNo: 'FNHR100001' });
  assert.equal('message' in notFound, false);
});

test('the per-number wrapper presents the answer, passes cancelled and owner, and skips the lookup once the client is gone', async () => {
  const calls = [];
  const lookup = async (userId, applicationNo, options) => {
    calls.push({ userId, applicationNo, options });
    return { status: 'NOT_FOUND', applicationNo: 'FNHR100001', message: 'raw' };
  };
  let gone = false;
  const search = createClientSearch(lookup, { userId: 42, cancelled: () => gone });

  assert.deepEqual(await search('fnhr100001'), { status: 'NOT_FOUND', applicationNo: 'FNHR100001' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 42);
  assert.equal(calls[0].applicationNo, 'fnhr100001'); // the lookup normalises, the wrapper does not
  assert.equal(calls[0].options.owner, 42);
  assert.equal(calls[0].options.cancelled(), false);

  gone = true;
  assert.equal(calls[0].options.cancelled(), true, 'the lookup sees the client leave');
  assert.deepEqual(await search(' fnhr100002 '), { status: 'UNAVAILABLE', applicationNo: 'FNHR100002', message: UNAVAILABLE_TEXT });
  assert.equal(calls.length, 1, 'no lookup once the client is gone');
});

test('the per-number wrapper lets a throwing lookup reject, so the caller decides what the client sees', async () => {
  const search = createClientSearch(async () => { throw new Error('boom'); }, { userId: 1 });
  await assert.rejects(search('FNHR100001'), /boom/);
});

test('the default server log writes to console.error unless LOG_LEVEL is silent', (t) => {
  const calls = [];
  t.mock.method(console, 'error', (...args) => { calls.push(args); });
  const previous = process.env.LOG_LEVEL;
  try {
    process.env.LOG_LEVEL = 'silent';
    defaultLog('quiet message');
    assert.deepEqual(calls, []);
    delete process.env.LOG_LEVEL;
    defaultLog('loud message');
    assert.deepEqual(calls, [['loud message']]);
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});

test('every validation failure of the CSV parser is an InvalidInputError, so the route can tell it from a bug', () => {
  const tooMany = Array.from({ length: 1001 }, (_, i) => `FNHR${100000 + i}`).join('\n');
  for (const csv of [' \r\n', '"never closed\n', 'Application No\r\n', tooMany, undefined]) {
    assert.throws(() => parseApplicationNumbers(csv), InvalidInputError, JSON.stringify(csv)?.slice(0, 30));
  }
  assert.deepEqual(parseApplicationNumbers('FNHR100001\n'), ['FNHR100001']);
});

test('createApp refuses to start without records or a lookup', () => {
  const deps = { users: {}, sessions: {}, throttle: {}, config: { trustProxy: false } };
  assert.throws(() => createApp(deps), /records or a lookup/);
  assert.doesNotThrow(() => createApp({ ...deps, lookup: async () => ({}) }));
});

// ---------- the routes ----------

test('a failure whose raw message contains the source URL never reaches the client: single search, stream line and bulk row', async () => {
  await withApp({ automation: { searchTransaction: failingSearch } }, async (t) => {
    const cookie = await t.cookieFor('alice');

    const single = await post(t, '/api/transaction/search', { applicationNo: 'FNHR100001' }, cookie);
    assert.equal(single.status, 200);
    const singleBody = await single.json();
    assert.deepEqual(singleBody, { status: 'UNAVAILABLE', applicationNo: 'FNHR100001', message: UNAVAILABLE_TEXT });
    assert.equal(LEAK.test(JSON.stringify(singleBody)), false);

    const stream = await post(t, '/api/transaction/search-stream', { applicationNos: ['FNHR100002', 'FNHR100003'] }, cookie);
    assert.equal(stream.status, 200);
    const streamText = await stream.clone().text();
    assert.equal(LEAK.test(streamText), false, streamText);
    const lines = await streamLines(stream);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.result.status, 'UNAVAILABLE');
      assert.equal(line.result.message, UNAVAILABLE_TEXT);
    }

    const bulk = await post(t, '/api/transaction/bulk', { applicationNos: ['FNHR100004'] }, cookie);
    assert.equal(bulk.status, 200);
    const bulkText = await bulk.text();
    assert.equal(LEAK.test(bulkText), false, bulkText);
    const { results } = JSON.parse(bulkText);
    assert.equal(results[0].status, 'UNAVAILABLE');
    assert.equal(results[0].message, UNAVAILABLE_TEXT);

    // The real failure is for the operator: it is in the server log, and only there.
    assert.ok(t.logged.some((line) => line.includes('ERR_X')), 'the real failure was logged');
  });
});

test('the bulk csv and xlsx downloads and the export of such a failure never name the source', async () => {
  await withApp({ automation: { searchTransaction: failingSearch } }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const bulkCsv = await post(t, '/api/transaction/bulk?format=csv', { applicationNos: ['FNHR100001'] }, cookie);
    const csv = await bulkCsv.text();
    assert.equal(LEAK.test(csv), false, csv);
    assert.match(csv, /UNAVAILABLE/);

    const bulkXlsx = await post(t, '/api/transaction/bulk?format=xlsx', { applicationNos: ['FNHR100001'] }, cookie);
    const buffer = Buffer.from(await bulkXlsx.arrayBuffer());
    assert.equal(SOURCE_WORDS.test(xlsxParts(buffer)), false);
    const sheet = (await loadWorkbook(buffer)).getWorksheet('Transaction Results');
    assert.equal(LEAK.test(JSON.stringify(sheet.getSheetValues())), false);
    assert.equal(sheet.getCell('B2').value, 'UNAVAILABLE');
    assert.equal(sheet.getCell('N2').value, UNAVAILABLE_TEXT);
  });
});

test('a lookup that throws gives the fixed "Something went wrong" message and logs the real error', async () => {
  const lookup = async () => { throw new Error(`boom: could not reach ${SOURCE_FAILURE}`); };
  await withApp({ automation: {}, lookup }, async (t) => {
    const cookie = await t.cookieFor('alice');

    const single = await post(t, '/api/transaction/search', { applicationNo: 'FNHR100001' }, cookie);
    assert.equal(single.status, 500);
    assert.deepEqual(await single.json(), WENT_WRONG);
    assert.ok(t.logged.some((line) => line.includes('boom') && line.includes('ERR_X')), 'the real error was logged');

    // In a batch the one number fails alone, in the client vocabulary, and the rest of the batch is answered.
    t.logged.length = 0;
    const stream = await post(t, '/api/transaction/search-stream', { applicationNos: ['FNHR100002', 'FNHR100003'] }, cookie);
    assert.equal(stream.status, 200);
    const streamText = await stream.clone().text();
    assert.equal(/boom|ERR_X/.test(streamText), false, streamText);
    assert.equal(LEAK.test(streamText), false);
    const lines = await streamLines(stream);
    assert.deepEqual(lines.map((line) => line.result.status), ['UNAVAILABLE', 'UNAVAILABLE']);
    assert.equal(t.logged.filter((line) => line.includes('boom')).length, 2, 'each failed number was logged');

    const bulk = await post(t, '/api/transaction/bulk', { applicationNos: ['FNHR100004', 'FNHR100005'] }, cookie);
    assert.equal(bulk.status, 200);
    const bulkText = await bulk.text();
    assert.equal(/boom|ERR_X/.test(bulkText), false, bulkText);
    assert.deepEqual(JSON.parse(bulkText).results.map((row) => [row.applicationNo, row.status]), [['FNHR100004', 'UNAVAILABLE'], ['FNHR100005', 'UNAVAILABLE']]);
  });
});

test('a server log that throws changes nothing a client sees', async () => {
  const log = () => { throw new Error('the log itself is broken'); };
  const lookup = async (_userId, applicationNo) => {
    if (applicationNo === 'FNHR100002') throw new Error('lookup broke');
    return { status: 'NOT_FOUND', applicationNo };
  };
  await withApp({ automation: {}, lookup, log }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const ok = await post(t, '/api/transaction/search', { applicationNo: 'FNHR100001' }, cookie);
    assert.deepEqual(await ok.json(), { status: 'NOT_FOUND', applicationNo: 'FNHR100001' });

    const broken = await post(t, '/api/transaction/search', { applicationNo: 'FNHR100002' }, cookie);
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), WENT_WRONG);

    const stream = await post(t, '/api/transaction/search-stream', { applicationNos: ['FNHR100001', 'FNHR100002'] }, cookie);
    const lines = await streamLines(stream);
    assert.deepEqual(lines.map((line) => line.result.status).sort(), ['NOT_FOUND', 'UNAVAILABLE']);
  });
});

const FOUND_DETAILS = {
  transactionNo: 'TXN1',
  paymentId: 'PAY1',
  paymentDate: '01-Nov-2026',
  paymentConfirmationDate: '02-Nov-2026',
  paymentGateway: 'GATE',
  bankRefNo: 'BANK1',
  grn: 'GRN1',
  cin: 'CIN1'
};

test('a FOUND answer carries data and asOf and has no rawStatus or source key', async () => {
  const automation = { searchTransaction: async (applicationNo) => foundResult(applicationNo, FOUND_DETAILS) };
  await withApp({ automation }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const response = await post(t, '/api/transaction/search', { applicationNo: ' fnhr100001 ' }, cookie);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(Object.keys(body).sort(), ['applicationNo', 'asOf', 'data', 'status']);
    assert.equal(body.status, 'FOUND');
    assert.equal(body.applicationNo, 'FNHR100001');
    assert.deepEqual(body.data, { vehicleNo: 'HR31V0031', ...FOUND_DETAILS, amount: '500', bankStatus: 'SUCCESS', statusDescription: 'Paid' });
    assert.equal(new Date(body.asOf).toISOString(), body.asOf, 'asOf is an ISO string');
    assert.ok(Math.abs(Date.now() - Date.parse(body.asOf)) < 60 * 1000, 'asOf is about now for a record found just now');
    assert.equal(/rawStatus|"source"|"record"|"id"|"live"|"stored"/.test(JSON.stringify(body)), false);
    assert.equal('rawStatus' in body || 'source' in body || 'id' in body, false);
    assert.equal('rawStatus' in body.data || 'source' in body.data || 'status' in body.data, false);
  });
});

test('a found number is stored, linked to the signed-in user, and the next answer comes from our own data', async () => {
  const optionsSeen = [];
  const search = async (applicationNo, options) => {
    optionsSeen.push(options);
    return foundResult(applicationNo, FOUND_DETAILS);
  };
  await withApp({ automation: { searchTransaction: search } }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const { rows: [alice] } = await t.pool.query("select id from users where username = 'alice'");

    const first = await (await post(t, '/api/transaction/search', { applicationNo: 'FNHR100001' }, cookie)).json();
    assert.equal(first.status, 'FOUND');

    // The route handed the lookup the signed-in user and a way to tell that the client left.
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0].owner, alice.id);
    assert.equal(typeof optionsSeen[0].cancelled, 'function');
    assert.equal((await t.stores.records.list(alice.id)).total, 1, 'the record is linked to the signed-in user');

    const second = await post(t, '/api/transaction/search', { applicationNo: 'FNHR100001' }, cookie);
    assert.deepEqual(await second.json(), first);
    assert.equal(optionsSeen.length, 1, 'the second answer came from our own data');
  });
});

test('search-stream answers one line per number with the client vocabulary only', async () => {
  const answers = {
    FNHR100001: (no) => foundResult(no),
    FNHR100002: (no) => ({ status: 'NOT_FOUND', applicationNo: no, message: `No record found: ${SOURCE_FAILURE}` }),
    FNHR100004: (no) => ({ status: 'TIMEOUT', applicationNo: no, message: SOURCE_FAILURE }),
    FNHR100005: (no) => ({ status: 'CAPTCHA_REQUIRED', applicationNo: no, message: 'The captcha could not be read after 5 tries. Search this number again, or use the userscript and type it.' }),
    FNHR100006: (no) => ({ status: 'SOMETHING_NEW', applicationNo: no, message: SOURCE_FAILURE })
  };
  const automation = { searchTransaction: async (no) => answers[no](no) };
  await withApp({ automation }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const numbers = ['FNHR100001', 'FNHR100002', 'bad', 'FNHR100004', 'FNHR100005', 'FNHR100006'];
    const response = await post(t, '/api/transaction/search-stream', { applicationNos: numbers }, cookie);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const text = await response.text();
    const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));

    assert.equal(lines.length, numbers.length, 'one line per number');
    assert.deepEqual(lines.map((line) => line.index).sort(), [0, 1, 2, 3, 4, 5]);
    for (const line of lines) assert.deepEqual(Object.keys(line).sort(), ['index', 'result']);
    for (const line of lines) assert.ok(CLIENT_STATUSES.includes(line.result.status), line.result.status);
    assert.equal(/WEBSITE_ERROR|TIMEOUT|CAPTCHA_REQUIRED|CANCELLED|SOMETHING_NEW/.test(text), false, text);
    assert.equal(LEAK.test(text), false, text);

    const byIndex = Object.fromEntries(lines.map((line) => [line.index, line.result]));
    assert.equal(byIndex[0].status, 'FOUND');
    assert.deepEqual(Object.keys(byIndex[0]).sort(), ['applicationNo', 'asOf', 'data', 'status']);
    assert.deepEqual(byIndex[1], { status: 'NOT_FOUND', applicationNo: 'FNHR100002' });
    assert.deepEqual(byIndex[2], { status: 'INVALID_INPUT', applicationNo: 'BAD', message: INVALID_INPUT_TEXT });
    for (const index of [3, 4, 5]) {
      assert.deepEqual(byIndex[index], { status: 'UNAVAILABLE', applicationNo: numbers[index], message: UNAVAILABLE_TEXT });
    }
  });
});

test('search-stream keeps its limits: 1-1000 numbers, nothing else', async () => {
  await withApp({ automation: { searchTransaction: failingSearch } }, async (t) => {
    const cookie = await t.cookieFor('alice');
    for (const applicationNos of [undefined, 'FNHR100001', [], Array.from({ length: 1001 }, (_, i) => `FNHR${100000 + i}`)]) {
      const response = await post(t, '/api/transaction/search-stream', { applicationNos }, cookie);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.status, 'INVALID_INPUT');
      assert.equal(LEAK.test(JSON.stringify(body)), false);
    }
  });
});

test('bulk json returns every number in input order', async () => {
  const delays = { FNHR100001: 80, FNHR100002: 50, FNHR100003: 20, FNHR100004: 0 };
  const automation = {
    searchTransaction: async (no) => {
      await sleep(delays[no]);
      return no === 'FNHR100001' || no === 'FNHR100003' ? foundResult(no) : { status: 'NOT_FOUND', applicationNo: no };
    }
  };
  await withApp({ automation }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const response = await post(t, '/api/transaction/bulk', { applicationNos: ['fnhr100001', 'FNHR100002', ' FNHR100003 ', 'FNHR100004', 'x'] }, cookie);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const { results } = await response.json();

    assert.deepEqual(results.map((row) => [row.applicationNo, row.status]), [
      ['FNHR100001', 'FOUND'],
      ['FNHR100002', 'NOT_FOUND'],
      ['FNHR100003', 'FOUND'],
      ['FNHR100004', 'NOT_FOUND'],
      ['X', 'INVALID_INPUT']
    ]);
    assert.equal(results[0].vehicleNo, 'HR31V0031');
    assert.equal(results[0].amount, '500');
    assert.equal(results[0].message, '');
    assert.equal(results[1].vehicleNo, '');
    assert.equal(results[4].message, INVALID_INPUT_TEXT);
    assert.equal(LEAK.test(JSON.stringify(results)), false);
  });
});

test('bulk accepts a CSV upload, keeps its validation messages, and refuses a bad request before searching', async () => {
  let searches = 0;
  const automation = { searchTransaction: async (no) => { searches += 1; return { status: 'NOT_FOUND', applicationNo: no }; } };
  await withApp({ automation }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const upload = (text, query = '') => {
      const form = new FormData();
      form.append('file', new Blob([text], { type: 'text/csv' }), 'numbers.csv');
      return fetch(`${t.baseUrl}/api/transaction/bulk${query}`, { method: 'POST', headers: { cookie }, body: form });
    };

    const ok = await upload('Application No,Notes\r\nFNHR100001,a\r\nFNHR100002,b\r\n');
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).results.map((row) => row.applicationNo), ['FNHR100001', 'FNHR100002']);
    assert.equal(searches, 2, 'the numbers went through the shared lookup');

    const empty = await upload(' \r\n');
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { status: 'INVALID_INPUT', message: 'The CSV file is empty.' });

    const tooMany = await upload(Array.from({ length: 1001 }, (_, i) => `FNHR${100000 + i}`).join('\n'));
    assert.equal(tooMany.status, 400);
    assert.deepEqual(await tooMany.json(), { status: 'INVALID_INPUT', message: 'Bulk searches are limited to 1000 application numbers per upload.' });

    const tooLarge = await upload('FNHR100001\n'.repeat(120000));
    assert.equal(tooLarge.status, 400);
    assert.deepEqual(await tooLarge.json(), { status: 'INVALID_INPUT', message: 'CSV upload rejected: File too large' });

    const searchesBefore = searches;
    const missing = await post(t, '/api/transaction/bulk', {}, cookie);
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { status: 'INVALID_INPUT', message: 'Upload a CSV file in the "file" field or provide an applicationNos array.' });
    const over = await post(t, '/api/transaction/bulk', { applicationNos: Array.from({ length: 1001 }, (_, i) => `FNHR${100000 + i}`) }, cookie);
    assert.equal(over.status, 400);
    assert.deepEqual(await over.json(), { status: 'INVALID_INPUT', message: 'Bulk searches are limited to 1000 application numbers per request.' });
    const format = await post(t, '/api/transaction/bulk?format=pdf', { applicationNos: ['FNHR100001'] }, cookie);
    assert.equal(format.status, 400);
    assert.deepEqual(await format.json(), { status: 'INVALID_INPUT', message: 'Unsupported export format. Choose json, csv, or xlsx.' });
    assert.equal(searches, searchesBefore, 'a refused request searches nothing');
  });
});

test('an unexpected error in the final handler is a generic 500 with nothing from the error, and the real error is logged', async () => {
  await withApp({ automation: { searchTransaction: failingSearch } }, async (t) => {
    const cookie = await t.cookieFor('alice');
    // A multipart body that stops in the middle of the file is an error the upload library throws, not one of its own.
    const response = await fetch(`${t.baseUrl}/api/transaction/bulk`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'multipart/form-data; boundary=XYZ' },
      body: '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nFNHR100001'
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), WENT_WRONG);
    assert.ok(t.logged.length >= 1, 'the real error was logged');
    assert.match(t.logged.join('\n'), /Unexpected end of form/);
  });
});

test('xlsx export has creator "Data export" and is downloaded as results.xlsx; /api/export csv as results.csv', async () => {
  const automation = { searchTransaction: async (no) => (no === 'FNHR100001' ? foundResult(no) : failingSearch(no)) };
  await withApp({ automation }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const numbers = ['FNHR100001', 'FNHR100002'];

    const xlsx = await post(t, '/api/transaction/bulk?format=xlsx', { applicationNos: numbers }, cookie);
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.headers.get('content-disposition'), 'attachment; filename="results.xlsx"');
    assert.equal(xlsx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = await loadWorkbook(Buffer.from(await xlsx.arrayBuffer()));
    assert.equal(workbook.creator, 'Data export');
    const sheet = workbook.getWorksheet('Transaction Results');
    assert.equal(sheet.getCell('A2').value, 'FNHR100001');
    assert.equal(sheet.getCell('B2').value, 'FOUND');
    assert.equal(sheet.getCell('C2').value, 'HR31V0031');
    assert.equal(sheet.getCell('B3').value, 'UNAVAILABLE');

    const csv = await post(t, '/api/transaction/bulk?format=csv', { applicationNos: numbers }, cookie);
    assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="results.csv"');
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    const rows = parse(await csv.text());
    assert.deepEqual(rows[0].slice(0, 3), ['Application No', 'Status', 'Vehicle No']);
    assert.deepEqual(rows.slice(1).map((row) => row.slice(0, 2)), [['FNHR100001', 'FOUND'], ['FNHR100002', 'UNAVAILABLE']]);

    const posted = [{ status: 'FOUND', applicationNo: 'FNHR100001', data: { vehicleNo: 'HR31V0031', amount: '500' } }, { status: 'NOT_FOUND', applicationNo: 'FNHR100002' }];
    const exportCsv = await post(t, '/api/export?format=csv', { results: posted }, cookie);
    assert.equal(exportCsv.status, 200);
    assert.equal(exportCsv.headers.get('content-disposition'), 'attachment; filename="results.csv"');
    assert.deepEqual(parse(await exportCsv.text()).slice(1).map((row) => [row[0], row[1], row[2], row[11]]), [['FNHR100001', 'FOUND', 'HR31V0031', '500'], ['FNHR100002', 'NOT_FOUND', '', '']]);

    const exportDefault = await post(t, '/api/export', { results: posted }, cookie);
    assert.equal(exportDefault.headers.get('content-disposition'), 'attachment; filename="results.csv"');

    const exportXlsx = await post(t, '/api/export?format=xlsx', { results: posted }, cookie);
    assert.equal(exportXlsx.status, 200);
    assert.equal(exportXlsx.headers.get('content-disposition'), 'attachment; filename="results.xlsx"');
    const exported = await loadWorkbook(Buffer.from(await exportXlsx.arrayBuffer()));
    assert.equal(exported.creator, 'Data export');
    assert.equal(exported.getWorksheet('Transaction Results').getCell('C2').value, 'HR31V0031');
  });
});

test('createXlsx names the workbook creator "Data export" unless told otherwise, and no property of the file names the source', async () => {
  for (const [options, expected] of [[undefined, 'Data export'], [{}, 'Data export'], [{ creator: 'Someone else' }, 'Someone else']]) {
    const workbook = await loadWorkbook(await createXlsx([{ applicationNo: 'FNHR100001', status: 'FOUND' }], options));
    assert.equal(workbook.creator, expected);
  }
  const buffer = await createXlsx([{ applicationNo: 'FNHR100001', status: 'FOUND', vehicleNo: 'HR31V0031' }]);
  const parts = xlsxParts(buffer);
  // The reader really sees inside the file (the check below would pass on an empty string too).
  assert.match(parts, /docProps\/core\.xml/);
  assert.match(parts, /Data export/);
  assert.match(parts, /HR31V0031/);
  assert.equal(SOURCE_WORDS.test(parts), false);
  const workbook = await loadWorkbook(buffer);
  for (const property of ['creator', 'lastModifiedBy', 'company', 'manager', 'title', 'subject', 'keywords', 'category', 'description']) {
    assert.equal(SOURCE_WORDS.test(String(workbook[property] ?? '')), false, property);
  }
});

test('/api/export writes only text this service wrote, whatever the posted results say', async () => {
  await withApp({ automation: {} }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const posted = [
      { status: 'WEBSITE_ERROR', applicationNo: 'FNHR100001', message: `Could not open the portal: ${SOURCE_FAILURE}` },
      { status: 'CAPTCHA_REQUIRED', applicationNo: 'FNHR100002', message: 'The captcha could not be read after 5 tries.' },
      { status: 'NOT_FOUND', applicationNo: 'FNHR100003', message: 'No record found on parivahan' },
      { status: 'FOUND', applicationNo: 'FNHR100004', data: { vehicleNo: 'HR31V0031', amount: '500', rawStatus: 'SUCCESS', source: 'live' }, source: 'live', rawStatus: 'SUCCESS', message: 'from the portal' },
      { status: 'INVALID_INPUT', applicationNo: 'ab', message: 'Application/Challan number must contain 6-50 letters, numbers, or hyphens. See https://vahan.parivahan.gov.in' },
      { status: 'UNAVAILABLE', applicationNo: 'FNHR100006', message: 'see https://example.org/portal' },
      null,
      'text',
      5
    ];

    const csv = await (await post(t, '/api/export?format=csv', { results: posted }, cookie)).text();
    assert.equal(LEAK.test(csv), false, csv);
    const rows = parse(csv).slice(1);
    assert.equal(rows.length, posted.length, 'one row per posted result');
    assert.deepEqual(rows.map((row) => row[1]), ['UNAVAILABLE', 'UNAVAILABLE', 'NOT_FOUND', 'FOUND', 'INVALID_INPUT', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE']);
    assert.equal(rows[0][13], UNAVAILABLE_TEXT);
    assert.equal(rows[2][13], '');
    assert.deepEqual([rows[3][2], rows[3][11], rows[3][13]], ['HR31V0031', '500', '']);
    assert.equal(rows[4][13], INVALID_INPUT_TEXT);

    const xlsx = Buffer.from(await (await post(t, '/api/export?format=xlsx', { results: posted }, cookie)).arrayBuffer());
    assert.equal(SOURCE_WORDS.test(xlsxParts(xlsx)), false);
    assert.equal(LEAK.test(JSON.stringify((await loadWorkbook(xlsx)).getWorksheet('Transaction Results').getSheetValues())), false);

    for (const [query, body, message] of [
      ['?format=csv', {}, 'Provide 1-1000 results to export.'],
      ['?format=csv', { results: [] }, 'Provide 1-1000 results to export.'],
      ['?format=csv', { results: Array.from({ length: 1001 }, () => ({})) }, 'Provide 1-1000 results to export.'],
      ['?format=pdf', { results: posted }, 'Unsupported export format. Choose csv or xlsx.']
    ]) {
      const refused = await post(t, `/api/export${query}`, body, cookie);
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { status: 'INVALID_INPUT', message });
    }
  });
});

test('manual captcha routes are 404 when enableManualCaptcha is false and reachable (401 without a cookie) when true', async () => {
  const calls = [];
  const automation = {
    openSearchPage: async () => { calls.push('open'); return { close: async () => {} }; },
    prepareSearchForm: async () => { calls.push('prepare'); return null; },
    refreshCaptcha: async () => { calls.push('refresh'); return null; },
    isValidCaptcha: () => { calls.push('valid'); return true; },
    searchWithCaptcha: async () => { calls.push('search'); return { status: 'NOT_FOUND' }; },
    nextCaptcha: async () => null
  };
  const routes = [
    ['POST', '/api/captcha/session'],
    ['POST', '/api/captcha/session/abc/refresh'],
    ['POST', '/api/captcha/session/abc/search'],
    ['DELETE', '/api/captcha/session/abc']
  ];
  const call = (t, method, path, cookie) => fetch(`${t.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: method === 'DELETE' ? undefined : JSON.stringify({ applicationNo: 'FNHR100001', captcha: 'abc123' })
  });

  // Off (the default): behind login like everything else, then a 404 that is the same as for any unknown path.
  await withApp({ automation }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const unknown = await call(t, 'POST', '/api/not-a-route', cookie);
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.text();
    for (const [method, path] of routes) {
      assert.equal((await call(t, method, path)).status, 401, `${method} ${path} without a cookie`);
      const response = await call(t, method, path, cookie);
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(await response.text(), unknownBody, `${method} ${path} answers like an unknown path`);
      assert.equal(SOURCE_WORDS.test(unknownBody), false);
    }
    assert.deepEqual(calls, [], 'the source was never touched');
  });

  // On: reachable, still behind login.
  await withApp({ automation, config: { enableManualCaptcha: true } }, async (t) => {
    const cookie = await t.cookieFor('alice');
    for (const [method, path] of routes) {
      assert.equal((await call(t, method, path)).status, 401, `${method} ${path} without a cookie`);
    }
    const created = await call(t, 'POST', '/api/captcha/session', cookie);
    assert.equal(created.status, 201);
    const { sessionId } = await created.json();
    assert.equal(typeof sessionId, 'string');
    assert.equal((await call(t, 'POST', `/api/captcha/session/${sessionId}/refresh`, cookie)).status, 200);
    assert.equal((await call(t, 'POST', `/api/captcha/session/${sessionId}/search`, cookie)).status, 200);
    assert.equal((await call(t, 'DELETE', `/api/captcha/session/${sessionId}`, cookie)).status, 204);
    assert.equal((await call(t, 'POST', '/api/captcha/session/nope/refresh', cookie)).status, 404, 'a session that does not exist');
    assert.deepEqual(calls.filter((name) => name === 'open'), ['open']);
  });
});

test('an unexpected failure in a manual captcha route is a generic 500 and is logged', async () => {
  const automation = { openSearchPage: async () => { throw new Error(`browserType.launch: Executable doesn't exist at C:\\chromium\\chrome.exe (${SOURCE_FAILURE})`); } };
  await withApp({ automation, config: { enableManualCaptcha: true } }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const response = await post(t, '/api/captcha/session', {}, cookie);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), WENT_WRONG);
    assert.match(t.logged.join('\n'), /Executable doesn't exist/);
  });
});

test('an unknown /api path is a 404 that does not repeat the path', async () => {
  await withApp({ automation: {} }, async (t) => {
    const cookie = await t.cookieFor('alice');
    for (const [method, path] of [['GET', '/api/nothing-here'], ['POST', '/api/captcha-session/parivahan'], ['DELETE', '/api/vahan%3Cb%3E']]) {
      const response = await fetch(`${t.baseUrl}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), NOT_FOUND_API);
    }
  });
});

test('a client that goes away marks the lookup as cancelled, for a single search, a stream and a bulk request', async () => {
  const seen = [];
  let release = () => {};
  const automation = {
    searchTransaction: async (no, options) => {
      seen.push(options);
      await new Promise((resolve) => { release = resolve; });
      return { status: 'NOT_FOUND', applicationNo: no };
    }
  };
  await withApp({ automation }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const { rows: [alice] } = await t.pool.query("select id from users where username = 'alice'");

    for (const [path, body] of [
      ['/api/transaction/search', { applicationNo: 'FNHR100001' }],
      ['/api/transaction/search-stream', { applicationNos: ['FNHR100002'] }],
      ['/api/transaction/bulk', { applicationNos: ['FNHR100003'] }]
    ]) {
      seen.length = 0;
      const controller = new AbortController();
      const pending = post(t, path, body, cookie, { signal: controller.signal }).then((response) => response.text()).catch(() => null);
      for (let waited = 0; seen.length === 0 && waited < 3000; waited += 10) await sleep(10);
      assert.equal(seen.length, 1, `${path}: the search started`);
      assert.equal(seen[0].owner, alice.id, `${path}: owner`);
      assert.equal(seen[0].cancelled(), false, `${path}: the client is still there`);

      controller.abort();
      for (let waited = 0; !seen[0].cancelled() && waited < 3000; waited += 10) await sleep(10);
      assert.equal(seen[0].cancelled(), true, `${path}: the client left`);
      release();
      await pending;
    }
    assert.equal((await fetch(`${t.baseUrl}/health`)).status, 200, 'the server is still serving');
  });
});

test('no response header names the source', async () => {
  const automation = { searchTransaction: async (no) => (no === 'FNHR100001' ? foundResult(no) : failingSearch(no)) };
  await withApp({ automation, config: { enableManualCaptcha: false } }, async (t) => {
    const cookie = await t.cookieFor('alice');
    const numbers = ['FNHR100001', 'FNHR100002'];
    const posted = [{ status: 'FOUND', applicationNo: 'FNHR100001', data: { vehicleNo: 'HR31V0031' } }];
    const responses = [
      await fetch(`${t.baseUrl}/health`),
      await fetch(`${t.baseUrl}/`),
      await fetch(`${t.baseUrl}/no-such-page`),
      await fetch(`${t.baseUrl}/api/auth/me`),
      await fetch(`${t.baseUrl}/api/auth/me`, { headers: { cookie } }),
      await fetch(`${t.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'correct-horse-1' }) }),
      await fetch(`${t.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wrong-password-1' }) }),
      await post(t, '/api/transaction/search', { applicationNo: 'FNHR100001' }, cookie),
      await post(t, '/api/transaction/search', { applicationNo: 'FNHR100002' }, cookie),
      await post(t, '/api/transaction/search', {}, cookie),
      await post(t, '/api/transaction/search-stream', { applicationNos: numbers }, cookie),
      await post(t, '/api/transaction/search-stream', { applicationNos: [] }, cookie),
      await post(t, '/api/transaction/bulk', { applicationNos: numbers }, cookie),
      await post(t, '/api/transaction/bulk?format=csv', { applicationNos: numbers }, cookie),
      await post(t, '/api/transaction/bulk?format=xlsx', { applicationNos: numbers }, cookie),
      await post(t, '/api/transaction/bulk?format=pdf', { applicationNos: numbers }, cookie),
      await post(t, '/api/export?format=csv', { results: posted }, cookie),
      await post(t, '/api/export?format=xlsx', { results: posted }, cookie),
      await post(t, '/api/export?format=pdf', { results: posted }, cookie),
      await post(t, '/api/captcha/session', {}, cookie),
      await post(t, '/api/nothing-here', {}, cookie),
      await fetch(`${t.baseUrl}/api/transaction/search`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"applicationNo": broken' }),
      await fetch(`${t.baseUrl}/api/transaction/bulk`, { method: 'POST', headers: { cookie, 'content-type': 'multipart/form-data; boundary=XYZ' }, body: '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nFNHR100001' })
    ];
    const statuses = [];
    for (const response of responses) {
      const headers = headerText(response);
      assert.equal(SOURCE_WORDS.test(headers), false, `${response.url} (${response.status}):\n${headers}`);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    // The set must really have covered successes, client errors, an unknown path and a server error.
    for (const status of [200, 400, 401, 404, 500]) assert.ok(statuses.includes(status), `no ${status} among ${statuses}`);
  });
});
