// Installs the server as a Windows service that starts automatically at boot.
// Run from an Administrator terminal:  npm run service:install
const path = require('path');
const { execSync } = require('child_process');
const { createService, browsersPath } = require('./config');

// Playwright's browsers are not part of `npm install`; fetch them into the folder the service will
// use (a no-op if already present). Includes the headless shell that headless launches need.
console.log(`Making sure Chromium is installed in ${browsersPath} ...`);
execSync('npx playwright install chromium', {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath }
});

const svc = createService();

svc.on('install', () => {
  console.log('Service installed. Starting it...');
  svc.start();
});
svc.on('alreadyinstalled', () => console.log('Service is already installed. Run "npm run service:uninstall" first to reinstall.'));
svc.on('start', () => console.log('Service started. UI: http://127.0.0.1:3000'));
svc.on('error', (error) => console.error('Service error:', error));

svc.install();
