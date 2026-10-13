const test = require('node:test');
const assert = require('node:assert/strict');
const { runBatch } = require('../src/stream');

test('reports every number once with its index, as each search finishes', async () => {
  const delays = { A: 30, B: 5, C: 15 };
  const search = (n) => new Promise((resolve) => setTimeout(() => resolve({ status: 'FOUND', applicationNo: n }), delays[n]));
  const seen = [];

  await runBatch(['A', 'B', 'C'], search, (item) => seen.push(item));

  assert.deepEqual(seen.map((s) => s.index), [1, 2, 0]);
  assert.deepEqual(seen.map((s) => s.result.applicationNo), ['B', 'C', 'A']);
});

test('turns a thrown search into a WEBSITE_ERROR for that number only', async () => {
  const search = async (n) => {
    if (n === 'BAD') throw new Error('boom');
    return { status: 'FOUND', applicationNo: n };
  };
  const seen = [];

  await runBatch(['OK1', 'BAD', 'OK2'], search, (item) => seen.push(item));

  const byIndex = Object.fromEntries(seen.map((s) => [s.index, s.result]));
  assert.equal(byIndex[0].status, 'FOUND');
  assert.equal(byIndex[1].status, 'WEBSITE_ERROR');
  assert.equal(byIndex[1].applicationNo, 'BAD');
  assert.match(byIndex[1].message, /boom/);
  assert.equal(byIndex[2].status, 'FOUND');
});

test('stops writing once the writer says the client is gone', async () => {
  const search = async (n) => ({ status: 'FOUND', applicationNo: n });
  let calls = 0;

  await runBatch(['A', 'B', 'C'], search, () => {
    calls += 1;
    return false;
  });

  assert.equal(calls, 1);
});
