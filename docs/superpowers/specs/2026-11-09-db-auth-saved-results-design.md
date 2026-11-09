# Client data service: accounts, our own database, hidden source — design

Date: 2026-11-09 · Status: draft for review (revision 2). Items under "My calls" are my decisions unless marked as yours.

## Intent

The Parivahan lookup works for one trusted person on one machine. You want to sell it to clients. Clients must experience it as **a service that has the data**, not as a front end for another website. That means:

1. Clients log in (today there is one shared `ACCESS_KEY`, or nothing).
2. Found transactions are stored in our own PostgreSQL database. Nothing else is stored: not "not found", not errors.
3. When a client asks for a number we already hold, we answer from our database. We go to the source only when we don't have it, or what we have might be out of date.
4. Nothing a client can see (pages, messages, errors, statuses, file names, API fields) names or hints at the source or the way we get the data.
5. A client can come back later and see, search, export and remove the records they asked for.

## Goals

- Username/password login, server-side sessions. Clients are created by you through a CLI.
- One shared store of found records that belongs to us, plus a per-client list of the records each client has asked for.
- Strict isolation between clients: a client only ever sees records they asked for.
- A client-facing result vocabulary that reveals nothing: `FOUND`, `NOT_FOUND`, `INVALID_INPUT`, `UNAVAILABLE`. Every found result carries an "as of" date so a client is never misled about how fresh it is.
- A product name set by `BRAND_NAME`, so each client can get their own branding.
- Production basics: security headers, login throttling, graceful shutdown, readiness check, Docker Compose with Postgres, accurate README.
- One client's large batch cannot lock the others out of the live-search queue.

## Non-goals (v1)

- No admin web UI, self-signup, password reset by email, 2FA, API keys, billing or usage metering.
- No bulk loading or scheduled refreshing of the database. It fills as clients ask.
- `npm run search` and `npm run bulk` (CLIs) keep working as today and store nothing.
- One server process only. The browser pool, OCR worker and login throttle live in memory.
- The userscript is untouched, and must never be given to clients (it runs on the source site).

## What "hidden" does and does not mean

It means a client using the UI, the API, an export file or a browser's network tab learns nothing about the source. It does **not** make the system secret from anyone who has our source code, our server logs or our Docker image, and the data fields themselves (GRN, CIN, payment gateway) still look like what they are. Those stay hidden by not sharing the repo, the image or the userscript.

## Anti-goals

Any of these is a failure even if the feature "works":

- Any client-visible text, field, error, status, header or file name that names the source (`parivahan`, `vahan`, `portal`, `captcha`, `gov.in`, `playwright`, a URL, a stack trace).
- Storing a result that is not FOUND.
- Client A seeing or removing client B's records.
- Serving stale data as if it were fresh.
- A database problem that turns a good lookup into an error.
- Breaking the 67 existing tests.

## Constraints

- Node 22, Express 5, CommonJS, vanilla JS UI. Follow existing style (`{ status, message }` bodies, `node:test`).
- No native-compiled dependencies (this also runs as a Windows service).
- Runs three ways: Docker Compose, PaaS, Windows service. The database comes only from `DATABASE_URL`.

## My calls

| # | Call | Why |
|---|------|-----|
| 1 | PostgreSQL via `pg`, no ORM | Standard for a product sold to clients; one URL works in all three deployment modes. |
| 2 | One deployment, many client accounts | Chromium plus OCR is heavy; one shared instance is cheaper than one per client. A per-client deployment still works (one user). |
| 3 | You onboard clients with a CLI, no admin UI, no roles | You do onboarding yourself. |
| 4 | Opaque session token in an HttpOnly cookie, hash in the DB, not JWT | Logout, disable and password change must kill sessions immediately. |
| 5 | Passwords use Node's built-in `crypto.scrypt` | No native `bcrypt` build problems on Windows. |
| 6 | **(Yours)** Serve stored data first. Stored data is shared across clients. | You chose this: "we have the data". |
| 7 | A stored record is served as-is only when its bank status is *final*: `FINAL_BANK_STATUSES`, default `SUCCESS`. Anything else is fetched again. **This default is a guess**: I could not see the source's real status values. Before go-live, look at the distinct `bank_status` values in `records` and set the list. | A pending or failed payment can later succeed, so serving it blindly would mislead clients. |
| 8 | If a refetch fails (timeout, site error) or says "no record" for a number we already hold, serve what we hold, with its "as of" date. | A client getting last-known data is better than an error, and "no record" after an earlier hit is almost certainly a glitch. |
| 9 | "Remove" on a client's list only removes it from that client's list. The shared record stays. | The record is our data, not theirs. |
| 10 | Failures a client cannot act on (timeout, site error, unreadable captcha, anything unexpected) all become `UNAVAILABLE` with one fixed message. The raw detail goes to our server log only. | Raw messages can contain the source's URL or browser error text. |
| 11 | The manual captcha routes are off unless `ENABLE_MANUAL_CAPTCHA=true`. | They hand the source's captcha image to the caller. |
| 12 | The bulk endpoint goes through the same lookup path as everything else. | It currently launches its own browser per request and ignores the concurrency limit. |
| 13 | Fairness = round-robin across clients for live searches, plus one running batch per client. | Today the queue is first-come-first-served, so one 1000-number batch makes every other client wait. |

## Left to the builder

Visual layout of the new pages (reuse `public/style.css`), exact SQL types, wording of messages not given in the plan, and the internal structure of each module behind the interfaces in the plan.
