# Client Data Service Implementation Plan (accounts, own database, hidden source)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Parivahan lookup server into a client-facing data service: client logins, our own PostgreSQL store of found records served first, and nothing client-visible that reveals where the data comes from.

**Architecture:** `server.js` is split into a testable `createApp(deps)`. A `lookup` service answers each number from our shared `records` table when it can and from the source only when it must. A `present` layer turns internal results into a small client-safe vocabulary, and every client-facing route goes through it. Each client sees only the records they have asked for (a link table). All client queries are scoped by `user_id`.

**Tech Stack:** Node 22, Express 5, `pg`, `cookie-parser`, `pg-mem` (tests only), Playwright (already present, used for the UI test), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-09-db-auth-saved-results-design.md`

**Branch:** work on `feature/data-service-db-auth` (Task 1 creates it). Baseline: `npm test` = 67 passing, 0 failing (about 20 s).

## Global Constraints

- CommonJS (`require`), no TypeScript, no ORM, no bcrypt or other native-compiled module.
- New runtime dependencies are exactly `pg` and `cookie-parser`. New dev dependency is exactly `pg-mem`.
- Tests: `node --test` via `npm test`. The count may only go up. Files under `test/helpers/` are also executed by `node --test`; they must do nothing when loaded.
- A record is stored only when `result.status === 'FOUND'` and `result.data` exists. Nothing else is ever written to `records`.
- Client-visible output (pages, JSON bodies, error messages, export files, response headers) must never contain, case-insensitively: `parivahan`, `vahan`, `portal`, `captcha`, `gov.in`, `playwright`, `chromium`, `ddddocr`, a URL, or a stack trace.
- Client-facing statuses are exactly `FOUND`, `NOT_FOUND`, `INVALID_INPUT`, `UNAVAILABLE`. Fixed client messages: `UNAVAILABLE` -> `We could not get this one right now. Please try again in a little while.`; `INVALID_INPUT` -> `Enter 6-50 letters, numbers or hyphens.`; unexpected server error -> `Something went wrong. Please try again.`.
- Error bodies keep the shape `{ status: '<CODE>', message: '...' }`. Auth failures use `status: 'UNAUTHORIZED'`.
- Every client query on `client_records` / list / export / remove is scoped by `user_id`.
- Usernames: trimmed, lowercased, `/^[a-z0-9._-]{3,40}$/`. Passwords: at least 10 characters, stored as scrypt.
- Session cookie: name `sid`, HttpOnly, `SameSite=Lax`, `Secure` when `config.cookieSecure`. Lifetime `SESSION_TTL_HOURS` (default 12).
- `DATABASE_URL` is read only from the environment. No secrets in the repo; `.env` stays git-ignored.
- `node-pg` returns `int8` as strings. `src/db.js` registers a parser so every id and count is a JS number.
- Application numbers are normalized with `normalizeApplicationNumber` (trimmed, upper case) before any lookup, store or compare.

## Review Focus

Inputs and conditions the spec implies but that no happy-path test would exercise. Each has an owning task with a pinning test.

1. A failure whose raw message contains the source's URL or browser error text (`page.goto: ... https://vahan.parivahan.gov.in/...`), a thrown exception, a validation error: the client sees only the fixed neutral message, in the single search, the stream, bulk and exports. (Tasks 6, 7 and 10)
2. A stored record whose payment status is not final, or whose refetch times out or says "no record": it must be refetched, or served with its "as of" date, never presented as fresh. (Task 6)
3. The same number asked twice at the same moment (two clients, or twice in one batch): two live searches finish together, the second save must not fail on the unique key and must not duplicate the row. (Tasks 5 and 6)
4. The database down or throwing during a lookup: the client still gets the answer, the stream keeps going, the process does not crash. (Task 6)
5. Cross-client leakage by guessing an id, exporting, or listing; and a "remove" that must only remove the caller's link. (Tasks 5 and 8)

---

### Task 1: Make the server testable (`createApp`)

**Files:**
- Create: `src/app.js`, `test/helpers/test-app.js`, `test/app.test.js`
- Modify: `src/server.js` (becomes the launcher only)

**Interfaces:**
- Produces: `createApp({ automation?, accessKey? }) -> { app: express.Application, closeCaptchaSessions(): Promise<void> }`. `automation` defaults to `require('./automation')`; `accessKey` defaults to `process.env.ACCESS_KEY || ''`. Routes read functions off `automation` at request time, so tests may pass a partial object.
- Produces: `startTestApp(deps = {}) -> Promise<{ baseUrl: string, stop(): Promise<void> }>`. It calls `createApp(deps)` and listens on `127.0.0.1:0`. Later tasks extend it.

- [ ] **Step 1: Create the branch.** Run `git switch -c feature/data-service-db-auth`.

- [ ] **Step 2: Write the failing tests** in `test/app.test.js` (each starts an app with `startTestApp` and calls `t.stop()` at the end):

```js
test('GET /health answers ok', async () => {
  // fetch(`${t.baseUrl}/health`) -> 200, body { status: 'ok' }
});
test('POST /api/transaction/search returns the injected search result', async () => {
  // automation: { searchTransaction: async (no) => ({ status: 'NOT_FOUND', applicationNo: no }) }
  // body { applicationNo: 'FNHR1' } -> deepEqual { status: 'NOT_FOUND', applicationNo: 'FNHR1' }
});
test('a search without a number is 400 INVALID_INPUT', async () => {
  // body {} -> 400, json.status === 'INVALID_INPUT'
});
test('with accessKey set, /api needs the x-access-key header', async () => {
  // accessKey: 'k' -> no header 401 UNAUTHORIZED; header 'k' -> 200
});
```

- [ ] **Step 3: Run `node --test test/app.test.js`.** Expected: FAIL, `Cannot find module '../src/app'`.

