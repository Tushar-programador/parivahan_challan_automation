const { chromium } = require('playwright');
const { createLimiter } = require('./limiter');
const { readCaptchaText, closeOcr } = require('./ocr');
const { createPagePool } = require('./page-pool');

const TRANSACTION_STATUS_URL = 'https://vahan.parivahan.gov.in/eTransPgi/transactionStatus';
const VALID_INPUT = /^[A-Za-z0-9-]+$/;
const VALID_CAPTCHA = /^[A-Za-z0-9]{6}$/;
// The option cards hide their radio inputs behind a styled span, so the card (its label) is what gets clicked.
const CHALLAN_OPTION = 'label.radio-card:has(input[name="selection"][value="6"])';
const CAPTCHA_REJECTED = /captcha/i;
const NO_RECORD = /\bno\b[^.]{0,40}\b(record|transaction|data)s?\b[^.]{0,20}\bfound|not found/i;

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

function isValidCaptcha(value) {
  return VALID_CAPTCHA.test(String(value ?? ''));
}

// What the portal's banner (the text in .alert-message) means for the search that was just sent.
function classifyMessage(message) {
  const text = SAFE_TEXT(message);
  if (CAPTCHA_REJECTED.test(text)) return 'CAPTCHA_WRONG';
  if (NO_RECORD.test(text)) return 'NOT_FOUND';
  return 'WEBSITE_ERROR';
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
const CAPTCHA_WAIT_MS = 5000;
const LOAD_ATTEMPTS = 3;
// Images read per number before giving up: each wrong or unreadable code costs a fresh image from the portal.
const MAX_CAPTCHA_ATTEMPTS = 5;
// Searches that run at once (default 1, to go easy on the government site).
const SEARCH_CONCURRENCY = Number.parseInt(process.env.SEARCH_CONCURRENCY, 10) || 5;
const limit = createLimiter(SEARCH_CONCURRENCY);
const pool = createPagePool();
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

const captchaRequiredResult = (applicationNo, attempts) => ({
  status: 'CAPTCHA_REQUIRED',
  applicationNo,
  message: `The captcha could not be read after ${attempts} tries. Search this number again, or use the userscript and type it.`
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

// The captcha image the page is showing, as a data URL for the UI. It copies the pixels already on
// screen: fetching /captcha again would make the portal issue a new code and spoil the one displayed.
async function readCaptcha(page, timeout = PAGE_TIMEOUT_MS) {
  await page.waitForFunction(() => {
    const img = document.querySelector('#captchaImage');
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }, undefined, { timeout });
  return page.evaluate(() => {
    const img = document.querySelector('#captchaImage');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  });
}

// Loads a fresh search form and returns the captcha it shows.
async function prepareSearchForm(page) {
  await loadSearchPage(page);
  return readCaptcha(page);
}

async function refreshCaptcha(page) {
  try {
    const reloaded = page.waitForResponse((response) => response.url().includes('/captcha'), { timeout: PAGE_TIMEOUT_MS });
    reloaded.catch(() => {}); // if the click below throws, nobody awaits this
    await page.locator('#refreshCaptchaBtn').click();
    await reloaded;
    return await readCaptcha(page, CAPTCHA_WAIT_MS);
  } catch {
    return prepareSearchForm(page);
  }
}

// The captcha for the next number after a search. A result page carries a fresh form and captcha;
// after a timeout or site error the page can't be trusted, so start over from a clean form.
async function nextCaptcha(page, result) {
  if (result.status !== 'TIMEOUT' && result.status !== 'WEBSITE_ERROR') {
    try {
      return await readCaptcha(page, CAPTCHA_WAIT_MS);
    } catch { /* no usable captcha on this page: reload below */ }
  }
  return prepareSearchForm(page);
}

async function readResult(page, applicationNo) {
  if (await page.locator('table tbody tr').count() > 0) {
    const payload = await extractTransactionTable(page);
    if (!payload) {
      return {
        status: 'WEBSITE_ERROR',
        applicationNo,
        message: 'The website returned an unexpected table structure.'
      };
    }
    return {
      status: 'FOUND',
      applicationNo,
      data: { ...payload, applicationNo },
      rawStatus: payload.status
    };
  }

  const banner = SAFE_TEXT((await page.locator('.alert-message').allInnerTexts()).join(' ')).replace(/^[^A-Za-z0-9]+/, '');
  const status = classifyMessage(banner || await page.locator('body').innerText());
  if (status === 'WEBSITE_ERROR') {
    return { status, applicationNo, message: banner || 'The website returned an unexpected page.' };
  }
  return { status, applicationNo };
}

// Sends one search from a page that is already showing the form and a captcha the person has read.
// Returns CAPTCHA_WRONG (with the same number to retry) when the portal rejects the code.
async function searchWithCaptcha(page, applicationNo, captcha) {
  const cleanApplicationNo = normalizeApplicationNumber(applicationNo);
  if (!isValidApplicationNumber(cleanApplicationNo)) return invalidResult(cleanApplicationNo);

  try {
    await page.locator(CHALLAN_OPTION).click();
    await page.locator('#dynamicTextField').fill(cleanApplicationNo);
    await page.locator('#captcha').fill(captcha);
    // The page that answers is a new document without this flag, so a result left over from the
    // previous search is never mistaken for this one.
    await page.evaluate(() => { window.__searchPending = true; });
    await page.locator('#searchButton').click();

    try {
      // The answering page has no <body> for a moment while it loads, so the predicate must not assume one.
      await page.waitForFunction(
        () => !window.__searchPending && (
          document.querySelector('table tbody tr')
          || [...document.querySelectorAll('.alert-message')].some((el) => el.innerText.trim())
          || /no record found/i.test(document.body ? document.body.innerText : '')
        ),
        undefined,
        { timeout: RESULT_TIMEOUT_MS }
      );
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      return {
        status: 'TIMEOUT',
        applicationNo: cleanApplicationNo,
        message: 'The transaction result did not appear within the timeout window.'
      };
    }

    return await readResult(page, cleanApplicationNo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'WEBSITE_ERROR',
      applicationNo: cleanApplicationNo,
      message: `Automation failed: ${message}`
    };
  }
}

// One shared headless browser; each captcha session gets its own page (and so its own cookies).
let browserPromise;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch(LAUNCH_OPTIONS);
    browserPromise.then((browser) => browser.on('disconnected', () => { browserPromise = undefined; }));
  }
  return browserPromise;
}

async function openSearchPage() {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  return page;
}

// Searches from a page already showing the form and the captcha image `image`. Each image is read with
// OCR; when the code cannot be read or the portal rejects it, a new image is loaded and tried, up to
// `attempts` images. `solve` is overridable for tests.
async function searchWithOcr(page, applicationNo, image, { solve = readCaptchaText, attempts = MAX_CAPTCHA_ATTEMPTS } = {}) {
  const cleanApplicationNo = normalizeApplicationNumber(applicationNo);
  if (!isValidApplicationNumber(cleanApplicationNo)) return invalidResult(cleanApplicationNo);

  let captcha = image;
  for (let attempt = 1; ; attempt += 1) {
    const code = await solve(captcha);
    let rejected = null;
    if (isValidCaptcha(code)) {
      const result = await searchWithCaptcha(page, cleanApplicationNo, code);
      if (result.status !== 'CAPTCHA_WRONG') return result;
      rejected = result;
    }
    log(`Captcha ${rejected ? `${code} rejected` : 'not readable'} for ${cleanApplicationNo} (image ${attempt}/${attempts})`);
    if (attempt >= attempts) return captchaRequiredResult(cleanApplicationNo, attempts);

    try {
      captcha = rejected ? await nextCaptcha(page, rejected) : await refreshCaptcha(page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'WEBSITE_ERROR', applicationNo: cleanApplicationNo, message: `Could not load a new captcha: ${message}` };
    }
  }
}

// One complete search on `page`: reads the captcha and searches, with no one to type anything. The form is
// loaded first unless the caller already has its captcha image (`options.image`), as on a result page.
async function searchTransactionOnPage(page, applicationNo, options = {}) {
  const cleanApplicationNo = normalizeApplicationNumber(applicationNo);
  if (!isValidApplicationNumber(cleanApplicationNo)) return invalidResult(cleanApplicationNo);

  let image = options.image;
  if (!image) {
    try {
      image = await prepareSearchForm(page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'WEBSITE_ERROR', applicationNo: cleanApplicationNo, message: `Could not open the portal: ${message}` };
    }
  }
  return searchWithOcr(page, cleanApplicationNo, image, options);
}

const isAnswer = (result) => result.status === 'FOUND' || result.status === 'NOT_FOUND';

// Searches on `page` and then either keeps it for the next number or, when the portal did not answer
// cleanly, closes it so the next search starts from a fresh page.
async function searchAndKeep(page, applicationNo, options, image) {
  try {
    const result = await searchTransactionOnPage(page, applicationNo, { ...options, image });
    if (isAnswer(result)) pool.keep(page, result);
    else await page.close().catch(() => {});
    return result;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

// Up to SEARCH_CONCURRENCY searches run at once. `options.cancelled()` turns a search that has not
// started yet into CANCELLED, so a closed browser tab does not leave the rest of a long list running.
// A page left by the previous search is reused, which skips loading the form again; if that page
// misbehaves, the number is searched once more from a fresh page.
function searchTransaction(applicationNo, options = {}) {
  const cleanApplicationNo = normalizeApplicationNumber(applicationNo);
  if (!isValidApplicationNumber(cleanApplicationNo)) return Promise.resolve(invalidResult(cleanApplicationNo));

  return limit(async () => {
    if (options.cancelled && options.cancelled()) return { status: 'CANCELLED', applicationNo: cleanApplicationNo };

    const warm = pool.take();
    if (warm) {
      const image = await nextCaptcha(warm.page, warm.last).catch(() => null);
      if (image) {
        const result = await searchAndKeep(warm.page, cleanApplicationNo, options, image);
        if (isAnswer(result)) return result;
        log(`Search from a reused page ended as ${result.status}; trying ${cleanApplicationNo} again on a fresh page`);
      } else {
        await warm.page.close().catch(() => {});
      }
    }
    return searchAndKeep(await openSearchPage(), cleanApplicationNo, options);
  });
}

async function closeBrowser() {
  await pool.closeAll();
  closeOcr();
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
  isValidCaptcha,
  classifyMessage,
  openSearchPage,
  prepareSearchForm,
  refreshCaptcha,
  nextCaptcha,
  searchWithCaptcha,
  searchWithOcr,
  MAX_CAPTCHA_ATTEMPTS,
  TRANSACTION_STATUS_URL
};
