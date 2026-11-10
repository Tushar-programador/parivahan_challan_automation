const { normalizeApplicationNumber, isValidApplicationNumber } = require('./automation');

// Raw statuses that are an ordinary answer, not a failure of the source.
const NOT_FAILURES = new Set(['FOUND', 'NOT_FOUND', 'INVALID_INPUT']);

const text = (value) => String(value ?? '');
const statusKey = (value) => text(value).trim().toUpperCase();

function describe(error) {
  try {
    return (error && error.message) || String(error);
  } catch {
    return 'unknown error';
  }
}

const found = (applicationNo, record, source) => ({ status: 'FOUND', applicationNo, record, source });

// A StoredRecord built from live data, for the rare case where the live search found it but it could not be saved or
// linked. It has the stored field names, and no id: it is not a row.
function recordFromLive(applicationNo, data) {
  const now = new Date();
  return {
    applicationNo,
    vehicleNo: text(data.vehicleNo),
    transactionNo: text(data.transactionNo),
    paymentId: text(data.paymentId),
    paymentDate: text(data.paymentDate),
    paymentConfirmationDate: text(data.paymentConfirmationDate),
    paymentGateway: text(data.paymentGateway),
    bankRefNo: text(data.bankRefNo),
    grn: text(data.grn),
    cin: text(data.cin),
    amount: text(data.amount),
    bankStatus: text(data.status),
    statusDescription: text(data.statusDescription),
    firstFoundAt: now,
    lastFoundAt: now
  };
}

// Answers "what is the transaction for this number?" from our own data first and from the live source only when
// needed: a stored record in a final status is served as it is, anything else is searched again, and when the source
// cannot answer a number we already hold, the held record is served (as 'stale') instead of an error.
//
// The returned function never throws or rejects: every failure is logged through `log` and turned into a result. The
// result is internal (raw source statuses allowed); a presenter maps it to what a client may see. Its `source`
// ('stored' | 'live' | 'stale') is internal too.
function createLookup({ records, search, finalBankStatuses = ['SUCCESS'], log = console.error }) {
  const finals = new Set(finalBankStatuses.map(statusKey));
  // An empty or missing bankStatus is never final, even if the list holds an empty entry.
  const isFinal = (record) => {
    const key = statusKey(record.bankStatus);
    return key !== '' && finals.has(key);
  };

  // A logger that throws must not turn a lookup into a rejection.
  const report = (message) => {
    try {
      log(message);
    } catch {
      // nothing else to do with it
    }
  };

  // Records that this user asked for this record. When it fails the record is still served: we hold the answer, and a
  // lost link is a smaller problem for the client than no answer.
  async function link(userId, record, key) {
    try {
      await records.link(userId, record.id);
    } catch (error) {
      report(`Could not link ${key} to the user: ${describe(error)}`);
    }
  }

  // The shared record, or null. A failing store is treated as holding nothing, so the source can still answer.
  async function getStored(key) {
    try {
      return (await records.get(key)) || null;
    } catch (error) {
      report(`Could not read ${key} from the store: ${describe(error)}`);
      return null;
    }
  }

  // The raw answer of the live source, with every failure logged once. A search that throws, or answers with
  // something unusable, is a WEBSITE_ERROR.
  async function searchLive(key, options) {
    const failed = (reason) => {
      report(`Lookup of ${key} failed: ${reason}`);
      return { status: 'WEBSITE_ERROR', applicationNo: key };
    };

    let result;
    try {
      result = await search(key, options);
    } catch (error) {
      return failed(describe(error));
    }
    if (!result || typeof result !== 'object' || typeof result.status !== 'string') return failed('the search returned no result');
    if (result.status === 'FOUND' && !result.data) return failed('the search returned FOUND without data');

    if (!NOT_FAILURES.has(result.status)) {
      report(`Lookup of ${key} ended as ${result.status}${result.message ? `: ${result.message}` : ''}`);
    }
    return result;
  }

  // A live FOUND is saved into the shared store and linked to the user. If that fails, the client still gets the answer.
  async function keepLive(userId, key, result) {
    try {
      const saved = await records.saveFound({ ...result, applicationNo: key });
      if (!saved) throw new Error('the record was not saved');
      await records.link(userId, saved.id);
      return found(key, saved, 'live');
    } catch (error) {
      report(`Could not keep ${key}: ${describe(error)}`);
      return found(key, recordFromLive(key, result.data), 'live');
    }
  }

  async function run(userId, key, { cancelled, owner }) {
    if (!isValidApplicationNumber(key)) return { status: 'INVALID_INPUT', applicationNo: key };

    const stored = await getStored(key);
    if (stored && isFinal(stored)) {
      await link(userId, stored, key);
      return found(key, stored, 'stored');
    }

    const result = await searchLive(key, { cancelled, owner });
    if (result.status === 'FOUND') return keepLive(userId, key, result);

    if (stored) {
      await link(userId, stored, key);
      return found(key, stored, 'stale');
    }
    return result;
  }

  return async function lookup(userId, applicationNo, options) {
    let key = '';
    try {
      key = normalizeApplicationNumber(applicationNo);
      return await run(userId, key, options || {});
    } catch (error) {
      report(`Lookup of ${key} failed unexpectedly: ${describe(error)}`);
      return { status: 'WEBSITE_ERROR', applicationNo: key };
    }
  };
}

module.exports = { createLookup };
