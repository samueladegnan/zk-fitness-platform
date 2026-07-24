const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../server');

const TEST_USER = 'testuser';
const TEST_AUTH_KEY = 'fake-auth-key-thirty-two-chars-' + Date.now();

function getCookie(res) {
  const cookies = res.headers['set-cookie'];
  if (!cookies || cookies.length === 0) return null;
  return cookies[0].split(';')[0];
}

describe('Auth endpoints', () => {
  before(async () => {
    // Ensure lockout table exists and clean test user
    await pool.query(`
      CREATE TABLE IF NOT EXISTS failed_login_attempts (
        username VARCHAR(32) PRIMARY KEY,
        attempt_count INTEGER DEFAULT 1 NOT NULL,
        last_attempt TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);
  });

  after(async () => {
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);
  });

  it('registers a new user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY })
      .expect(201);
    assert.equal(res.body.username, TEST_USER);
    assert.ok(res.body.serverSalt);
    assert.ok(getCookie(res));
  });

  it('rejects duplicate username', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY })
      .expect(409);
  });

  it('logs in an existing user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY })
      .expect(200);
    assert.equal(res.body.username, TEST_USER);
    assert.ok(res.body.serverSalt);
    assert.ok(getCookie(res));
  });

  it('rejects invalid credentials', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER, authKeyHash: 'wrong-key' })
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
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM failed_login_attempts WHERE username = $1', [TEST_USER]);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY });
    cookie = getCookie(res);
  });

  after(async () => {
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
    const blob = JSON.stringify({ iv: 'abc', ciphertext: 'xyz' });
    await request(app)
      .put('/api/sync')
      .set('Cookie', cookie)
      .send({ encryptedBlob: blob })
      .expect(200);

    const res = await request(app)
      .get('/api/sync')
      .set('Cookie', cookie)
      .expect(200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.encryptedBlob, blob);
  });

  it('rejects unauthenticated sync access', async () => {
    await request(app).get('/api/sync').expect(401);
  });
});
