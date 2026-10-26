const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore } = require('../src/sessions');

const fakePage = () => ({ closed: false, async close() { this.closed = true; } });
const opener = (page = fakePage(), value = 'first-captcha') => async () => ({ page, value });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('create returns a session id and whatever the opener produced', async () => {
  const store = createSessionStore();
  const { id, value } = await store.create(opener(fakePage(), 'img-1'));
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(value, 'img-1');
});

test('use hands the session page to the callback and returns its result', async () => {
  const store = createSessionStore();
  const page = fakePage();
  const { id } = await store.create(opener(page));
  assert.equal(await store.use(id, async (given) => (given === page ? 'same page' : 'other page')), 'same page');
});

test('use rejects with NOT_FOUND for an unknown session', async () => {
  const store = createSessionStore();
  await assert.rejects(store.use('missing', async () => 1), { code: 'NOT_FOUND' });
});

test('use rejects with BUSY while another call on the same session is still running', async () => {
  const store = createSessionStore();
  const { id } = await store.create(opener());
  let release;
  const first = store.use(id, () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(store.use(id, async () => 1), { code: 'BUSY' });
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await store.use(id, async () => 'free again'), 'free again');
});

test('close shuts the page and forgets the session', async () => {
  const store = createSessionStore();
  const page = fakePage();
  const { id } = await store.create(opener(page));
  await store.close(id);
  assert.equal(page.closed, true);
  await assert.rejects(store.use(id, async () => 1), { code: 'NOT_FOUND' });
});

test('closing an unknown session is harmless', async () => {
  await createSessionStore().close('missing');
});

test('an idle session is closed after idleMs', async () => {
  const store = createSessionStore({ idleMs: 20 });
  const page = fakePage();
  const { id } = await store.create(opener(page));
  await wait(80);
  assert.equal(page.closed, true);
  await assert.rejects(store.use(id, async () => 1), { code: 'NOT_FOUND' });
});

test('a session is not closed for idleness while a call is running', async () => {
  const store = createSessionStore({ idleMs: 20 });
  const page = fakePage();
  const { id } = await store.create(opener(page));
  await store.use(id, () => wait(80));
  assert.equal(page.closed, false);
});

test('create rejects with TOO_MANY at the limit and frees the slot when one closes', async () => {
  const store = createSessionStore({ maxSessions: 1 });
  const { id } = await store.create(opener());
  await assert.rejects(store.create(opener()), { code: 'TOO_MANY' });
  await store.close(id);
  await store.create(opener());
});

test('a failed open does not use up a slot', async () => {
  const store = createSessionStore({ maxSessions: 1 });
  await assert.rejects(store.create(async () => { throw new Error('portal down'); }), /portal down/);
  await store.create(opener());
});

test('closeAll closes every session', async () => {
  const store = createSessionStore();
  const pages = [fakePage(), fakePage()];
  await store.create(opener(pages[0]));
  await store.create(opener(pages[1]));
  await store.closeAll();
  assert.deepEqual(pages.map((p) => p.closed), [true, true]);
});
