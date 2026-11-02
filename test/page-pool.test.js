const test = require('node:test');
const assert = require('node:assert/strict');
const { createPagePool } = require('../src/page-pool');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakePage = () => ({ closed: false, close() { this.closed = true; return Promise.resolve(); } });

test('has nothing to hand out until a page is kept', () => {
  assert.equal(createPagePool().take(), null);
});

test('hands back a kept page with the result of its last search, once', () => {
  const pool = createPagePool();
  const page = fakePage();
  const last = { status: 'FOUND' };
  pool.keep(page, last);
  assert.deepEqual(pool.take(), { page, last });
  assert.equal(pool.take(), null);
});

test('closes a page nobody asked for within the idle time', async () => {
  const pool = createPagePool({ idleMs: 20 });
  const page = fakePage();
  pool.keep(page, {});
  await wait(60);
  assert.equal(page.closed, true);
  assert.equal(pool.take(), null);
});

test('a page that was taken is not closed behind the caller\'s back', async () => {
  const pool = createPagePool({ idleMs: 20 });
  const page = fakePage();
  pool.keep(page, {});
  assert.ok(pool.take());
  await wait(60);
  assert.equal(page.closed, false);
});

test('closeAll closes every kept page', async () => {
  const pool = createPagePool();
  const pages = [fakePage(), fakePage()];
  pages.forEach((page) => pool.keep(page, {}));
  await pool.closeAll();
  assert.deepEqual(pages.map((page) => page.closed), [true, true]);
  assert.equal(pool.take(), null);
});

test('a page that fails to close does not break closeAll', async () => {
  const pool = createPagePool();
  pool.keep({ close: () => Promise.reject(new Error('already closed')) }, {});
  await pool.closeAll();
});
