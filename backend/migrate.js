/**
 * Database migration for the zero-knowledge fitness platform.
 * Run with: npm run migrate
 */

const { createPool } = require('./db');

const pool = createPool();

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  dsa_public_key TEXT NOT NULL,
  kem_public_key TEXT NOT NULL,
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

-- One-time migration from the old Argon2id auth_hash/salt schema.
ALTER TABLE users DROP COLUMN IF EXISTS auth_hash;
ALTER TABLE users DROP COLUMN IF EXISTS salt;
ALTER TABLE sync_data ADD COLUMN IF NOT EXISTS kem_ciphertext TEXT NOT NULL DEFAULT '';

-- Old accounts and sync payloads cannot be migrated to the new PQC scheme,
-- so they must be removed. Only runs when legacy rows are detected.
DELETE FROM sync_data WHERE kem_ciphertext = '';
DELETE FROM users WHERE dsa_public_key IS NULL;
`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('Database migration completed successfully.');
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
