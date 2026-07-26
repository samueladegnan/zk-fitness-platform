/**
 * Zero-Knowledge Fitness Platform - Backend API
 *
 * The server provides authentication and encrypted sync only.
 * It NEVER has access to the user's master password, private keys,
 * or plaintext workout data.
 *
 * Security features:
 * - ML-DSA-65 signature-based authentication (post-quantum)
 * - ML-KEM-768 encapsulated data keys (post-quantum)
 * - Cryptographically random per-login nonces
 * - JWT delivered in HTTP-only, secure, SameSite cookies
 * - Strict per-IP and per-username rate limits on auth routes
 * - Account lockout after repeated failed login attempts
 * - Helmet, CORS, and CSP hardened for production
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { randomBytes, createHash } = require('crypto');
const cookieParser = require('cookie-parser');
const { createPool } = require('./db');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const IS_DEV = process.env.NODE_ENV !== 'production';
const COOKIE_NAME = 'zkfitness_session';
const ORIGIN = process.env.CLIENT_ORIGIN || undefined;

// ─── Post-Quantum Crypto (ESM-only dependency) ─────────────────────────────
let ml_dsa65;

const pqcReady = (async function loadPqc() {
  const dsaMod = await import('@noble/post-quantum/ml-dsa.js');
  ml_dsa65 = dsaMod.ml_dsa65;
})();

function buf(str) {
  return Buffer.from(str, 'base64');
}

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"].concat(ORIGIN ? [ORIGIN] : []),
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

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ─── Database ───────────────────────────────────────────────────────────────
const pool = createPool();

// ─── Anti-Bot Registration Challenge ──────────────────────────────────────────
const CHALLENGE_DIFFICULTY = Number(process.env.REGISTRATION_CHALLENGE_DIFFICULTY) || 12;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const REGISTRATION_INVITE_CODE = process.env.REGISTRATION_INVITE_CODE;
const challenges = new Map();

function generateChallenge() {
  const nonce = randomBytes(32).toString('hex');
  const challenge = { nonce, difficulty: CHALLENGE_DIFFICULTY, createdAt: Date.now() };
  challenges.set(nonce, challenge);
  return challenge;
}

function cleanupChallenges() {
  const now = Date.now();
  for (const [nonce, ch] of challenges) {
    if (now - ch.createdAt > CHALLENGE_TTL_MS) challenges.delete(nonce);
  }
}

setInterval(cleanupChallenges, 60_000);

function hashForPoW(authKeyHash, nonce, solution) {
  return createHash('sha256')
    .update(`${authKeyHash}:${nonce}:${solution}`)
    .digest('hex');
}

function countLeadingZeroBits(hex) {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const n = parseInt(hex[i], 16);
    if (n === 0) { bits += 4; continue; }
    const leading = 4 - Math.floor(Math.log2(n + 0.5) + 1);
    bits += leading;
    break;
  }
  return bits;
}

function verifyPoW(authKeyHash, nonce, solution) {
  const challenge = challenges.get(nonce);
  if (!challenge) return false;
  if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) return false;
  const hash = hashForPoW(authKeyHash, nonce, solution);
  return countLeadingZeroBits(hash) >= challenge.difficulty;
}

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

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many registration attempts from this IP. Please try again later.' },
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
  return IS_DEV || Boolean(process.env.CLIENT_ORIGIN);
}

function setAuthCookie(res, token) {
  const crossOrigin = isCrossOrigin();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: crossOrigin || !IS_DEV,
    sameSite: crossOrigin ? 'none' : 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
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

// ─── Login Nonce Store ──────────────────────────────────────────────────────
const LOGIN_NONCE_TTL_MS = 5 * 60 * 1000;
const loginNonces = new Map();

function generateLoginNonce() {
  return randomBytes(32).toString('base64');
}

function cleanupLoginNonces() {
  const now = Date.now();
  for (const [username, { createdAt }] of loginNonces) {
    if (now - createdAt > LOGIN_NONCE_TTL_MS) loginNonces.delete(username);
  }
}

setInterval(cleanupLoginNonces, 60_000);

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
 * GET /api/auth/challenge
 * Returns a proof-of-work challenge that must be solved before registration.
 */
app.get('/api/auth/challenge', authLimiter, (req, res) => {
  const challenge = generateChallenge();
  res.json(challenge);
});

/**
 * POST /api/auth/register
 * Body: { username, dsaPublicKey, kemPublicKey, challenge, solution, inviteCode, website }
 */
