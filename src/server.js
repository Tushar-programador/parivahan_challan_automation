const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { searchTransaction, closeBrowser } = require('./automation');
const multer = require('multer');
const {
  MAX_BULK_ROWS,
  parseApplicationNumbers,
  normalizeBulkResult,
  processBulk,
  createCsv,
  createXlsx
} = require('./bulk');

const ACCESS_KEY = process.env.ACCESS_KEY || '';

// Optional shared key for /api. Set ACCESS_KEY when the service is reachable from the internet.
function requireAccessKey(req, res, next) {
  if (!ACCESS_KEY) return next();
  const given = Buffer.from(String(req.get('x-access-key') || ''));
  const wanted = Buffer.from(ACCESS_KEY);
  if (given.length === wanted.length && crypto.timingSafeEqual(given, wanted)) return next();
  return res.status(401).json({ status: 'UNAUTHORIZED', message: 'Enter the access key to use this service.' });
}

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', requireAccessKey);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/transaction/search', async (req, res) => {
  const applicationNo = req.body && req.body.applicationNo;

  if (!applicationNo || String(applicationNo).trim() === '') {
    return res.status(400).json({
      status: 'INVALID_INPUT',
      applicationNo: '',
      message: 'Application/Challan number is required.'
    });
  }

  // The UI's Stop button aborts the request; searches still queued behind it are skipped.
  let clientGone = false;
  res.on('close', () => { clientGone = !res.writableEnded; });

  try {
    const result = await searchTransaction(applicationNo, { cancelled: () => clientGone });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      status: 'WEBSITE_ERROR',
      applicationNo: String(applicationNo).trim(),
      message: `Unexpected server error: ${message}`
    });
  }
});

app.post('/api/transaction/bulk', upload.single('file'), async (req, res) => {
  try {
    const applicationNumbers = req.file
      ? parseApplicationNumbers(req.file.buffer.toString('utf8'))
      : req.body && req.body.applicationNos;

    if (!Array.isArray(applicationNumbers) || applicationNumbers.length === 0) {
      return res.status(400).json({
        status: 'INVALID_INPUT',
        message: 'Upload a CSV file in the "file" field or provide an applicationNos array.'
      });
    }
    if (applicationNumbers.length > MAX_BULK_ROWS) {
      return res.status(400).json({
        status: 'INVALID_INPUT',
        message: `Bulk searches are limited to ${MAX_BULK_ROWS} application numbers per request.`
      });
    }

    const results = await processBulk(applicationNumbers);
    const format = String(req.query.format || 'json').toLowerCase();

    if (format === 'csv') {
      res.type('text/csv');
      res.attachment('parivahan-transaction-results.csv');
      return res.send(createCsv(results));
    }
    if (format === 'xlsx') {
      const workbook = await createXlsx(results);
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.attachment('parivahan-transaction-results.xlsx');
      return res.send(Buffer.from(workbook));
    }
    if (format !== 'json') {
      return res.status(400).json({
        status: 'INVALID_INPUT',
        message: 'Unsupported export format. Choose json, csv, or xlsx.'
      });
    }

    return res.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ status: 'INVALID_INPUT', message });
  }
});

// Export results the UI already collected, without re-running the searches.
app.post('/api/export', async (req, res) => {
  const items = req.body && req.body.results;
  const format = String(req.query.format || 'csv').toLowerCase();
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BULK_ROWS) {
    return res.status(400).json({ status: 'INVALID_INPUT', message: 'Provide 1-100 results to export.' });
  }
  const results = items.map((item) => normalizeBulkResult(item || {}, (item && item.applicationNo) || ''));
  if (format === 'csv') {
    res.type('text/csv');
    res.attachment('parivahan-transaction-results.csv');
    return res.send(createCsv(results));
  }
  if (format === 'xlsx') {
    const workbook = await createXlsx(results);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.attachment('parivahan-transaction-results.xlsx');
    return res.send(Buffer.from(workbook));
  }
  return res.status(400).json({ status: 'INVALID_INPUT', message: 'Unsupported export format. Choose csv or xlsx.' });
});

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      status: 'INVALID_INPUT',
      message: `CSV upload rejected: ${error.message}`
    });
  }

  console.error('Unhandled API error:', error);
  return res.status(500).json({
    status: 'WEBSITE_ERROR',
    message: 'The server could not process the request.'
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Parivahan automation API running on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  server.close();
  closeBrowser().finally(() => process.exit(0));
});
