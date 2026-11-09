#!/usr/bin/env node

const crypto = require('node:crypto');
const { loadConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { createUserStore, UserError, normalizeUsername } = require('./users');

const GENERATED_PASSWORD_LENGTH = 16;
// No look-alike characters (0/O, 1/l/I), so a password read out or copied by hand is not misread.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const USAGE = [
  'Usage: npm run user -- <command>',
  '  create <username> [--password <pw>]   add a client (without --password a password is generated and shown once)',
  '  list                                  show every client and whether it is active',
  '  passwd <username> [--password <pw>]   set a new password and sign the client out everywhere',
  '  disable <username>                    block the client and sign it out everywhere',
  '  enable <username>                     let a disabled client in again'
];

function generatePassword() {
  let password = '';
  for (let i = 0; i < GENERATED_PASSWORD_LENGTH; i += 1) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

// Splits "<username> [--password <pw>]" style arguments. Returns null for anything unexpected.
function parseArgs(args, { allowPassword }) {
  let username;
  let password;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (allowPassword && arg === '--password') {
      i += 1;
      if (i >= args.length || password !== undefined) return null;
      password = args[i];
    } else if (arg.startsWith('--') || username !== undefined) {
      return null;
    } else {
      username = arg;
    }
  }
  return username === undefined ? null : { username, password };
}

function formatDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : String(value);
}

// Runs one admin command against the user store. print(line) receives every output line.
// Resolves to the process exit code: 0 on success, 1 for any problem. Output never includes a password or hash,
// except the single "Password: ..." line for a password this command generated.
async function runUserCli(args, { users, print = console.log }) {
  const [command, ...rest] = args;
  const usage = (code) => {
    USAGE.forEach((line) => print(line));
    return code;
  };

  if (command === 'help' || command === '--help' || command === '-h') return usage(0);

  try {
    switch (command) {
      case 'create': {
        const parsed = parseArgs(rest, { allowPassword: true });
        if (!parsed) return usage(1);
        const password = parsed.password === undefined ? generatePassword() : parsed.password;
        const user = await users.create(parsed.username, password);
        print(`Created user ${user.username}.`);
        if (parsed.password === undefined) print(`Password: ${password}`);
        return 0;
      }
      case 'list': {
        if (rest.length > 0) return usage(1);
        const all = await users.list();
        if (all.length === 0) {
          print('No users yet.');
          return 0;
        }
        const width = Math.max(8, ...all.map((user) => user.username.length));
        print(`${'ID'.padEnd(6)}${'USERNAME'.padEnd(width + 2)}${'STATUS'.padEnd(10)}CREATED`);
        for (const user of all) {
          print(`${String(user.id).padEnd(6)}${user.username.padEnd(width + 2)}${(user.isActive ? 'active' : 'disabled').padEnd(10)}${formatDate(user.createdAt)}`);
        }
        return 0;
      }
      case 'passwd': {
        const parsed = parseArgs(rest, { allowPassword: true });
        if (!parsed) return usage(1);
        const name = normalizeUsername(parsed.username);
        const password = parsed.password === undefined ? generatePassword() : parsed.password;
        if (!(await users.setPassword(parsed.username, password))) {
          print(`No user named ${name}.`);
          return 1;
        }
        print(`Password changed for ${name}. They are signed out everywhere.`);
        if (parsed.password === undefined) print(`Password: ${password}`);
        return 0;
      }
      case 'disable':
      case 'enable': {
        const parsed = parseArgs(rest, { allowPassword: false });
        if (!parsed) return usage(1);
        const name = normalizeUsername(parsed.username);
        const enabling = command === 'enable';
        if (!(await users.setActive(parsed.username, enabling))) {
          print(`No user named ${name}.`);
          return 1;
        }
        print(enabling ? `Enabled ${name}.` : `Disabled ${name}. They are signed out everywhere.`);
        return 0;
      }
      default:
        print(command === undefined ? 'No command given.' : `Unknown command: ${command}`);
        return usage(1);
    }
  } catch (error) {
    if (error instanceof UserError) {
      print(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function main() {
  let pool;
  let exitCode = 1;
  try {
    const config = loadConfig(process.env);
    pool = createPool(config);
    await migrate(pool);
    exitCode = await runUserCli(process.argv.slice(2), { users: createUserStore(pool), print: (line) => console.log(line) });
  } catch (error) {
    // Message only: no stack trace, and nothing from the connection string.
    console.error(`User command failed: ${error.message}`);
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  main();
}

module.exports = { runUserCli };