- [ ] **Step 4: Implement `createApp`** by moving the route and middleware code from `src/server.js:1-272` into `src/app.js` with no behaviour change. Replace direct `require('./automation')` calls by the injected `automation` object. `src/server.js` keeps only: build the app, `app.listen(PORT, HOST)`, and the SIGINT handler (`closeCaptchaSessions().then(closeBrowser)`).

- [ ] **Step 5: Run `npm test`.** Expected: 71 passing (67 + 4), 0 failing.

- [ ] **Step 6: Smoke check.** Run `npm start`, request `http://127.0.0.1:3000/health`, expect `{"status":"ok"}`, then stop it.

- [ ] **Step 7: Commit.** `git add src test && git commit -m "refactor: extract createApp so the server can be tested"`

---

### Task 2: Database layer, migrations, config

**Files:**
- Create: `src/config.js`, `src/db.js`, `migrations/001_init.sql`, `test/db.test.js`
- Modify: `test/helpers/test-app.js` (add `createTestPool`), `package.json` (via `npm install pg cookie-parser` and `npm install -D pg-mem`)

**Interfaces:**
- Produces: `loadConfig(env = process.env) -> { port: number, host: string, databaseUrl: string, databaseSsl: false | true | 'no-verify', sessionTtlHours: number, cookieSecure: boolean, trustProxy: boolean | number, brandName: string, finalBankStatuses: string[], enableManualCaptcha: boolean }`. Throws an `Error` containing `DATABASE_URL` when it is missing. Defaults: port 3000, host `127.0.0.1`, ssl false, ttl 12, `cookieSecure` true only when `NODE_ENV === 'production'`, `trustProxy` from `TRUST_PROXY` (`'true'` -> true, a number string -> that number, unset -> false), `brandName` from `BRAND_NAME` (default `Records`), `finalBankStatuses` from `FINAL_BANK_STATUSES` (comma separated, trimmed, upper-cased; default `['SUCCESS']`), `enableManualCaptcha` true only when `ENABLE_MANUAL_CAPTCHA === 'true'`. `DATABASE_SSL`: `'true'` -> true, `'no-verify'` -> `'no-verify'`.
- Produces: `createPool(config) -> pg.Pool` (ssl `{ rejectUnauthorized: true }` for true, `{ rejectUnauthorized: false }` for `'no-verify'`).
- Produces: `migrate(pool, dir = <repo>/migrations) -> Promise<string[]>`: applies `*.sql` files in name order, each in a transaction, recorded in `schema_migrations(name text primary key)`. Resolves to the names applied in this call (`[]` when up to date).
- Produces: `createTestPool({ migrate = true } = {}) -> Promise<pg.Pool>`: a `pg-mem` pool by default; when `TEST_DATABASE_URL` is set, a real Postgres pool whose `public` schema is dropped and recreated first. Applies migrations unless `migrate: false`.
- Schema (`001_init.sql`):
  - `users(id bigserial pk, username text unique not null, password_hash text not null, is_active boolean not null default true, created_at timestamptz not null default now())`
  - `sessions(token_hash text pk, user_id bigint not null references users on delete cascade, expires_at timestamptz not null, created_at timestamptz not null default now())`
  - `records(id bigserial pk, application_no text unique not null, vehicle_no, transaction_no, payment_id, payment_date, payment_confirmation_date, payment_gateway, bank_ref_no, grn, cin, amount, bank_status, status_description` all `text not null default ''`, `first_found_at timestamptz not null default now(), last_found_at timestamptz not null default now())` — the shared store, one row per application number.
  - `client_records(user_id bigint not null references users on delete cascade, record_id bigint not null references records on delete cascade, first_requested_at timestamptz not null default now(), last_requested_at timestamptz not null default now(), primary key (user_id, record_id))` plus an index on `(user_id, last_requested_at desc)`.

- [ ] **Step 1: Install dependencies.** `npm install pg cookie-parser` and `npm install -D pg-mem`.

- [ ] **Step 2: Write the failing tests** in `test/db.test.js`:

```js
test('loadConfig requires DATABASE_URL', () => assert.throws(() => loadConfig({}), /DATABASE_URL/));
test('loadConfig defaults', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x' });
  assert.deepEqual([c.port, c.host, c.databaseSsl, c.sessionTtlHours, c.cookieSecure, c.trustProxy, c.brandName, c.finalBankStatuses, c.enableManualCaptcha],
    [3000, '127.0.0.1', false, 12, false, false, 'Records', ['SUCCESS'], false]);
});
test('cookieSecure defaults to true in production; TRUST_PROXY=2 is the number 2; DATABASE_SSL=no-verify is kept', ...);
test('FINAL_BANK_STATUSES=" success , Paid " becomes ["SUCCESS","PAID"]; ENABLE_MANUAL_CAPTCHA=true turns it on', ...);
test('migrate creates users, sessions, records, client_records and a second run applies nothing', async () => {
  const pool = await createTestPool({ migrate: false });
  assert.deepEqual(await migrate(pool), ['001_init.sql']);
  assert.deepEqual(await migrate(pool), []);
  // select from each of the four tables succeeds
});
test('a second records row for the same application_no violates the unique key', async () => {
  // insert twice -> rejects with error.code === '23505'
});
test('deleting a user removes their sessions and client_records but keeps the shared records', ...);
test('ids and counts come back as numbers', async () => {
  // typeof user row id === 'number'; typeof count(*) === 'number'
});
```

- [ ] **Step 3: Run `node --test test/db.test.js`.** Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `config.js`, `db.js` and `001_init.sql`** per the interfaces. Keep the SQL inside the subset `pg-mem` supports; if `pg-mem` rejects a statement, run the suite against real Postgres (`TEST_DATABASE_URL`) rather than weakening the schema.

- [ ] **Step 5: Run `npm test`.** Expected: all passing.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: add config, Postgres pool and migrations"`

---

### Task 3: Users, passwords and the admin CLI

