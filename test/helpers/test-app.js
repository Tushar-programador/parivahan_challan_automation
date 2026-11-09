const { createApp } = require('../../src/app');

// Starts the app on a random local port. Used by the HTTP tests; later tasks extend it.
async function startTestApp(deps = {}) {
  const { app, closeCaptchaSessions } = createApp(deps);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      await closeCaptchaSessions();
    }
  };
}

module.exports = { startTestApp };
