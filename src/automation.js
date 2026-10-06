const { chromium } = require('playwright');

const TRANSACTION_STATUS_URL = 'https://vahan.parivahan.gov.in/eTransPgi/transactionStatus';
const VALID_INPUT = /^[A-Za-z0-9-]+$/;

const SAFE_TEXT = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function normalizeHeader(header) {
  const normalized = SAFE_TEXT(header)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();

  if (!normalized) return '';

  return normalized
    .split(' ')
    .filter(Boolean)
    .map((part, index) => {
      const text = part.toLowerCase();
      return index === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
    })
    .join('');
}

function normalizeApplicationNumber(value) {
  return SAFE_TEXT(value).toUpperCase();
}

function isValidApplicationNumber(value) {
  const normalized = normalizeApplicationNumber(value);
  return normalized.length >= 6 && normalized.length <= 50 && VALID_INPUT.test(normalized);
}

function toResultPayload(rowValues, headers) {
  const payload = {};

  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    if (!key) return;
    payload[key.toLowerCase()] = SAFE_TEXT(rowValues[index] ?? '');
  });

  return {
    applicationNo: payload.applicationno || payload.paymentid || '',
    vehicleNo: payload.vehicleno || '',
    transactionNo: payload.transactionnoauin || payload.transactionno || '',
    paymentId: payload.paymentid || '',
    paymentDate: payload.paymentdate || '',
    paymentConfirmationDate: payload.paymentconfdate || '',
    paymentGateway: payload.paymentgateway || '',
    bankRefNo: payload.bankrefno || '',
    grn: payload.grn || '',
    cin: payload.cin || '',
    amount: payload.amount || '',
    status: payload.status || '',
    statusDescription: payload.statusdescription || ''
  };
}

async function extractTransactionTable(page) {
  const headers = await page.locator('table thead th').evaluateAll((items) => items.map((el) => el.textContent));
  const rows = await page.locator('table tbody tr').evaluateAll((items) => items.map((row) => {
    const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim());
    return cells;
  }));

  const relevantRow = rows.find((cells) => cells.length >= 14 && !(cells[12] || '').toLowerCase().includes('subtotal'));
  if (!relevantRow) {
    return null;
  }

  return toResultPayload(relevantRow, headers);
}

const PAGE_TIMEOUT_MS = 30000;
const RESULT_TIMEOUT_MS =  20000;
const LOAD_ATTEMPTS = 3;
// Container-friendly flags: no sandbox (runs as root), and /tmp instead of the small /dev/shm.
const LAUNCH_OPTIONS = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };

function log(message) {
  if (process.env.LOG_LEVEL !== 'silent') console.error(`[INFO] ${message}`);
}

const invalidResult = (applicationNo) => ({
  status: 'INVALID_INPUT',
  applicationNo,
  message: 'Application/Challan number must contain 6-50 letters, numbers, or hyphens.'
});

async function loadSearchPage(page) {
  let lastError;
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(TRANSACTION_STATUS_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      await page.locator('#dynamicTextField').waitFor({ timeout: PAGE_TIMEOUT_MS });
      return;
    } catch (error) {
      lastError = error;
      log(`Page load attempt ${attempt}/${LOAD_ATTEMPTS} failed`);
      await page.waitForTimeout(1000 * attempt);
    }
  }
  throw lastError;
}

async function searchTransactionOnPage(page, applicationNo) {
  const cleanApplicationNo = normalizeApplicationNumber(applicationNo);
  if (!isValidApplicationNumber(cleanApplicationNo)) return invalidResult(cleanApplicationNo);

  log(`Starting search for ${cleanApplicationNo}`);
  try {
    await loadSearchPage(page);
    log('Transaction page loaded');

    await page.locator('input[name="selection"][value="6"]').check();
    await page.locator('#dynamicTextField').fill(cleanApplicationNo);
    await page.locator('button:has-text("Search")').click();
    log('Search submitted');

    try {
      await page.waitForURL(/paymentDetails/, { timeout: RESULT_TIMEOUT_MS });
      await page.waitForFunction(
        () => document.querySelector('table tbody tr') || /no record found/i.test(document.body.innerText),
        undefined,
        { timeout: RESULT_TIMEOUT_MS }
      );
    } catch {
      return {
        status: 'TIMEOUT',
        applicationNo: cleanApplicationNo,
        message: 'The transaction result did not appear within the timeout window.'
      };
    }

    if (await page.locator('table tbody tr').count() === 0) {
      log('No record found');
      return { status: 'NOT_FOUND', applicationNo: cleanApplicationNo };
    }

    const payload = await extractTransactionTable(page);
    if (!payload) {
      return {
        status: 'WEBSITE_ERROR',
        applicationNo: cleanApplicationNo,
        message: 'The website returned an unexpected table structure.'
      };
    }

    log('Transaction extracted');
    return {
      status: 'FOUND',
      applicationNo: cleanApplicationNo,
      data: { ...payload, applicationNo: cleanApplicationNo },
      rawStatus: payload.status
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'WEBSITE_ERROR',
      applicationNo: cleanApplicationNo,
      message: `Automation failed: ${message}`
    };
  }
}

// One shared headless browser, so repeated searches (UI bulk) don't pay launch cost each time.
let browserPromise;
let queue = Promise.resolve();

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch(LAUNCH_OPTIONS);
    browserPromise.then((browser) => browser.on('disconnected', () => { browserPromise = undefined; }));
  }
  return browserPromise;
}

async function runSearch(applicationNo) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try {
    return await searchTransactionOnPage(page, applicationNo);
  } finally {
    await page.close();
  }
}

// Searches run one at a time to stay polite to the government site.
function searchTransaction(applicationNo, options = {}) {
  const cleanApplicationNo = normalizeApplicationNumber(applicationNo);
  if (!isValidApplicationNumber(cleanApplicationNo)) return Promise.resolve(invalidResult(cleanApplicationNo));

  const run = queue.then(() => (options.cancelled && options.cancelled()
    ? { status: 'CANCELLED', applicationNo: cleanApplicationNo }
    : runSearch(cleanApplicationNo)));
  queue = run.catch(() => {});
  return run;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = undefined;
  await browser.close();
}

module.exports = {
  searchTransaction,
  closeBrowser,
  LAUNCH_OPTIONS,
  toResultPayload,
  searchTransactionOnPage,
  isValidApplicationNumber,
  normalizeApplicationNumber,
  TRANSACTION_STATUS_URL
};
