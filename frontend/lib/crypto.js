/**
 * Zero-Knowledge Fitness Platform — Client-side cryptography.
 *
 * This module isolates all key-derivation, encryption, and post-quantum
 * primitives so the rest of the frontend can treat crypto as a black box.
 *
 * - Argon2id + HKDF for deterministic key derivation from the password.
 * - ML-DSA-65 for login signatures.
 * - ML-KEM-768 for per-sync AES data key encapsulation.
 * - AES-256-GCM for the encrypted vault payload.
 */

/**
 * Encode an ArrayBuffer as a base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Decode a base64 string into an ArrayBuffer.
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Encode a string into a Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function bufferFromString(str) {
  return new TextEncoder().encode(str);
}

/**
 * Derive a deterministic salt for a username.
 * @param {string} username
 * @returns {Promise<Uint8Array>}
 */
export async function deriveSalt(username) {
  const input = `zkfitness:salt:v1:${username}`;
  const hash = await crypto.subtle.digest('SHA-256', bufferFromString(input));
  return new Uint8Array(hash);
}

/**
 * Derive the user's post-quantum keypairs from their password and salt.
 *
 * Argon2id stretches the password, HKDF expands it into deterministic seeds,
 * and the Noble PQC library generates ML-DSA-65 and ML-KEM-768 keypairs.
 *
 * @param {string} masterPassword
 * @param {Uint8Array} salt
 * @returns {Promise<{ dsaKeyPair: object, kemKeyPair: object }>}
 */
export async function deriveKeys(masterPassword, salt) {
  const argonParams = {
    pass: masterPassword,
    salt,
    type: argon2.ArgonType.Argon2id,
    hashLen: 32,
    time: 3,
    mem: 65536,
    parallelism: 1,
  };
  const masterKey = await argon2.hash(argonParams);

  const keyMaterial = await crypto.subtle.importKey('raw', masterKey.hash, 'HKDF', false, ['deriveBits']);
  const derive = async (info, bits) =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: bufferFromString('zkfitness'), info: bufferFromString(info) },
      keyMaterial,
      bits
    );

  // Deterministic seeds ensure the same password always recovers the same
  // post-quantum keypair on any device.
  const dsaSeed = new Uint8Array(await derive('pq-dsa-v1', 256));
  const kemSeed = new Uint8Array(await derive('pq-kem-v1', 512));

  const dsaKeyPair = window.NoblePQC.ml_dsa65.keygen(dsaSeed);
  const kemKeyPair = window.NoblePQC.ml_kem768.keygen(kemSeed);

  return { dsaKeyPair, kemKeyPair };
}

/**
 * Count the number of leading zero bits in a hex string.
 * @param {string} hex
 * @returns {number}
 */
export function hexLeadingZeroBits(hex) {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const n = parseInt(hex[i], 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    const leading = 4 - Math.floor(Math.log2(n + 0.5) + 1);
    bits += leading;
    break;
  }
  return bits;
}

/**
 * Solve a proof-of-work challenge for anti-bot registration.
 * @param {string} authKeyHash
 * @param {string} nonce
 * @param {number} difficulty
 * @returns {Promise<number>}
 */
export async function solvePoW(authKeyHash, nonce, difficulty) {
  const enc = new TextEncoder();
  let solution = 0;
  while (true) {
    const data = `${authKeyHash}:${nonce}:${solution}`;
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(data));
    const hash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (hexLeadingZeroBits(hash) >= difficulty) return solution;
    solution += 1;
    if (solution % 1000 === 0) {
      // Yield to keep the UI responsive during heavy workloads.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/**
 * Return the fixed AES-GCM key used for local-only (demo) mode.
 * @returns {Promise<CryptoKey>}
 */
export async function getLocalEncKey() {
  // Local mode uses a fixed, non-secret key because data lives only in localStorage.
  const raw = new Uint8Array(32);
  for (let i = 0; i < raw.length; i++) raw[i] = i;
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt workout data with AES-256-GCM.
 *
 * In cloud mode a fresh key is encapsulated with ML-KEM-768; in local/demo mode
 * the provided CryptoKey is used directly.
 *
 * @param {object} data
 * @param {CryptoKey|Uint8Array} keyOrKemPublic
 * @returns {Promise<{ iv: string, ciphertext: string, kemCiphertext?: string }>}
 */
export async function encryptData(data, keyOrKemPublic) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = bufferFromString(JSON.stringify(data));

  let aesKey;
  let kemCiphertext;

  if (keyOrKemPublic instanceof CryptoKey) {
    // Demo / legacy mode: use the provided AES key directly.
    aesKey = keyOrKemPublic;
  } else {
    // Real mode: encapsulate a fresh shared secret with the user's ML-KEM
    // public key. The shared secret is the AES data key.
    const { cipherText, sharedSecret } = window.NoblePQC.ml_kem768.encapsulate(keyOrKemPublic);
    aesKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'AES-GCM' }, false, ['encrypt']);
    kemCiphertext = arrayBufferToBase64(cipherText);
  }

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const result = {
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext),
  };
  if (kemCiphertext) result.kemCiphertext = kemCiphertext;
  return result;
}

/**
 * Decrypt workout data with AES-256-GCM.
 *
 * @param {{ iv: string, ciphertext: string, kemCiphertext?: string }} encrypted
 * @param {CryptoKey|object} keyOrKemSecret
 * @returns {Promise<object>}
 */
export async function decryptData(encrypted, keyOrKemSecret) {
  const iv = new Uint8Array(base64ToArrayBuffer(encrypted.iv));
  const ciphertext = base64ToArrayBuffer(encrypted.ciphertext);

  let aesKey;
  if (keyOrKemSecret instanceof CryptoKey) {
    aesKey = keyOrKemSecret;
  } else {
    const kemCipherText = base64ToArrayBuffer(encrypted.kemCiphertext);
    const sharedSecret = window.NoblePQC.ml_kem768.decapsulate(kemCipherText, keyOrKemSecret);
    aesKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'AES-GCM' }, false, ['decrypt']);
  }

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
