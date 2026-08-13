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

  // node-postgres replaces the explicit `ssl` object when the connection string
  // contains sslmode, sslcert, sslkey, or sslrootcert. Strip those parameters
  // so the caller can control certificate verification deliberately.
  for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    url.searchParams.delete(parameter);
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
      // Managed Postgres providers require TLS. Render uses a managed
      // self-signed certificate, so its Blueprint explicitly opts out of
      // certificate verification while retaining encryption in transit.
      ssl: isLocal
        ? undefined
        : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
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
