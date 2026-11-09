const { createApp } = require('./app');
const { closeBrowser } = require('./automation');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const { app, closeCaptchaSessions } = createApp();

const server = app.listen(PORT, HOST, () => {
  console.log(`Parivahan automation API running on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  server.close();
  closeCaptchaSessions().then(closeBrowser).finally(() => process.exit(0));
});
