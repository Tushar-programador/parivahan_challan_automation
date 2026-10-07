const MAX = 1000;
const $ = (id) => document.getElementById(id);
const FIELDS = [
  ['vehicleNo', 'Vehicle no'], ['transactionNo', 'Transaction no'], ['paymentId', 'Payment ID'],
  ['paymentDate', 'Payment date'], ['paymentConfirmationDate', 'Confirmed on'], ['paymentGateway', 'Gateway'],
  ['bankRefNo', 'Bank ref'], ['grn', 'GRN'], ['cin', 'CIN'], ['amount', 'Amount'], ['statusDescription', 'Bank status']
];
const LABELS = { FOUND: 'Found', NOT_FOUND: 'Not found', INVALID_INPUT: 'Invalid', TIMEOUT: 'Timed out', WEBSITE_ERROR: 'Site error', CAPTCHA_REQUIRED: 'CAPTCHA' };
const KEY_NAME = 'parivahan-access-key';
const store = {
  get: () => { try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; } },
  set: (v) => { try { localStorage.setItem(KEY_NAME, v); } catch { /* private mode: key is asked again next time */ } }
};

// fetch wrapper: sends the access key, and asks for it once if the server requires one.
async function api(url, options = {}) {
  const send = () => fetch(url, { ...options, headers: { ...options.headers, 'x-access-key': store.get() } });
  let res = await send();
  if (res.status === 401) {
    const key = window.prompt('Enter the access key for this service');
    if (!key) return res;
    store.set(key.trim());
    res = await send();
    if (res.status === 401) store.set('');
  }
  return res;
}

let results = [];
let running = false;
let controller = null;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.id);
  toast.id = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed. Select the text and copy it manually.');
  }
}

function parseNumbers(text) {
  const seen = new Set();
  return text.split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && !/^(APPLICATIONNO|CHALLANNO)$/.test(s.replace(/[^A-Z]/g, '')) && !seen.has(s) && seen.add(s));
}

// FNHR26107623401 x3 -> FNHR26107623401, ...402, ...403 (keeps the prefix and zero padding)
function expandSequence(start, count) {
  const m = /^(.*?)(\d+)$/.exec(start);
  if (!m) return null;
  const [, prefix, digits] = m;
  const first = BigInt(digits);
  return Array.from({ length: count }, (_, i) => prefix + String(first + BigInt(i)).padStart(digits.length, '0'));
}

function slipText(r) {
  const d = r.data || {};
  return [
    `Application no: ${r.applicationNo}`,
    `Status: ${LABELS[r.status] || r.status}`,
    ...FIELDS.filter(([k]) => d[k]).map(([k, l]) => `${l}: ${d[k]}`)
  ].join('\n');
}

function tsv() {
  const head = ['Application no', 'Status', ...FIELDS.map((f) => f[1])];
  const rows = results.filter(Boolean).map((r) => [
    r.applicationNo, LABELS[r.status] || r.status, ...FIELDS.map(([k]) => (r.data || {})[k] || '')
  ]);
  return [head, ...rows].map((r) => r.join('\t')).join('\n');
}

const openCards = new Set();

