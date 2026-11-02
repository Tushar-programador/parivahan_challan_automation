const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PYTHON } = require('../src/ocr');

// test/captchas holds real portal captchas, each named after the code it shows (<CODE>.png). A few have
// their last letter clipped by the image edge; the reader must refuse those (null), never guess.
const DIR = path.join(__dirname, 'captchas');
const SRC = path.join(__dirname, '..', 'src');
const MIN_READ_SHARE = 0.8;

const SCRIPT = `
import json, os, sys
sys.path.insert(0, sys.argv[1])
import ocr
folder = sys.argv[2]
print(json.dumps({f: ocr.solve(os.path.join(folder, f)) for f in sorted(os.listdir(folder)) if f.endswith('.png')}))
`;

function readAll() {
  try {
    execFileSync(PYTHON, ['-c', 'import ddddocr'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const out = execFileSync(PYTHON, ['-c', SCRIPT, SRC, DIR], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.trim().split('\n').pop());
}

test('reads real portal captchas: never a wrong code, and most of them', (t) => {
  const reads = readAll();
  if (!reads) return t.skip('ddddocr is not installed (pip install ddddocr)');

  const files = Object.keys(reads);
  assert.ok(files.length >= 40, 'the captcha fixtures are missing');
  const wrong = files.filter((f) => reads[f] !== null && `${reads[f]}.png` !== f);
  assert.deepEqual(wrong.map((f) => `${f} read as ${reads[f]}`), [], 'a wrong code would burn a portal attempt');

  const read = files.filter((f) => reads[f] !== null).length;
  assert.ok(read / files.length >= MIN_READ_SHARE, `only ${read} of ${files.length} captchas were read`);
  assert.equal(fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).length, files.length);
});
