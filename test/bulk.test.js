const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {
  MAX_BULK_ROWS,
  parseApplicationNumbers,
  processBulk,
  createCsv,
  createXlsx
} = require('../src/bulk');

test('parses CSV with application number header and extra columns', () => {
  assert.deepEqual(
    parseApplicationNumbers('Application No,Notes\r\nFNHR26107623401,first\r\nFNHR26107623402,second\r\n'),
    ['FNHR26107623401', 'FNHR26107623402']
  );
});

test('parses a CSV containing only one number per row', () => {
  assert.deepEqual(
    parseApplicationNumbers('FNHR26107623401\nFNHR26107623402\n'),
    ['FNHR26107623401', 'FNHR26107623402']
  );
});

test('rejects empty and over-limit CSV input', () => {
  assert.throws(() => parseApplicationNumbers(' \r\n'), /empty/i);
  const overLimit = Array.from({ length: MAX_BULK_ROWS + 1 }, (_, index) => `FNHR${index}`).join('\n');
  assert.throws(() => parseApplicationNumbers(overLimit), /limited/i);
});

test('bulk validation emits invalid-input rows without opening a browser', async () => {
  const results = await processBulk(['bad value']);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'INVALID_INPUT');
  assert.equal(results[0].applicationNo, 'BAD VALUE');
});

test('CSV export quotes values and neutralizes spreadsheet formulas', () => {
  const csv = createCsv([{
    applicationNo: '=SUM(1,1)',
    status: 'FOUND',
    message: 'note, with "quotes"\nand newline'
  }]);
  assert.match(csv, /"'=SUM\(1,1\)"/);
  assert.match(csv, /"note, with ""quotes""\nand newline"/);
});

test('XLSX export creates a workbook with headers and text values', async () => {
  const buffer = await createXlsx([{
    applicationNo: '=1+1',
    status: 'FOUND',
    vehicleNo: 'HR31V0031'
  }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.getWorksheet('Transaction Results');
  assert.equal(worksheet.getCell('A1').value, 'Application No');
  assert.equal(worksheet.getCell('A2').value, "'=1+1");
  assert.equal(worksheet.getCell('C2').value, 'HR31V0031');
});