**Files:**
- Create: `src/passwords.js`, `src/users.js`, `src/user-cli.js`, `test/passwords.test.js`, `test/users.test.js`
- Modify: `package.json` (script `"user": "node src/user-cli.js"`)

**Interfaces:**
- Consumes: `createTestPool`, `migrate`, `loadConfig`, `createPool`.
- Produces: `hashPassword(plain: string) -> Promise<string>` (format `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`), `verifyPassword(plain: string, stored: string) -> Promise<boolean>` (constant-time compare; `false`, never a throw, for a malformed `stored`).
- Produces: `class UserError extends Error { code: 'INVALID' | 'EXISTS' }`.
- Produces: `createUserStore(pool) -> { create(username, password) -> Promise<{id, username}>, authenticate(username, password) -> Promise<{id, username} | null>, getById(id) -> Promise<{id, username} | null>, setPassword(username, password) -> Promise<boolean>, setActive(username, active: boolean) -> Promise<boolean>, list() -> Promise<{id, username, isActive, createdAt}[]> }`. `authenticate` returns `null` for an unknown user, a wrong password or an inactive user, and burns a dummy hash for an unknown user so timing does not reveal which usernames exist. `getById` returns `null` for inactive users. `setPassword` and `setActive(false)` delete that user's rows in `sessions`.
- Produces: `runUserCli(args: string[], { users, print }) -> Promise<number>` (exit code). Commands: `create <username> [--password <pw>]` (without a password, generates 16 random characters and prints `Password: <value>` once), `list`, `passwd <username> [--password <pw>]`, `disable <username>`, `enable <username>`. `node src/user-cli.js` reads `DATABASE_URL`, runs `migrate`, then calls `runUserCli`.

- [ ] **Step 1: Write the failing tests.**

```js
// passwords.test.js
test('verifies the right password and rejects a wrong one', ...);
test('two hashes of the same password differ', ...);
test('verifyPassword is false for a malformed stored value', async () => assert.equal(await verifyPassword('x', 'garbage'), false));

// users.test.js (pool from createTestPool)
test('create trims and lowercases the username; authenticate then works with any case', ...);
test('create rejects a short password and a bad username with UserError INVALID', ...);
test('create rejects a duplicate username, ignoring case, with UserError EXISTS', ...);
test('authenticate returns null for unknown user, wrong password and inactive user', ...);
test('setActive(false) deletes that user\'s sessions and getById returns null', ...);
test('setPassword revokes sessions; the old password fails, the new one works', ...);
test('runUserCli create prints a 16 character password once and the user can log in with it', async () => {
  // print collects lines; one line matches /^Password: \S{16}$/ and authenticate succeeds with it
});
test('runUserCli exits 1 with a message for an unknown command', ...);
```

- [ ] **Step 2: Run `node --test test/passwords.test.js test/users.test.js`.** Expected: FAIL, modules not found.

- [ ] **Step 3: Implement** `passwords.js` (Node `crypto.scrypt`, 16-byte random salt, `timingSafeEqual`), `users.js` and `user-cli.js` per the interfaces.

- [ ] **Step 4: Run `npm test`.** Expected: all passing.

- [ ] **Step 5: Manual check.** With a local Postgres (or Docker `postgres:16`), run `DATABASE_URL=... npm run user -- create alice`; it prints a password. `npm run user -- list` shows `alice`.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: add users, scrypt passwords and a user admin CLI"`

---

### Task 4: Login, sessions and protecting the API

**Files:**
- Create: `src/auth.js`, `test/auth.test.js`
- Modify: `src/app.js` (remove `ACCESS_KEY`; mount auth; guard `/api`), `test/helpers/test-app.js`, `test/app.test.js` (delete the access-key test)

**Interfaces:**
- Consumes: `createUserStore` (Task 3), the `loadConfig` shape (Task 2).
- Produces: `createSessionStore(pool, { ttlHours }) -> { create(userId) -> Promise<{ token: string, expiresAt: Date }>, resolve(token) -> Promise<{id, username} | null>, destroy(token) -> Promise<void>, purgeExpired() -> Promise<number> }`. The token is 32 random bytes in hex; the table stores only its SHA-256. `resolve` is `null` when the token is unknown, expired, or its user is inactive.
- Produces: `createLoginThrottle({ maxFailures = 5, windowMs = 15 * 60 * 1000, now = Date.now }) -> { blocked(key): boolean, fail(key): void, reset(key): void }`.
- Produces: `authRouter({ users, sessions, throttle, cookieSecure }) -> express.Router`, mounted at `/api/auth`: `POST /login` (body `{ username, password }`), `POST /logout`, `GET /me`.
  - `/login` success: 200 `{ user: { id, username } }` and the `sid` cookie. Failure: 401 `{ status: 'UNAUTHORIZED', message: 'Invalid username or password.' }`, the same message for unknown, wrong-password and inactive. The throttle key is `${req.ip}|${username lowercased}`; once blocked, even a correct password gets 429 `{ status: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' }` with a `Retry-After` header. A success calls `reset`.
  - `/logout`: 204, deletes the session row, clears the cookie. `/me`: 200 `{ user }` or 401.
- Produces: `requireAuth(sessions) -> middleware` (reads `req.cookies.sid`, sets `req.user = { id, username }`, otherwise 401 `UNAUTHORIZED`), and `sameOrigin() -> middleware` (for non-GET/HEAD/OPTIONS requests, a present `Origin` header whose host differs from `req.get('host')` gets 403 `FORBIDDEN`).
- Produces: `createApp({ automation, users, sessions, throttle, config })`. `/health` and `/api/auth/*` stay open; every other `/api` route goes through `requireAuth`. The app uses `cookie-parser` and `app.set('trust proxy', config.trustProxy)`.
- Produces: `startTestApp({ automation?, users?: [[username, password]], config? }) -> Promise<{ baseUrl, pool, stores: { users, sessions }, cookieFor(username): Promise<string>, stop() }>`. It builds a `pg-mem` pool, runs `migrate`, creates the listed users (default `[['alice', 'correct-horse-1']]`), and wires real stores. `cookieFor` logs in through the HTTP route and returns the `sid=...` string for a `cookie` request header.

