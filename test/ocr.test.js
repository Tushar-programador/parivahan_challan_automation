const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readCaptchaText } = require('../src/ocr');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Node stands in for Python: each fake script is run as `node script <image>` and behaves like src/ocr.py.
async function fakeScript(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-test-'));
  const script = path.join(dir, 'fake-ocr.js');
  await fs.writeFile(script, body);
  return { script, python: process.execPath, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('resolves to the code the script prints, given the image as a file it can read', async () => {
  const fake = await fakeScript(`
    const fs = require('fs');
    const png = fs.readFileSync(process.argv[2]);
    process.stdout.write(png.subarray(1, 4).toString() === 'PNG' ? 'EE5GHK\\n' : 'BADIMG\\n');
  `);
  try {
    assert.equal(await readCaptchaText(PNG, fake), 'EE5GHK');
  } finally {
    await fake.cleanup();
  }
});

test('resolves to null when the script found no 6 character read', async () => {
  const fake = await fakeScript('process.exit(3);');
  try {
    assert.equal(await readCaptchaText(PNG, fake), null);
  } finally {
    await fake.cleanup();
  }
});

test('rejects with the last line of the error when OCR cannot run', async () => {
  const fake = await fakeScript("console.error('Traceback...'); console.error('ModuleNotFoundError: No module named pytesseract'); process.exit(1);");
  try {
    await assert.rejects(readCaptchaText(PNG, fake), /Reading the captcha failed: ModuleNotFoundError: No module named pytesseract/);
  } finally {
    await fake.cleanup();
  }
});

test('rejects with a hint when Python is not installed', async () => {
  await assert.rejects(readCaptchaText(PNG, { python: 'no-such-python-binary-xyz' }), /was not found.*PYTHON/);
});

test('rejects something that is not a PNG data URL before running anything', async () => {
  await assert.rejects(readCaptchaText('hello'), /PNG data URL/);
});
