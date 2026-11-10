const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createSessionStore, SessionError } = require('./sessions');
const { authRouter, requireAuth, sameOrigin, bodyParserErrorHandler } = require('./auth');
const { saveCaptchaImage } = require('./captcha-images');
const { normalizeApplicationNumber } = require('./automation');
const { createLookup } = require('./lookup');
const { runBatch } = require('./stream');
const { toClientResult, sanitizeResult, createClientSearch, SERVER_ERROR_MESSAGE } = require('./present');
const {
  MAX_BULK_ROWS,
  InvalidInputError,
  parseApplicationNumbers,
  normalizeBulkResult,
  createCsv,
  createXlsx
} = require('./bulk');

const SESSION_ERROR_STATUS = { NOT_FOUND: 404, BUSY: 409, TOO_MANY: 429 };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// The server log: stderr, unless LOG_LEVEL is "silent". Read on every call so a test can change it.
function defaultLog(message) {
  if (process.env.LOG_LEVEL !== 'silent') console.error(message);
}

function describeError(error) {
  try {
    return error instanceof Error ? (error.stack || error.message) : String(error);
  } catch {
    return 'unknown error';
  }
}

// True from the moment the client's connection closes before the response was finished. Lets a long search stop
// working for someone who is no longer there.
function trackClient(res) {
  let gone = false;
  res.on('close', () => { gone = !res.writableEnded; });
  return () => gone;
}

// Sends results as a download. Whatever the file is called inside, the download is always results.csv / results.xlsx.
async function sendDownload(res, format, results) {
  if (format === 'csv') {
    res.type('text/csv');
    res.attachment('results.csv');
    return res.send(createCsv(results));
  }
  const workbook = await createXlsx(results);
  res.type(XLSX_TYPE);
  res.attachment('results.xlsx');
  return res.send(Buffer.from(workbook));
}

// The attended (manual captcha) search routes, for an operator who types the captcha in the UI: the source wants a captcha
// for every search, so the UI shows the image from a session's browser page, a person types it, and the server submits
// it from that same page. They are mounted only when config.enableManualCaptcha is set. Their answers are raw, because
// they are an operator tool: they must stay off on any instance that clients can reach.
function manualCaptchaRoutes({ automation, report }) {
  const router = express.Router();
  const captchaSessions = createSessionStore();
  const imageDir = process.env.CAPTCHA_IMAGE_DIR || path.join(__dirname, '..', 'images');

  // Every captcha image sent to the UI is also saved to the image folder. Best effort: a full disk or a
  // locked folder is logged and must never stop a search.
  function keepCaptcha(image) {
    if (image) {
      saveCaptchaImage(image, imageDir).catch((error) => report(`Could not save the captcha image: ${error.message}`));
    }
    return image;
  }

  function sendSessionError(res, error, where) {
    if (error instanceof SessionError) {
      return res.status(SESSION_ERROR_STATUS[error.code]).json({ status: error.code, message: error.message });
    }
    report(`Unexpected error in ${where}: ${describeError(error)}`);
    return res.status(500).json({ status: 'ERROR', message: SERVER_ERROR_MESSAGE });
  }

  router.post('/session', async (_req, res) => {
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
      return sendSessionError(res, error, 'POST /api/captcha/session');
    }
  });

  router.post('/session/:id/refresh', async (req, res) => {
    try {
      return res.json({ captcha: keepCaptcha(await captchaSessions.use(req.params.id, automation.refreshCaptcha)) });
    } catch (error) {
      return sendSessionError(res, error, 'POST /api/captcha/session/:id/refresh');
    }
  });

  // Body: { applicationNo, captcha, next }. `next: false` says no number follows, so no new image is needed
  // (unless the captcha was wrong and the same number is tried again).
  router.post('/session/:id/search', async (req, res) => {
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
      return sendSessionError(res, error, 'POST /api/captcha/session/:id/search');
    }
  });

  router.delete('/session/:id', async (req, res) => {
    await captchaSessions.close(req.params.id);
    return res.status(204).end();
  });

  return { router, closeAll: () => captchaSessions.closeAll() };
}

