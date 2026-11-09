const crypto = require('node:crypto');
// Used as passwords.<name>() so the calls can be observed in tests.
const passwords = require('./passwords');

const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;
const MIN_PASSWORD_LENGTH = 10;
const UNIQUE_VIOLATION = '23505';

// code is 'INVALID' (bad username or password) or 'EXISTS' (username already taken). The message is safe to show.
class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

// Usernames are stored trimmed and lowercase. Anything that is not a string normalizes to '' (which is never valid).
function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function requireValidUsername(username) {
  const name = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(name)) {
    throw new UserError('INVALID', 'Username must be 3-40 characters: letters, numbers, dots, underscores or hyphens.');
  }
  return name;
}

function requireValidPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError('INVALID', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return password;
}

// Runs fn(client) in one transaction, so a password or status change and the session revocation that goes with it
// happen together or not at all.
async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createUserStore(pool) {
  // A real hash of a random password nobody knows. authenticate checks the supplied password against it when the
  // user does not exist, so an unknown username costs the same time as a wrong password. It is started now so the
  // first unknown-username attempt is not slower than the rest.
  const dummyHash = passwords.hashPassword(crypto.randomBytes(24).toString('base64'));
  dummyHash.catch(() => {}); // a failure is surfaced by authenticate, not as an unhandled rejection

  return {
    async create(username, password) {
      const name = requireValidUsername(username);
      requireValidPassword(password);
      const hash = await passwords.hashPassword(password);
      try {
        const { rows } = await pool.query('insert into users (username, password_hash) values ($1, $2) returning id, username', [name, hash]);
        return { id: rows[0].id, username: rows[0].username };
      } catch (error) {
        if (error.code === UNIQUE_VIOLATION) throw new UserError('EXISTS', `A user named "${name}" already exists.`);
        throw error;
      }
    },

    // Returns {id, username, passwordHash}, or null for an unknown user, a wrong password or an inactive user. Never
    // says which. Every path does exactly one password check, so timing reveals neither which usernames exist nor who
    // is disabled.
    // passwordHash is the stored scrypt string. It is for the caller to hand straight to sessions.create, which only
    // opens a session while that is still the user's hash. It must never be sent to a client or written to a log.
    async authenticate(username, password) {
      const name = normalizeUsername(username);
      let row;
      if (name) {
        row = (await pool.query('select id, username, password_hash, is_active from users where username = $1', [name])).rows[0];
      }
      const matches = await passwords.verifyPassword(password, row ? row.password_hash : await dummyHash);
      if (!row || !matches || !row.is_active) return null;
      return { id: row.id, username: row.username, passwordHash: row.password_hash };
    },

    // Only active users; a disabled user's still-open session stops working here.
    async getById(id) {
      const userId = typeof id === 'number' || (typeof id === 'string' && /^\d{1,15}$/.test(id)) ? Number(id) : NaN;
      if (!Number.isSafeInteger(userId) || userId < 1) return null;
      const { rows } = await pool.query('select id, username from users where id = $1 and is_active = true', [userId]);
      return rows[0] ? { id: rows[0].id, username: rows[0].username } : null;
    },

    // Replaces the password and signs the user out everywhere. False when there is no such user.
    async setPassword(username, password) {
      requireValidPassword(password);
      const name = normalizeUsername(username);
      const hash = await passwords.hashPassword(password);
      return inTransaction(pool, async (client) => {
        const { rows } = await client.query('update users set password_hash = $1 where username = $2 returning id', [hash, name]);
        if (rows.length === 0) return false;
        await client.query('delete from sessions where user_id = $1', [rows[0].id]);
        return true;
      });
    },

    // Disabling and enabling both sign the user out everywhere: disabling so no session outlives it, enabling so that
    // a session a racing login slipped in while the user was disabled does not come back to life. False when there is
    // no such user.
    async setActive(username, active) {
      if (typeof active !== 'boolean') throw new TypeError('active must be true or false');
      const name = normalizeUsername(username);
      return inTransaction(pool, async (client) => {
        const { rows } = await client.query('update users set is_active = $1 where username = $2 returning id', [active, name]);
        if (rows.length === 0) return false;
        await client.query('delete from sessions where user_id = $1', [rows[0].id]);
        return true;
      });
    },

    async list() {
      const { rows } = await pool.query('select id, username, is_active, created_at from users order by id');
      return rows.map((row) => ({ id: row.id, username: row.username, isActive: row.is_active, createdAt: row.created_at }));
    }
  };
}

module.exports = { createUserStore, UserError, normalizeUsername };