app.post('/api/auth/register', registerLimiter, authLimiter, usernameAuthLimiter, async (req, res, next) => {
  try {
    await pqcReady;
    const { username, dsaPublicKey, kemPublicKey, challenge, solution, inviteCode, website } = req.body;
    if (!username || !dsaPublicKey || !kemPublicKey) {
      return res.status(400).json({ error: 'username, dsaPublicKey, and kemPublicKey are required' });
    }
    if (typeof username !== 'string' || username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'username must be 3-32 characters' });
    }
    if (typeof dsaPublicKey !== 'string' || dsaPublicKey.length < 64 || dsaPublicKey.length > 8192) {
      return res.status(400).json({ error: 'Invalid dsaPublicKey' });
    }
    if (typeof kemPublicKey !== 'string' || kemPublicKey.length < 64 || kemPublicKey.length > 8192) {
      return res.status(400).json({ error: 'Invalid kemPublicKey' });
    }

    if (website && typeof website === 'string' && website.length > 0) {
      return res.status(400).json({ error: 'Invalid registration request' });
    }

    if (REGISTRATION_INVITE_CODE && inviteCode?.trim() !== REGISTRATION_INVITE_CODE.trim()) {
      return res.status(403).json({ error: 'A valid invite code is required to register.' });
    }

    if (!challenge || typeof challenge !== 'string' || !solution || typeof solution !== 'number') {
      return res.status(400).json({ error: 'Registration challenge and solution are required' });
    }
    if (!verifyPoW(dsaPublicKey, challenge, solution)) {
      return res.status(403).json({ error: 'Invalid or expired registration challenge. Please try again.' });
    }
    challenges.delete(challenge);

    const result = await pool.query(
      'INSERT INTO users (username, dsa_public_key, kem_public_key) VALUES ($1, $2, $3) RETURNING id',
      [username, dsaPublicKey, kemPublicKey]
    );

    const token = generateToken(result.rows[0].id);
    setAuthCookie(res, token);
    res.status(201).json({ message: 'User created', username });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Step 1: Body: { username } -> { nonce }
 * Step 2: Body: { username, signature } -> { username } + JWT cookie
 */
app.post('/api/auth/login', authLimiter, usernameAuthLimiter, async (req, res, next) => {
  try {
    await pqcReady;
    const { username, signature } = req.body;
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'username is required' });
    }

    if (await isAccountLocked(username)) {
      return res.status(423).json({ error: 'Account temporarily locked due to failed login attempts. Try again later.' });
    }

    const result = await pool.query('SELECT id, dsa_public_key FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Step 1: return a login nonce for the client to sign.
    if (!signature) {
      const nonce = generateLoginNonce();
      loginNonces.set(username, { nonce, createdAt: Date.now() });
      return res.json({ nonce });
    }

    // Step 2: verify the signature.
    const nonceEntry = loginNonces.get(username);
    if (!nonceEntry) {
      return res.status(401).json({ error: 'Login nonce expired or invalid. Please start again.' });
    }
    const { nonce } = nonceEntry;

    let sigBytes;
    let pubBytes;
    let nonceBytes;
    try {
      sigBytes = buf(signature);
      pubBytes = buf(user.dsa_public_key);
      nonceBytes = new TextEncoder().encode(nonce);
    } catch {
      return res.status(400).json({ error: 'Invalid signature or key encoding' });
    }

    const valid = ml_dsa65.verify(sigBytes, nonceBytes, pubBytes);
    if (!valid) {
      await recordFailedLogin(username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    loginNonces.delete(username);
    await resetFailedLogin(username);

    const token = generateToken(user.id);
    setAuthCookie(res, token);
    res.json({ message: 'Authenticated', username });
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
      'SELECT encrypted_blob, kem_ciphertext, updated_at FROM sync_data WHERE user_id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.json({ exists: false, encryptedBlob: null, kemCiphertext: null, updatedAt: null });
    }
    const row = result.rows[0];
    res.json({
      exists: true,
      encryptedBlob: row.encrypted_blob,
      kemCiphertext: row.kem_ciphertext,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/sync', authenticate, async (req, res, next) => {
  try {
    const { encryptedBlob, kemCiphertext } = req.body;
    if (!encryptedBlob || typeof encryptedBlob !== 'string' || !kemCiphertext || typeof kemCiphertext !== 'string') {
      return res.status(400).json({ error: 'encryptedBlob and kemCiphertext are required' });
    }
    if (encryptedBlob.length > 2_000_000 || kemCiphertext.length > 8192) {
      return res.status(400).json({ error: 'Payload too large' });
    }

    await pool.query(
      `INSERT INTO sync_data (user_id, encrypted_blob, kem_ciphertext, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET encrypted_blob = EXCLUDED.encrypted_blob, kem_ciphertext = EXCLUDED.kem_ciphertext, updated_at = EXCLUDED.updated_at`,
      [req.userId, encryptedBlob, kemCiphertext]
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
