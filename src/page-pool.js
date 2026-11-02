const IDLE_MS = 60 * 1000;

// Keeps browser pages open between searches. A result page already carries a fresh form and captcha, so
// the next number can be searched from it without loading the form again (about a second of the portal's
// time per number). Pages nobody asks for within idleMs are closed, so a quiet server holds no Chromium
// pages and the portal never sees a session sit idle for long.
function createPagePool({ idleMs = IDLE_MS } = {}) {
  const idle = [];

  function drop(entry) {
    const index = idle.indexOf(entry);
    if (index >= 0) idle.splice(index, 1);
    clearTimeout(entry.timer);
    return entry.page.close().catch(() => {});
  }

  // A page left by an earlier search, with that search's result; null when none is waiting.
  function take() {
    const entry = idle.pop();
    if (!entry) return null;
    clearTimeout(entry.timer);
    return { page: entry.page, last: entry.last };
  }

  function keep(page, last) {
    const entry = { page, last };
    entry.timer = setTimeout(() => drop(entry), idleMs);
    entry.timer.unref();
    idle.push(entry);
  }

  async function closeAll() {
    await Promise.all([...idle].map(drop));
  }

  return { take, keep, closeAll };
}

module.exports = { createPagePool, IDLE_MS };