function render(numbers) {
  const ol = $('results');
  ol.textContent = '';
  numbers.forEach((n, i) => {
    const r = results[i];
    const li = document.createElement('li');
    const cls = !r ? 'pending' : r.status === 'FOUND' ? 'found' : ['NOT_FOUND', 'INVALID_INPUT'].includes(r.status) ? 'bad' : 'warn';
    li.className = `slip ${cls}`;

    const hasData = Boolean(r && r.data);
    const head = document.createElement(hasData ? 'summary' : 'div');
    head.className = 'head';
    const left = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = n;
    left.append(b);
    if (r && r.data) {
      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = [r.data.vehicleNo, r.data.amount && `Rs ${r.data.amount}`].filter(Boolean).join(' - ');
      left.append(s);
    }
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = r ? (LABELS[r.status] || r.status) : (running ? (i === results.length ? 'Searching' : 'Waiting') : 'Not searched');
    head.append(left, chip);

    if (hasData) {
      const details = document.createElement('details');
      details.open = numbers.length === 1 || openCards.has(n);
      details.addEventListener('toggle', () => (details.open ? openCards.add(n) : openCards.delete(n)));
      details.append(head);
      const dl = document.createElement('dl');
      for (const [k, l] of FIELDS) {
        if (!r.data[k]) continue;
        const dt = document.createElement('dt');
        dt.textContent = l;
        const dd = document.createElement('dd');
        dd.textContent = r.data[k];
        dl.append(dt, dd);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.textContent = 'Copy details';
      btn.addEventListener('click', () => copy(slipText(r)));
      details.append(dl, btn);
      li.append(details);
    } else if (r && r.message) {
      const p = document.createElement('p');
      p.className = 'msg';
      p.textContent = r.message;
      li.append(head, p);
    } else {
      li.append(head);
    }
    ol.append(li);
  });

  const done = results.filter(Boolean).length;
  const found = results.filter((r) => r && r.status === 'FOUND').length;
  $('bar').style.width = `${(done / numbers.length) * 100}%`;
  $('meter').hidden = !running;
  $('stop').hidden = !running;
  $('progress').textContent = running
    ? `Searching ${Math.min(done + 1, numbers.length)} of ${numbers.length}`
    : `${found} of ${numbers.length} found${done < numbers.length ? ` (stopped after ${done})` : ''}`;
}

async function searchOne(n, signal) {
  try {
    const res = await api('/api/transaction/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationNo: n }),
      signal
    });
    const body = await res.json();
    if (res.status === 401) return { status: 'WEBSITE_ERROR', applicationNo: n, message: body.message };
    return body;
  } catch (error) {
    if (error && error.name === 'AbortError') return null;
    return { status: 'WEBSITE_ERROR', applicationNo: n, message: 'Could not reach the local server. Check that it is running.' };
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (running) return;
  let numbers = parseNumbers($('numbers').value);
  const hint = $('hint');
  const count = Math.floor(Number($('count').value)) || 1;
  if (count > 1 && numbers.length) {
    const seq = expandSequence(numbers[0], Math.min(count, MAX));
    if (!seq) {
      hint.textContent = `"${numbers[0]}" does not end in digits, so it cannot be counted up.`;
      hint.className = 'hint err';
      return;
    }
    numbers = seq;
    $('numbers').value = numbers.join('\n');
  }
  if (!numbers.length) {
    hint.textContent = 'Enter at least one number.';
    hint.className = 'hint err';
    return;
  }
  if (numbers.length > MAX) {
    hint.textContent = `Enter at most ${MAX} numbers. You entered ${numbers.length}.`;
    hint.className = 'hint err';
    return;
  }
  hint.textContent = 'Up to 1000 numbers. Searches run one at a time.';
  hint.className = 'hint';
  results = [];
  openCards.clear();
  running = true;
  $('go').disabled = true;
  $('results-wrap').hidden = false;
  render(numbers);
  controller = new AbortController();
  let finished = true;
  for (const n of numbers) {
    const result = await searchOne(n, controller.signal);
    if (!result) {
      finished = false;
      break;
    }
    results.push(result);
    render(numbers);
  }
  controller = null;
  running = false;
  $('go').disabled = false;
  render(numbers);
  if (finished && $('auto').value !== 'off') exportAs('xlsx', $('auto').value);
});

$('stop').addEventListener('click', () => {
  if (controller) controller.abort();
  toast('Stopped. Results so far are kept.');
});

$('clear').addEventListener('click', () => {
  if (running) return;
  $('numbers').value = '';
  $('count').value = 1;
  results = [];
  $('results-wrap').hidden = true;
});

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('numbers').value = parseNumbers(await f.text()).join('\n');
  e.target.value = '';
});

$('copy-all').addEventListener('click', () => (results.some(Boolean) ? copy(tsv()) : toast('Nothing to copy yet')));

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');

// scope: 'all' or 'found'. Returns false when there was nothing to download.
async function exportAs(format, scope = 'all') {
  const done = results.filter((r) => r && (scope === 'all' || r.status === 'FOUND'));
  if (!done.length) {
    toast(scope === 'found' ? 'No found results to download' : 'Nothing to export yet');
    return false;
  }
  const res = await api(`/api/export?format=${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results: done })
  });
  if (!res.ok) {
    toast('Download failed');
    return false;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = `parivahan-${scope}-${stamp()}.${format}`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Downloaded ${done.length} ${scope === 'found' ? 'found ' : ''}result${done.length === 1 ? '' : 's'}`);
  return true;
}
$('csv').addEventListener('click', () => exportAs('csv'));
$('xlsx').addEventListener('click', () => exportAs('xlsx'));
$('xlsx-found').addEventListener('click', () => exportAs('xlsx', 'found'));

const AUTO_KEY = 'parivahan-auto-download';
try { $('auto').value = localStorage.getItem(AUTO_KEY) || 'all'; } catch { /* default */ }
$('auto').addEventListener('change', () => { try { localStorage.setItem(AUTO_KEY, $('auto').value); } catch { /* not saved */ } });
