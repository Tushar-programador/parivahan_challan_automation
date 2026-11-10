const { normalizeApplicationNumber } = require('./automation');

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_EXPORT_LIMIT = 50000;

const COLUMNS = [
  'id', 'application_no', 'vehicle_no', 'transaction_no', 'payment_id', 'payment_date', 'payment_confirmation_date',
  'payment_gateway', 'bank_ref_no', 'grn', 'cin', 'amount', 'bank_status', 'status_description', 'first_found_at', 'last_found_at'
];
const RECORD_COLUMNS = COLUMNS.join(', ');
const JOINED_RECORD_COLUMNS = COLUMNS.map((column) => `records.${column}`).join(', ');

// The record is the shared copy; the date columns stay the JS Dates that pg returns.
function toStoredRecord(row) {
  return {
    id: row.id,
    applicationNo: row.application_no,
    vehicleNo: row.vehicle_no,
    transactionNo: row.transaction_no,
    paymentId: row.payment_id,
    paymentDate: row.payment_date,
    paymentConfirmationDate: row.payment_confirmation_date,
    paymentGateway: row.payment_gateway,
    bankRefNo: row.bank_ref_no,
    grn: row.grn,
    cin: row.cin,
    amount: row.amount,
    bankStatus: row.bank_status,
    statusDescription: row.status_description,
    firstFoundAt: row.first_found_at,
    lastFoundAt: row.last_found_at
  };
}

const text = (value) => String(value ?? '');

// "%", "_" and the escape character itself are plain characters in a search, never wildcards. The result is bound as a
// query parameter (LIKE's default escape character is the backslash); q is never part of the SQL text.
function searchPattern(q) {
  const escaped = text(q).trim().replace(/[\\%_]/g, '\\$&');
  return `%${escaped}%`;
}

function countOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// Both list and all read the same thing: this user's linked records that match the search. Binding order is
// $1 user, $2 pattern. Newest-requested first; the record id breaks ties so paging is stable.
const LINKED_FROM_WHERE = `
  from client_records
  join records on records.id = client_records.record_id
  where client_records.user_id = $1
    and (records.application_no ilike $2 or records.vehicle_no ilike $2)`;
const LINKED_ORDER = 'order by client_records.last_requested_at desc, records.id desc';

// The store for found results. Records are shared: one row per application number for everyone, written only by a
// successful lookup. A client sees a record only through a client_records link of their own, so every method that
// takes a userId is scoped by it. get and saveFound are not, by design: they are for the lookup service, and no route
// may expose them directly.
function createRecordStore(pool) {
  return {
    // The shared record for an application number (trimmed, upper case), or null.
    async get(applicationNo) {
      const key = normalizeApplicationNumber(applicationNo);
      if (!key) return null;
      const { rows } = await pool.query(`select ${RECORD_COLUMNS} from records where application_no = $1`, [key]);
      return rows[0] ? toStoredRecord(rows[0]) : null;
    },

    // Stores a FOUND result with data, and nothing else (any other result returns null without using the database).
    // One row per application number: a repeat overwrites every field and moves last_found_at; first_found_at stays.
    // The upsert is one statement, so two lookups finishing together for one number leave one row.
    async saveFound(result) {
      if (!result || result.status !== 'FOUND' || !result.data) return null;
      const data = result.data;
      const applicationNo = normalizeApplicationNumber(result.applicationNo) || normalizeApplicationNumber(data.applicationNo);
      if (!applicationNo) return null;

      const { rows } = await pool.query(
        `insert into records (application_no, vehicle_no, transaction_no, payment_id, payment_date, payment_confirmation_date,
           payment_gateway, bank_ref_no, grn, cin, amount, bank_status, status_description)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict (application_no) do update set
           vehicle_no = excluded.vehicle_no,
           transaction_no = excluded.transaction_no,
           payment_id = excluded.payment_id,
           payment_date = excluded.payment_date,
           payment_confirmation_date = excluded.payment_confirmation_date,
           payment_gateway = excluded.payment_gateway,
           bank_ref_no = excluded.bank_ref_no,
           grn = excluded.grn,
           cin = excluded.cin,
           amount = excluded.amount,
           bank_status = excluded.bank_status,
           status_description = excluded.status_description,
           last_found_at = now()
         returning ${RECORD_COLUMNS}`,
        [
          applicationNo,
          text(data.vehicleNo),
          text(data.transactionNo),
          text(data.paymentId),
          text(data.paymentDate),
          text(data.paymentConfirmationDate),
          text(data.paymentGateway),
          text(data.bankRefNo),
          text(data.grn),
          text(data.cin),
          text(data.amount),
          text(data.status),
          text(data.statusDescription)
        ]
      );
      return toStoredRecord(rows[0]);
    },

    // Records that the user has asked for this record, now. Calling it again only moves last_requested_at.
    async link(userId, recordId) {
      await pool.query(
        `insert into client_records (user_id, record_id) values ($1, $2)
         on conflict (user_id, record_id) do update set last_requested_at = now()`,
        [userId, recordId]
      );
    },

    // One page of the user's linked records, newest-requested first. total is the number of matches, not of the page.
    async list(userId, { q = '', limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
      const pattern = searchPattern(q);
      const { rows } = await pool.query(
        `select ${JOINED_RECORD_COLUMNS}${LINKED_FROM_WHERE}
         ${LINKED_ORDER}
         limit $3 offset $4`,
        [userId, pattern, countOr(limit, DEFAULT_PAGE_SIZE), countOr(offset, 0)]
      );
      const { rows: counted } = await pool.query(`select count(*) as n${LINKED_FROM_WHERE}`, [userId, pattern]);
      return { items: rows.map(toStoredRecord), total: counted[0].n };
    },

    // Every linked record of the user (up to limit), in the same order as list. For the export.
    async all(userId, { q = '', limit = DEFAULT_EXPORT_LIMIT } = {}) {
      const { rows } = await pool.query(
        `select ${JOINED_RECORD_COLUMNS}${LINKED_FROM_WHERE}
         ${LINKED_ORDER}
         limit $3`,
        [userId, searchPattern(q), countOr(limit, DEFAULT_EXPORT_LIMIT)]
      );
      return rows.map(toStoredRecord);
    },

    // Removes only this user's link; the shared record stays for everyone else. True when a link was removed.
    async unlink(userId, recordId) {
      const { rowCount } = await pool.query('delete from client_records where user_id = $1 and record_id = $2', [userId, recordId]);
      return rowCount > 0;
    }
  };
}

module.exports = { createRecordStore };
