const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { decodePngDataUrl } = require('./captcha-images');

const SCRIPT = path.join(__dirname, 'ocr.py');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// The first answer waits for Python to start and the model to load (a few seconds); later ones take milliseconds.
const OCR_TIMEOUT_MS = 60000;
// The model takes memory, so a worker nobody has asked anything for in a while is stopped (and restarted on demand).
const IDLE_MS = 5 * 60 * 1000;

// One `python ocr.py --serve` process: a base64 PNG per line in, one reply line out, in the same order.
class Worker {
  constructor(python, script, onEnd) {
    this.pending = [];
    this.stderr = '';
    this.ended = false;
    this.onEnd = onEnd;
    this.child = spawn(python, [script, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.answer(line));
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.child.stdin.on('error', () => {}); // a dead process is reported by 'close'
    this.child.on('error', (error) => this.end(error.code === 'ENOENT'
      ? `${python} was not found. Install Python, or set PYTHON to its path.`
      : error.message));
    this.child.on('close', () => this.end(this.stderr.trim().split('\n').pop() || 'the OCR process stopped'));
    this.hold(false);
  }

  // A worker with nothing to answer must not keep Node alive, but one that is being waited on must.
  hold(on) {
    const streams = [this.child, this.child.stdin, this.child.stdout, this.child.stderr];
    streams.forEach((stream) => (on ? stream.ref() : stream.unref()));
  }

  ask(png) {
    return new Promise((resolve, reject) => {
      if (this.ended) return reject(new Error('the OCR process stopped'));
      const request = { resolve, reject };
      request.timer = setTimeout(() => this.end(`no answer after ${OCR_TIMEOUT_MS / 1000} seconds`), OCR_TIMEOUT_MS);
      this.pending.push(request);
      clearTimeout(this.idleTimer);
      this.hold(true);
      this.child.stdin.write(`${png.toString('base64')}\n`);
    });
  }

  answer(line) {
    const request = this.pending.shift();
    if (!request) return;
    clearTimeout(request.timer);
    if (this.pending.length === 0) {
      this.hold(false);
      this.idleTimer = setTimeout(() => this.end('idle'), IDLE_MS);
      this.idleTimer.unref();
    }
    request.resolve(line);
  }

  // Fails everything still waiting; the next call starts a new worker.
  end(reason) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    this.onEnd();
    this.child.kill();
    for (const { reject, timer } of this.pending.splice(0)) {
      clearTimeout(timer);
      reject(new Error(`Reading the captcha failed: ${reason}`));
    }
  }
}

const workers = new Map();

function workerFor(python, script) {
  const key = `${python}\0${script}`;
  if (!workers.has(key)) workers.set(key, new Worker(python, script, () => workers.delete(key)));
  return workers.get(key);
}

// Reads the code in a captcha image (a PNG data URL) with src/ocr.py. Resolves to the code, or null when
// the image gave no 6-character read. Rejects when OCR itself cannot run (no Python or ddddocr),
// which retrying with another image would not fix. `python` and `script` are overridable for tests.
async function readCaptchaText(dataUrl, { python = PYTHON, script = SCRIPT } = {}) {
  const png = decodePngDataUrl(dataUrl);
  const reply = await workerFor(python, script).ask(png);
  if (reply === 'NOREAD') return null;
  if (reply.startsWith('OK ')) return reply.slice(3);
  throw new Error(`Reading the captcha failed: ${reply.replace(/^ERR /, '')}`);
}

function closeOcr() {
  for (const worker of [...workers.values()]) worker.end('closed');
}

module.exports = { readCaptchaText, closeOcr, PYTHON, SCRIPT };
