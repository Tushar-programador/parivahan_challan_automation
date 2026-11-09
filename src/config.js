// An unset or empty variable means "use the default". Any other value that is not recognised is an operator
// mistake in a security-relevant setting, so it throws (naming the variable, never echoing the value).
function isBlank(value) {
  return value === undefined || value === '';
}

function parseDatabaseSsl(value) {
  if (isBlank(value) || value === 'false') return false;
  if (value === 'true') return true;
  if (value === 'no-verify') return 'no-verify';
  throw new Error('DATABASE_SSL must be one of: true, false, no-verify');
}

function parseSessionTtlHours(value) {
  if (isBlank(value)) return 12;
  const hours = /^(?:\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('SESSION_TTL_HOURS must be a positive number');
  return hours;
}

function parseTrustProxy(value) {
  if (isBlank(value) || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  throw new Error('TRUST_PROXY must be true, false or a non-negative whole number');
}

function parsePort(value) {
  if (isBlank(value)) return 3000;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a whole number from 1 to 65535');
  return port;
}

function parseStatuses(value) {
  const statuses = String(value || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return statuses.length ? statuses : ['SUCCESS'];
}

// Reads every setting from the environment once. DATABASE_URL is mandatory and is never given a default.
function loadConfig(env = process.env) {
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Set it to the PostgreSQL connection string.');
  }
  return {
    port: parsePort(env.PORT),
    host: env.HOST || '127.0.0.1',
    databaseUrl,
    databaseSsl: parseDatabaseSsl(env.DATABASE_SSL),
    sessionTtlHours: parseSessionTtlHours(env.SESSION_TTL_HOURS),
    cookieSecure: env.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    brandName: env.BRAND_NAME || 'Records',
    finalBankStatuses: parseStatuses(env.FINAL_BANK_STATUSES),
    enableManualCaptcha: env.ENABLE_MANUAL_CAPTCHA === 'true'
  };
}

module.exports = { loadConfig };
