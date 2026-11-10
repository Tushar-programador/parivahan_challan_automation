const { normalizeApplicationNumber } = require('./automation');

// What a client may see of a lookup result. A lookup result is internal: it carries the raw statuses of the source, its
// messages, which route the answer took and the row ids. The service must look like one that simply has the data, so
// every client-facing route puts its answers through here, and nothing else reaches a client.
//
// The only statuses a client ever sees are FOUND, NOT_FOUND, INVALID_INPUT and UNAVAILABLE, and every message is one of
// the fixed texts below, never text taken from a result. The data values of a FOUND are text taken from the source, so a
// value that names the source is blanked too (SOURCE_VALUE).
const UNAVAILABLE_MESSAGE = 'We could not get this one right now. Please try again in a little while.';
const INVALID_INPUT_MESSAGE = 'Enter 6-50 letters, numbers or hyphens.';
const SERVER_ERROR_MESSAGE = 'Something went wrong. Please try again.';

// The only fields of a record a client ever sees, in display order. Everything else on a record is dropped.
const DATA_FIELDS = [
  'vehicleNo',
  'transactionNo',
  'paymentId',
  'paymentDate',
  'paymentConfirmationDate',
  'paymentGateway',
  'bankRefNo',
  'grn',
  'cin',
  'amount',
  'bankStatus',
  'statusDescription'
];

// A data value that holds one of the source's words, or a URL, is not shown to a client: the whole value becomes ''. This is
// the one place the list is written down. It matches anywhere in the value, in any case.
const SOURCE_VALUE = /parivahan|vahan|portal|captcha|gov\.in|playwright|chromium|ddddocr|https?:\/\//i;

const text = (value) => String(value ?? '');
const isObject = (value) => value !== null && typeof value === 'object';

// The whitelisted fields of `source` (a stored record, or the `data` of a result a client posted back), each as text. A
// value that matches SOURCE_VALUE is replaced as a whole by '' (never edited in part), and `log` is told once for each,
// with what it was: the client sees nothing of it, the operator can. `source` itself is never changed. `applicationNo` is
// only there to name the number in that line.
function toClientData(source, { applicationNo = '', log = () => {} } = {}) {
  const from = isObject(source) ? source : {};
  const data = {};
  for (const field of DATA_FIELDS) {
    const value = text(from[field]);
    if (SOURCE_VALUE.test(value)) {
      log(`Redacted client data field ${field} for ${applicationNo}: ${value}`);
      data[field] = '';
    } else {
      data[field] = value;
    }
  }
  return data;
}

// An ISO 8601 string for a Date, or for a date written as text or as milliseconds; null for anything else.
function toIsoDate(value) {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const unavailable = (applicationNo) => ({ status: 'UNAVAILABLE', applicationNo, message: UNAVAILABLE_MESSAGE });

// LookupResult -> ClientResult. Anything that is not a clear FOUND, NOT_FOUND or INVALID_INPUT, whatever its status says
// (TIMEOUT, WEBSITE_ERROR, CAPTCHA_REQUIRED, CANCELLED, a status nobody has heard of, no result at all), is UNAVAILABLE.
// A FOUND without a record, or whose record has no usable lastFoundAt, is UNAVAILABLE too: the "as of" date is never made
// up, so a client is never told that old data is fresh.
//
// `log` (optional) is for the operator and never reaches a client. It is told, once each, about every data value that was
// blanked (see toClientData) and about a FOUND that could not be presented and became UNAVAILABLE: that one would otherwise
// be a silent drop, because the lookup service counts it as a success. The result is not changed by logging, and nothing
// that is given is changed either.
function toClientResult(result, { log = () => {} } = {}) {
  const source = isObject(result) ? result : {};
  const applicationNo = text(source.applicationNo);

  switch (source.status) {
    case 'FOUND': {
      const record = isObject(source.record) ? source.record : null;
      const asOf = record ? toIsoDate(record.lastFoundAt) : null;
      if (!asOf) {
        log(`Found result for ${applicationNo} could not be presented: ${record ? 'no usable lastFoundAt' : 'no record'}`);
        return unavailable(applicationNo);
      }
      const number = applicationNo || text(record.applicationNo);
      return { status: 'FOUND', applicationNo: number, data: toClientData(record, { applicationNo: number, log }), asOf };
    }
    case 'NOT_FOUND':
      return { status: 'NOT_FOUND', applicationNo };
    case 'INVALID_INPUT':
      return { status: 'INVALID_INPUT', applicationNo, message: INVALID_INPUT_MESSAGE };
    default:
      return unavailable(applicationNo);
  }
}

// A result a client posted back (to be exported), rebuilt from the client vocabulary: a status that is not ours is
// UNAVAILABLE, every message is one of ours, and a FOUND keeps only the whitelisted data fields, with a value that names
// the source blanked exactly as in toClientResult. The posted number and the other data values are the client's own text,
// and are written as posted. `log` is optional, as in toClientResult.
function sanitizeResult(item, { log = () => {} } = {}) {
  const source = isObject(item) ? item : {};
  if (source.status === 'FOUND') {
    const applicationNo = text(source.applicationNo);
    return { status: 'FOUND', applicationNo, data: toClientData(source.data, { applicationNo, log }) };
  }
  return toClientResult({ status: source.status, applicationNo: source.applicationNo }, { log });
}

// Wraps a lookup function for one signed-in user: (applicationNo) -> Promise<ClientResult>. The lookup gets the user, the
// way to tell that the client has left and the owner the search is scheduled under. Once the client is gone no lookup is
// made at all; the answer is CANCELLED, which a client would see as UNAVAILABLE (but nobody is left to see it).
// A lookup that throws makes this reject, so the caller decides what the client sees. `log` (optional) is given to the
// presenter, which tells it what it blanked or could not present.
function createClientSearch(lookup, { userId, cancelled = () => false, log = () => {} }) {
  return async function searchForClient(applicationNo) {
    if (cancelled()) return toClientResult({ status: 'CANCELLED', applicationNo: normalizeApplicationNumber(applicationNo) }, { log });
    return toClientResult(await lookup(userId, applicationNo, { cancelled, owner: userId }), { log });
  };
}

module.exports = {
  UNAVAILABLE_MESSAGE,
  INVALID_INPUT_MESSAGE,
  SERVER_ERROR_MESSAGE,
  DATA_FIELDS,
  toClientData,
  toClientResult,
  sanitizeResult,
  createClientSearch
};
