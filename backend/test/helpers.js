/**
 * Shared backend test helpers.
 *
 * Centralizes key generation, proof-of-work solving, cookie extraction,
 * and user registration so integration tests stay DRY.
 */

const { createHash } = require('crypto');
const path = require('path');
const snarkjs = require('snarkjs');
const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const request = require('supertest');
const { buildPoseidonReference } = require('circomlibjs');

let ml_dsa65;
let ml_kem768;
let pqcReady;
let poseidonPromise;

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

async function poseidonHash(values) {
  poseidonPromise ??= buildPoseidonReference();
  const poseidon = await poseidonPromise;
  return poseidon.F.toString(poseidon(values));
}

function hashToField(value) {
  const digest = createHash('sha256').update(value).digest();
  let number = 0n;
  for (const byte of digest) number = (number << 8n) | BigInt(byte);
  return (number % BN254_FIELD).toString();
}

async function identitySecretFor(keyPair) {
  const digest = createHash('sha256')
    .update(JSON.stringify(Array.from(new Uint8Array(keyPair.dsaKeyPair.secretKey))))
    .digest();
  let number = 0n;
  for (const byte of digest) number = (number << 8n) | BigInt(byte);
  return (number % BN254_FIELD).toString();
}

async function identityCommitmentFor(keyPair) {
  return poseidonHash([await identitySecretFor(keyPair)]);
}

async function createProofPayload(keyPair, encryptedBlob, options = {}) {
  const secret = await identitySecretFor(keyPair);
  const workoutCount = String(options.workoutCount ?? 2);
  const totalMinutes = String(options.totalMinutes ?? 30);
  const totalDistance = String(options.totalDistance ?? 10);
  const minWorkoutCount = String(options.minWorkoutCount ?? 1);
  const minMinutes = String(options.minMinutes ?? 1);
  const kemCiphertext = Buffer.alloc(1088, 7).toString('base64');
  const validEncryptedBlob = encryptedBlob || JSON.stringify({
    iv: Buffer.alloc(12, 1).toString('base64'),
    ciphertext: Buffer.alloc(16, 2).toString('base64'),
  });
  const payloadBinding = hashToField(JSON.stringify({ encryptedBlob: validEncryptedBlob, kemCiphertext }));
  const workoutHash = await poseidonHash([workoutCount, totalMinutes, totalDistance]);
  const identityCommitment = await poseidonHash([secret]);
  const nonce = String(options.nonce ?? 67890);
  const commitment = await poseidonHash([secret, nonce, workoutHash, payloadBinding]);
  const nullifier = await poseidonHash([secret, nonce]);
  const input = {
    secret,
    nonce,
    workoutCount,
    totalMinutes,
    totalDistance,
    workoutHash,
    identityCommitment,
    commitment,
    nullifier,
    payloadBinding,
    minWorkoutCount,
    minMinutes,
  };
  const root = path.join(__dirname, '..', '..');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    path.join(root, 'zk', 'circuits', 'main_js', 'main.wasm'),
    path.join(root, 'zk', 'circuits', 'main.zkey'),
  );
  return {
    encryptedBlob: validEncryptedBlob,
    kemCiphertext,
    proof,
    publicSignals,
    commitment,
    nullifier,
    payloadBinding,
    identityCommitment,
    minWorkoutCount,
    minMinutes,
    circuitVersion: 'workout-validity-v1',
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
  const identityCommitment = await identityCommitmentFor(keyPair);
  keyPair.identityCommitment = identityCommitment;
  const res = await request(app)
    .post('/api/auth/register')
    .set('Origin', process.env.CLIENT_ORIGIN)
    .send({
      username,
      dsaPublicKey: keyPair.dsaPublicKey,
      kemPublicKey: keyPair.kemPublicKey,
      identityCommitment,
      challenge: challengeRes.body.nonce,
      solution,
    })
    .expect(201);
  return res;
}

async function loginUser(app, username, keyPair) {
  const nonceRes = await request(app)
    .post('/api/auth/login')
    .set('Origin', process.env.CLIENT_ORIGIN)
    .send({ username })
    .expect(200);
  const signature = await signNonce(nonceRes.body.nonce, keyPair.dsaKeyPair.secretKey);
  const res = await request(app)
    .post('/api/auth/login')
    .set('Origin', process.env.CLIENT_ORIGIN)
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
  identityCommitmentFor,
  poseidonHash,
  createProofPayload,
};
