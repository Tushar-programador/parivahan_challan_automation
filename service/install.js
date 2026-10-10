// Installs the server as a Windows service that starts automatically at boot.
// Run from an Administrator terminal:  npm run service:install
const fs = require('fs');
const { createService, browsersPath } = require('./config');

if (!fs.existsSync(browsersPath)) {
  console.warn(`Warning: ${browsersPath} not found. Run "npx playwright install chromium" first.`);
}

const svc = createService();

svc.on('install', () => {
  console.log('Service installed. Starting it...');
  svc.start();
});
svc.on('alreadyinstalled', () => console.log('Service is already installed. Run "npm run service:uninstall" first to reinstall.'));
svc.on('start', () => console.log('Service started. UI: http://127.0.0.1:3000'));
svc.on('error', (error) => console.error('Service error:', error));

svc.install();
