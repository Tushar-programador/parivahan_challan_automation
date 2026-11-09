const { loadConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { createUserStore } = require('./users');
const { createSessionStore, createLoginThrottle } = require('./auth');
const { createApp } = require('./app');
const { closeBrowser } = require('./automation');

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function main() {
  const config = loadConfig(process.env);
  const pool = createPool(config);
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  const users = createUserStore(pool);
  const sessions = createSessionStore(pool, { ttlHours: config.sessionTtlHours });
  const throttle = createLoginThrottle();
  const { app, closeCaptchaSessions } = createApp({ users, sessions, throttle, config });

  // Expired login sessions are already refused; this only keeps the table small.
  const purge = () => sessions.purgeExpired().catch((error) => console.error(`[WARN] could not purge expired sessions: ${error.message}`));
  purge();
  setInterval(purge, PURGE_INTERVAL_MS).unref();

  const server = app.listen(config.port, config.host, () => {
    console.log(`Parivahan automation API running on http://${config.host}:${config.port}`);
  });

  process.on('SIGINT', () => {
    server.close();
    closeCaptchaSessions().then(closeBrowser).finally(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error(`Could not start: ${error.message}`);
  process.exit(1);
});