- [ ] **Step 1: Write the failing tests** in `test/auth.test.js`:

```js
test('login with the right password sets an HttpOnly SameSite=Lax sid cookie and returns the user', ...);
test('the cookie has no Secure flag by default and has it when config.cookieSecure is true', ...);
test('wrong password, unknown user and inactive user all get the same 401 message', ...);
test('after 5 wrong passwords the 6th attempt, even with the right password, is 429 with Retry-After', ...);
test('a successful login resets the failure count', ...);
test('GET /api/auth/me is 401 without a cookie and 200 with one', ...);
test('POST /api/transaction/search is 401 without a cookie and 200 with one', ...);
test('/health stays open without a cookie', ...);
test('logout returns 204 and the cookie no longer works', ...);
test('an expired session is 401', async () => {
  // UPDATE sessions SET expires_at = now() - interval '1 minute'; then /me -> 401
});
test('disabling the user kills a cookie that was already issued', ...);
test('a POST with a foreign Origin header and a valid cookie is 403', ...);
test('purgeExpired removes only expired rows and returns how many', ...);
```

- [ ] **Step 2: Run `node --test test/auth.test.js`.** Expected: FAIL, `Cannot find module '../src/auth'`.

- [ ] **Step 3: Implement `auth.js`, update `createApp`** (drop `requireAccessKey` and the `accessKey` option), and extend `startTestApp`. In `server.js`, build config, pool, `migrate`, stores and throttle, and pass them to `createApp`; call `sessions.purgeExpired()` at boot and every hour (`setInterval(...).unref()`).

- [ ] **Step 4: Delete the access-key test** from `test/app.test.js`; update the other `app.test.js` tests to send `cookieFor('alice')`.

- [ ] **Step 5: Run `npm test`.** Expected: all passing.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: add login, cookie sessions and protect the API"`

---

### Task 5: Record store (shared records, per-client links)

**Files:**
- Create: `src/records.js`, `test/records.test.js`

**Interfaces:**
- Consumes: `normalizeApplicationNumber` from `src/automation.js`; the pool from `createTestPool`.
- Produces: `createRecordStore(pool) -> { get(applicationNo) -> Promise<StoredRecord | null>, saveFound(result) -> Promise<StoredRecord | null>, link(userId, recordId) -> Promise<void>, list(userId, { q = '', limit = 50, offset = 0 }) -> Promise<{ items: StoredRecord[], total: number }>, all(userId, { q = '', limit = 50000 }) -> Promise<StoredRecord[]>, unlink(userId, recordId) -> Promise<boolean> }`.
  - `get` normalizes the number and reads the shared `records` table. It is for the lookup service only; no route exposes it directly.
  - `saveFound(result)` writes only when `result.status === 'FOUND' && result.data`; otherwise it returns `null` without touching the database. It upserts on `application_no` (`ON CONFLICT ... DO UPDATE`): every field is overwritten, `last_found_at = now()`, `first_found_at` is kept. It returns the stored row.
  - `link(userId, recordId)` upserts the `client_records` row and sets `last_requested_at = now()`; calling it twice leaves one row.
  - `list` and `all` return only records the user has linked, ordered by `last_requested_at desc`. `q` is a case-insensitive substring match on application number or vehicle number, with `%` and `_` escaped.
  - `unlink(userId, recordId)` deletes only that user's `client_records` row and returns whether one was deleted. The shared record stays.
  - `StoredRecord = { id, applicationNo, vehicleNo, transactionNo, paymentId, paymentDate, paymentConfirmationDate, paymentGateway, bankRefNo, grn, cin, amount, bankStatus, statusDescription, firstFoundAt, lastFoundAt }`. `bankStatus` is `result.data.status` (for example `SUCCESS`).
- Produces: a test fixture `foundResult(applicationNo, overrides = {})` in `test/helpers/test-app.js` returning `{ status: 'FOUND', applicationNo, data: { vehicleNo: 'HR31V0031', amount: '500', status: 'SUCCESS', statusDescription: 'Paid', ...overrides }, rawStatus: 'SUCCESS' }`.

- [ ] **Step 1: Write the failing tests** (two users `u1`, `u2` created in `before`):

```js
test('saveFound stores a FOUND result and get returns it', ...);
test('saveFound stores nothing for any other status', async () => {
  for (const status of ['NOT_FOUND', 'INVALID_INPUT', 'TIMEOUT', 'WEBSITE_ERROR', 'CAPTCHA_REQUIRED', 'CANCELLED']) {
    assert.equal(await store.saveFound({ status, applicationNo: 'FNHR1' }), null);
  }
  // select count(*) from records -> 0
});
test('a FOUND result without data is not stored', ...);
test('saving the same number again refreshes the row: amount 500 -> 600, one row, firstFoundAt kept, lastFoundAt >= firstFoundAt', ...);
test('" fnhr1 " and "FNHR1" are the same record, stored as FNHR1', ...);
test('two saveFound calls at the same moment for one number both resolve and leave one row', async () => {
  await Promise.all([store.saveFound(r), store.saveFound(r)]); // count(*) === 1
});
test('link makes the record appear in that user\'s list; linking twice leaves one entry', ...);
test('another user\'s list and export are empty even though the shared record exists', ...);
test('unlink by a user who has no link returns false and the owner\'s entry survives', ...);
test('unlink by the owner returns true, drops the list entry, and the shared record is still readable with get', ...);
test('q matches vehicle and application number case-insensitively, and "%" matches nothing', ...);
test('limit/offset page newest-requested first and total is the full count', async () => {
  // 3 linked records, limit 2 offset 2 -> 1 item, total 3
});
```

