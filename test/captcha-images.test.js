const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveCaptchaImage } = require('../src/captcha-images');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'captcha-images-'));

test('writes the image bytes to a png file inside the folder', async () => {
  const dir = await tempDir();
  const file = await saveCaptchaImage(dataUrl, dir);
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^captcha-\d{8}-\d+-[a-f0-9]{6}\.png$/);
  assert.deepEqual(await fs.readFile(file), Buffer.from(PNG_BASE64, 'base64'));
  await fs.rm(dir, { recursive: true });
});

test('creates the folder when it does not exist yet', async () => {
  const dir = path.join(await tempDir(), 'images', 'nested');
  const file = await saveCaptchaImage(dataUrl, dir);
  assert.equal((await fs.stat(file)).isFile(), true);
  await fs.rm(path.dirname(path.dirname(dir)), { recursive: true });
});

test('two images saved in the same instant do not overwrite each other', async () => {
  const dir = await tempDir();
  const files = await Promise.all([saveCaptchaImage(dataUrl, dir), saveCaptchaImage(dataUrl, dir)]);
  assert.notEqual(files[0], files[1]);
  assert.equal((await fs.readdir(dir)).length, 2);
  await fs.rm(dir, { recursive: true });
});

test('refuses anything that is not a png data url and writes nothing', async () => {
  const dir = await tempDir();
  await assert.rejects(saveCaptchaImage('data:text/html;base64,PGI+', dir), /PNG/);
  await assert.rejects(saveCaptchaImage(undefined, dir), /PNG/);
  assert.deepEqual(await fs.readdir(dir), []);
  await fs.rm(dir, { recursive: true });
});
