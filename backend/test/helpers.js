/**
 * Shared backend test helpers.
 *
 * Centralizes key generation, proof-of-work solving, cookie extraction,
 * and user registration so integration tests stay DRY.
 */

const { createHash } = require('crypto');
const request = require('supertest');

let ml_dsa65;
let ml_kem768;
let pqcReady;

function loadPqc() {
  if (pqcReady) return pqcReady;
  pqcReady = (async () => {
    const dsaMod = await import('@noble/post-quantum/ml-dsa.js');
    const kemMod = await import('@noble/post-quantum/ml-kem.js');
    ml_dsa65 = dsaMod.ml_dsa65;
    ml_kem768 = kemMod.ml_kem768;
  })();
  return pqcReady;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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

async function generateTestKeyPair() {
  await loadPqc();
  const dsaSeed = new Uint8Array(32);
  const kemSeed = new Uint8Array(64);
  for (let i = 0; i < 32; i++) dsaSeed[i] = i;
  for (let i = 0; i < 64; i++) kemSeed[i] = i + 32;
  const dsaKeyPair = ml_dsa65.keygen(dsaSeed);
  const kemKeyPair = ml_kem768.keygen(kemSeed);
  return {
    dsaKeyPair,
    kemKeyPair,
    dsaPublicKey: arrayBufferToBase64(dsaKeyPair.publicKey),
    kemPublicKey: arrayBufferToBase64(kemKeyPair.publicKey),
  };
}

function getCookie(res) {
  const cookies = res.headers['set-cookie'];
  if (!cookies || cookies.length === 0) return null;
  return cookies[0].split(';')[0];
}

async function registerUser(app, username, keyPair) {
  const challengeRes = await request(app).get('/api/auth/challenge').expect(200);
  const solution = solvePoW(keyPair.dsaPublicKey, challengeRes.body.nonce, challengeRes.body.difficulty);
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      username,
      dsaPublicKey: keyPair.dsaPublicKey,
      kemPublicKey: keyPair.kemPublicKey,
      challenge: challengeRes.body.nonce,
      solution,
    })
    .expect(201);
  return res;
}

async function loginUser(app, username, keyPair) {
  const nonceRes = await request(app)
    .post('/api/auth/login')
    .send({ username })
    .expect(200);
  const signature = await signNonce(nonceRes.body.nonce, keyPair.dsaKeyPair.secretKey);
  const res = await request(app)
    .post('/api/auth/login')
    .send({
      username,
      signature: arrayBufferToBase64(signature),
    })
    .expect(200);
  return res;
}

async function registerAndLogin(app, username) {
  const keyPair = await generateTestKeyPair();
  await registerUser(app, username, keyPair);
  const res = await loginUser(app, username, keyPair);
  return { keyPair, cookie: getCookie(res) };
}

module.exports = {
  loadPqc,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  solvePoW,
  signNonce,
  generateTestKeyPair,
  getCookie,
  registerUser,
  loginUser,
  registerAndLogin,
};
