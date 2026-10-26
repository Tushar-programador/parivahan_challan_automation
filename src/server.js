const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  searchTransaction,
  closeBrowser,
  isValidCaptcha,
  openSearchPage,
  prepareSearchForm,
  refreshCaptcha,
  nextCaptcha,
  searchWithCaptcha
} = require('./automation');
const { createSessionStore, SessionError } = require('./sessions');
const multer = require('multer');
const { runBatch } = require('./stream');
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

app.use(express.json({ limit: '5mb' }));
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

  try {
    const result = await searchTransaction(applicationNo);
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

// Streams one JSON line per finished search ({ index, result }) so the UI needs only one connection,
// which gets around the browser's ~6 connections per host limit.
app.post('/api/transaction/search-stream', async (req, res) => {
  const applicationNos = req.body && req.body.applicationNos;
  if (!Array.isArray(applicationNos) || applicationNos.length === 0 || applicationNos.length > MAX_BULK_ROWS) {
    return res.status(400).json({
      status: 'INVALID_INPUT',
      message: `Provide 1-${MAX_BULK_ROWS} application numbers in applicationNos.`
    });
  }

  let clientGone = false;
  res.on('close', () => { clientGone = !res.writableEnded; });

  res.type('application/x-ndjson');
  res.flushHeaders();
  await runBatch(
    applicationNos,
    (applicationNo) => searchTransaction(applicationNo),
    (item) => {
      if (clientGone) return false;
      res.write(`${JSON.stringify(item)}\n`);
      return true;
    }
  );
  return res.end();
});

// Attended searches: the portal wants a captcha for every search, so the UI shows the image from a
// session's browser page, a person types it, and the server submits it from that same page.
const sessions = createSessionStore();
const SESSION_ERROR_STATUS = { NOT_FOUND: 404, BUSY: 409, TOO_MANY: 429 };

function sendSessionError(res, error) {
  if (error instanceof SessionError) {
    return res.status(SESSION_ERROR_STATUS[error.code]).json({ status: error.code, message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return res.status(500).json({ status: 'WEBSITE_ERROR', message: `Unexpected server error: ${message}` });
}

app.post('/api/captcha/session', async (_req, res) => {
  try {
    const { id, value } = await sessions.create(async () => {
      const page = await openSearchPage();
      try {
        return { page, value: await prepareSearchForm(page) };
      } catch (error) {
        await page.close().catch(() => {});
        throw error;
      }
    });
    return res.status(201).json({ sessionId: id, captcha: value });
  } catch (error) {
    return sendSessionError(res, error);
  }
});

app.post('/api/captcha/session/:id/refresh', async (req, res) => {
  try {
    return res.json({ captcha: await sessions.use(req.params.id, refreshCaptcha) });
  } catch (error) {
    return sendSessionError(res, error);
  }
});

// Body: { applicationNo, captcha, next }. `next: false` says no number follows, so no new image is needed
// (unless the captcha was wrong and the same number is tried again).
app.post('/api/captcha/session/:id/search', async (req, res) => {
  const { applicationNo, captcha, next } = req.body || {};
  if (!applicationNo || String(applicationNo).trim() === '') {
    return res.status(400).json({ status: 'INVALID_INPUT', applicationNo: '', message: 'Application/Challan number is required.' });
  }
  if (!isValidCaptcha(captcha)) {
    return res.status(400).json({
      status: 'INVALID_INPUT',
      applicationNo: String(applicationNo).trim(),
      message: 'Type the 6 letters or digits shown in the captcha image.'
    });
  }

  try {
    const payload = await sessions.use(req.params.id, async (page) => {
      const result = await searchWithCaptcha(page, applicationNo, captcha);
      if (next === false && result.status !== 'CAPTCHA_WRONG') return { result };
      // The search is already answered; failing to load the next image must not lose that answer.
      return { result, captcha: await nextCaptcha(page, result).catch(() => null) };
    });
    return res.json(payload);
  } catch (error) {
    return sendSessionError(res, error);
  }
});

app.delete('/api/captcha/session/:id', async (req, res) => {
  await sessions.close(req.params.id);
  return res.status(204).end();
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
    return res.status(400).json({ status: 'INVALID_INPUT', message: 'Provide 1-1000 results to export.' });
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
  sessions.closeAll().then(closeBrowser).finally(() => process.exit(0));
});
