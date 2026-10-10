// Stops and removes the Windows service. Run from an Administrator terminal:  npm run service:uninstall
const { createService } = require('./config');

const svc = createService();

svc.on('uninstall', () => console.log('Service removed.'));
svc.on('alreadyuninstalled', () => console.log('Service is not installed.'));
svc.on('error', (error) => console.error('Service error:', error));

svc.uninstall();
