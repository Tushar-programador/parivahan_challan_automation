function positiveNumber(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseDatabaseSsl(value) {
  if (value === 'true') return true;
  if (value === 'no-verify') return 'no-verify';
  return false;
}

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return false;
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
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Set it to the PostgreSQL connection string.');
  }
  return {
    port: positiveNumber(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    databaseUrl: env.DATABASE_URL,
    databaseSsl: parseDatabaseSsl(env.DATABASE_SSL),
    sessionTtlHours: positiveNumber(env.SESSION_TTL_HOURS, 12),
    cookieSecure: env.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    brandName: env.BRAND_NAME || 'Records',
    finalBankStatuses: parseStatuses(env.FINAL_BANK_STATUSES),
    enableManualCaptcha: env.ENABLE_MANUAL_CAPTCHA === 'true'
  };
}

module.exports = { loadConfig };
