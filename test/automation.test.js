const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toResultPayload,
  isValidApplicationNumber,
  normalizeApplicationNumber,
  isValidCaptcha,
  classifyMessage,
  searchTransaction
} = require('../src/automation');

test('maps website columns to normalized fields and ignores unknown ones', () => {
  const headers = ['Sl No', 'Vehicle No', 'Application No', 'Transaction No/AUIN', 'Payment Id', 'Payment Conf Date', 'Bank Ref.No', 'Brand New Column'];
  const row = ['1', 'HR31V0031', 'FNHR1', 'HRZ1', 'FNHR1', '2026-10-02', '1100', 'x'];
  const payload = toResultPayload(row, headers);
  assert.equal(payload.vehicleNo, 'HR31V0031');
  assert.equal(payload.transactionNo, 'HRZ1');
  assert.equal(payload.paymentConfirmationDate, '2026-10-02');
  assert.equal(payload.bankRefNo, '1100');
});

test('validates and normalizes application numbers', () => {
  assert.equal(normalizeApplicationNumber('  fnhr26107623401 '), 'FNHR26107623401');
  assert.equal(isValidApplicationNumber('FNHR26107623401'), true);
  assert.equal(isValidApplicationNumber('ab'), false);
  assert.equal(isValidApplicationNumber('bad number!'), false);
});

test('accepts only the six letters or digits the portal captcha uses', () => {
  assert.equal(isValidCaptcha('EE5GHK'), true);
  assert.equal(isValidCaptcha('ee5ghk'), true);
  assert.equal(isValidCaptcha('EE5GH'), false);
  assert.equal(isValidCaptcha('EE5GHKX'), false);
  assert.equal(isValidCaptcha('EE5 GH'), false);
  assert.equal(isValidCaptcha(''), false);
  assert.equal(isValidCaptcha(undefined), false);
});

test('recognises the wrong captcha banner the portal shows', () => {
  assert.equal(classifyMessage('⚠\nInvalid CAPTCHA. Please enter the correct CAPTCHA.'), 'CAPTCHA_WRONG');
});

test('treats a no record message as not found', () => {
  assert.equal(classifyMessage('⚠ No record found for the given details.'), 'NOT_FOUND');
});

test('reports any other portal message as a site error, and never guesses not found from nothing', () => {
  assert.equal(classifyMessage('⚠ Service is temporarily unavailable.'), 'WEBSITE_ERROR');
  assert.equal(classifyMessage(''), 'WEBSITE_ERROR');
});

test('a search with no captcha step answers CAPTCHA_REQUIRED without opening a browser', async () => {
  const result = await searchTransaction('fnhr26107623401');
  assert.equal(result.status, 'CAPTCHA_REQUIRED');
  assert.equal(result.applicationNo, 'FNHR26107623401');
  assert.match(result.message, /web UI/i);
});

test('a search with no captcha step still rejects a malformed number first', async () => {
  const result = await searchTransaction('bad number!');
  assert.equal(result.status, 'INVALID_INPUT');
});
