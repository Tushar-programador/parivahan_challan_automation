const crypto = require('node:crypto');
const net = require('node:net');
const express = require('express');
const { normalizeUsername } = require('./users');

const SESSION_COOKIE = 'sid';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PASSWORD_LENGTH = 1000; // hashing a longer password would only be a way to burn CPU
const MAX_USERNAME_LENGTH = 100; // usernames are at most 40 characters; this also bounds the throttle key
const LOGIN_BODY_LIMIT = '10kb';

// Throttle defaults: failures per window for one address+username, for one address (any usernames) and for one
// username (any addresses), and the most keys the table may hold.
const MAX_FAILURES = 5;
const MAX_FAILURES_PER_IP = 50;
const MAX_FAILURES_PER_USERNAME = 25;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const MAX_THROTTLE_KEYS = 10000;
const IP_KEY_PREFIX = 'ip:'; // the throttle picks a key's limit from its prefix
const USER_KEY_PREFIX = 'user:';

const UNAUTHORIZED = { status: 'UNAUTHORIZED', message: 'Sign in to continue.' };
const BAD_LOGIN = { status: 'UNAUTHORIZED', message: 'Invalid username or password.' };
const TOO_MANY = { status: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' };
const FORBIDDEN = { status: 'FORBIDDEN', message: 'This request was not allowed.' };
const BAD_REQUEST = { status: 'BAD_REQUEST', message: 'Invalid request.' };

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

    // Opens a session for a user who has just proved their password. `passwordHash` is the stored hash that
    // users.authenticate returned for that proof. Resolves to { token, expiresAt }, or null when the user is no longer
    // active or the password has been changed since (their stored hash is no longer that value).
    // The check and the insert are one statement, and the user row is share-locked while it runs, so it waits for a
    // concurrent setPassword / setActive to commit and then sees the new state. Together with the sessions those two
    // delete, no session can outlive the credential it was opened with.
    async create(userId, passwordHash) {
      if (!Number.isSafeInteger(userId) || userId < 1) return null;
      if (typeof passwordHash !== 'string' || passwordHash === '') return null;
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + ttlMs);
      const result = await pool.query(
        'insert into sessions (token_hash, user_id, expires_at) select $1::text, id, $3::timestamptz from users where id = $2 and is_active = true and password_hash = $4 for share',
        [hashToken(token), userId, expiresAt, passwordHash]
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

// Counts failures per key, in memory. A key is blocked once it has `limit` failures inside the window, which starts
// at its first failure. The limit depends on the key: keys starting `ip:` (one client address, any usernames) use
// `maxFailuresPerIp`, keys starting `user:` (one username, any addresses) use `maxFailuresPerUsername`, every other
// key (in practice "<address>|<username>") uses `maxFailures`.
// The table holds at most `maxKeys` keys. When it is full, expired keys go first, then keys that are only counting
// (oldest first), and a blocked key only when nothing else is left, so a flood of throwaway keys cannot push a
// blocked key out and so free it. The key just recorded is never the one evicted.
function createLoginThrottle({
  maxFailures = MAX_FAILURES,
  windowMs = THROTTLE_WINDOW_MS,
  now = Date.now,
  maxKeys = MAX_THROTTLE_KEYS,
  maxFailuresPerIp = MAX_FAILURES_PER_IP,
  maxFailuresPerUsername = MAX_FAILURES_PER_USERNAME
} = {}) {
  const entries = new Map(); // key -> { count, windowEndsAt }; a Map iterates in insertion order, so oldest first

  function limitFor(key) {
    if (key.startsWith(IP_KEY_PREFIX)) return maxFailuresPerIp;
    if (key.startsWith(USER_KEY_PREFIX)) return maxFailuresPerUsername;
    return maxFailures;
  }

  function current(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.windowEndsAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function makeRoom(newKey) {
    if (entries.size <= maxKeys) return;
    const time = now();
    for (const [key, entry] of entries) {
      if (entry.windowEndsAt <= time) entries.delete(key);
    }
    for (const evictBlocked of [false, true]) {
      for (const [key, entry] of entries) {
        if (entries.size <= maxKeys) return;
        if (key !== newKey && (entry.count >= limitFor(key)) === evictBlocked) entries.delete(key);
      }
    }
  }

  return {
    blocked(key) {
      const entry = current(key);
      return entry !== undefined && entry.count >= limitFor(key);
    },

    fail(key) {
      const entry = current(key);
      if (entry) {
        entry.count += 1;
      } else {
        entries.set(key, { count: 1, windowEndsAt: now() + windowMs });
        makeRoom(key);
      }
    },

    // Takes back one failure (for an attempt that was charged up front and then turned out to be a success).
    forgive(key) {
      const entry = current(key);
      if (!entry) return;
      if (entry.count <= 1) entries.delete(key);
      else entry.count -= 1;
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

// The eight 16-bit groups of a valid IPv6 address, as numbers.
function ipv6Groups(address) {
  let text = address.split('%')[0].toLowerCase(); // a zone id ("%eth0") is not part of the address
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  const gap = text.includes('::') ? 8 - first.length - last.length : 0;
  return [...first, ...new Array(gap).fill('0'), ...last].map((group) => parseInt(group, 16));
}

// The part of a client address that identifies one client for throttling. An IPv4 address stands for itself. An
// IPv4-mapped IPv6 address (::ffff:a.b.c.d) is the same client as that IPv4 address. Any other IPv6 address is keyed by
// its /64, because one subscriber usually controls a whole /64 and could otherwise rotate through billions of
// addresses. Anything that is not an IP address at all shares the one key "unknown", so inventing values (for example
// in a forwarded header that is trusted too widely) never yields a fresh set of attempts.
function clientAddressKey(ip) {
  if (typeof ip !== 'string') return 'unknown';
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return 'unknown';
  const groups = ipv6Groups(ip);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
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

// A request body the JSON parser refused (broken, too large, wrong encoding) is the caller's mistake: 4xx, with the
// parser's status, and nothing logged. It must not reach a handler that logs errors, because the parser's error
// carries the whole raw request body (for a login, a password).
function bodyParserErrorHandler(error, _req, res, next) {
  const clientError = Boolean(error) && typeof error.type === 'string' && Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
  if (!clientError || res.headersSent) return next(error);
  return res.status(error.status).json(BAD_REQUEST);
}

// The three throttle keys one login attempt is counted under.
function loginKeys(ip, username) {
  const address = clientAddressKey(ip);
  const name = normalizeUsername(username).slice(0, MAX_USERNAME_LENGTH);
  return { pair: `${address}|${name}`, address: `${IP_KEY_PREFIX}${address}`, username: `${USER_KEY_PREFIX}${name}` };
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
      const keys = loginKeys(req.ip, username);

      // Blocked when this address+username, this address (whatever usernames it tries) or this username (from
      // whatever address) has used up its failures. A blocked attempt is refused even with the right password.
      const blocked = [keys.pair, keys.address, keys.username].filter((key) => throttle.blocked(key));
      if (blocked.length > 0) {
        res.set('Retry-After', String(Math.max(...blocked.map((key) => throttle.retryAfterSeconds(key)))));
        return res.status(429).json(TOO_MANY);
      }
      // Every attempt is counted before it is checked and forgiven on success, so a burst of parallel guesses cannot
      // all slip past the limits while the first ones are still being verified.
      throttle.fail(keys.pair);
      throttle.fail(keys.address);
      throttle.fail(keys.username);

      // Input that could never be a valid login is an ordinary failure, decided before any hashing or database work.
      if (!plausibleCredentials(username, password)) return res.status(401).json(BAD_LOGIN);

      const user = await users.authenticate(username, password);
      // The session is bound to the hash the password was just checked against; if the password was changed or the
      // user disabled meanwhile, create answers null.
      const session = user ? await sessions.create(user.id, user.passwordHash) : null;
      if (!session) return res.status(401).json(BAD_LOGIN);

      // A success clears the failures of this address+username and of this username, but not the address's own
      // count, so one valid account cannot be used to keep wiping an address's record of guesses. It only takes back
      // the success's own up-front charge there, so the address counter counts failures only.
      throttle.reset(keys.pair);
      throttle.reset(keys.username);
      throttle.forgive(keys.address);
      res.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, maxAge: sessions.ttlMs });
      // The body is built field by field: `user` carries the password hash, which must never leave the server.
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

  router.use(bodyParserErrorHandler);

  return router;
}

module.exports = {
  createSessionStore,
  createLoginThrottle,
  clientAddressKey,
  authRouter,
  requireAuth,
  sameOrigin,
  bodyParserErrorHandler
};
