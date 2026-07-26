/**
 * Database connection factory.
 *
 * Supports two configurations:
 *   1. A managed Postgres connection string via DATABASE_URL (e.g. Neon).
 *   2. Local development with discrete DB_* variables and Docker Compose.
 *
 * For local development, use the DB_* variables (or the included Docker Compose
 * setup). DATABASE_URL is intended for managed providers that require TLS.
 */

const { Pool } = require('pg');
require('dotenv').config();

function normalizeDatabaseUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(
      'DATABASE_URL is not a valid URL. Make sure special characters in the password are percent-encoded.'
    );
  }

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode && ['prefer', 'require', 'verify-ca'].includes(sslMode)) {
    // pg currently treats the above modes as verify-full. In pg v9 they will
    // switch to standard libpq semantics and emit a deprecation warning unless
    // the mode is explicit. Keep current (strict) behavior and silence the warning.
    url.searchParams.set('sslmode', 'verify-full');
  }

  return url.toString();
}

function createPool() {
  const baseConfig = {
    // Fail fast if Postgres is not reachable instead of hanging tests/requests.
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 5000,
  };

  if (process.env.DATABASE_URL) {
    const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
    const url = new URL(connectionString);

    const isLocal =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    return new Pool({
      ...baseConfig,
      connectionString,
      // Managed Postgres providers (e.g. Neon) require TLS. Local/dev URLs
      // such as localhost/127.0.0.1 do not.
      ssl: isLocal ? undefined : true,
    });
  }

  return new Pool({
    ...baseConfig,
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'fitness',
    password: process.env.DB_PASSWORD || 'fitness',
    database: process.env.DB_NAME || 'fitness_db',
  });
}

module.exports = { createPool };