- [ ] **Step 2: Run `node --test test/records.test.js`.** Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createRecordStore`** with parameterized SQL only. Never build SQL from `q`.

- [ ] **Step 4: Run `npm test`.** Expected: all passing.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: add the shared record store with per-client links"`

---

### Task 6: Lookup service (our data first, the source only when needed)

**Files:**
- Create: `src/lookup.js`, `test/lookup.test.js`

**Interfaces:**
- Consumes: `createRecordStore` (Task 5), `normalizeApplicationNumber` and `isValidApplicationNumber` from `src/automation.js`, `config.finalBankStatuses` (Task 2).
- Produces: `createLookup({ records, search, finalBankStatuses = ['SUCCESS'], log = console.error }) -> (userId, applicationNo, { cancelled?, owner? } = {}) -> Promise<LookupResult>`. `search` has the signature of `automation.searchTransaction`. **It never throws.**
  - `LookupResult` is internal (raw statuses allowed): `{ status: 'FOUND', applicationNo, record: StoredRecord, source: 'stored' | 'live' | 'stale' }`, or `{ status: <any raw status>, applicationNo, message? }`.
  - Rules, in order:
    1. Invalid number -> `INVALID_INPUT`, no database or source access.
    2. `records.get`; if the record exists and `record.bankStatus.toUpperCase()` is in `finalBankStatuses` -> `records.link`, return FOUND with `source: 'stored'`, no source search.
    3. Otherwise call `search(applicationNo, { cancelled, owner })`.
    4. Live FOUND -> `records.saveFound`, `records.link`, return FOUND with `source: 'live'`. If the save or link throws, log it and still return FOUND built from the live data (`record` fields from `result.data`, `lastFoundAt` now, no `id`).
    5. Live NOT_FOUND with no stored record -> return NOT_FOUND (nothing stored, nothing linked).
    6. Live non-FOUND (NOT_FOUND, TIMEOUT, WEBSITE_ERROR, CAPTCHA_REQUIRED, ...) while a stored record exists -> link it and return FOUND with `source: 'stale'`.
    7. Live failure with no stored record -> return the raw result as is.
    8. If `records.get` throws, log it and continue at step 3 as if nothing were stored. Any other thrown error is caught, logged, and returned as `{ status: 'WEBSITE_ERROR', applicationNo }`.
    9. Every raw failure (status other than FOUND, NOT_FOUND, INVALID_INPUT) is logged once with its raw message.

- [ ] **Step 1: Write the failing tests** (a fake in-memory `records` where useful, the real store on a `pg-mem` pool for the shared-store tests; a `search` spy):

```js
test('a stored record with a final status is answered from the store: source "stored", search never called, user linked', ...);
test('the final-status check ignores case and honours a custom list', async () => {
  // bankStatus 'success' with ['SUCCESS'] -> stored; bankStatus 'PAID' with ['PAID'] -> stored; 'PENDING' -> search called
});
test('a stored record with a non-final status is searched again; a live FOUND updates the shared row and returns source "live"', ...);
test('nothing stored: live FOUND is saved, linked and returned; live NOT_FOUND stores and links nothing', ...);
test('live TIMEOUT, WEBSITE_ERROR and CAPTCHA_REQUIRED return the stored record as source "stale" when one exists, else the raw status', ...);
test('live NOT_FOUND for a number we hold with a non-final status returns the stored record as "stale"', ...);
test('an invalid number returns INVALID_INPUT without touching the store or the search', ...);
test('a second client asking for a number the first client found is served from the store, and each client lists only what they asked for', ...);
test('two lookups of the same new number at the same time both return FOUND and leave one record', async () => {
  // search resolves FOUND after a tick for both; Promise.all(...) ; count(*) from records === 1
});
test('when records.get throws, the lookup still searches live; when saveFound throws, it still returns FOUND (log called once each)', ...);
test('a thrown search becomes WEBSITE_ERROR and lookup does not throw', ...);
test('"fnhr1 " and "FNHR1" are the same number', ...);
test('cancelled and owner are passed through to search', ...);
test('each raw failure is logged once with its raw message', ...);
```

- [ ] **Step 2: Run `node --test test/lookup.test.js`.** Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createLookup`** following the rules above.

- [ ] **Step 4: Run `npm test`.** Expected: all passing.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: add the lookup service (our data first, source when needed)"`

---

### Task 7: Client-facing results, routes and exports

**Files:**
- Create: `src/present.js`, `test/client-results.test.js`
- Modify: `src/app.js` (search, search-stream, bulk, export, error handler, manual captcha gating), `src/bulk.js` (`createXlsx` creator), `test/helpers/test-app.js` (wire `records`, `lookup`, expose `stores.records`)

**Interfaces:**
- Consumes: `createLookup` (Task 6), `req.user.id` (Task 4), `runBatch` (`src/stream.js`), `normalizeBulkResult` and `createCsv` / `createXlsx` (`src/bulk.js`).
- Produces: `toClientResult(lookupResult) -> ClientResult`:
  - FOUND -> `{ status: 'FOUND', applicationNo, data: { vehicleNo, transactionNo, paymentId, paymentDate, paymentConfirmationDate, paymentGateway, bankRefNo, grn, cin, amount, bankStatus, statusDescription }, asOf: <ISO string of record.lastFoundAt> }`. Only those fields; `source`, `rawStatus`, ids and everything else are dropped.
  - NOT_FOUND -> `{ status: 'NOT_FOUND', applicationNo }`.
  - INVALID_INPUT -> `{ status: 'INVALID_INPUT', applicationNo, message: <fixed> }`.
  - Every other status, and anything unrecognised, including CANCELLED -> `{ status: 'UNAVAILABLE', applicationNo, message: <fixed> }`.
