const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const { chromium } = require('playwright');
const {
  isValidApplicationNumber,
  normalizeApplicationNumber,
  searchTransactionOnPage,
  LAUNCH_OPTIONS
} = require('./automation');

const MAX_BULK_ROWS = 1000;
const DEFAULT_DELAY_MS = 1000;
const RESULT_COLUMNS = [
  ['applicationNo', 'Application No'],
  ['status', 'Status'],
  ['vehicleNo', 'Vehicle No'],
  ['transactionNo', 'Transaction No/AUIN'],
  ['paymentId', 'Payment Id'],
  ['paymentDate', 'Payment Date'],
  ['paymentConfirmationDate', 'Payment Confirmation Date'],
  ['paymentGateway', 'Payment Gateway'],
  ['bankRefNo', 'Bank Ref No'],
  ['grn', 'GRN'],
  ['cin', 'CIN'],
  ['amount', 'Amount'],
  ['statusDescription', 'Status Description'],
  ['message', 'Message']
];

function parseApplicationNumbers(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) {
    throw new Error('The CSV file is empty.');
  }

  let records;
  try {
    records = parse(csvText, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (error) {
    throw new Error(`Could not parse CSV: ${error.message}`);
  }

  if (!records.length) {
    throw new Error('The CSV file does not contain any application numbers.');
  }

  const firstCell = normalizeApplicationNumber(records[0][0] || '').replace(/[^A-Z0-9]/g, '');
  const hasHeader = [
    'APPLICATIONNO',
    'APPLICATIONNUMBER',
    'CHALLANNO',
    'CHALLANNUMBER',
    'APPLICATIONCHALLANNO',
    'APPLICATIONCHALLANNUMBER',
    'CHALLANAPPLICATIONNO'
  ].includes(firstCell);
  const values = records.slice(hasHeader ? 1 : 0)
    .map((record) => String(record[0] || '').trim())
    .filter(Boolean);

  if (!values.length) {
    throw new Error('The CSV file does not contain any application numbers.');
  }
  if (values.length > MAX_BULK_ROWS) {
    throw new Error(`Bulk searches are limited to ${MAX_BULK_ROWS} application numbers per upload.`);
  }

  return values;
}

function normalizeBulkResult(result, submittedValue) {
  const data = result.data || {};
  return {
    applicationNo: result.applicationNo || normalizeApplicationNumber(submittedValue),
    status: result.status,
    vehicleNo: data.vehicleNo || '',
    transactionNo: data.transactionNo || '',
    paymentId: data.paymentId || '',
    paymentDate: data.paymentDate || '',
    paymentConfirmationDate: data.paymentConfirmationDate || '',
    paymentGateway: data.paymentGateway || '',
    bankRefNo: data.bankRefNo || '',
    grn: data.grn || '',
    cin: data.cin || '',
    amount: data.amount || '',
    statusDescription: data.statusDescription || '',
    message: result.message || ''
  };
}

async function processBulk(applicationNumbers, options = {}) {
  if (!Array.isArray(applicationNumbers) || applicationNumbers.length === 0) {
    throw new Error('Provide at least one application number.');
  }
  if (applicationNumbers.length > MAX_BULK_ROWS) {
    throw new Error(`Bulk searches are limited to ${MAX_BULK_ROWS} application numbers per request.`);
  }

  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const results = [];
  const validNumbers = applicationNumbers.some(isValidApplicationNumber);
  if (!validNumbers) {
    return applicationNumbers.map((value) => normalizeBulkResult({
      status: 'INVALID_INPUT',
      applicationNo: normalizeApplicationNumber(value),
      message: 'Application/Challan number must contain 6-50 letters, numbers, or hyphens.'
    }, value));
  }

  const browser = await chromium.launch(LAUNCH_OPTIONS);
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.setDefaultTimeout(30000);

    for (let index = 0; index < applicationNumbers.length; index += 1) {
      const submittedValue = applicationNumbers[index];
      const result = isValidApplicationNumber(submittedValue)
        ? await searchTransactionOnPage(page, submittedValue)
        : {
          status: 'INVALID_INPUT',
          applicationNo: normalizeApplicationNumber(submittedValue),
          message: 'Application/Challan number must contain 6-50 letters, numbers, or hyphens.'
        };
      results.push(normalizeBulkResult(result, submittedValue));

      if (index < applicationNumbers.length - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

function safeSpreadsheetValue(value) {
  const text = String(value ?? '');
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvEscape(value) {
  const text = safeSpreadsheetValue(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function createCsv(results) {
  const header = RESULT_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
  const rows = results.map((result) => RESULT_COLUMNS
    .map(([key]) => csvEscape(result[key]))
    .join(','));
  return `${[header, ...rows].join('\r\n')}\r\n`;
}

async function createXlsx(results) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Parivahan Transaction Automation';
  const worksheet = workbook.addWorksheet('Transaction Results');

  worksheet.columns = RESULT_COLUMNS.map(([key, header]) => ({
    header,
    key,
    width: Math.min(Math.max(header.length + 4, 16), 32)
  }));

  for (const result of results) {
    const row = {};
    for (const [key] of RESULT_COLUMNS) {
      row[key] = safeSpreadsheetValue(result[key]);
    }
    worksheet.addRow(row);
  }

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  DEFAULT_DELAY_MS,
  MAX_BULK_ROWS,
  RESULT_COLUMNS,
  parseApplicationNumbers,
  normalizeBulkResult,
  processBulk,
  createCsv,
  createXlsx
};
