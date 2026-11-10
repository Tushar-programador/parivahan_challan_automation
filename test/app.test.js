const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/test-app');

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

test('GET /health answers ok', async () => {
  const t = await startTestApp({ automation: {} });
  try {
    const response = await fetch(`${t.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await t.stop();
  }
});

test('POST /api/transaction/search answers with the lookup result as a client may see it', async () => {
  const t = await startTestApp({
    automation: { searchTransaction: async (no) => ({ status: 'NOT_FOUND', applicationNo: no, message: 'raw message from the source' }) }
  });
  try {
    const response = await postJson(`${t.baseUrl}/api/transaction/search`, { applicationNo: 'FNHR100001' }, { cookie: await t.cookieFor('alice') });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'NOT_FOUND', applicationNo: 'FNHR100001' });
  } finally {
    await t.stop();
  }
});

test('a search without a number is 400 INVALID_INPUT', async () => {
  const t = await startTestApp({ automation: { searchTransaction: async () => ({ status: 'FOUND' }) } });
  try {
    const response = await postJson(`${t.baseUrl}/api/transaction/search`, {}, { cookie: await t.cookieFor('alice') });
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.status, 'INVALID_INPUT');
  } finally {
    await t.stop();
  }
});
