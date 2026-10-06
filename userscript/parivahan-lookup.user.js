// ==UserScript==
// @name         Parivahan Transaction Lookup
// @namespace    https://github.com/Tushar-programador/parivahan_challan_automation
// @version      1.0.0
// @description  Look up Parivahan transaction status for one or many Application/Challan numbers from the Transaction Status page, with counting up, copy and CSV export.
// @match        https://vahan.parivahan.gov.in/eTransPgi/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/Tushar-programador/parivahan_challan_automation/main/userscript/parivahan-lookup.user.js
// @updateURL    https://raw.githubusercontent.com/Tushar-programador/parivahan_challan_automation/main/userscript/parivahan-lookup.user.js
// ==/UserScript==

(function () {
  'use strict';
  if (window.__parivahanLookup) return;
  window.__parivahanLookup = true;

  const SEARCH_URL = '/eTransPgi/paymentDetails';
  const MAX = 100;
  const DELAY_MS = 1000;
  const TIMEOUT_MS = 20000;
  const VALID = /^[A-Z0-9-]{6,50}$/;

  const FIELDS = [
    ['vehicleNo', 'Vehicle no'], ['transactionNo', 'Transaction no'], ['paymentId', 'Payment ID'],
    ['paymentDate', 'Payment date'], ['paymentConfirmationDate', 'Confirmed on'], ['paymentGateway', 'Gateway'],
    ['bankRefNo', 'Bank ref'], ['grn', 'GRN'], ['cin', 'CIN'], ['amount', 'Amount'], ['statusDescription', 'Bank status']
  ];
  const LABELS = { FOUND: 'Found', NOT_FOUND: 'Not found', INVALID_INPUT: 'Invalid', TIMEOUT: 'Timed out', WEBSITE_ERROR: 'Site error' };

  // ---------- search + parsing ----------

  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  // "🚗 Vehicle No" -> "vehicleno", "Bank Ref.No" -> "bankrefno"
  const headerKey = (h) => clean(h).replace(/[^A-Za-z0-9]+/g, '').toLowerCase();

  function parseResult(html, applicationNo) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headers = [...doc.querySelectorAll('table thead th')].map((th) => th.textContent);
    const rows = [...doc.querySelectorAll('table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => clean(td.textContent)));

    if (!rows.length) {
      return /no record found/i.test(doc.body ? doc.body.textContent : '')
        ? { status: 'NOT_FOUND', applicationNo }
        : { status: 'WEBSITE_ERROR', applicationNo, message: 'Unexpected response from the site. Reload the page and try again.' };
    }
    const row = rows.find((c) => c.length >= 14 && !(c[12] || '').toLowerCase().includes('subtotal'));
    if (!row) {
      return { status: 'WEBSITE_ERROR', applicationNo, message: 'The site returned an unexpected table layout.' };
    }

    const byKey = {};
    headers.forEach((h, i) => { const k = headerKey(h); if (k) byKey[k] = row[i] || ''; });
    return {
      status: 'FOUND',
      applicationNo,
      data: {
        applicationNo,
        vehicleNo: byKey.vehicleno || '',
        transactionNo: byKey.transactionnoauin || byKey.transactionno || '',
        paymentId: byKey.paymentid || '',
        paymentDate: byKey.paymentdate || '',
        paymentConfirmationDate: byKey.paymentconfdate || '',
        paymentGateway: byKey.paymentgateway || '',
        bankRefNo: byKey.bankrefno || '',
        grn: byKey.grn || '',
        cin: byKey.cin || '',
        amount: byKey.amount || '',
        statusDescription: byKey.statusdescription || ''
      }
    };
  }

  // Same-origin POST, exactly what the page's own Search button sends.
  async function searchOne(applicationNo, signal) {
    if (!VALID.test(applicationNo)) {
      return { status: 'INVALID_INPUT', applicationNo, message: 'Must be 6-50 letters, numbers or hyphens.' };
    }
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
    const onStop = () => timer.abort();
    signal.addEventListener('abort', onStop);
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        credentials: 'same-origin',
        body: new URLSearchParams({ selection: '6', 'Challan No./Application No.': applicationNo }),
        signal: timer.signal
      });
      if (!res.ok) return { status: 'WEBSITE_ERROR', applicationNo, message: `The site answered with HTTP ${res.status}.` };
      return parseResult(await res.text(), applicationNo);
    } catch (err) {
      if (signal.aborted) return null;
      if (err && err.name === 'AbortError') return { status: 'TIMEOUT', applicationNo, message: 'The site did not answer in time.' };
      return { status: 'WEBSITE_ERROR', applicationNo, message: 'Could not reach the site. Check your connection.' };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onStop);
    }
  }

  // "FNHR26107623401" x3 -> ...401, ...402, ...403 (keeps prefix and zero padding)
  function expandSequence(start, count) {
    const m = /^(.*?)(\d+)$/.exec(start);
    if (!m) return null;
    const first = BigInt(m[2]);
    return Array.from({ length: count }, (_, i) => m[1] + String(first + BigInt(i)).padStart(m[2].length, '0'));
  }

  function parseNumbers(text) {
    const seen = new Set();
    return text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase())
      .filter((s) => s && !/^(APPLICATIONNO|CHALLANNO)$/.test(s.replace(/[^A-Z]/g, '')) && !seen.has(s) && seen.add(s));
  }

  // ---------- export ----------

  const sheetSafe = (v) => (/^\s*[=+\-@]/.test(String(v)) ? `'${v}` : String(v));
  const csvCell = (v) => { const t = sheetSafe(v == null ? '' : v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rowsFor = (list) => list.map((r) => [r.applicationNo, LABELS[r.status] || r.status, ...FIELDS.map(([k]) => (r.data || {})[k] || '')]);
  const HEAD = ['Application no', 'Status', ...FIELDS.map((f) => f[1])];
  const toTsv = (list) => [HEAD, ...rowsFor(list)].map((r) => r.join('\t')).join('\n');
  const toCsv = (list) => `﻿${[HEAD, ...rowsFor(list)].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const slipText = (r) => [`Application no: ${r.applicationNo}`, `Status: ${LABELS[r.status] || r.status}`,
    ...FIELDS.filter(([k]) => (r.data || {})[k]).map(([k, l]) => `${l}: ${r.data[k]}`)].join('\n');


  // Minimal .xlsx writer (no dependencies): an uncompressed ZIP of the few XML parts Excel needs.
  const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const xmlEsc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = []; const central = []; let offset = 0;
    for (const [name, text] of files) {
      const nameB = enc.encode(name); const data = enc.encode(text); const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameB.length, true);
      parts.push(new Uint8Array(local.buffer), nameB, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, nameB.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    }
    const centralSize = central.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function toXlsx(list) {
    const colName = (i) => String.fromCharCode(65 + i); // up to 26 columns; the sheet has 13
    const cell = (v, ref, bold) => `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    const sheetRows = [HEAD, ...rowsFor(list)].map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(v, `${colName(c)}${i + 1}`, i === 0)).join('')}</row>`).join('');
    const cols = HEAD.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 22 : 20}" customWidth="1"/>`).join('');
    const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return zipStore([
      ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
      ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Transaction Results" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', `${XML}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`],
      ['xl/worksheets/sheet1.xml', `${XML}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>`]
    ]);
  }

  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------- UI (shadow DOM so the site's styles can't interfere) ----------

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:0;bottom:0;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { --paper:#eef1f4; --card:#fff; --ink:#14213d; --muted:#5b6678; --line:#d5dbe3; --saf:#e8890c; --ok:#17753f; --okbg:#e3f4e9; --bad:#a32424; --badbg:#fbe6e6; --warn:#8a5a00; --warnbg:#fdf0d2;
    font: 400 15px/1.45 system-ui, "Segoe UI", sans-serif; color: var(--ink); font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: dark) { .wrap { --paper:#0f1624; --card:#182237; --ink:#e8edf5; --muted:#9aa6ba; --line:#2b3850; --ok:#6fd69a; --okbg:#17342a; --bad:#f19a9a; --badbg:#3a1e22; --warn:#f2c15c; --warnbg:#3a2f14; } }
  .fab { position: fixed; right: 16px; bottom: 16px; min-height: 48px; padding: 0 20px; border: 0; border-radius: 24px; background: var(--saf); color: #1d1203; font: 600 15px system-ui; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
  .panel { position: fixed; right: 16px; bottom: 16px; width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 6px 30px rgba(0,0,0,.35); overflow: hidden; }
  .panel[hidden], .fab[hidden], [hidden] { display: none !important; }
  .top { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--ink); color: var(--paper); }
  .top b { font-size: 16px; }
  .body { padding: 14px; overflow-y: auto; }
  label { display: block; font-weight: 500; margin-bottom: 4px; }
  select { width: 100%; font: inherit; font-size: 16px; color: var(--ink); background: var(--card); border: 1.5px solid var(--line); border-radius: 6px; padding: 8px 10px; }
  textarea, input[type=number] { width: 100%; font: inherit; font-size: 16px; color: var(--ink); background: var(--card); border: 1.5px solid var(--line); border-radius: 6px; padding: 8px 10px; }
  textarea { resize: vertical; min-height: 84px; }
  .small { font-size: 13px; color: var(--muted); font-weight: 400; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  button { font: 500 14px system-ui; min-height: 40px; padding: 0 14px; border-radius: 6px; border: 1.5px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--saf); border-color: var(--saf); color: #1d1203; font-weight: 600; flex: 1; }
  button.danger { background: var(--badbg); border-color: var(--bad); color: var(--bad); font-weight: 600; }
  button.quiet { background: transparent; }
  button:disabled { opacity: .55; }
  :focus-visible { outline: 3px solid var(--saf); outline-offset: 2px; }
  .err { color: var(--bad); font-size: 13px; margin: 8px 0 0; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 14px 0 8px; flex-wrap: wrap; }
  .bar b { font-size: 15px; }
  .meter { height: 5px; background: var(--line); border-radius: 3px; overflow: hidden; margin-bottom: 10px; }
  .meter i { display: block; height: 100%; width: 0; background: var(--saf); }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .slip { background: var(--card); border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: 6px; }
  .slip.found { border-left-color: var(--ok); } .slip.bad { border-left-color: var(--bad); } .slip.warn { border-left-color: var(--saf); } .slip.pending { opacity: .7; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 9px 12px; min-height: 48px; list-style: none; }
  summary.head { cursor: pointer; } summary.head::-webkit-details-marker { display: none; }
  .head b { word-break: break-all; }
  .chip { font-size: 13px; font-weight: 600; padding: 2px 9px; border-radius: 99px; background: var(--line); white-space: nowrap; margin-left: auto; }
  .found .chip { background: var(--okbg); color: var(--ok); } .bad .chip { background: var(--badbg); color: var(--bad); } .warn .chip { background: var(--warnbg); color: var(--warn); }
  dl { margin: 0; padding: 8px 12px; border-top: 1px dashed var(--line); display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; text-align: right; word-break: break-all; }
  .msg { margin: 0; padding: 0 12px 10px; color: var(--muted); font-size: 13px; }
  .copy { margin: 0 12px 10px; min-height: 34px; }
  @media (max-width: 520px) { .panel { right: 0; bottom: 0; width: 100vw; max-height: 92vh; border-radius: 10px 10px 0 0; } dl { grid-template-columns: 1fr; gap: 0; } dt { margin-top: 6px; font-size: 12px; } dd { text-align: left; } }
</style>
<div class="wrap">
  <button class="fab" id="open" type="button">Lookup</button>
  <section class="panel" id="panel" hidden aria-label="Parivahan transaction lookup">
    <div class="top"><b>Transaction lookup</b><button class="quiet" id="close" type="button" style="color:inherit;border-color:transparent;min-height:32px">Close</button></div>
    <div class="body">
      <label for="nums">Application / Challan numbers <span class="small">(one per line)</span></label>
      <textarea id="nums" placeholder="FNHR26107623401" spellcheck="false" autocapitalize="characters" autocomplete="off"></textarea>
      <label for="count" class="small" style="margin-top:10px">Search this many in a row, counting up from the first number</label>
      <input id="count" type="number" min="1" max="${MAX}" value="1" inputmode="numeric">
      <label for="auto" class="small" style="margin-top:10px">When the search finishes,Automatic download</label>
      <select id="auto"><option value="all">Excel with all results</option><option value="found">Excel with found only</option><option value="off">nothing</option></select>
      <div class="row">
        <button class="primary" id="go" type="button">Search</button>
        <button class="danger" id="stop" type="button" hidden>Stop</button>
        <button class="quiet" id="clear" type="button">Clear</button>
      </div>
      <p class="err" id="err" hidden></p>
      <div id="out" hidden>
        <div class="bar"><b id="progress" aria-live="polite"></b>
          </div>
        <div class="row" style="margin:0 0 10px"><button class="quiet" id="xfound" type="button">Excel: found only</button><button class="quiet" id="xall" type="button">Excel: all results</button><button class="quiet" id="csv" type="button">CSV: all</button><button class="quiet" id="copyall" type="button">Copy all</button></div>
        <div class="meter" id="meter" hidden><i id="fill"></i></div>
        <ol id="list"></ol>
      </div>
    </div>
  </section>
</div>`;

  const $ = (id) => root.getElementById(id);
  let results = [];
  let numbers = [];
  let running = false;
  let controller = null;
  const openCards = new Set();

  const showError = (text) => { $('err').textContent = text || ''; $('err').hidden = !text; };
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    const p = $('progress'); const old = p.textContent; p.textContent = 'Copied'; setTimeout(() => { p.textContent = old; }, 1200);
  }

  function render() {
    const list = $('list');
    list.textContent = '';
    numbers.forEach((n, i) => {
      const r = results[i];
      const li = document.createElement('li');
      const cls = !r ? 'pending' : r.status === 'FOUND' ? 'found' : ['NOT_FOUND', 'INVALID_INPUT'].includes(r.status) ? 'bad' : 'warn';
      li.className = `slip ${cls}`;
      const hasData = Boolean(r && r.data);
      const head = document.createElement(hasData ? 'summary' : 'div');
      head.className = 'head';
      const left = document.createElement('div');
      const b = document.createElement('b'); b.textContent = n; left.append(b);
      if (hasData) {
        const s = document.createElement('div'); s.className = 'small';
        s.textContent = [r.data.vehicleNo, r.data.amount && `Rs ${r.data.amount}`].filter(Boolean).join(' - '); left.append(s);
      }
      const chip = document.createElement('span'); chip.className = 'chip';
      chip.textContent = r ? (LABELS[r.status] || r.status) : (running ? (i === results.length ? 'Searching' : 'Waiting') : 'Not searched');
      head.append(left, chip);
      if (hasData) {
        const det = document.createElement('details');
        det.open = numbers.length === 1 || openCards.has(n);
        det.addEventListener('toggle', () => (det.open ? openCards.add(n) : openCards.delete(n)));
        const dl = document.createElement('dl');
        for (const [k, l] of FIELDS) {
          if (!r.data[k]) continue;
          const dt = document.createElement('dt'); dt.textContent = l;
          const dd = document.createElement('dd'); dd.textContent = r.data[k];
          dl.append(dt, dd);
        }
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'copy'; btn.textContent = 'Copy details';
        btn.addEventListener('click', () => copy(slipText(r)));
        det.append(head, dl, btn); li.append(det);
      } else if (r && r.message) {
        const p = document.createElement('p'); p.className = 'msg'; p.textContent = r.message; li.append(head, p);
      } else {
        li.append(head);
      }
      list.append(li);
    });
    const done = results.length;
    const found = results.filter((r) => r.status === 'FOUND').length;
    $('fill').style.width = `${numbers.length ? (done / numbers.length) * 100 : 0}%`;
    $('meter').hidden = !running;
    $('stop').hidden = !running;
    $('go').disabled = running;
    $('progress').textContent = running
      ? `Searching ${Math.min(done + 1, numbers.length)} of ${numbers.length}`
      : `${found} of ${numbers.length} found${done < numbers.length ? ` (stopped after ${done})` : ''}`;
  }

  const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });

  async function run() {
    if (running) return;
    let list = parseNumbers($('nums').value);
    const count = Math.floor(Number($('count').value)) || 1;
    if (!list.length) return showError('Enter at least one number.');
    if (count > 1) {
      list = expandSequence(list[0], Math.min(count, MAX));
      if (!list) return showError('The first number must end in digits to count up.');
      $('nums').value = list.join('\n');
    }
    if (list.length > MAX) return showError(`Enter at most ${MAX} numbers. You entered ${list.length}.`);
    showError('');
    numbers = list; results = []; openCards.clear();
    running = true; controller = new AbortController();
    $('out').hidden = false; render();
    for (let i = 0; i < numbers.length; i += 1) {
      const result = await searchOne(numbers[i], controller.signal);
      if (!result) break;
      results.push(result);
      render();
      if (i < numbers.length - 1 && result.status !== 'INVALID_INPUT') await sleep(DELAY_MS, controller.signal);
      if (controller.signal.aborted) break;
    }
    const finished = results.length === numbers.length;
    running = false; controller = null; render();
    if (finished && $('auto').value !== 'off') download('xlsx', $('auto').value);
  }

  $('open').addEventListener('click', () => { $('panel').hidden = false; $('open').hidden = true; });
  $('close').addEventListener('click', () => { $('panel').hidden = true; $('open').hidden = false; });
  $('go').addEventListener('click', run);
  $('stop').addEventListener('click', () => { if (controller) controller.abort(); });
  $('clear').addEventListener('click', () => { if (running) return; $('nums').value = ''; $('count').value = 1; results = []; numbers = []; showError(''); $('out').hidden = true; });
  $('copyall').addEventListener('click', () => (results.length ? copy(toTsv(results)) : showError('Nothing to copy yet.')));
  const AUTO_KEY = 'parivahan-auto-download';
  try { $('auto').value = localStorage.getItem(AUTO_KEY) || 'all'; } catch (e) { /* default */ }
  $('auto').addEventListener('change', () => { try { localStorage.setItem(AUTO_KEY, $('auto').value); } catch (e) { /* not saved */ } });

  // kind: 'xlsx' | 'csv'; scope: 'all' | 'found'
  function download(kind, scope) {
    const list = results.filter((r) => scope === 'all' || r.status === 'FOUND');
    if (!list.length) return showError(scope === 'found' ? 'No found results to download.' : 'Nothing to export yet.');
    showError('');
    const blob = kind === 'xlsx' ? toXlsx(list) : new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8' });
    saveBlob(blob, `parivahan-${scope}-${stamp()}.${kind}`);
    const p = $('progress'); const old = p.textContent;
    p.textContent = `Downloaded ${list.length} result${list.length === 1 ? '' : 's'}`;
    setTimeout(() => { p.textContent = old; }, 2000);
  }
  $('xall').addEventListener('click', () => download('xlsx', 'all'));
  $('xfound').addEventListener('click', () => download('xlsx', 'found'));
  $('csv').addEventListener('click', () => download('csv', 'all'));
})();