// Builds the Express app without listening on a port, so tests can start it on any port.
// Routes read functions off `automation` at request time, so a test may pass a partial object.
// `users`, `sessions` (the login session store), `throttle` and `config` are required: without them there would
// be no sign-in, so the app refuses to be built rather than serve /api to everyone.
// Every number a client asks about goes through `lookup`: our own data first, the source only when needed. Pass `lookup`
// to replace it; by default it is built from `records` (the shared record store) and `automation.searchTransaction`.
// `log(message)` is where the real reason for a failure goes (default: stderr, silent when LOG_LEVEL=silent): a client
// is only ever told that something went wrong, never why.
function createApp({ automation = require('./automation'), users, sessions, throttle, config, records, lookup, log = defaultLog } = {}) {
  if (!users || !sessions || !throttle || !config) {
    throw new Error('createApp needs users, sessions, throttle and config');
  }
  if (!lookup && !records) {
    throw new Error('createApp needs records or a lookup');
  }

  // A logger that throws must never turn one failure into another.
  const report = (message) => {
    try {
      log(message);
    } catch {
      // nothing else can be done with it
    }
  };
  const lookupNumber = lookup || createLookup({
    records,
    search: (applicationNo, options) => automation.searchTransaction(applicationNo, options),
    finalBankStatuses: config.finalBankStatuses,
    log: report
  });

  // For a batch: a number whose lookup throws (it should never) is UNAVAILABLE for that number alone, and the real error
  // is logged, so one bad number never spoils the others and nothing of the error reaches the client.
  const forBatch = (search, where) => async (applicationNo) => {
    try {
      return await search(applicationNo);
    } catch (error) {
      const key = normalizeApplicationNumber(applicationNo);
      report(`Unexpected error in ${where} for ${key}: ${describeError(error)}`);
      return toClientResult({ status: 'WEBSITE_ERROR', applicationNo: key });
    }
  };

  // An error nobody expected: the client gets the fixed text and nothing else, the log gets the real error.
  const sendUnexpected = (res, error, where) => {
    report(`Unexpected error in ${where}: ${describeError(error)}`);
    return res.status(500).json({ status: 'ERROR', message: SERVER_ERROR_MESSAGE });
  };

  const app = express();
  app.set('trust proxy', config.trustProxy);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024, files: 1 }
  });

  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Everything under /api refuses a cross-origin write, and only /api/auth/* is reachable without signing in.
  // The large JSON parser exists only under /api and comes after the sign-in check, so nobody who is not signed in can
  // make the server read or parse a big body. (/api/auth has its own small parser, in the auth router.)
  app.use('/api', sameOrigin());
  app.use('/api/auth', authRouter({ users, sessions, throttle, cookieSecure: config.cookieSecure }));
  app.use('/api', requireAuth(sessions));
  app.use('/api', express.json({ limit: '5mb' }));

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
      const search = createClientSearch(lookupNumber, { userId: req.user.id, cancelled: trackClient(res) });
      return res.json(await search(applicationNo));
    } catch (error) {
      return sendUnexpected(res, error, 'POST /api/transaction/search');
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

    const cancelled = trackClient(res);
    const search = forBatch(createClientSearch(lookupNumber, { userId: req.user.id, cancelled }), 'POST /api/transaction/search-stream');

    res.type('application/x-ndjson');
    res.flushHeaders();
    try {
      await runBatch(applicationNos, search, (item) => {
        if (cancelled()) return false;
        res.write(`${JSON.stringify(item)}\n`);
        return true;
      });
    } catch (error) {
      // The answer has started, so there is no status left to send; the log has the reason.
      report(`Unexpected error in POST /api/transaction/search-stream: ${describeError(error)}`);
    }
    return res.end();
  });

  // Off unless the operator turned it on: otherwise these paths do not exist (404 like any other unknown path).
  let closeCaptchaSessions = async () => {};
  if (config.enableManualCaptcha) {
    const manual = manualCaptchaRoutes({ automation, report });
    app.use('/api/captcha', manual.router);
    closeCaptchaSessions = manual.closeAll;
  }

  app.post('/api/transaction/bulk', upload.single('file'), async (req, res) => {
    try {
      // The only errors answered with their own message are the ones about the CSV file the client sent.
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
      const format = String(req.query.format || 'json').toLowerCase();
      if (!['json', 'csv', 'xlsx'].includes(format)) {
        return res.status(400).json({
          status: 'INVALID_INPUT',
          message: 'Unsupported export format. Choose json, csv, or xlsx.'
        });
      }

      // The same path as search-stream, collected in input order instead of as each one finishes.
      const cancelled = trackClient(res);
      const search = forBatch(createClientSearch(lookupNumber, { userId: req.user.id, cancelled }), 'POST /api/transaction/bulk');
      const results = new Array(applicationNumbers.length);
      await runBatch(applicationNumbers, search, ({ index, result }) => {
        if (cancelled()) return false;
        results[index] = normalizeBulkResult(result, applicationNumbers[index]);
        return true;
      });
      if (cancelled()) return res.end();

      if (format === 'json') return res.json({ results });
      return await sendDownload(res, format, results);
    } catch (error) {
      if (error instanceof InvalidInputError) {
        return res.status(400).json({ status: 'INVALID_INPUT', message: error.message });
      }
      return sendUnexpected(res, error, 'POST /api/transaction/bulk');
    }
  });

  // Export results the UI already collected, without re-running the searches. The posted results are rebuilt from the
  // client vocabulary first, so a file only ever holds text this service wrote.
  app.post('/api/export', async (req, res) => {
    const items = req.body && req.body.results;
    const format = String(req.query.format || 'csv').toLowerCase();
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BULK_ROWS) {
      return res.status(400).json({ status: 'INVALID_INPUT', message: 'Provide 1-1000 results to export.' });
    }
    if (format !== 'csv' && format !== 'xlsx') {
      return res.status(400).json({ status: 'INVALID_INPUT', message: 'Unsupported export format. Choose csv or xlsx.' });
    }

    try {
      const results = items.map((item) => {
        const clean = sanitizeResult(item);
        return normalizeBulkResult(clean, clean.applicationNo);
      });
      return await sendDownload(res, format, results);
    } catch (error) {
      return sendUnexpected(res, error, 'POST /api/export');
    }
  });

  // Keep this after every /api route. It answers an unknown /api path without repeating the path back: that text would
  // be one more place for a client to read a word we do not want to say.
  app.use('/api', (_req, res) => {
    res.status(404).json({ status: 'NOT_FOUND', message: 'Not found.' });
  });

  // A body that could not be parsed is the caller's error (400/413), and is not logged: the error carries the raw body.
  app.use(bodyParserErrorHandler);

  app.use((error, _req, res, next) => {
    if (res.headersSent) {
      report(`Unhandled API error after the response started: ${describeError(error)}`);
      return next(error);
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        status: 'INVALID_INPUT',
        message: `CSV upload rejected: ${error.message}`
      });
    }

    return sendUnexpected(res, error, 'the API');
  });

  return { app, closeCaptchaSessions: () => closeCaptchaSessions() };
}

module.exports = { createApp, defaultLog };
