const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

// Writes a captcha image (the PNG data URL the UI receives) into `dir` and returns the file path.
async function saveCaptchaImage(dataUrl, dir) {
  const match = PNG_DATA_URL.exec(dataUrl || '');
  if (!match) throw new Error('Expected a PNG data URL.');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);
  const file = path.join(dir, `captcha-${stamp}-${crypto.randomBytes(3).toString('hex')}.png`);
  await fs.writeFile(file, Buffer.from(match[1], 'base64'));
  return file;
}

module.exports = { saveCaptchaImage };
