const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createSessionStore, SessionError } = require('./sessions');
const { authRouter, requireAuth, sameOrigin } = require('./auth');
const { saveCaptchaImage } = require('./captcha-images');
const { runBatch } = require('./stream');
const {
  MAX_BULK_ROWS,
  parseApplicationNumbers,
  normalizeBulkResult,
  processBulk,
  createCsv,
  createXlsx
} = require('./bulk');

const SESSION_ERROR_STATUS = { NOT_FOUND: 404, BUSY: 409, TOO_MANY: 429 };

// Builds the Express app without listening on a port, so tests can start it on any port.
// Routes read functions off `automation` at request time, so a test may pass a partial object.
// `users`, `sessions` (the login session store), `throttle` and `config` are required: without them there would
// be no sign-in, so the app refuses to be built rather than serve /api to everyone.
function createApp({ automation = require('./automation'), users, sessions, throttle, config } = {}) {
  if (!users || !sessions || !throttle || !config) {
    throw new Error('createApp needs users, sessions, throttle and config');
  }

  const app = express();
  app.set('trust proxy', config.trustProxy);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024, files: 1 }
  });

  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Everything under /api refuses a cross-origin write, and only /api/auth/* is reachable without signing in.
  // The large JSON parser comes after the guard, so nobody unauthenticated can make the server read a big body.
  app.use('/api', sameOrigin());
  app.use('/api/auth', authRouter({ users, sessions, throttle, cookieSecure: config.cookieSecure }));
  app.use('/api', requireAuth(sessions));
  app.use(express.json({ limit: '5mb' }));

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
      const result = await automation.searchTransaction(applicationNo);
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
      (applicationNo) => automation.searchTransaction(applicationNo, { cancelled: () => clientGone }),
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
  const captchaSessions = createSessionStore();
  const CAPTCHA_IMAGE_DIR = process.env.CAPTCHA_IMAGE_DIR || path.join(__dirname, '..', 'images');

  // Every captcha image sent to the UI is also saved to CAPTCHA_IMAGE_DIR. Best effort: a full disk or a
  // locked folder is logged and must never stop a search.
  function keepCaptcha(image) {
    if (image) {
      saveCaptchaImage(image, CAPTCHA_IMAGE_DIR).catch((error) => console.error(`Could not save the captcha image: ${error.message}`));
    }
    return image;
  }

  function sendSessionError(res, error) {
    if (error instanceof SessionError) {
      return res.status(SESSION_ERROR_STATUS[error.code]).json({ status: error.code, message: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ status: 'WEBSITE_ERROR', message: `Unexpected server error: ${message}` });
  }

  app.post('/api/captcha/session', async (_req, res) => {
    try {
      const { id, value } = await captchaSessions.create(async () => {
        const page = await automation.openSearchPage();
        try {
          return { page, value: await automation.prepareSearchForm(page) };
        } catch (error) {
          await page.close().catch(() => {});
          throw error;
        }
      });
      return res.status(201).json({ sessionId: id, captcha: keepCaptcha(value) });
    } catch (error) {
      return sendSessionError(res, error);
    }
  });

  app.post('/api/captcha/session/:id/refresh', async (req, res) => {
    try {
      return res.json({ captcha: keepCaptcha(await captchaSessions.use(req.params.id, automation.refreshCaptcha)) });
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
    if (!automation.isValidCaptcha(captcha)) {
      return res.status(400).json({
        status: 'INVALID_INPUT',
        applicationNo: String(applicationNo).trim(),
        message: 'Type the 6 letters or digits shown in the captcha image.'
      });
    }

    try {
      const payload = await captchaSessions.use(req.params.id, async (page) => {
        const result = await automation.searchWithCaptcha(page, applicationNo, captcha);
        if (next === false && result.status !== 'CAPTCHA_WRONG') return { result };
        // The search is already answered; failing to load the next image must not lose that answer.
        return { result, captcha: keepCaptcha(await automation.nextCaptcha(page, result).catch(() => null)) };
      });
      return res.json(payload);
    } catch (error) {
      return sendSessionError(res, error);
    }
  });

  app.delete('/api/captcha/session/:id', async (req, res) => {
    await captchaSessions.close(req.params.id);
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

  return { app, closeCaptchaSessions: () => captchaSessions.closeAll() };
}

module.exports = { createApp };
