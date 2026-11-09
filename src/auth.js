const crypto = require('node:crypto');
const express = require('express');
const { normalizeUsername } = require('./users');

const SESSION_COOKIE = 'sid';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PASSWORD_LENGTH = 1000; // hashing a longer password would only be a way to burn CPU
const MAX_USERNAME_LENGTH = 100; // usernames are at most 40 characters; this also bounds the throttle key
const MAX_THROTTLE_KEYS = 10000;
const LOGIN_BODY_LIMIT = '10kb';

const UNAUTHORIZED = { status: 'UNAUTHORIZED', message: 'Sign in to continue.' };
const BAD_LOGIN = { status: 'UNAUTHORIZED', message: 'Invalid username or password.' };
const TOO_MANY = { status: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' };
const FORBIDDEN = { status: 'FORBIDDEN', message: 'This request was not allowed.' };
const INVALID_REQUEST = { status: 'INVALID_INPUT', message: 'Invalid request.' };

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Only a well-formed token is ever hashed or looked up. cookie-parser turns a cookie like `sid=j:{"a":1}` into an
// object, so anything that is not a 64-character lowercase hex string is simply "not a session".
function isToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

// Login sessions. The browser holds a random token; the database holds only its SHA-256, so a copy of the
// sessions table cannot be used to sign in. `ttlMs` is the lifetime, also used for the cookie's Max-Age.
function createSessionStore(pool, { ttlHours = 12 } = {}) {
  if (typeof ttlHours !== 'number' || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new TypeError('ttlHours must be a positive number');
  }
  const ttlMs = ttlHours * 60 * 60 * 1000;

  return {
    ttlMs,

    // Resolves to { token, expiresAt }, or null when there is no active user with that id. The row is inserted only
    // while the user is still active, so a login that already checked the password cannot open a session after the
    // user was disabled or their password changed (both of which delete the user's sessions).
    async create(userId) {
      if (!Number.isSafeInteger(userId) || userId < 1) return null;
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + ttlMs);
      const result = await pool.query(
        'insert into sessions (token_hash, user_id, expires_at) select $1::text, id, $3::timestamptz from users where id = $2 and is_active = true',
        [hashToken(token), userId, expiresAt]
      );
      return result.rowCount === 1 ? { token, expiresAt } : null;
    },

    // Resolves to { id, username }, or null when the token is unknown, expired, or its user is inactive.
    async resolve(token) {
      if (!isToken(token)) return null;
      const { rows } = await pool.query(
        'select u.id, u.username from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > $2 and u.is_active = true',
        [hashToken(token), new Date()]
      );
      return rows[0] ? { id: rows[0].id, username: rows[0].username } : null;
    },

    async destroy(token) {
      if (!isToken(token)) return;
      await pool.query('delete from sessions where token_hash = $1', [hashToken(token)]);
    },

    // Deletes every expired row and resolves to how many there were.
    async purgeExpired() {
      const result = await pool.query('delete from sessions where expires_at <= $1', [new Date()]);
      return result.rowCount;
    }
  };
}