- Produces: `createXlsx(results, { creator = 'Data export' } = {})`. The workbook `creator` is no longer `Parivahan Transaction Automation`. All export downloads are named `results.csv` / `results.xlsx`.
- `createApp` takes `lookup` and `log` in its deps. The routes `POST /api/transaction/search`, `search-stream` and `bulk` call `async (n) => toClientResult(await lookup(req.user.id, n, { cancelled, owner: req.user.id }))`. The bulk route no longer uses `processBulk` (that stays for `npm run bulk`); it collects results in input order with `runBatch`, then `normalizeBulkResult`.
- Unexpected errors in the routes and in the final error handler no longer echo the error text (today they answer `Unexpected server error: <message>`). They answer 500 `{ status: 'ERROR', message: 'Something went wrong. Please try again.' }` and log the real error through `log`. Multer rejections keep their client-safe text.
- The manual captcha routes (`/api/captcha/session...`) are mounted only when `config.enableManualCaptcha` is true, and then still require login. When off, they answer 404 like any unknown path.

- [ ] **Step 1: Write the failing tests** in `test/client-results.test.js`:

```js
test('toClientResult keeps only the whitelisted fields for FOUND and formats asOf as ISO', ...);
test('TIMEOUT, WEBSITE_ERROR, CAPTCHA_REQUIRED, CANCELLED and an unknown status all become UNAVAILABLE with the fixed message and no raw message', ...);
test('INVALID_INPUT gets the fixed message; NOT_FOUND has no message', ...);
const LEAK = /parivahan|vahan|portal|captcha|gov\.in|playwright|chromium|ddddocr|https?:\/\//i;
test('a failure whose raw message contains the source URL never reaches the client: single search, stream line and bulk row', async () => {
  // stub search -> { status: 'WEBSITE_ERROR', message: 'page.goto: net::ERR_X at https://vahan.parivahan.gov.in/eTransPgi/transactionStatus' }
  // assert !LEAK.test(JSON.stringify(body)) for each of the three routes, and status === 'UNAVAILABLE'
});
test('a lookup that throws gives the fixed "Something went wrong" message and logs the real error', ...);
test('a FOUND answer carries data and asOf and has no rawStatus or source key', ...);
test('search-stream answers one line per number with the client vocabulary only', ...);
test('bulk json returns every number in input order', ...);
test('xlsx export has creator "Data export" and is downloaded as results.xlsx; /api/export csv as results.csv', ...);
test('manual captcha routes are 404 when enableManualCaptcha is false and reachable (401 without a cookie) when true', ...);
test('no response header names the source', async () => { /* iterate response headers, assert !LEAK.test(value) */ });
```

- [ ] **Step 2: Run `node --test test/client-results.test.js`.** Expected: FAIL, module not found.

- [ ] **Step 3: Implement `present.js`, rewire the routes, gate the manual captcha routes, neutralize filenames, creator and error text.**

- [ ] **Step 4: Run `npm test`.** Expected: all passing (update the Task 1 and Task 4 tests that assumed the old raw results).

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: client-safe results, routes and exports that never name the source"`

---

### Task 8: "My records" API and export

**Files:**
- Create: `src/records-routes.js`, `test/records-api.test.js`
- Modify: `src/app.js` (mount at `/api/records`)

**Interfaces:**
- Consumes: `createRecordStore` (Task 5), `createCsv` / `createXlsx` / `normalizeBulkResult` (`src/bulk.js`), `toClientResult` (Task 7).
- Produces: `recordsRouter({ records }) -> express.Router` mounted at `/api/records` behind `requireAuth`:
  - `GET /api/records?q=&limit=&offset=` -> 200 `{ items, total, limit, offset }` where each item is `{ id, applicationNo, data: {…whitelisted fields…}, asOf }` (same shape as a `FOUND` client result plus `id`). `limit` is clamped to 1-200 (default 50); a non-numeric `limit` or `offset` falls back to the default.
  - `GET /api/records/export?format=csv|xlsx&q=` -> the user's records (up to 50000) through the existing export columns with `status: 'FOUND'`. An unknown format -> 400 `INVALID_INPUT`. Filename `results.csv` / `results.xlsx`.
  - `DELETE /api/records/:id` -> 204 when the caller's link was removed, else 404 `{ status: 'NOT_FOUND', message: 'No such record.' }` (also for an id that is not a positive integer).

- [ ] **Step 1: Write the failing tests:**

```js
test('GET /api/records lists only the caller\'s records, newest requested first, with total/limit/offset', ...);
test('limit above 200 is clamped to 200 and limit=abc falls back to 50', ...);
test('q filters by vehicle number', ...);
test('another user gets an empty list and an empty export even though the record exists', ...);
test('export csv has the existing header row and one line per record; xlsx loads with ExcelJS and has the same rows', ...);
test('export with an unknown format is 400', ...);
test('DELETE removes the caller\'s entry (204); it is gone from their list but still in the other user\'s list', ...);
test('DELETE of an id the caller never asked for is 404 and changes nothing', ...);
test('DELETE with id "abc" is 404', ...);
test('every records route is 401 without a cookie', ...);
test('no records response or export contains the source words (LEAK regexp from Task 7)', ...);
```

- [ ] **Step 2: Run `node --test test/records-api.test.js`.** Expected: FAIL (404 on the routes).

- [ ] **Step 3: Implement `records-routes.js` and mount it.**

- [ ] **Step 4: Run `npm test`.** Expected: all passing.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: add the my-records API with csv/xlsx export"`

---

### Task 9: Fair scheduling and one batch per client

**Files:**
- Modify: `src/limiter.js`, `src/automation.js` (the `limit(...)` call in `searchTransaction`), `src/app.js` (batch guard)
- Create: `test/fair-limiter.test.js`

