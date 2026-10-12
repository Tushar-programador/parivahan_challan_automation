const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../src/limiter');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('never runs more than the limit at once, and does reach the limit', async () => {
  const limit = createLimiter(5);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    await tick();
    active -= 1;
  };
  await Promise.all(Array.from({ length: 12 }, () => limit(task)));
  assert.equal(peak, 5);
});

test('returns each task result and propagates its error without blocking others', async () => {
  const limit = createLimiter(2);
  const ok = limit(async () => 'a');
  const bad = limit(async () => { throw new Error('boom'); });
  const after = limit(async () => 'b');
  assert.equal(await ok, 'a');
  await assert.rejects(bad, /boom/);
  assert.equal(await after, 'b');
});

test('starts queued tasks in the order they were submitted', async () => {
  const limit = createLimiter(1);
  const started = [];
  await Promise.all([1, 2, 3, 4].map((n) => limit(async () => {
    started.push(n);
    await tick();
  })));
  assert.deepEqual(started, [1, 2, 3, 4]);
});

test('falls back to 1 for an invalid limit', async () => {
  const limit = createLimiter(0);
  let active = 0;
  let peak = 0;
  await Promise.all([1, 2, 3].map(() => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
  })));
  assert.equal(peak, 1);
});
