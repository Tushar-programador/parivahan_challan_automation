const test = require('node:test');
const assert = require('node:assert/strict');
const { toResultPayload, isValidApplicationNumber, normalizeApplicationNumber } = require('../src/automation');

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