**Interfaces:**
- Produces: `createLimiter(max) -> (task, key?) -> Promise`. With no `key`, behaviour is unchanged (one FIFO queue). With keys, waiting tasks sit in one FIFO queue per key and the next task to start is taken round-robin across keys that have waiting tasks.
- Produces: `searchTransaction(applicationNo, { cancelled?, owner? })`. `owner` (string or number) is the limiter key. The lookup service already passes `owner` through (Task 6).
- Produces: in `createApp`, `search-stream` and `bulk` refuse a second concurrent batch from the same user with 429 `{ status: 'BUSY', message: 'A request is already running. Wait for it to finish or stop it.' }`. The slot is released when the batch finishes or the connection closes.

- [ ] **Step 1: Write the failing tests:**

```js
test('without keys the limiter is still FIFO (existing limiter tests keep passing)', ...);
test('round-robin across keys', async () => {
  // createLimiter(1); A1 holds the slot; queue A2..A5 under 'A' and B1 under 'B'; release.
  // start order === ['A1', 'B1', 'A2', 'A3', 'A4', 'A5']
});
test('a key with nothing waiting does not block others', ...);
test('a second search-stream from the same user is 429 BUSY while the first runs, and 200 once it ends', async () => {
  // stub search blocks on a promise the test releases
});
test('a different user can stream at the same time', ...);
test('bulk counts as a batch for the same guard', ...);
test('closing the connection frees the user\'s batch slot', ...);
test('the BUSY message passes the source-word check', ...);
```

- [ ] **Step 2: Run `node --test test/fair-limiter.test.js test/limiter.test.js`.** Expected: new tests FAIL, old limiter tests PASS.

- [ ] **Step 3: Implement** the keyed round-robin in `createLimiter`, the `owner` option, and the per-user batch guard.

- [ ] **Step 4: Run `npm test`.** Expected: all passing.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat: fair scheduling across clients and one batch per client"`

---

### Task 10: UI: login, neutral wording, brand, My records page

**Files:**
- Create: `public/login.html`, `public/login.js`, `public/records.html`, `public/records.js`, `test/ui-flow.test.js`, `test/no-source-in-ui.test.js`
- Modify: `public/index.html`, `public/app.js`, `public/style.css` (only what the new pages need), `src/app.js` (public `GET /brand.json`)

**Interfaces:**
- Produces: `GET /brand.json` (public, no login) -> `{ name: config.brandName }`.
- Behaviour:
  - Every page sets `document.title` and its heading from `/brand.json`; the static HTML ships with a neutral placeholder (`Records`), never the old product name.
  - Wording: the status labels become `FOUND` -> "Available", `NOT_FOUND` -> "No record", `INVALID_INPUT` -> "Invalid", `UNAVAILABLE` -> "Try again later". The `CAPTCHA`, `Timed out` and `Site error` labels and the hint text about reading the captcha are removed (hint: "Up to 1000 numbers per request."). Page text never says search "site", "portal" or "captcha".
  - A FOUND slip shows "Data as of <date>" from `asOf`. There is no "Saved" chip.
  - `app.js` `api()` drops the access-key prompt; any 401 goes to `/login.html`; on load `GET /api/auth/me` runs first and redirects when it is 401. Downloads are named `records-<scope>-<stamp>.<ext>`.
  - `login.html` posts the form and shows the server's message on 401/429; success goes to `/`.
  - `records.html` shows a table (application no, vehicle no, amount, payment status, data as of), a search box (debounced 300 ms), previous/next paging at 50, Excel and CSV links, and a per-row Remove with a confirm. Header on every page: signed-in name, "My records" / "Search" links, Logout. Use `textContent`, never `innerHTML`, for any server-provided value.
  - Static files stay public and contain no data.

- [ ] **Step 1: Write the failing tests.**

```js
// no-source-in-ui.test.js
test('no file under public/ names the source', async () => {
  // read every file in public/ recursively; assert !/parivahan|vahan|portal|captcha|gov\.in|playwright|chromium|ddddocr/i.test(text)
  // for index.html, login.html, records.html, app.js, login.js, records.js, style.css
});
test('GET /brand.json is public and returns the configured name', ...);

// ui-flow.test.js: startTestApp with config.brandName 'Acme Data'; stub search: FOUND00001 -> found,
// MISS00001 -> NOT_FOUND, FAIL00001 -> { status:'WEBSITE_ERROR', message:'page.goto ... https://vahan.parivahan.gov.in/...' }
test('login, look up numbers, see records, remove, logout', async () => {
  // 1. goto('/') signed out -> url ends with /login.html; document.title contains 'Acme Data'
  // 2. wrong password -> an error is visible, url stays on /login.html
  // 3. correct password -> url is '/'
  // 4. enter "FOUND00001\nMISS00001\nFAIL00001" and search ->
  //    slips read "Available" (with "Data as of"), "No record", "Try again later"
  // 5. the whole page text and every network response body match none of the source words
  // 6. click "My records" -> exactly one row, FOUND00001
  // 7. search box "zzz" -> zero rows; clear -> one row
  // 8. Remove + confirm -> zero rows
  // 9. Logout -> url ends with /login.html and GET /api/records answers 401
});
```

- [ ] **Step 2: Run `node --test test/ui-flow.test.js test/no-source-in-ui.test.js`.** Expected: FAIL (old names still in `public/`, no login redirect).

- [ ] **Step 3: Rebuild the pages, update `app.js`, add `/brand.json`.**

- [ ] **Step 4: Run `npm test`.** Expected: all passing.

- [ ] **Step 5: Manual check in a real browser.** Run the app against a real Postgres, create a user with the CLI, look up one real number twice, and confirm the second answer is instant and shows "Data as of". Check the My records page at phone width. Open the browser's network tab and confirm no request or response names the source.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: login, neutral wording, brand name and my-records page"`

---

### Task 11: Production hardening

**Files:**
- Create: `src/security-headers.js`, `test/hardening.test.js`
- Modify: `src/app.js` (headers, `/ready`, `x-powered-by`), `src/server.js` (signals, shutdown order)

