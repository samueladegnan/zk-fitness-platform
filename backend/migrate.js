/**
 * Database migration for the zero-knowledge fitness platform.
 * Run with: npm run migrate
 */

const { createPool } = require('./db');
const { logger } = require('./lib/logger');

function hasDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL) || Boolean(process.env.DB_HOST);
}

// Defer pool creation so the script can exit cleanly when no database is
// configured (for example, during the first Render Blueprint sync before the
// Neon connection string has been added).
let pool;
function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

const schema = `
BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  dsa_public_key TEXT NOT NULL,
  kem_public_key TEXT NOT NULL,
  subscription_status VARCHAR(32) DEFAULT 'inactive' NOT NULL,
  subscription_type VARCHAR(32) DEFAULT NULL,
  stripe_customer_id VARCHAR(255) DEFAULT NULL,
  stripe_subscription_id VARCHAR(255) DEFAULT NULL,
  subscription_period_end TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_data (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_blob TEXT NOT NULL,
  kem_ciphertext TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS failed_login_attempts (
  username VARCHAR(32) PRIMARY KEY,
  attempt_count INTEGER DEFAULT 1 NOT NULL,
  last_attempt TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add the new post-quantum columns to any legacy tables without them.
-- They are added as nullable first so existing rows do not cause errors.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dsa_public_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kem_public_key TEXT;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS kem_ciphertext TEXT;

-- Add billing/subscription columns to existing users tables.
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(32) DEFAULT 'inactive' NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_type VARCHAR(32) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ DEFAULT NULL;

-- One-time migration from the old Argon2id auth_hash/salt schema.
ALTER TABLE users DROP COLUMN IF EXISTS auth_hash;
ALTER TABLE users DROP COLUMN IF EXISTS salt;

-- Old accounts and sync payloads cannot be migrated to the new PQC scheme,
-- so they must be removed. Only runs when legacy rows are detected.
DELETE FROM sync_data WHERE kem_ciphertext IS NULL OR kem_ciphertext = '';
DELETE FROM users WHERE dsa_public_key IS NULL OR dsa_public_key = ''
   OR kem_public_key IS NULL OR kem_public_key = '';

-- Now that legacy rows are gone, enforce the NOT NULL constraints.
ALTER TABLE users ALTER COLUMN dsa_public_key SET NOT NULL;
ALTER TABLE users ALTER COLUMN kem_public_key SET NOT NULL;
ALTER TABLE sync_data ALTER COLUMN kem_ciphertext SET NOT NULL;

COMMIT;
`;

async function main() {
  if (!hasDatabaseConfigured()) {
    logger.info('No database configured; skipping migration. Set DATABASE_URL or DB_HOST to enable cloud sync.');
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query(schema);
    logger.info('Database migration completed successfully.');
  } finally {
    client.release();
  }
  await getPool().end();
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Migration failed');
  process.exit(1);
});
