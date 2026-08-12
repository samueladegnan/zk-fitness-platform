import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
if (!globalThis.CryptoKey) {
  Object.defineProperty(globalThis, 'CryptoKey', { value: webcrypto.CryptoKey, configurable: true });
}
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  bufferFromString,
  hexLeadingZeroBits,
  encryptData,
  decryptData,
} from '../lib/crypto.js';

describe('crypto helpers', () => {
  it('round-trips an ArrayBuffer through base64', () => {
    const input = new Uint8Array([1, 2, 3, 255, 0]).buffer;
    const encoded = arrayBufferToBase64(input);
    const decoded = base64ToArrayBuffer(encoded);

    assert.equal(typeof encoded, 'string');
    assert.ok(encoded.length > 0);
    assert.deepEqual(new Uint8Array(decoded), new Uint8Array([1, 2, 3, 255, 0]));
  });

  it('encodes a string to a Uint8Array', () => {
    const encoded = bufferFromString('hello');
    assert.ok(encoded instanceof Uint8Array);
    assert.deepEqual(encoded, new TextEncoder().encode('hello'));
  });

  it('counts leading zero bits in hex strings', () => {
    assert.equal(hexLeadingZeroBits('0000'), 16);
    assert.equal(hexLeadingZeroBits('0abc'), 4);
    assert.equal(hexLeadingZeroBits('1234'), 3);
    assert.equal(hexLeadingZeroBits('f234'), 0);
  });

  it('rejects corrupted ciphertext and a wrong AES key', async () => {
    const key = await webcrypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const wrongKey = await webcrypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const encrypted = await encryptData({ workouts: [{ id: 'test' }] }, key);
    const corrupted = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA`,
    };

    await assert.rejects(() => decryptData(corrupted, key));
    await assert.rejects(() => decryptData(encrypted, wrongKey));
    assert.deepEqual(await decryptData(encrypted, key), { workouts: [{ id: 'test' }] });
  });
});
