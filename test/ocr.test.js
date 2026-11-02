const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readCaptchaText, closeOcr } = require('../src/ocr');

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const toUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const PNG = toUrl(PNG_BYTES);
const SIZE = String(PNG_BYTES.length).padStart(3, '0'); // what the fake worker reports back
const LONGER_SIZE = String(PNG_BYTES.length + 20).padStart(3, '0');
const LONGER_PNG = toUrl(Buffer.concat([PNG_BYTES, Buffer.alloc(20)]));

// Node stands in for Python: each fake is run as `node script --serve` and speaks src/ocr.py's protocol
// (a base64 PNG per line in, "OK <code>", "NOREAD" or "ERR <message>" per line out).
const REPLY_WITH_COUNT = String.raw`
  handled += 1;
  const png = Buffer.from(line, 'base64');
  if (png.subarray(1, 4).toString() !== 'PNG') return console.log('ERR not a png');
  console.log('OK ' + String(handled).padStart(3, '0') + String(png.length).padStart(3, '0'));
`;

async function fakeWorker(onLine, { before = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-test-'));
  const script = path.join(dir, 'fake-ocr.js');
  await fs.writeFile(script, `
    const readline = require('readline');
    const fs = require('fs');
    let handled = 0;
    ${before}
    readline.createInterface({ input: process.stdin }).on('line', (line) => { ${onLine} });
  `);
  return { script, python: process.execPath, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test.afterEach(() => closeOcr());

test('resolves to the code the worker answers, given the image as base64', async () => {
  const fake = await fakeWorker(REPLY_WITH_COUNT);
  try {
    assert.equal(await readCaptchaText(PNG, fake), `001${SIZE}`);
  } finally {
    await fake.cleanup();
  }
});

test('one worker keeps answering, so only the first image pays for the startup', async () => {
  const fake = await fakeWorker(REPLY_WITH_COUNT);
  try {
    assert.equal(await readCaptchaText(PNG, fake), `001${SIZE}`);
    assert.equal(await readCaptchaText(PNG, fake), `002${SIZE}`);
    assert.equal(await readCaptchaText(PNG, fake), `003${SIZE}`);
  } finally {
    await fake.cleanup();
  }
});

test('requests made at the same time each get their own answer', async () => {
  const fake = await fakeWorker(REPLY_WITH_COUNT);
  try {
    const [a, b, c] = await Promise.all([readCaptchaText(PNG, fake), readCaptchaText(LONGER_PNG, fake), readCaptchaText(PNG, fake)]);
    assert.deepEqual([a, b, c], [`001${SIZE}`, `002${LONGER_SIZE}`, `003${SIZE}`]);
  } finally {
    await fake.cleanup();
  }
});

test('resolves to null when the worker found no 6 character read', async () => {
  const fake = await fakeWorker("console.log('NOREAD');");
  try {
    assert.equal(await readCaptchaText(PNG, fake), null);
  } finally {
    await fake.cleanup();
  }
});

test('rejects with the message when the worker fails one request, and keeps serving', async () => {
  const fake = await fakeWorker(String.raw`
    handled += 1;
    console.log(handled === 1 ? 'ERR ValueError: bad image' : 'OK ABC123');
  `);
  try {
    await assert.rejects(readCaptchaText(PNG, fake), /Reading the captcha failed: ValueError: bad image/);
    assert.equal(await readCaptchaText(PNG, fake), 'ABC123');
  } finally {
    await fake.cleanup();
  }
});

test('rejects with the last line of the error when the worker dies, and the next call starts a new one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-test-'));
  const marker = path.join(dir, 'crashed');
  const fake = await fakeWorker(String.raw`
    if (!fs.existsSync(${JSON.stringify(marker)})) {
      fs.writeFileSync(${JSON.stringify(marker)}, '');
      console.error('Traceback...');
      console.error('ModuleNotFoundError: No module named ddddocr');
      process.exit(1);
    }
    console.log('OK ABC123');
  `);
  try {
    await assert.rejects(readCaptchaText(PNG, fake), /Reading the captcha failed: ModuleNotFoundError: No module named ddddocr/);
    assert.equal(await readCaptchaText(PNG, fake), 'ABC123');
  } finally {
    await fake.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rejects with a hint when Python is not installed', async () => {
  await assert.rejects(readCaptchaText(PNG, { python: 'no-such-python-binary-xyz' }), /was not found.*PYTHON/);
});

test('rejects something that is not a PNG data URL before starting anything', async () => {
  await assert.rejects(readCaptchaText('hello'), /PNG data URL/);
});

test('an idle worker does not keep the program from exiting', async () => {
  const fake = await fakeWorker("console.log('OK ABC123');");
  try {
    const program = `
      const { readCaptchaText } = require(${JSON.stringify(require.resolve('../src/ocr'))});
      readCaptchaText(${JSON.stringify(PNG)}, { python: ${JSON.stringify(fake.python)}, script: ${JSON.stringify(fake.script)} })
        .then((code) => console.log(code));
    `;
    const out = execFileSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 15000 });
    assert.equal(out.trim(), 'ABC123');
  } finally {
    await fake.cleanup();
  }
});