**Interfaces:**
- Produces: `securityHeaders({ hsts: boolean }) -> middleware` setting `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'`, and `Strict-Transport-Security: max-age=15552000` when `hsts` is true (pass `config.cookieSecure`). `app.disable('x-powered-by')`.
- Produces: `GET /ready` (public) -> 200 `{ status: 'ready' }` when `SELECT 1` succeeds, otherwise 503 `{ status: 'NOT_READY' }`. `/health` stays a plain liveness check.
- Behaviour: `server.js` handles both `SIGINT` and `SIGTERM` (Docker and PaaS send SIGTERM). Shutdown order: stop accepting connections, close captcha sessions, `closeBrowser()`, `pool.end()`, exit. A second signal exits at once. A shutdown that takes longer than 15 s exits anyway.

- [ ] **Step 1: Write the failing tests:**

```js
test('every response, including /health and a 401, carries the security headers and no X-Powered-By', ...);
test('HSTS is sent only when config.cookieSecure is true', ...);
test('/ready is 200 with a working pool and 503 when the pool\'s query throws', ...);
test('the UI flow test logs no Content Security Policy console message', ...);
```

- [ ] **Step 2: Run `node --test test/hardening.test.js`.** Expected: FAIL.

- [ ] **Step 3: Implement** the middleware, `/ready` and the shutdown handler. Add the CSP-console assertion to `test/ui-flow.test.js`.

- [ ] **Step 4: Run `npm test`.** Expected: all passing.

- [ ] **Step 5: Manual check.** Start the app, send SIGTERM (for example `docker stop` in Task 12), confirm it exits within the shutdown window with code 0.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: security headers, readiness check and SIGTERM shutdown"`

---

### Task 12: Deployment files and README

**Files:**
- Create: `docker-compose.yml`, `.env.example`
- Modify: `Dockerfile` (copy `migrations`, add `HEALTHCHECK` on `/ready`), `service/config.js` (pass `DATABASE_URL` and the other settings into the service env from the installer's environment, never hard-coded)
- Replace: `README.md` (it contains UTF-16 junk at the end, so `Edit`/`Write` refuse it: run `git rm README.md`, then create the new file)

**Interfaces:**
- `docker-compose.yml`: services `db` (`postgres:16`, named volume, `pg_isready` healthcheck, password from `.env`) and `app` (built from the Dockerfile, `depends_on: db` healthy, env `DATABASE_URL`, `PORT=10000`, `TRUST_PROXY`, `SEARCH_CONCURRENCY`, `BRAND_NAME`, ports `10000:10000`).
- `.env.example` lists every variable with a one-line comment: `DATABASE_URL`, `DATABASE_SSL`, `PORT`, `HOST`, `TRUST_PROXY`, `SESSION_TTL_HOURS`, `SEARCH_CONCURRENCY`, `BRAND_NAME`, `FINAL_BANK_STATUSES`, `ENABLE_MANUAL_CAPTCHA`, `POSTGRES_PASSWORD`, `PYTHON`, `CAPTCHA_IMAGE_DIR`, `LOG_LEVEL`.
- The README is for **you, the operator**. It must cover: what the service does, the three deployment modes, all environment variables, first-run steps (`docker compose up -d`, then `docker compose exec app node src/user-cli.js create <client>`), the user CLI commands, backup and restore with `pg_dump`/`psql`, "migrations run automatically at start", that only FOUND results are stored and are shared across clients, that the server must run as a single process, and the API list (auth, search, records). It must also say, near the top: **never give clients the repository, the Docker image, the `userscript/` folder or the `images/` folder; they name the source. Keep `ENABLE_MANUAL_CAPTCHA` off on any instance clients can reach.** And: **before go-live, list the distinct `bank_status` values in `records` and set `FINAL_BANK_STATUSES`** (the default `SUCCESS` is a guess). Remove the `render.yaml` paragraph (that file does not exist in the repo); ask the owner whether a Render blueprint is wanted.

- [ ] **Step 1: Write the files** as above.

- [ ] **Step 2: Validate.** Run `docker compose config` (expected: prints the merged config, exit 0).

- [ ] **Step 3: End-to-end smoke test** (needs Docker): `docker compose up -d --build`, wait until `GET http://127.0.0.1:10000/ready` is 200, create a client with the CLI, log in through the UI, look up a real found number, look it up again and confirm the second answer is instant, run `docker compose restart app` and confirm it is still listed under My records, then `docker compose down`.

- [ ] **Step 4: Run `npm test`, and once with `TEST_DATABASE_URL` pointing at a throwaway real Postgres.** Expected: all passing in both runs.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "docs: Docker Compose, env example and an operator README"`

---

## Self-review

- **Spec coverage:** login, sessions, CLI onboarding (3-4); Postgres, migrations, brand config (2); shared found-only store with per-client links, enforced once at the store boundary (5); stored-first lookup with final-status rule, stale fallback and failure tolerance (6); client-safe vocabulary, no raw messages, neutral exports, manual captcha gated (7); view, search, export, remove (8); fairness and one batch per client (9); neutral UI, brand, "as of" date, static-file leak sweep (10); headers, readiness, SIGTERM (11); deploy, README with the "don't hand out the repo/userscript/images" warning (12).
- **Type consistency:** `StoredRecord` field names are the same in Tasks 5, 6, 7 and 8. `LookupResult.source` is internal and dropped by `toClientResult`. `owner` is set in Task 6, consumed in Task 9. `createApp`'s deps grow in Tasks 4, 7 and 9 and `startTestApp` is extended in the same tasks. The `LEAK` regexp is defined in Task 7 and reused in Tasks 8, 9 and 10.
- **Proportion:** tests are spelled out where a value matters (statuses, messages, field lists, counts); module bodies are left to the builder.
- **Known risks:** `pg-mem` may not support some SQL (mitigation: `TEST_DATABASE_URL` switches to real Postgres, and Task 12 runs both ways). The default final status `SUCCESS` is a guess about the source's real values (mitigation: README step before go-live).
