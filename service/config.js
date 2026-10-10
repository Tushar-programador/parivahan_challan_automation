const path = require('path');
const os = require('os');
const { Service } = require('node-windows');

const root = path.join(__dirname, '..');

// The service runs as SYSTEM, which has its own profile, so point Playwright at the browsers
// that `npx playwright install chromium` put in this user's profile.
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');

function createService() {
  return new Service({
    name: 'ParivahanLookup',
    description: 'Parivahan transaction lookup UI + API (http://127.0.0.1:3000)',
    script: path.join(root, 'src', 'server.js'),
    workingdirectory: root,
    env: [
      { name: 'NODE_ENV', value: 'production' },
      { name: 'PLAYWRIGHT_BROWSERS_PATH', value: browsersPath }
    ],
    wait: 2,
    grow: 0.5,
    maxRestarts: 10
  });
}

module.exports = { createService, browsersPath };
