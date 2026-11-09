const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool, types } = require('pg');

// node-pg returns int8 (bigserial ids, count(*)) as strings. Every id and count in this app is a JS number.
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function sslOption(databaseSsl) {
  if (databaseSsl === true) return { rejectUnauthorized: true };
  if (databaseSsl === 'no-verify') return { rejectUnauthorized: false };
  return undefined;
}

function createPool(config) {
  const options = { connectionString: config.databaseUrl };
  const ssl = sslOption(config.databaseSsl);
  if (ssl) options.ssl = ssl;
  const pool = new Pool(options);
  // An idle client can fail (for example when the database restarts). Without a listener that would crash the process.
  pool.on('error', (error) => {
    console.error(`[WARN] database connection error: ${error.message}`);
  });
  return pool;
}

// Applies every migrations/*.sql file that has not been applied yet, in name order, each in its own transaction.
// Resolves to the names applied by this call.
async function migrate(pool, dir = DEFAULT_MIGRATIONS_DIR) {
  // The existence check is explicit because pg-mem rejects "create table if not exists" with a primary key once the table exists.
  const { rows: existing } = await pool.query(
    "select 1 as present from information_schema.tables where table_schema = current_schema() and table_name = 'schema_migrations'"
  );
  if (existing.length === 0) {
    await pool.query('create table if not exists schema_migrations (name text primary key)');
  }
  const applied = new Set((await pool.query('select name from schema_migrations')).rows.map((row) => row.name));
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const ran = [];

  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await fs.readFile(path.join(dir, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
      ran.push(name);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return ran;
}

module.exports = { createPool, migrate };
