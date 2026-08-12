/**
 * ZK Fitness - Local IndexedDB persistence.
 *
 * Stores only encrypted blobs and the optional KEM ciphertext so plaintext
 * workout state does not touch disk through this persistence layer.
 */

const DB_NAME = 'zkfitness-db';
const DB_VERSION = 1;
const STORE_NAME = 'sync';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'username' });
      }
    };
  });
}

export async function saveLocalData(username, encryptedBlob, kemCiphertext = '') {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = { username, encryptedBlob, kemCiphertext, updatedAt: Date.now() };
    const request = store.put(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function loadLocalData(username) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(username);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const result = request.result;
      if (!result) return resolve(null);
      resolve({
        exists: true,
        encryptedBlob: result.encryptedBlob,
        kemCiphertext: result.kemCiphertext || '',
      });
    };
  });
}

export async function clearLocalData(username) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(username);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

