const crypto = require('crypto');

const MAX_SESSIONS = 5;
const IDLE_MS = 5 * 60 * 1000;

class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Holds the browser pages that wait for a person to type a captcha. One page per run keeps the
// portal's cookies (and so the captcha it issued) together; idle pages are closed so a
// forgotten tab never keeps Chromium busy.
function createSessionStore({ maxSessions = MAX_SESSIONS, idleMs = IDLE_MS } = {}) {
  const sessions = new Map();
  let opening = 0;

  function disarm(session) {
    clearTimeout(session.timer);
  }

  function arm(id, session) {
    disarm(session);
    session.timer = setTimeout(() => { close(id); }, idleMs);
    session.timer.unref();
  }

  async function close(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    disarm(session);
    await session.page.close().catch(() => {});
  }

  // `open` resolves to { page, value }; the caller gets { id, value } back.
  async function create(open) {
    if (sessions.size + opening >= maxSessions) {
      throw new SessionError('TOO_MANY', 'Too many captcha sessions are open. Finish or stop one first.');
    }
    opening += 1;
    try {
      const { page, value } = await open();
      const id = crypto.randomBytes(16).toString('hex');
      const session = { page, busy: false, timer: null };
      sessions.set(id, session);
      arm(id, session);
      return { id, value };
    } finally {
      opening -= 1;
    }
  }

  // Runs fn(page) with the session to itself: a second call while one is running is refused.
  async function use(id, fn) {
    const session = sessions.get(id);
    if (!session) throw new SessionError('NOT_FOUND', 'This captcha session expired. Start the search again.');
    if (session.busy) throw new SessionError('BUSY', 'The previous request for this session is still running.');
    session.busy = true;
    disarm(session);
    try {
      return await fn(session.page);
    } finally {
      session.busy = false;
      if (sessions.get(id) === session) arm(id, session);
    }
  }

  async function closeAll() {
    await Promise.all([...sessions.keys()].map(close));
  }

  return { create, use, close, closeAll };
}

module.exports = { createSessionStore, SessionError, MAX_SESSIONS, IDLE_MS };
