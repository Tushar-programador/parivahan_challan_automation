const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { decodePngDataUrl } = require('./captcha-images');

const SCRIPT = path.join(__dirname, 'ocr.py');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const OCR_TIMEOUT_MS = 60000;
const NO_READ_EXIT = 3; // keep in step with NO_READ_EXIT in ocr.py

function run(python, script, imagePath) {
  return new Promise((resolve, reject) => {
    execFile(python, [script, imagePath], { timeout: OCR_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim());
      if (error.code === NO_READ_EXIT) return resolve(null);
      const detail = error.code === 'ENOENT'
        ? `${python} was not found. Install Python, or set PYTHON to its path.`
        : (stderr.trim().split('\n').pop() || error.message);
      return reject(new Error(`Reading the captcha failed: ${detail}`));
    });
  });
}

// Reads the code in a captcha image (a PNG data URL) with src/ocr.py. Resolves to the code, or null when
// the image gave no 6-character read. Rejects when OCR itself cannot run (no Python or ddddocr),
// which retrying with another image would not fix. `python` and `script` are overridable for tests.
async function readCaptchaText(dataUrl, { python = PYTHON, script = SCRIPT } = {}) {
  const png = decodePngDataUrl(dataUrl);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'captcha-'));
  try {
    const file = path.join(dir, 'captcha.png');
    await fs.writeFile(file, png);
    return await run(python, script, file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { readCaptchaText, PYTHON, SCRIPT };
