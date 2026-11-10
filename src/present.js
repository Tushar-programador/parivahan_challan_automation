const { normalizeApplicationNumber } = require('./automation');

// What a client may see of a lookup result. A lookup result is internal: it carries the raw statuses of the source, its
// messages, which route the answer took and the row ids. The service must look like one that simply has the data, so
// every client-facing route puts its answers through here, and nothing else reaches a client.
//
// The only statuses a client ever sees are FOUND, NOT_FOUND, INVALID_INPUT and UNAVAILABLE, and every message is one of
// the fixed texts below, never text taken from a result.
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

const text = (value) => String(value ?? '');
const isObject = (value) => value !== null && typeof value === 'object';

// The whitelisted fields of `source` (a stored record, or the `data` of a result a client posted back), each as text.
function toClientData(source) {
  const from = isObject(source) ? source : {};
  const data = {};
  for (const field of DATA_FIELDS) data[field] = text(from[field]);
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
function toClientResult(result) {
  const source = isObject(result) ? result : {};
  const applicationNo = text(source.applicationNo);

  switch (source.status) {
    case 'FOUND': {
      const record = isObject(source.record) ? source.record : null;
      const asOf = record ? toIsoDate(record.lastFoundAt) : null;
      if (!asOf) return unavailable(applicationNo);
      return { status: 'FOUND', applicationNo: applicationNo || text(record.applicationNo), data: toClientData(record), asOf };
    }
    case 'NOT_FOUND':
      return { status: 'NOT_FOUND', applicationNo };
    case 'INVALID_INPUT':
      return { status: 'INVALID_INPUT', applicationNo, message: INVALID_INPUT_MESSAGE };
    default:
      return unavailable(applicationNo);
  }
}

// A result a client posted back (to be exported), rebuilt from the client vocabulary only: a status that is not ours is
// UNAVAILABLE, every message is one of ours, and a FOUND keeps only the whitelisted data fields. A file can therefore
// only ever hold text this service wrote, whatever was posted.
function sanitizeResult(item) {
  const source = isObject(item) ? item : {};
  if (source.status === 'FOUND') {
    return { status: 'FOUND', applicationNo: text(source.applicationNo), data: toClientData(source.data) };
  }
  return toClientResult({ status: source.status, applicationNo: source.applicationNo });
}

// Wraps a lookup function for one signed-in user: (applicationNo) -> Promise<ClientResult>. The lookup gets the user, the
// way to tell that the client has left and the owner the search is scheduled under. Once the client is gone no lookup is
// made at all; the answer is CANCELLED, which a client would see as UNAVAILABLE (but nobody is left to see it).
// A lookup that throws makes this reject, so the caller decides what the client sees.
function createClientSearch(lookup, { userId, cancelled = () => false }) {
  return async function searchForClient(applicationNo) {
    if (cancelled()) return toClientResult({ status: 'CANCELLED', applicationNo: normalizeApplicationNumber(applicationNo) });
    return toClientResult(await lookup(userId, applicationNo, { cancelled, owner: userId }));
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
