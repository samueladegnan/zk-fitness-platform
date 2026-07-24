/**
 * Zero-Knowledge Fitness Platform - Backend API
 *
 * The server provides authentication and encrypted sync only.
 * It NEVER has access to the user's master password, encryption key,
 * or plaintext workout data.
 *
 * Security features:
 * - Argon2id-based zero-knowledge authentication (client derives auth key from password)
 * - Cryptographically random per-user salts generated server-side
 * - JWT delivered in HTTP-only, Secure, SameSite cookies
 * - Strict per-IP and per-username rate limits on auth routes
 * - Account lockout after repeated failed login attempts
 * - Helmet, CORS, and CSP hardened for production
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const { randomBytes } = require('crypto');
const cookieParser = require('cookie-parser');
const { createPool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const IS_DEV = process.env.NODE_ENV !== 'production';
const COOKIE_NAME = 'zkfitness_session';
const ORIGIN = process.env.CLIENT_ORIGIN || (IS_DEV ? 'http://localhost:3001' : null);

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", ORIGIN],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

app.use(cors({
  origin: ORIGIN || (IS_DEV ? true : false),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ─── Database ───────────────────────────────────────────────────────────────
const pool = createPool();

// ─── Rate Limiting ──────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', generalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many auth attempts from this IP. Please try again later.' },
});

const usernameAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.username || req.ip,
  message: { error: 'Too many auth attempts for this username. Please try again later.' },
});

// ─── Authentication Helpers ─────────────────────────────────────────────────
function generateToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function isCrossOrigin() {
  // When CLIENT_ORIGIN is explicitly set, assume the frontend is hosted
  // separately (e.g. GitHub Pages) and allow the cookie cross-site.
  return Boolean(process.env.CLIENT_ORIGIN);
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: !IS_DEV,
    sameSite: isCrossOrigin() ? 'none' : 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function authenticate(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid session' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function randomSalt() {
  return randomBytes(32).toString('base64');
}

// ─── Account Lockout ───────────────────────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;

async function recordFailedLogin(username) {
  await pool.query(
    `INSERT INTO failed_login_attempts (username, last_attempt)
     VALUES ($1, NOW())
     ON CONFLICT (username) DO UPDATE SET
       attempt_count = failed_login_attempts.attempt_count + 1,
       last_attempt = NOW(),
       locked_until = CASE
         WHEN failed_login_attempts.attempt_count + 1 >= $2 THEN NOW() + interval '30 minutes'
         ELSE failed_login_attempts.locked_until
       END`,
    [username, MAX_FAILED_ATTEMPTS]
  );
}

async function resetFailedLogin(username) {
  await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [username]);
}

async function isAccountLocked(username) {
  const result = await pool.query(
    'SELECT locked_until FROM failed_login_attempts WHERE username = $1',
    [username]
  );
  if (result.rows.length === 0) return false;
  const lockedUntil = result.rows[0].locked_until;
  if (!lockedUntil) return false;
  return new Date(lockedUntil) > new Date();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Body: { username, authKeyHash, salt }
 *
 * The client still derives authKeyHash from their password. To strengthen
 * the system, the server now generates a random per-user salt and returns
 * it. The client should re-derive using this server salt for future logins.
 */
app.post('/api/auth/register', authLimiter, usernameAuthLimiter, async (req, res, next) => {
  try {
    const { username, authKeyHash } = req.body;
    if (!username || !authKeyHash) {
      return res.status(400).json({ error: 'username and authKeyHash are required' });
    }
    if (typeof username !== 'string' || username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'username must be 3-32 characters' });
    }
    if (typeof authKeyHash !== 'string' || authKeyHash.length < 32) {
      return res.status(400).json({ error: 'Invalid authKeyHash' });
    }

    const serverSalt = randomSalt();
    const serverHash = await argon2.hash(authKeyHash + serverSalt, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const result = await pool.query(
      'INSERT INTO users (username, auth_hash, salt) VALUES ($1, $2, $3) RETURNING id, salt',
      [username, serverHash, serverSalt]
    );

    const token = generateToken(result.rows[0].id);
    setAuthCookie(res, token);
    res.status(201).json({ message: 'User created', username, serverSalt });
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
 */
app.post('/api/auth/login', authLimiter, usernameAuthLimiter, async (req, res, next) => {
  try {
    const { username, authKeyHash } = req.body;
    if (!username || !authKeyHash) {
      return res.status(400).json({ error: 'username and authKeyHash are required' });
    }

    if (await isAccountLocked(username)) {
      return res.status(423).json({ error: 'Account temporarily locked due to failed login attempts. Try again later.' });
    }

    const result = await pool.query('SELECT id, auth_hash, salt FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      // Use consistent timing to prevent user enumeration
      await argon2.verify('$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authKeyHash);
      await recordFailedLogin(username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await argon2.verify(user.auth_hash, authKeyHash + user.salt);
    if (!valid) {
      await recordFailedLogin(username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await resetFailedLogin(username);

    const token = generateToken(user.id);
    setAuthCookie(res, token);
    res.json({ message: 'Authenticated', username, serverSalt: user.salt });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 */
app.post('/api/auth/logout', authenticate, async (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out' });
});

/**
 * GET /api/auth/session
 * Returns the current session info without exposing the token.
 */
app.get('/api/auth/session', authenticate, async (req, res) => {
  const result = await pool.query(
    'SELECT username FROM users WHERE id = $1', [req.userId]);
  if (result.rows.length === 0) {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'User not found' });
  }
  res.json({ username: result.rows[0].username });
});



// ─── Sync ─────────────────────────────────────────────────────────────────────
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
