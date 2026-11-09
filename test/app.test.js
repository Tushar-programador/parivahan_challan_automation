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

test('POST /api/transaction/search returns the injected search result', async () => {
  const t = await startTestApp({
    automation: { searchTransaction: async (no) => ({ status: 'NOT_FOUND', applicationNo: no }) }
  });
  try {
    const response = await postJson(`${t.baseUrl}/api/transaction/search`, { applicationNo: 'FNHR1' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'NOT_FOUND', applicationNo: 'FNHR1' });
  } finally {
    await t.stop();
  }
});

test('a search without a number is 400 INVALID_INPUT', async () => {
  const t = await startTestApp({ automation: { searchTransaction: async () => ({ status: 'FOUND' }) } });
  try {
    const response = await postJson(`${t.baseUrl}/api/transaction/search`, {});
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.status, 'INVALID_INPUT');
  } finally {
    await t.stop();
  }
});

test('with accessKey set, /api needs the x-access-key header', async () => {
  const t = await startTestApp({
    accessKey: 'k',
    automation: { searchTransaction: async (no) => ({ status: 'NOT_FOUND', applicationNo: no }) }
  });
  try {
    const url = `${t.baseUrl}/api/transaction/search`;
    const denied = await postJson(url, { applicationNo: 'FNHR1' });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).status, 'UNAUTHORIZED');

    const allowed = await postJson(url, { applicationNo: 'FNHR1' }, { 'x-access-key': 'k' });
    assert.equal(allowed.status, 200);
  } finally {
    await t.stop();
  }
});
