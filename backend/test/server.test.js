const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../server');

const TEST_USER = 'testuser';
const TEST_AUTH_KEY = 'fake-auth-key-' + Date.now();
const TEST_SALT = 'test-salt';

describe('Auth endpoints', () => {
  before(async () => {
    // Clean test user
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
  });

  after(async () => {
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
  });

  it('registers a new user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY, salt: TEST_SALT })
      .expect(201);
    assert.ok(res.body.token);
    assert.equal(res.body.username, TEST_USER);
  });

  it('rejects duplicate username', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY, salt: TEST_SALT })
      .expect(409);
  });

  it('logs in an existing user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY })
      .expect(200);
    assert.ok(res.body.token);
  });

  it('rejects invalid credentials', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER, authKeyHash: 'wrong-key' })
      .expect(401);
  });
});

describe('Sync endpoints', () => {
  let token;

  before(async () => {
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: TEST_USER, authKeyHash: TEST_AUTH_KEY, salt: TEST_SALT });
    token = res.body.token;
  });

  after(async () => {
    await pool.query('DELETE FROM users WHERE username = $1', [TEST_USER]);
  });

  it('returns no sync data initially', async () => {
    const res = await request(app)
      .get('/api/sync')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal(res.body.exists, false);
  });

  it('stores and retrieves encrypted data', async () => {
    const blob = JSON.stringify({ iv: 'abc', ciphertext: 'xyz' });
    await request(app)
      .put('/api/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({ encryptedBlob: blob })
      .expect(200);

    const res = await request(app)
      .get('/api/sync')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.encryptedBlob, blob);
  });

  it('rejects unauthenticated sync access', async () => {
    await request(app).get('/api/sync').expect(401);
  });
});
