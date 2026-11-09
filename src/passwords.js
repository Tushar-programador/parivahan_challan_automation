const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// scrypt cost. N=16384, r=8, p=1 needs 16 MB, inside Node's default 32 MB limit, and takes tens of milliseconds.
const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const PREFIX = 'scrypt';

function isPowerOfTwo(value) {
  return value >= 2 && (value & (value - 1)) === 0;
}

// Decodes strict base64: anything Buffer would silently skip or repair is rejected, so a corrupted value cannot verify.
function decodeBase64(text) {
  if (typeof text !== 'string' || text === '') return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === text ? bytes : null;
}

// Hashes a password for storage as scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>. A fresh random salt makes every hash differ.
async function hashPassword(plain) {
  if (typeof plain !== 'string') throw new TypeError('password must be a string');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(plain, salt, KEY_BYTES, { N, r: R, p: P });
  return [PREFIX, N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

// Reads a stored value back into its parts, or null when it is not one we wrote. The cost parameters come from the
// stored value, so older hashes keep verifying after the constants above change.
function parseStored(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [n, r, p] = parts.slice(1, 4).map((part) => (/^[1-9]\d{0,9}$/.test(part) ? Number(part) : NaN));
  if (!isPowerOfTwo(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return null;
  const salt = decodeBase64(parts[4]);
  const hash = decodeBase64(parts[5]);
  if (!salt || !hash) return null;
  return { n, r, p, salt, hash };
}

// True only for the right password. A malformed stored value, a non-string password or any scrypt failure
// (for example cost parameters that need more memory than allowed) is just false, never a throw.
async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string') return false;
  const parsed = parseStored(stored);
  if (!parsed) return false;
  try {
    const key = await scrypt(plain, parsed.salt, parsed.hash.length, { N: parsed.n, r: parsed.r, p: parsed.p });
    // Both buffers are parsed.hash.length bytes, so timingSafeEqual cannot throw on a length mismatch.
    return crypto.timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