// Counts failed logins per key (in practice "<client address>|<username>") in memory. After `maxFailures` failures
// the key is blocked until `windowMs` after its first failure. The table is capped so that an endless stream of
// different usernames cannot grow it without limit: expired keys go first, then the oldest.
function createLoginThrottle({ maxFailures = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map(); // key -> { count, windowEndsAt }

  function current(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.windowEndsAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function makeRoom() {
    if (entries.size <= MAX_THROTTLE_KEYS) return;
    const time = now();
    for (const [key, entry] of entries) {
      if (entry.windowEndsAt <= time) entries.delete(key);
    }
    for (const key of entries.keys()) {
      if (entries.size <= MAX_THROTTLE_KEYS) break;
      entries.delete(key); // a Map iterates in insertion order, so this is the oldest key
    }
  }

  return {
    blocked(key) {
      const entry = current(key);
      return entry !== undefined && entry.count >= maxFailures;
    },

    fail(key) {
      const entry = current(key);
      if (entry) {
        entry.count += 1;
      } else {
        entries.set(key, { count: 1, windowEndsAt: now() + windowMs });
        makeRoom();
      }
    },

    reset(key) {
      entries.delete(key);
    },

    // Whole seconds until the key is released; 0 when it is not being counted.
    retryAfterSeconds(key) {
      const entry = current(key);
      return entry ? Math.max(1, Math.ceil((entry.windowEndsAt - now()) / 1000)) : 0;
    },

    size() {
      return entries.size;
    }
  };
}

// Sets req.user = { id, username } for a valid `sid` cookie, otherwise answers 401. A database error is passed on
// as an error (a 500), so a failing database never lets a request through.
function requireAuth(sessions) {
  return async (req, res, next) => {
    try {
      const user = await sessions.resolve(req.cookies ? req.cookies[SESSION_COOKIE] : undefined);
      if (!user) return res.status(401).json(UNAUTHORIZED);
      req.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

// Cross-site request forgery guard for the cookie. SameSite=Lax already keeps the cookie off cross-site POSTs; this
// also refuses any state-changing request whose Origin header names a different host than the one being called.
// A request with no Origin header (curl, scripts) is let through: it did not come from a browser page.
function sameOrigin() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (origin === undefined) return next();
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase(); // 'null' (an opaque origin) does not parse, and is refused
    } catch {
      originHost = '';
    }
    const host = String(req.get('host') || '').toLowerCase();
    if (originHost && originHost === host) return next();
    return res.status(403).json(FORBIDDEN);
  };
}

function throttleKey(ip, username) {
  return `${ip}|${normalizeUsername(username).slice(0, MAX_USERNAME_LENGTH)}`;
}

function plausibleCredentials(username, password) {
  return typeof username === 'string' && username.length <= MAX_USERNAME_LENGTH
    && typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH;
}

function authRouter({ users, sessions, throttle, cookieSecure }) {
  const router = express.Router();
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: Boolean(cookieSecure), path: '/' };

  // Small body limit: this router is reachable by anyone, before any sign-in.
  router.use(express.json({ limit: LOGIN_BODY_LIMIT }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body && typeof req.body === 'object' ? req.body : {};
      const key = throttleKey(req.ip, username);

      if (throttle.blocked(key)) {
        res.set('Retry-After', String(throttle.retryAfterSeconds(key)));
        return res.status(429).json(TOO_MANY);
      }
      // Every attempt is counted before it is checked and forgiven on success, so a burst of parallel guesses cannot
      // all slip past the limit while the first ones are still being verified.
      throttle.fail(key);

      // Input that could never be a valid login is an ordinary failure, decided before any hashing or database work.
      if (!plausibleCredentials(username, password)) return res.status(401).json(BAD_LOGIN);

      const user = await users.authenticate(username, password);
      const session = user ? await sessions.create(user.id) : null;
      if (!session) return res.status(401).json(BAD_LOGIN);

      throttle.reset(key);
      res.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, maxAge: sessions.ttlMs });
      return res.json({ user: { id: user.id, username: user.username } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await sessions.destroy(req.cookies ? req.cookies[SESSION_COOKIE] : undefined);
      res.clearCookie(SESSION_COOKIE, cookieOptions);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', requireAuth(sessions), (req, res) => {
    res.json({ user: { id: req.user.id, username: req.user.username } });
  });

  // A body the JSON parser refused (broken, too large, wrong encoding) is the caller's mistake. It is answered here,
  // and never reaches the app's logging error handler, because the parser's error carries the raw request body,
  // which for a login is a password.
  router.use((error, _req, res, next) => {
    if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json(INVALID_REQUEST);
    }
    return next(error);
  });

  return router;
}

module.exports = { createSessionStore, createLoginThrottle, authRouter, requireAuth, sameOrigin };
