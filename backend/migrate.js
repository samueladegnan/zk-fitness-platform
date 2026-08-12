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
  identity_commitment TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_data (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_blob TEXT NOT NULL,
  kem_ciphertext TEXT NOT NULL,
  proof JSONB,
  public_signals JSONB,
  commitment TEXT,
  nullifier TEXT,
  payload_binding TEXT,
  circuit_version TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zk_nullifiers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nullifier TEXT NOT NULL,
  commitment TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, nullifier)
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_commitment TEXT;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS kem_ciphertext TEXT;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS proof JSONB;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS public_signals JSONB;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS commitment TEXT;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS nullifier TEXT;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS payload_binding TEXT;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS circuit_version TEXT;

-- Do not silently delete accounts, subscriptions, authentication material, or
-- sync payloads during a schema upgrade. Existing rows from the pre-PQC
-- schema cannot be converted automatically, so fail with an operator-readable
-- error and require an explicit data migration or reset plan.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
    WHERE dsa_public_key IS NULL OR dsa_public_key = ''
       OR kem_public_key IS NULL OR kem_public_key = ''
       OR identity_commitment IS NULL OR identity_commitment = ''
  ) THEN
    RAISE EXCEPTION 'Legacy users require an explicit migration or reset before enabling the PQC schema';
  END IF;
  IF EXISTS (
    SELECT 1 FROM sync_data
    WHERE kem_ciphertext IS NULL OR kem_ciphertext = ''
  ) THEN
    RAISE EXCEPTION 'Legacy sync payloads require an explicit migration or reset before enabling proof-carrying sync';
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN dsa_public_key SET NOT NULL;
ALTER TABLE users ALTER COLUMN kem_public_key SET NOT NULL;
ALTER TABLE users ALTER COLUMN identity_commitment SET NOT NULL;
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
