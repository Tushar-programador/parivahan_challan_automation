const test = require('node:test');
const assert = require('node:assert/strict');

// The bulk and export routes have error handling that no input can reach: the CSV parser only fails on bad input, and the
// file writers only on a bug. To reach it, the two functions are replaced before the app is loaded (node --test runs each
// file in its own process, so this changes nothing for the other test files).
const bulk = require('../src/bulk');

const realParse = bulk.parseApplicationNumbers;
bulk.parseApplicationNumbers = (csvText) => {
  if (String(csvText).includes('BUG')) throw new TypeError('Cannot read properties of undefined (reading "chromium") at https://vahan.parivahan.gov.in');
  return realParse(csvText);
};
bulk.createXlsx = async () => { throw new Error('xlsx writer broke: page.goto https://vahan.parivahan.gov.in/eTransPgi'); };

const { startTestApp, LEAK } = require('./helpers/test-app');

const WENT_WRONG = { status: 'ERROR', message: 'Something went wrong. Please try again.' };
const lookup = async (_userId, applicationNo) => ({ status: 'NOT_FOUND', applicationNo });

test('an error that is not about the caller\'s CSV is a generic 500 with nothing from the error, and is logged', async () => {
  const t = await startTestApp({ automation: {}, lookup });
  try {
    const cookie = await t.cookieFor('alice');
    const upload = (text) => {
      const form = new FormData();
      form.append('file', new Blob([text], { type: 'text/csv' }), 'numbers.csv');
      return fetch(`${t.baseUrl}/api/transaction/bulk`, { method: 'POST', headers: { cookie }, body: form });
    };

    // The caller's own mistakes still get their message...
    const empty = await upload(' ');
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { status: 'INVALID_INPUT', message: 'The CSV file is empty.' });

    // ...and a failure of ours does not.
    const bug = await upload('BUG');
    assert.equal(bug.status, 500);
    const body = await bug.text();
    assert.deepEqual(JSON.parse(body), WENT_WRONG);
    assert.equal(LEAK.test(body), false);
    assert.match(t.logged.join('\n'), /Cannot read properties of undefined/);
  } finally {
    await t.stop();
  }
});

test('a file that cannot be written is a generic 500 for a bulk download and for an export', async () => {
  const t = await startTestApp({ automation: {}, lookup });
  try {
    const cookie = await t.cookieFor('alice');
    const headers = { 'content-type': 'application/json', cookie };

    const download = await fetch(`${t.baseUrl}/api/transaction/bulk?format=xlsx`, { method: 'POST', headers, body: JSON.stringify({ applicationNos: ['FNHR100001'] }) });
    assert.equal(download.status, 500);
    const downloadBody = await download.text();
    assert.deepEqual(JSON.parse(downloadBody), WENT_WRONG);
    assert.equal(LEAK.test(downloadBody), false);
    assert.equal(download.headers.get('content-disposition'), null, 'no half-made download');

    const exported = await fetch(`${t.baseUrl}/api/export?format=xlsx`, { method: 'POST', headers, body: JSON.stringify({ results: [{ status: 'NOT_FOUND', applicationNo: 'FNHR100001' }] }) });
    assert.equal(exported.status, 500);
    const exportedBody = await exported.text();
    assert.deepEqual(JSON.parse(exportedBody), WENT_WRONG);
    assert.equal(LEAK.test(exportedBody), false);

    assert.equal(t.logged.filter((line) => line.includes('xlsx writer broke')).length, 2, 'both failures were logged');
  } finally {
    await t.stop();
  }
});
