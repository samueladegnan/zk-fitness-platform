/**
 * Zero-Knowledge Gamified Fitness Platform — Backend API
 *
 * The server provides authentication and encrypted sync only.
 * It NEVER has access to the user's master password, encryption key,
 * or plaintext workout data.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const IS_DEV = process.env.NODE_ENV !== 'production';

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet());
const corsOrigin = process.env.NODE_ENV === 'development'
  ? (process.env.CLIENT_ORIGIN || true)
  : (process.env.CLIENT_ORIGIN || '*');
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// ─── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'fitness',
  password: process.env.DB_PASSWORD || 'fitness',
  database: process.env.DB_NAME || 'fitness_db',
});

// ─── Authentication ───────────────────────────────────────────────────────────
function generateToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Body: { username, authKeyHash, salt }
 *   - username: unique display name
 *   - authKeyHash: the client-derived authentication key, hashed again server-side
 *   - salt: the Argon2 salt used by the client (hex/base64)
 *
 * The server never receives the master password or the encryption key.
 */
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { username, authKeyHash, salt } = req.body;
    if (!username || !authKeyHash || !salt) {
      return res.status(400).json({ error: 'username, authKeyHash, and salt are required' });
    }
    if (typeof username !== 'string' || username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'username must be 3-32 characters' });
    }

    const serverHash = await argon2.hash(authKeyHash, { type: argon2.argon2id });

    const result = await pool.query(
      'INSERT INTO users (username, auth_hash, salt) VALUES ($1, $2, $3) RETURNING id',
      [username, serverHash, salt]
    );

    const token = generateToken(result.rows[0].id);
    res.status(201).json({ message: 'User created', token, username });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Body: { username, authKeyHash }
 *
 * The server verifies the authKeyHash against the stored Argon2 hash.
 * The plaintext master password and encryption key are never transmitted.
 */
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, authKeyHash } = req.body;
    if (!username || !authKeyHash) {
      return res.status(400).json({ error: 'username and authKeyHash are required' });
    }

    const result = await pool.query('SELECT id, auth_hash FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await argon2.verify(result.rows[0].auth_hash, authKeyHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(result.rows[0].id);
    res.json({ message: 'Authenticated', token, username });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync
 * Authorization: Bearer <token>
 *
 * Returns the user's encrypted payload. The server cannot decrypt it.
 */
app.get('/api/sync', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT encrypted_blob, updated_at FROM sync_data WHERE user_id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.json({ exists: false, encryptedBlob: null, updatedAt: null });
    }
    const row = result.rows[0];
    res.json({ exists: true, encryptedBlob: row.encrypted_blob, updatedAt: row.updated_at });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/sync
 * Authorization: Bearer <token>
 * Body: { encryptedBlob }
 *
 * Stores an opaque encrypted blob for the authenticated user.
 */
app.put('/api/sync', authenticate, async (req, res, next) => {
  try {
    const { encryptedBlob } = req.body;
    if (!encryptedBlob || typeof encryptedBlob !== 'string') {
      return res.status(400).json({ error: 'encryptedBlob is required' });
    }
    if (encryptedBlob.length > 2_000_000) {
      return res.status(400).json({ error: 'Payload too large' });
    }

    await pool.query(
      `INSERT INTO sync_data (user_id, encrypted_blob, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET encrypted_blob = EXCLUDED.encrypted_blob, updated_at = EXCLUDED.updated_at`,
      [req.userId, encryptedBlob]
    );

    res.json({ message: 'Sync data stored' });
  } catch (err) {
    next(err);
  }
});

// ─── Health & Errors ────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({
    error: IS_DEV ? err.message : 'Internal server error',
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ZK Fitness API listening on port ${PORT}`);
  });
}

module.exports = { app, pool };
