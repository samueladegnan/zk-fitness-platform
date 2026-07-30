process.env.NODE_ENV ??= 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../server');
const { generateTestKeyPair, registerAndLogin } = require('./helpers');

const TEST_USER = 'inttestuser';
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
  await cleanupUser();
  ({ cookie } = await registerAndLogin(app, TEST_USER));
});

after(async () => {
  await cleanupUser();
  await pool.end();
});

async function cleanupUser() {
  await pool.query('DELETE FROM sync_data WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [TEST_USER]);
  await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
  await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);
}

describe('Health & meta endpoints', () => {
  it('returns ok from the health endpoint', async () => {
    const res = await request(app).get('/api/health').expect(200);
    assert.equal(res.body.status, 'ok');
  });

  it('returns the authenticated session', async () => {
    const res = await request(app)
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.username, TEST_USER);
  });

  it('rejects an unauthenticated session request', async () => {
    await request(app).get('/api/auth/session').expect(401);
  });

  it('logs out and clears the session cookie', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.message, 'Logged out');
  });
});

describe('Registration validation', () => {
  it('rejects registration without required fields', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: TEST_USER })
      .expect(400);
  });

  it('rejects a username that is too short', async () => {
    const kp = await generateTestKeyPair();
    await request(app)
      .post('/api/auth/register')
      .send({
        username: 'ab',
        dsaPublicKey: kp.dsaPublicKey,
        kemPublicKey: kp.kemPublicKey,
        challenge: 'nonce',
        solution: 0,
      })
      .expect(400);
  });

  it('rejects an invalid registration challenge solution', async () => {
    const kp = await generateTestKeyPair();
    const challengeRes = await request(app).get('/api/auth/challenge').expect(200);
    await request(app)
      .post('/api/auth/register')
      .send({
        username: 'badchallengeuser',
        dsaPublicKey: kp.dsaPublicKey,
        kemPublicKey: kp.kemPublicKey,
        challenge: challengeRes.body.nonce,
        solution: 1,
      })
      .expect(403);
  });
});

describe('Sync lifecycle', () => {
  it('returns no sync data initially', async () => {
    const res = await request(app)
      .get('/api/sync')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.exists, false);
  });

  it('stores encrypted data and returns it on subsequent requests', async () => {
    const blob = JSON.stringify({ iv: 'abc', ciphertext: 'xyz', version: 2 });
    const kemCiphertext = 'integration-kem-ciphertext';

    await request(app)
      .put('/api/sync')
      .set('Cookie', cookie)
      .send({ encryptedBlob: blob, kemCiphertext })
      .expect(200);

    const res = await request(app)
      .get('/api/sync')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.encryptedBlob, blob);
    assert.equal(res.body.kemCiphertext, kemCiphertext);
  });

  it('overwrites previous sync data', async () => {
    const blob = JSON.stringify({ iv: 'updated', ciphertext: 'updated-payload' });
    const kemCiphertext = 'updated-kem';

    await request(app)
      .put('/api/sync')
      .set('Cookie', cookie)
      .send({ encryptedBlob: blob, kemCiphertext })
      .expect(200);

    const res = await request(app)
      .get('/api/sync')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.encryptedBlob, blob);
  });

  it('rejects sync payloads that are too large', async () => {
    const hugeBlob = 'x'.repeat(2_000_001);
    await request(app)
      .put('/api/sync')
      .set('Cookie', cookie)
      .send({ encryptedBlob: hugeBlob, kemCiphertext: 'x' })
      .expect(400);
  });

  it('rejects unauthenticated sync access', async () => {
    await request(app).get('/api/sync').expect(401);
    await request(app).put('/api/sync').send({ encryptedBlob: 'x', kemCiphertext: 'y' }).expect(401);
  });
});
