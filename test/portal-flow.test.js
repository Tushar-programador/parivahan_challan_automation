const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  LAUNCH_OPTIONS,
  prepareSearchForm,
  refreshCaptcha,
  nextCaptcha,
  searchWithCaptcha
} = require('../src/automation');

// A stand-in for the portal, served through request interception so no test touches the real site.
// Its markup mirrors the parts the automation relies on: option cards that wrap the radio inputs,
// #dynamicTextField renamed by the chosen card, #captchaImage, #captcha, #searchButton and .alert-message.
// The head loads a slow script, so for a moment the answering page has no <body>, as on the real portal.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const HEADERS = ['Sl No', 'Vehicle No', 'Application No', 'Transaction No/AUIN', 'Payment Id', 'Payment Date', 'Payment Conf Date',
  'Payment Gateway', 'Bank Ref.No', 'GRN', 'CIN', 'Amount', 'Status', 'Status Description'];
const ROW = ['1', 'HR31V0031', 'FNHR1', 'HRZ1', 'FNHR1', '2026-10-01', '2026-10-02', 'SBI', '1100', 'GRN1', 'CIN1', '500', 'SUCCESS', 'Paid'];

const form = `
<form id="transactionSearchForm" method="post" action="/eTransPgi/paymentDetails">
  <label class="radio-card"><input type="radio" name="selection" value="1" checked data-text-field-name="Transaction Id."><span class="radio-card-content">Transaction ID</span></label>
  <label class="radio-card"><input type="radio" name="selection" value="6" data-text-field-name="Challan No./Application No."><span class="radio-card-content">Challan</span></label>
  <input type="text" id="dynamicTextField" name="Transaction Id.">
  <img id="captchaImage" src="/eTransPgi/captcha" alt="CAPTCHA">
  <button type="button" id="refreshCaptchaBtn" onclick="document.getElementById('captchaImage').src='/eTransPgi/captcha?t='+Date.now()">refresh</button>
  <input type="text" id="captcha" name="captcha" maxlength="6" required>
  <button type="submit" id="searchButton">Search</button>
</form>
<script>
  document.querySelectorAll('input[name=selection]').forEach((radio) => radio.addEventListener('change', () => {
    document.getElementById('dynamicTextField').name = radio.dataset.textFieldName;
  }));
</script>`;

const layout = (extra = '') => `<!doctype html><html><head><script src="/eTransPgi/js/slow.js"></script></head><body>${form}${extra}</body></html>`;
const table = `<table><thead><tr>${HEADERS.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr>${ROW.map((c) => `<td>${c}</td>`).join('')}</tr></tbody></table>`;
const banner = (text) => `<div class="alert-message"><span>⚠</span>\n${text}</div>`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The fake portal's rules: captcha WRONG1 is rejected, application number NOREC0001 has no record,
// NOISE0001 gets an unrelated banner, anything else finds a transaction.
async function openFakePortal(browser) {
  const page = await browser.newPage();
  const posts = [];
  await page.route('**/eTransPgi/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/slow.js')) {
      await wait(400);
      return route.fulfill({ contentType: 'text/javascript', body: '' });
    }
    if (pathname.endsWith('/captcha')) return route.fulfill({ contentType: 'image/png', body: PNG });
    if (pathname.endsWith('/transactionStatus')) return route.fulfill({ contentType: 'text/html', body: layout() });
    if (pathname.endsWith('/paymentDetails')) {
      const sent = new URLSearchParams(request.postData() || '');
      posts.push(sent);
      const number = sent.get('Challan No./Application No.');
      let extra = table;
      if (sent.get('captcha') === 'WRONG1') extra = banner('Invalid CAPTCHA. Please enter the correct CAPTCHA.');
      else if (number === 'NOREC0001') extra = banner('No record found for the given details.');
      else if (number === 'NOISE0001') extra = banner('Service is temporarily unavailable.');
      return route.fulfill({ contentType: 'text/html', body: layout(extra) });
    }
    return route.abort();
  });
  page.setDefaultTimeout(10000);
  return { page, posts };
}

let browser;
test.before(async () => { browser = await chromium.launch(LAUNCH_OPTIONS); });
test.after(async () => { await browser.close(); });

test('reads the captcha image as a PNG data URL', async () => {
  const { page } = await openFakePortal(browser);
  const image = await prepareSearchForm(page);
  assert.match(image, /^data:image\/png;base64,/);
  await page.close();
});

test('refreshing loads another captcha image', async () => {
  const { page } = await openFakePortal(browser);
  await prepareSearchForm(page);
  assert.match(await refreshCaptcha(page), /^data:image\/png;base64,/);
  await page.close();
});

test('a correct captcha returns the transaction and sends the fields the form would send', async () => {
  const { page, posts } = await openFakePortal(browser);
  await prepareSearchForm(page);
  const result = await searchWithCaptcha(page, ' fnhr26107623401 ', 'ABC123');
  assert.equal(result.status, 'FOUND');
  assert.equal(result.applicationNo, 'FNHR26107623401');
  assert.equal(result.data.vehicleNo, 'HR31V0031');
  assert.equal(result.data.amount, '500');
  assert.equal(posts[0].get('selection'), '6');
  assert.equal(posts[0].get('Challan No./Application No.'), 'FNHR26107623401');
  assert.equal(posts[0].get('captcha'), 'ABC123');
  await page.close();
});

test('a rejected captcha is CAPTCHA_WRONG and the page offers a new image', async () => {
  const { page } = await openFakePortal(browser);
  await prepareSearchForm(page);
  const result = await searchWithCaptcha(page, 'FNHR26107623401', 'WRONG1');
  assert.equal(result.status, 'CAPTCHA_WRONG');
  assert.equal(result.applicationNo, 'FNHR26107623401');
  assert.match(await nextCaptcha(page, result), /^data:image\/png;base64,/);
  await page.close();
});

test('a no record banner is NOT_FOUND', async () => {
  const { page } = await openFakePortal(browser);
  await prepareSearchForm(page);
  assert.equal((await searchWithCaptcha(page, 'NOREC0001', 'ABC123')).status, 'NOT_FOUND');
  await page.close();
});

test('any other banner is a site error that carries the portal message', async () => {
  const { page } = await openFakePortal(browser);
  await prepareSearchForm(page);
  const result = await searchWithCaptcha(page, 'NOISE0001', 'ABC123');
  assert.equal(result.status, 'WEBSITE_ERROR');
  assert.match(result.message, /temporarily unavailable/);
  await page.close();
});

test('a second search is not answered with the banner left over from the first', async () => {
  const { page } = await openFakePortal(browser);
  await prepareSearchForm(page);
  assert.equal((await searchWithCaptcha(page, 'FNHR26107623401', 'WRONG1')).status, 'CAPTCHA_WRONG');
  const result = await searchWithCaptcha(page, 'FNHR26107623401', 'ABC123');
  assert.equal(result.status, 'FOUND');
  await page.close();
});

test('a number the portal would reject is INVALID_INPUT and nothing is sent', async () => {
  const { page, posts } = await openFakePortal(browser);
  await prepareSearchForm(page);
  assert.equal((await searchWithCaptcha(page, 'bad number!', 'ABC123')).status, 'INVALID_INPUT');
  assert.equal(posts.length, 0);
  await page.close();
});
