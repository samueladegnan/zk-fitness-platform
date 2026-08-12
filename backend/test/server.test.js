process.env.NODE_ENV ??= 'test';
process.env.CLIENT_ORIGIN ??= 'http://localhost:3001';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createHash } = require('crypto');
const { app, pool } = require('../server');
const { identityCommitmentFor, createProofPayload } = require('./helpers');

after(async () => {
  await pool.end();
});

const TEST_USER = 'testuser';
let ml_dsa65;
let ml_kem768;
let testKeyPair;

function getCookie(res) {
  const cookies = res.headers['set-cookie'];
  if (!cookies || cookies.length === 0) return null;
  return cookies[0].split(';')[0];
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function solvePoW(identifier, nonce, difficulty) {
  let solution = 0;
  while (true) {
    const hash = createHash('sha256').update(`${identifier}:${nonce}:${solution}`).digest('hex');
    let bits = 0;
    for (let i = 0; i < hash.length; i++) {
      const n = parseInt(hash[i], 16);
      if (n === 0) {
        bits += 4;
        continue;
      }
      const leading = 4 - Math.floor(Math.log2(n + 0.5) + 1);
      bits += leading;
      break;
    }
    if (bits >= difficulty) return solution;
    solution++;
  }
}

async function signNonce(nonce, secretKey) {
  return ml_dsa65.sign(new TextEncoder().encode(nonce), secretKey);
}

describe('Auth endpoints', () => {
  before(async () => {
    const dsaMod = await import('@noble/post-quantum/ml-dsa.js');
    const kemMod = await import('@noble/post-quantum/ml-kem.js');
    ml_dsa65 = dsaMod.ml_dsa65;
    ml_kem768 = kemMod.ml_kem768;

    const dsaSeed = new Uint8Array(32);
    const kemSeed = new Uint8Array(64);
    for (let i = 0; i < 32; i++) dsaSeed[i] = i;
    for (let i = 0; i < 64; i++) kemSeed[i] = i + 32;
    const dsaKeyPair = ml_dsa65.keygen(dsaSeed);
    const kemKeyPair = ml_kem768.keygen(kemSeed);
    testKeyPair = {
      dsaKeyPair,
      kemKeyPair,
      dsaPublicKey: arrayBufferToBase64(dsaKeyPair.publicKey),
      kemPublicKey: arrayBufferToBase64(kemKeyPair.publicKey),
    };

    await pool.query(`
      CREATE TABLE IF NOT EXISTS failed_login_attempts (
        username VARCHAR(32) PRIMARY KEY,
        attempt_count INTEGER DEFAULT 1 NOT NULL,
        last_attempt TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('DELETE FROM sync_data WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [TEST_USER]);
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);
  });

  after(async () => {
    await pool.query('DELETE FROM sync_data WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [TEST_USER]);
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);
  });

  it('registers a new user', async () => {
    const challengeRes = await request(app).get('/api/auth/challenge').expect(200);
    const solution = solvePoW(testKeyPair.dsaPublicKey, challengeRes.body.nonce, challengeRes.body.difficulty);
    const identityCommitment = await identityCommitmentFor(testKeyPair);
    testKeyPair.identityCommitment = identityCommitment;
    const res =    await request(app)
      .post('/api/auth/register')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({
        username: TEST_USER,
        dsaPublicKey: testKeyPair.dsaPublicKey,
        kemPublicKey: testKeyPair.kemPublicKey,
        identityCommitment,
        challenge: challengeRes.body.nonce,
        solution,
      })
      .expect(201);
    assert.equal(res.body.username, TEST_USER);
    assert.ok(getCookie(res));
  });

  it('rejects duplicate username', async () => {
    const challengeRes = await request(app).get('/api/auth/challenge').expect(200);
    const solution = solvePoW(testKeyPair.dsaPublicKey, challengeRes.body.nonce, challengeRes.body.difficulty);
    const identityCommitment = await identityCommitmentFor(testKeyPair);
    await request(app)
      .post('/api/auth/register')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({
        username: TEST_USER,
        dsaPublicKey: testKeyPair.dsaPublicKey,
        kemPublicKey: testKeyPair.kemPublicKey,
        identityCommitment,
        challenge: challengeRes.body.nonce,
        solution,
      })
      .expect(409);
  });

  it('logs in an existing user', async () => {
    const nonceRes = await request(app)
      .post('/api/auth/login')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({ username: TEST_USER })
      .expect(200);
    assert.ok(nonceRes.body.nonce);

    const signature = await signNonce(nonceRes.body.nonce, testKeyPair.dsaKeyPair.secretKey);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({
        username: TEST_USER,
        signature: arrayBufferToBase64(signature),
      })
      .expect(200);
    assert.equal(loginRes.body.username, TEST_USER);
    assert.ok(getCookie(loginRes));
  });

  it('rejects invalid credentials', async () => {
    await request(app)
      .post('/api/auth/login')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({ username: TEST_USER })
      .expect(200);
    const badSignature = new Uint8Array(ml_dsa65.lengths.signature).fill(0);
    await request(app)
      .post('/api/auth/login')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({
        username: TEST_USER,
        signature: arrayBufferToBase64(badSignature),
      })
      .expect(401);
  });
});

describe('Sync endpoints', () => {
  let cookie;

  before(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS failed_login_attempts (
        username VARCHAR(32) PRIMARY KEY,
        attempt_count INTEGER DEFAULT 1 NOT NULL,
        last_attempt TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('DELETE FROM sync_data WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [TEST_USER]);
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);

    const challengeRes = await request(app).get('/api/auth/challenge').expect(200);
    const solution = solvePoW(testKeyPair.dsaPublicKey, challengeRes.body.nonce, challengeRes.body.difficulty);
    const identityCommitment = await identityCommitmentFor(testKeyPair);
    testKeyPair.identityCommitment = identityCommitment;
    const registerRes =    await request(app)
      .post('/api/auth/register')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({
        username: TEST_USER,
        dsaPublicKey: testKeyPair.dsaPublicKey,
        kemPublicKey: testKeyPair.kemPublicKey,
        identityCommitment,
        challenge: challengeRes.body.nonce,
        solution,
      })
      .expect(201);
    assert.ok(getCookie(registerRes));

    const nonceRes = await request(app)
      .post('/api/auth/login')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({ username: TEST_USER })
      .expect(200);
    const signature = await signNonce(nonceRes.body.nonce, testKeyPair.dsaKeyPair.secretKey);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .send({
        username: TEST_USER,
        signature: arrayBufferToBase64(signature),
      })
      .expect(200);
    assert.ok(getCookie(loginRes));
    cookie = getCookie(loginRes);
  });

  after(async () => {
    await pool.query('DELETE FROM sync_data WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [TEST_USER]);
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);
  });

  it('returns no sync data initially', async () => {
    const res = await request(app)
      .get('/api/sync')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.exists, false);
  });

  it('stores and retrieves encrypted data', async () => {
    const blob = JSON.stringify({
      iv: Buffer.alloc(12, 1).toString('base64'),
      ciphertext: Buffer.alloc(16, 2).toString('base64'),
    });
    const payload = await createProofPayload(testKeyPair, blob, { nonce: 67890 });
    await request(app)
      .put('/api/sync')
      .set('Origin', process.env.CLIENT_ORIGIN)
      .set('Cookie', cookie)
      .send(payload)
      .expect(200);

    const res = await request(app)
      .get('/api/sync')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.encryptedBlob, blob);
    assert.equal(res.body.kemCiphertext, Buffer.alloc(1088, 7).toString('base64'));
    assert.equal(res.body.publicSignals.length, 6);
  });

  it('rejects unauthenticated sync access', async () => {
    await request(app).get('/api/sync').expect(401);
  });
;
});
