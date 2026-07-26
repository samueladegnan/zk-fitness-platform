/**
 * ZK Fitness - Client Application
 *
 * - Derives auth and encryption keys from the password using Argon2id + HKDF.
 * - Encrypts/decrypts workout data with Web Crypto API (AES-256-GCM).
 * - Runs the gamification engine (XP, tonnage, streak, levels, badges, PRs) in the browser.
 * - NEW: Demo/portfolio mode, empty workouts, rest +/-30s, warmup helper,
 *        barbell math, confetti, sounds, plan editor, and history editing.
 */

import {
  calculateOneRepMax,
  formatOneRm,
  averageOneRm,
  xpForSet,
  xpForWorkout,
  totalTonnage,
  totalCardioDistance,
  totalCardioCalories,
  totalCardioDuration,
  computeStats,
  getLevel,
  xpToNextLevel,
  getPR,
  getRecentPRs,
  currentStreak,
  escapeHtml,
  getLevenshteinDistance,
  getExerciseHistory,
  getExerciseRecords,
  getBestOneRepMax,
} from './lib/fitness.js';
import { getExerciseById, EXERCISE_CATALOG } from './exercises.js';

// API_BASE can be overridden for production by setting window.ZK_API_BASE
// (e.g. via an inline <script> in index.html or a CI build step).
const API_BASE =
  (typeof window !== 'undefined' && window.ZK_API_BASE) ||
  (typeof window !== 'undefined' && window.location.hostname !== 'localhost'
    ? '/api'
    : 'http://localhost:3000/api');

// In-memory session state (never persists to disk unencrypted except in demo mode)
let session = {
  username: null,
  token: null,
  dsaKeyPair: null,
  kemKeyPair: null,
  encKey: null, // demo mode only
  salt: null,
  data: {
    plans: [],
    workouts: [],
    customExercises: [],
    preferences: { defaultRestSeconds: 90, units: 'kg' },
  },
};

let isRegisterMode = true;
let isAuthenticated = false;
let isDemoMode = false;
let globalTimerInterval = null;
let restTimerInterval = null;
let restEndTime = 0;
let currentView = 'auth-view';
let syncTimeout = null;

// API failure debounce: suppress toasts until a burst of failures occurs.
let apiFailureState = { count: 0, timer: null, lastErr: null };
const API_FAILURE_THRESHOLD = 3;
const API_FAILURE_WINDOW_MS = 10000;



function flushApiErrors() {
  const { lastErr, onFlush } = apiFailureState;
  if (onFlush) {
    onFlush(lastErr);
  } else if (lastErr) {
    showToast(lastErr.message || 'Network error', 'error');
  }
  resetApiFailureState();
}

function markApiSuccess() {
  if (apiFailureState.count > 0 || apiFailureState.timer) {
    resetApiFailureState();
  }
}

function reportApiError(err, onFlush) {
  apiFailureState.count += 1;
  apiFailureState.lastErr = err;
  if (onFlush) apiFailureState.onFlush = onFlush;

  if (apiFailureState.count >= API_FAILURE_THRESHOLD) {
    flushApiErrors();
    return;
  }

  if (!apiFailureState.timer) {
    apiFailureState.timer = setTimeout(() => {
      if (apiFailureState.count > 0) {
        flushApiErrors();
      }
    }, API_FAILURE_WINDOW_MS);
  }
}

function resetApiFailureState() {
  clearTimeout(apiFailureState.timer);
  apiFailureState = { count: 0, timer: null, lastErr: null, onFlush: null };
}

// ─── Demo Mode Constants ────────────────────────────────────────────────────
const DEMO_KEY_BASE64 = 'demo-demo-demo-demo-demo-demo-demo-demo'; // 32 bytes placeholder handled below
const DEMO_STORAGE_KEY = 'zkfitness_demo_data';

// Callback for the shared security/demonstration modal.
let securityModalCallback = null;

// Track whether a loading modal is currently shown so nested calls don't hide it early.
let loadingModalDepth = 0;

// ─── Crypto Utilities ───────────────────────────────────────────────────────

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

function bufferFromString(str) {
  return new TextEncoder().encode(str);
}

async function deriveSalt(username) {
  const input = `zkfitness:salt:v1:${username}`;
  const hash = await crypto.subtle.digest('SHA-256', bufferFromString(input));
  return new Uint8Array(hash);
}

async function deriveKeys(masterPassword, salt) {
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

// ─── Proof-of-Work Solver ───────────────────────────────────────────────────

function hexLeadingZeroBits(hex) {
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

async function solvePoW(authKeyHash, nonce, difficulty) {
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

async function getDemoEncKey() {
  // Demo mode uses a fixed, non-secret key because data lives only in localStorage.
  const raw = new Uint8Array(32);
  for (let i = 0; i < raw.length; i++) raw[i] = i;
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptData(data, keyOrKemPublic) {
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

async function decryptData(encrypted, keyOrKemSecret) {
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

// ─── API Helpers ──────────────────────────────────────────────────────────────

function isBackendLikelyConfigured() {
  // If API_BASE still points to localhost but the page is served from
  // a non-localhost origin (e.g. GitHub Pages), the backend is not configured.
  const isLocalBackend = API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1');
  const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  return !isLocalBackend || isLocalHost;
}

async function api(path, options = {}) {
  if (isDemoMode) {
    return demoApi(path, options);
  }

  if (!isBackendLikelyConfigured()) {
    throw new Error('Backend not configured. The live demo requires a deployed API; please use Demo Mode for now.');
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  } catch (networkErr) {
    throw new Error('Unable to reach the backend. Please check your connection and try again. If the backend has just started, it may need 30–60 seconds to become available.');
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);
  markApiSuccess();
  return body;
}

async function demoApi(path, options) {
  await new Promise((r) => setTimeout(r, 30)); // Simulate network latency
  const method = options.method || 'GET';
  if (path === '/sync' && method === 'GET') {
    const stored = localStorage.getItem(DEMO_STORAGE_KEY);
    const kemCiphertext = localStorage.getItem(`${DEMO_STORAGE_KEY}_kem`) || '';
    return { exists: !!stored, encryptedBlob: stored, kemCiphertext };
  }
  if (path === '/sync' && method === 'PUT') {
    const body = JSON.parse(options.body);
    localStorage.setItem(DEMO_STORAGE_KEY, body.encryptedBlob);
    if (body.kemCiphertext) localStorage.setItem(`${DEMO_STORAGE_KEY}_kem`, body.kemCiphertext);
    return { message: 'Demo sync stored' };
  }
  if (path === '/auth/challenge') {
    return { nonce: 'demo-challenge-nonce', difficulty: 4 };
  }
  if (path.startsWith('/auth/')) {
    return { token: 'demo-token', username: 'Demo User' };
  }
  return {};
}

// ─── Gamification Engine ────────────────────────────────────────────────────

function isCardioExercise(exerciseId) {
  return getExercise(exerciseId).category === 'Cardio';
}

function computeBadges(stats) {
  const badges = [];
  if (stats.workouts >= 1) badges.push({ id: 'first_workout', name: 'First Workout', icon: '️' });
  if (stats.workouts >= 10) badges.push({ id: 'dedication', name: 'Dedication', icon: '🔥' });
  if (stats.workouts >= 50) badges.push({ id: 'veteran', name: 'Veteran', icon: '💪' });
  if (stats.tonnage >= 10000) badges.push({ id: 'heavy_lifter', name: 'Heavy Lifter', icon: '🏆' });
  if (stats.totalXp >= 1000) badges.push({ id: 'xp_grinder', name: 'XP Grinder', icon: '⭐' });
  return badges;
}

// ─── Auto-populate helpers ───────────────────────────────────────────────────

function getLastSetValues(exerciseId) {
  for (const w of session.data.workouts) {
    const ex = w.exercises.find((e) => e.exerciseId === exerciseId);
    if (!ex) continue;
    for (let i = ex.sets.length - 1; i >= 0; i--) {
      const s = ex.sets[i];
      if (s.type === 'working') return s;
    }
  }
  return null;
}

function getLastExerciseSettings(exerciseId) {
  for (const w of session.data.workouts) {
    const ex = w.exercises.find((e) => e.exerciseId === exerciseId);
    if (ex) return ex;
  }
  return null;
}

// ─── Exercise & Workout Helpers ─────────────────────────────────────────────

function getExercise(id) {
  const custom = (session.data.customExercises || []).find((ex) => ex.id === id);
  if (custom) return custom;
  return getExerciseById(id) || { id, name: id, category: 'Custom', equipment: 'Other', defaultRestSeconds: 90 };
}

function createSet(type = 'working', exerciseId = null) {
  const last = type === 'working' && exerciseId ? getLastSetValues(exerciseId) : null;
  return {
    id: crypto.randomUUID(),
    type,
    weight: last ? last.weight : '',
    reps: last ? last.reps : '',
    rpe: last ? last.rpe : '',
    // Cardio fields
    distance: last ? last.distance : '',
    durationMinutes: last ? last.durationMinutes : '',
    heartRate: last ? last.heartRate : '',
    calories: last ? last.calories : '',
    done: false,
    xp: 0,
  };
}

function renderSetFields(exercise, set, exIndex, setIndex, isCardio) {
  const equipment = escapeHtml(getExercise(exercise.exerciseId).equipment || '');
  if (isCardio) {
    return `
      <div class="set-field">
        <label>Dist (${session.data.preferences.units === 'kg' ? 'km' : 'mi'})</label>
        <input type="number" step="0.1" value="${set.distance}" data-idx="${exIndex}" data-set="${setIndex}" data-field="distance" />
      </div>
      <div class="set-field">
        <label>Time (min)</label>
        <input type="number" step="0.1" value="${set.durationMinutes}" data-idx="${exIndex}" data-set="${setIndex}" data-field="durationMinutes" />
      </div>
      <div class="set-field">
        <label>HR</label>
        <input type="number" placeholder="bpm" value="${set.heartRate}" data-idx="${exIndex}" data-set="${setIndex}" data-field="heartRate" />
      </div>
      <div class="set-field">
        <label>Kcal</label>
        <input type="number" placeholder="kcal" value="${set.calories}" data-idx="${exIndex}" data-set="${setIndex}" data-field="calories" />
      </div>
    `;
  }
  return `
    <div class="set-field">
      <label>Weight (${session.data.preferences.units || 'kg'})</label>
      <input type="number" placeholder="${session.data.preferences.units || 'kg'}" value="${set.weight}" data-idx="${exIndex}" data-set="${setIndex}" data-field="weight" class="weight-input" data-equipment="${equipment}" />
    </div>
    <div class="set-field">
      <label>Reps</label>
      <input type="number" placeholder="reps" value="${set.reps}" data-idx="${exIndex}" data-set="${setIndex}" data-field="reps" />
    </div>
  `;
}

function createWorkoutExercise(exerciseId, targetSets = 3, targetReps = 8, restSeconds = null) {
  const ex = getExercise(exerciseId);
  restSeconds = restSeconds || ex.defaultRestSeconds || session.data.preferences.defaultRestSeconds;
  const last = getLastExerciseSettings(exerciseId);
  return {
    id: crypto.randomUUID(),
    exerciseId,
    targetSets: last && last.sets.length > 0 ? last.sets.length : targetSets,
    targetReps: last ? last.targetReps : targetReps,
    restSeconds: last ? last.restSeconds : restSeconds,
    sets: [createSet('working', exerciseId)],
  };
}

function generateWarmupSets(workingWeight) {
  if (!workingWeight || workingWeight <= 0) return [];
  const warmups = [
    { factor: 0.5, reps: 10 },
    { factor: 0.7, reps: 8 },
    { factor: 0.9, reps: 5 },
  ];
  return warmups.map((w) => ({ weight: Math.round(workingWeight * w.factor), reps: w.reps }));
}

function addWarmupSets(workoutExercise, workingWeight) {
  const weight = workingWeight || findWorkingWeight(workoutExercise);
  if (!weight || weight <= 0) return null;
  const warmups = generateWarmupSets(weight);
  const newSets = warmups.map((w) => ({ ...createSet('warmup'), weight: w.weight, reps: w.reps }));
  // Remove existing warmup sets to avoid duplicates.
  workoutExercise.sets = workoutExercise.sets.filter((s) => s.type !== 'warmup');
  workoutExercise.sets = [...newSets, ...workoutExercise.sets];
  return workoutExercise;
}

function findWorkingWeight(workoutExercise) {
  const working = [...workoutExercise.sets].reverse().find((s) => s.type === 'working');
  if (working && working.weight > 0) return working.weight;
  return null;
}

function createPlan(name, exercises) {
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    exercises: exercises.map((e) => createWorkoutExercise(e.exerciseId, e.targetSets, e.targetReps, e.restSeconds)),
  };
}

function seedPlans() {
  return [
    createPlan('Full Body A', [
      { exerciseId: 'squat', targetSets: 3, targetReps: 5 },
      { exerciseId: 'bench_press', targetSets: 3, targetReps: 5 },
      { exerciseId: 'deadlift', targetSets: 1, targetReps: 5 },
      { exerciseId: 'overhead_press', targetSets: 3, targetReps: 8 },
      { exerciseId: 'lat_pulldown', targetSets: 3, targetReps: 10 },
    ]),
    createPlan('Upper / Lower', [
      { exerciseId: 'bench_press', targetSets: 3, targetReps: 8 },
      { exerciseId: 'dumbbell_shoulder_press', targetSets: 3, targetReps: 10 },
      { exerciseId: 'lat_pulldown', targetSets: 3, targetReps: 10 },
      { exerciseId: 'barbell_curl', targetSets: 3, targetReps: 12 },
      { exerciseId: 'tricep_pushdown', targetSets: 3, targetReps: 12 },
    ]),
  ];
}

// ─── Active Workout Persistence ──────────────────────────────────────────────

function getActiveWorkout() {
  return session.data.activeWorkout || null;
}

function setActiveWorkout(workout) {
  session.data.activeWorkout = workout;
  syncData();
}

function clearActiveWorkout() {
  delete session.data.activeWorkout;
  syncDataImmediate();
}

function startGlobalTimer() {
  clearInterval(globalTimerInterval);
  globalTimerInterval = setInterval(() => {
    updateActiveWorkoutBanner();
  }, 1000);
}

function stopGlobalTimer() {
  clearInterval(globalTimerInterval);
  globalTimerInterval = null;
}

function formatDuration(startTime) {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function updateActiveWorkoutBanner() {
  const banner = $('active-workout-banner');
  if (!banner) return;
  const workout = getActiveWorkout();
  if (!workout) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const timer = $('active-workout-timer');
  if (timer) timer.textContent = formatDuration(workout.startTime);

  const workoutTimer = $('workout-timer');
  if (workoutTimer) workoutTimer.textContent = formatDuration(workout.startTime);

  const resumeBtn = $('resume-workout-btn');
  if (resumeBtn) {
    if (currentView === 'workout-view') {
      resumeBtn.classList.add('hidden');
    } else {
      resumeBtn.classList.remove('hidden');
    }
  }
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showToast(message, type = 'info') {
  let toast = $('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = type === 'error' ? 'toast toast-error' : 'toast toast-info';
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 4000);
}

function toggleUnits() {
  const current = session.data.preferences.units || 'kg';
  session.data.preferences.units = current === 'kg' ? 'lbs' : 'kg';
  syncDataImmediate();
  return session.data.preferences.units;
}

// ─── Custom Modal (replaces alert/confirm/prompt) ───────────────────────────

function openAppModal({ title = 'Confirm', message, confirmText = 'OK', cancelText = 'Cancel', prompt = false, defaultValue = '', promptLabel = '' }) {
  return new Promise((resolve) => {
    const modal = $('app-modal');
    const titleEl = $('app-modal-title');
    const messageEl = $('app-modal-message');
    const confirmBtn = $('app-modal-confirm');
    const cancelBtn = $('app-modal-cancel');
    const inputWrapper = $('app-modal-input-wrapper');
    const inputLabel = $('app-modal-input-label');
    const input = $('app-modal-input');

    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    input.value = defaultValue;

    if (inputLabel) {
      if (prompt && promptLabel) {
        inputLabel.textContent = promptLabel;
        inputLabel.style.display = 'block';
        input.placeholder = promptLabel;
      } else {
        inputLabel.textContent = '';
        inputLabel.style.display = 'none';
        input.placeholder = '';
      }
    }

    cancelBtn.classList.remove('hidden');

    if (prompt) {
      inputWrapper.classList.remove('hidden');
      setTimeout(() => input.focus(), 50);
    } else {
      inputWrapper.classList.add('hidden');
      setTimeout(() => confirmBtn.focus(), 50);
    }

    let resolved = false;
    function cleanup() {
      modal.classList.add('hidden');
      inputWrapper.classList.add('hidden');
      cancelBtn.classList.remove('hidden');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
      modal.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeyDown);
    }

    confirmBtn.onclick = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(prompt ? input.value : true);
    };

    cancelBtn.onclick = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(prompt ? null : false);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmBtn.click();
      }
    };

    modal.classList.remove('hidden');

    function onBackdropClick(e) {
      if (e.target === modal) {
        cancelBtn.click();
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelBtn.click();
      }
    }

    modal.addEventListener('click', onBackdropClick);
    document.addEventListener('keydown', onKeyDown);
  });
}

function setTheme(isDark) {
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function initTheme() {
  const saved = localStorage.getItem('zkfitness_theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    setTheme(true);
  }
  const toggle = $('theme-toggle');
  if (toggle) {
    toggle.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
    toggle.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      setTheme(!isDark);
      localStorage.setItem('zkfitness_theme', isDark ? 'light' : 'dark');
      toggle.textContent = isDark ? '🌙' : '☀️';
    });
  }
}

function evaluatePasswordStrength(password) {
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  return Math.min(5, score);
}

function renderPasswordStrength(password) {
  const meter = $('password-strength');
  if (!meter) return;
  if (!password) {
    meter.textContent = '';
    meter.className = 'password-strength';
    return;
  }
  const score = evaluatePasswordStrength(password);
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Excellent'];
  meter.textContent = labels[score];
  meter.className = `password-strength strength-${score}`;
}

async function performPasswordAuth(username, password, inviteCode) {
  const salt = await deriveSalt(username);
  const { dsaKeyPair, kemKeyPair } = await deriveKeys(password, salt);
  session = { ...session, username, dsaKeyPair, kemKeyPair, salt };

  const dsaPublicKeyBase64 = arrayBufferToBase64(dsaKeyPair.publicKey);
  const kemPublicKeyBase64 = arrayBufferToBase64(kemKeyPair.publicKey);

  if (isRegisterMode) {
    // Solve a proof-of-work challenge before registering to discourage bots.
    let challengePayload = {};
    try {
      const challengeRes = await api('/auth/challenge');
      const solution = await solvePoW(dsaPublicKeyBase64, challengeRes.nonce, challengeRes.difficulty || 12);
      challengePayload = { challenge: challengeRes.nonce, solution };
    } catch (err) {
      // If the backend does not support challenges yet, fall back gracefully.
      if (!err.message?.includes('Not found') && !err.message?.includes('not configured')) {
        throw err;
      }
    }

    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username,
        dsaPublicKey: dsaPublicKeyBase64,
        kemPublicKey: kemPublicKeyBase64,
        ...challengePayload,
        inviteCode,
      }),
    });
  } else {
    // Two-step PQC login: get a nonce from the server, then sign it with the
    // user's ML-DSA private key. The server never sees the private key.
    const nonceRes = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
    if (!nonceRes.nonce) throw new Error('Server did not return a login nonce.');

    const signature = window.NoblePQC.ml_dsa65.sign(bufferFromString(nonceRes.nonce), dsaKeyPair.secretKey);
    await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username,
        signature: arrayBufferToBase64(signature),
      }),
    });
  }

  isAuthenticated = true;
  renderNav();
  await loadSync();
  showView('dashboard-view');
  renderDashboard();

  // Show the zero-knowledge security modal once after registration.
  if (isRegisterMode) {
    openSecurityModal('Continue', () => {});
  }
}

function openSecurityModal(label, callback) {
  securityModalCallback = callback;
  const btn = $('start-demo-confirm-btn');
  if (btn) btn.textContent = label;
  const modal = $('demo-modal');
  if (modal) modal.classList.remove('hidden');
}

function setAuthFormDisabled(disabled) {
  const authForm = $('auth-form');
  const authBtn = $('auth-btn');
  if (authForm) {
    authForm.setAttribute('aria-busy', String(disabled));
    authForm.querySelectorAll('input, button').forEach((el) => { el.disabled = disabled; });
  }
  if (authBtn) authBtn.disabled = disabled;
}

function showLoadingModal(message) {
  loadingModalDepth += 1;
  const modal = $('loading-modal');
  const msgEl = $('loading-modal-message');
  if (msgEl && message) msgEl.textContent = message;
  if (modal) modal.classList.remove('hidden');
  setAuthFormDisabled(true);
}

function hideLoadingModal() {
  if (loadingModalDepth > 0) loadingModalDepth -= 1;
  if (loadingModalDepth === 0) {
    const modal = $('loading-modal');
    if (modal) modal.classList.add('hidden');
    setAuthFormDisabled(false);
  }
}

function initAuthUI() {
  const authForm = $('auth-form');
  const authBtn = $('auth-btn');
  const toggleBtn = $('toggle-mode');

  function updateInviteField() {
    const inviteField = $('invite-code-field');
    if (inviteField) inviteField.classList.toggle('hidden', !isRegisterMode);
  }

  toggleBtn.addEventListener('click', () => {
    isRegisterMode = !isRegisterMode;
    authBtn.textContent = isRegisterMode ? 'Register' : 'Log in';
    toggleBtn.textContent = isRegisterMode ? 'Already have an account? Log in' : 'Need an account? Register';
    updateInviteField();
  });

  updateInviteField();

  const passwordInput = $('password');
  if (passwordInput) {
    passwordInput.addEventListener('input', (e) => renderPasswordStrength(e.target.value));
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('auth-error').textContent = '';
    const username = $('username').value.trim();
    const password = $('password').value;

    if ($('website').value) {
      $('auth-error').textContent = 'Something went wrong. Please try again.';
      return;
    }

    const inviteCode = $('invite-code')?.value.trim() || undefined;

    if (isRegisterMode) {
      const score = evaluatePasswordStrength(password);
      if (score < 3) {
        $('auth-error').textContent = 'Password is too weak. Use at least 12 characters with mixed case, numbers, and symbols.';
        return;
      }
    }

    const actionText = isRegisterMode ? 'Creating your account' : 'Logging you in';
    showLoadingModal(`${actionText}. Please wait.`);

    try {
      await performPasswordAuth(username, password, inviteCode);
    } catch (err) {
      $('auth-error').textContent = err.message;
    } finally {
      hideLoadingModal();
    }
  });

  const demoBtn = $('demo-mode-btn');
  if (demoBtn) {
    demoBtn.addEventListener('click', () => {
      openSecurityModal('Start Demo', startDemoMode);
    });
  }

  const confirmDemoBtn = $('start-demo-confirm-btn');
  if (confirmDemoBtn) {
    confirmDemoBtn.addEventListener('click', () => {
      const modal = $('demo-modal');
      if (modal) modal.classList.add('hidden');
      if (securityModalCallback) {
        securityModalCallback();
        securityModalCallback = null;
      }
    });
  }

  const cancelDemoBtn = $('cancel-demo-btn');
  if (cancelDemoBtn) {
    cancelDemoBtn.addEventListener('click', () => {
      const modal = $('demo-modal');
      if (modal) modal.classList.add('hidden');
    });
  }
}

async function startDemoMode() {
  try {
    isDemoMode = true;
    session.username = 'Demo User';
    session.token = 'demo-token';
    session.encKey = await getDemoEncKey();
    session.salt = new Uint8Array(32);

    const res = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'demo', authKeyHash: 'demo' }),
    });
    session.token = res.token;

    isAuthenticated = true;
    renderNav();
    await loadSync();
    showView('dashboard-view');
    renderDashboard();
    showToast('Demo mode active. Your data is stored locally', 'info');
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
}

function showView(viewId) {
  if (!isAuthenticated && viewId !== 'auth-view') {
    viewId = 'auth-view';
  }
  currentView = viewId;
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  $(viewId).classList.remove('hidden');
  updateActiveWorkoutBanner();
}

function renderNav() {
  const nav = $('nav');
  if (!isAuthenticated) {
    nav.innerHTML = '';
    return;
  }
  nav.innerHTML = `
    <button class="link" id="nav-dashboard">Dashboard</button>
    <button class="link" id="nav-plans">Plans</button>
    <button class="link" id="nav-history">History</button>
    <button class="link" id="nav-exercises">Exercises</button>
    <button class="link" id="nav-logout">Log out</button>
  `;
  $('nav-dashboard').addEventListener('click', () => { showView('dashboard-view'); renderDashboard(); });
  $('nav-plans').addEventListener('click', () => { showView('plans-view'); renderPlans(); });
  $('nav-history').addEventListener('click', () => { showView('history-view'); renderHistory(); });
  $('nav-exercises').addEventListener('click', () => { exerciseSelectCallback = null; showView('exercises-view'); renderExercises(); });
  $('nav-logout').addEventListener('click', logout);
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error('Logout API call failed:', err);
  }
  session = {
    username: null,
    token: null,
    dsaKeyPair: null,
    kemKeyPair: null,
    encKey: null,
    salt: null,
    data: {
      plans: [],
      workouts: [],
      customExercises: [],
      preferences: { defaultRestSeconds: 90, units: 'kg' },
    },
  };
  stopGlobalTimer();
  clearInterval(restTimerInterval);
  isAuthenticated = false;
  isDemoMode = false;
  renderNav();
  showView('auth-view');
  $('auth-error').textContent = 'You have been logged out.';
}

function renderDashboard() {
  const startEmptyBtn = $('start-empty-workout');
  if (startEmptyBtn) {
    startEmptyBtn.onclick = () => startEmptyWorkout();
  }

  const stats = computeStats(session.data.workouts);
  const level = getLevel(stats.totalXp);
  const xpInfo = xpToNextLevel(stats.totalXp);
  const badges = computeBadges(stats);
  const recentPRs = getRecentPRs(session.data.workouts, 3, getExercise);
  const units = session.data.preferences.units || 'kg';

  const unitsBtn = $('units-toggle');
  if (unitsBtn) {
    unitsBtn.textContent = `Units: ${units}`;
    unitsBtn.onclick = () => {
      toggleUnits();
      renderDashboard();
    };
  }

  $('stat-xp').textContent = stats.totalXp.toLocaleString();
  $('stat-tonnage').textContent = `${stats.tonnage.toLocaleString()} ${units}`;
  $('stat-workouts').textContent = stats.workouts;
  $('stat-streak').textContent = currentStreak(session.data.workouts);
  $('stat-level').textContent = level;
  $('stat-distance').textContent = `${stats.distance.toFixed(1)} ${session.data.preferences.units === 'kg' ? 'km' : 'mi'}`;
  $('stat-calories').textContent = `${stats.calories.toLocaleString()} kcal`;

  const progressPercent = Math.min(100, Math.round((xpInfo.current / xpInfo.range) * 100));
  $('xp-progress').style.width = `${progressPercent}%`;
  $('xp-progress-text').textContent = `${xpInfo.current}/${xpInfo.range} XP to next level`;

  const badgeContainer = $('badges-list');
  if (badges.length === 0) {
    badgeContainer.innerHTML = '<p class="muted">Finish a workout and your first badge will land here.</p>';
  } else {
    badgeContainer.innerHTML = badges.map((b) => `<span class="badge" title="${b.name}">${b.icon} ${b.name}</span>`).join('');
  }

  const prContainer = $('pr-list');
  if (recentPRs.length === 0) {
    prContainer.innerHTML = '<p class="muted">Log a workout and your latest personal records will show up here.</p>';
  } else {
    prContainer.innerHTML = recentPRs
      .map((pr) => `<div class="pr-item"><span>${getExercise(pr.exerciseId).name}</span><strong>${pr.weight}${units} × ${pr.reps}</strong></div>`)
      .join('');
  }

  const recent = session.data.workouts.slice(0, 5);
  const tbody = document.querySelector('#history-table tbody');
  tbody.innerHTML = '';
  if (recent.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" class="muted">No workouts yet-pick a plan and get moving!</td>`;
    tbody.appendChild(tr);
  } else {
    recent.forEach((w) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${new Date(w.date).toLocaleDateString()}</td>
        <td>${w.name}</td>
        <td>${w.exercises.length}</td>
        <td>${w.setsCount || 0}</td>
        <td>${w.xp || 0}</td>`;
      tbody.appendChild(tr);
    });
  }

}

// ─── Exercise Detail ────────────────────────────────────────────────────────

function renderExerciseChart(history, container, isCardio) {
  if (!history.length) {
    container.innerHTML = '<p class="muted">No data to chart yet.</p>';
    return;
  }

  const width = 600;
  const height = 220;
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const values = isCardio
    ? history.map((h) => h.distance)
    : history.map((h) => h.oneRm);
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values, 0);
  const range = Math.max(maxValue - minValue, 1);

  const xFor = (i) => padding.left + (i / Math.max(history.length - 1, 1)) * chartWidth;
  const yFor = (v) => padding.top + chartHeight - ((v - minValue) / range) * chartHeight;

  const points = history.map((h, i) => ({ x: xFor(i), y: yFor(isCardio ? h.distance : h.oneRm), value: isCardio ? h.distance : h.oneRm }));
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${isCardio ? 'Distance' : 'Estimated 1RM'} over time`);

  // Grid lines
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y2', y);
    line.style.stroke = 'var(--border)';
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }

  // Line path
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.style.stroke = 'var(--accent)';
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  // Data points
  points.forEach((p) => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x);
    circle.setAttribute('cy', p.y);
    circle.setAttribute('r', '4');
    circle.style.fill = 'var(--accent)';
    circle.style.stroke = 'var(--card)';
    circle.setAttribute('stroke-width', '2');
    svg.appendChild(circle);
  });

  // Labels
  const xAxisLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  xAxisLabel.setAttribute('x', width / 2);
  xAxisLabel.setAttribute('y', height - 5);
  xAxisLabel.setAttribute('text-anchor', 'middle');
  xAxisLabel.setAttribute('fill', 'var(--muted)');
  xAxisLabel.setAttribute('font-size', '12');
  xAxisLabel.textContent = 'Workout (oldest to newest)';
  svg.appendChild(xAxisLabel);

  const yAxisLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  yAxisLabel.setAttribute('x', 10);
  yAxisLabel.setAttribute('y', height / 2);
  yAxisLabel.setAttribute('fill', 'var(--muted)');
  yAxisLabel.setAttribute('font-size', '12');
  yAxisLabel.setAttribute('transform', `rotate(-90, 10, ${height / 2})`);
  yAxisLabel.textContent = isCardio ? 'Distance' : 'Estimated 1RM';
  svg.appendChild(yAxisLabel);

  container.innerHTML = '';
  container.appendChild(svg);
}

function openExerciseDetail(exerciseId) {
  const ex = getExercise(exerciseId);
  const history = getExerciseHistory(session.data.workouts, exerciseId);
  const records = getExerciseRecords(session.data.workouts, exerciseId, isCardioExercise);
  const isCardio = ex.category === 'Cardio';
  const units = session.data.preferences.units || 'kg';
  const modal = $('exercise-detail-modal');
  const body = $('exercise-detail-body');

  const best1rm = records && !isCardio ? Math.round(records.best1rm) : null;

  body.innerHTML = `
    <div class="exercise-detail-body">
      <div class="exercise-detail-header">
        <h2 id="exercise-detail-title">${escapeHtml(ex.name)}</h2>
        <div class="exercise-detail-meta">
          <span class="tag">${ex.category}</span>
          <span class="tag">${ex.equipment || 'Other'}</span>
          ${best1rm ? `<span class="tag">Best Est. 1RM: ${best1rm} ${units}</span>` : ''}
        </div>
      </div>

      <div class="exercise-detail-section">
        <h3>Records</h3>
        <div class="exercise-records-grid">
          ${isCardio ? `
            <div class="exercise-record-card">
              <span class="label">Max Distance</span>
              <span class="value">${records ? records.distance : '-'} ${units}</span>
            </div>
            <div class="exercise-record-card">
              <span class="label">Max Duration</span>
              <span class="value">${records ? `${records.duration} min` : '-'}</span>
            </div>
          ` : `
            <div class="exercise-record-card">
              <span class="label">Max Weight</span>
              <span class="value">${records ? `${records.maxWeight} ${units}` : '-'}</span>
            </div>
            <div class="exercise-record-card">
              <span class="label">Max Reps</span>
              <span class="value">${records ? records.maxReps : '-'}</span>
            </div>
            <div class="exercise-record-card">
              <span class="label">Best Est. 1RM</span>
              <span class="value">${best1rm ? `${best1rm} ${units}` : '-'}</span>
            </div>
          `}
        </div>
      </div>

      <div class="exercise-detail-section">
        <h3>Progress Chart</h3>
        <div class="exercise-detail-chart" id="exercise-chart"></div>
        <div class="chart-label">${isCardio ? 'Distance per workout' : 'Estimated one-rep max over time'}</div>
      </div>

      <div class="exercise-detail-section">
        <h3>1RM Calculator</h3>
        <div class="exercise-detail-1rm">
          <div class="set-field">
            <label>Weight (${units})</label>
            <input id="detail-1rm-weight" type="number" step="0.1" value="" />
          </div>
          <div class="set-field">
            <label>Reps</label>
            <input id="detail-1rm-reps" type="number" step="1" min="1" value="" />
          </div>
          <div class="exercise-detail-1rm-result">
            <strong id="detail-1rm-result">-</strong>
            <span>Estimated 1RM</span>
          </div>
        </div>
      </div>

      <div class="exercise-detail-section">
        <h3>History</h3>
        ${history.length === 0 ? '<p class="muted">No history for this exercise yet.</p>' : `
          <table class="exercise-history-table">
            <thead>
              ${isCardio ? '<tr><th>Date</th><th>Workout</th><th>Distance</th><th>Duration</th></tr>' : '<tr><th>Date</th><th>Workout</th><th>Weight</th><th>Reps</th><th>Est. 1RM</th></tr>'}
            </thead>
            <tbody>
              ${[...history].reverse().slice(0, 20).map((h) => isCardio ? `
                <tr>
                  <td>${new Date(h.date).toLocaleDateString()}</td>
                  <td>${escapeHtml(h.workoutName)}</td>
                  <td>${h.distance > 0 ? `${h.distance} ${units}` : '-'}</td>
                  <td>${h.durationMinutes > 0 ? `${h.durationMinutes} min` : '-'}</td>
                </tr>
              ` : `
                <tr>
                  <td>${new Date(h.date).toLocaleDateString()}</td>
                  <td>${escapeHtml(h.workoutName)}</td>
                  <td>${h.weight > 0 ? `${h.weight} ${units}` : '-'}</td>
                  <td>${h.reps > 0 ? h.reps : '-'}</td>
                  <td>${h.oneRm > 0 ? Math.round(h.oneRm) : '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `;

  // Render chart after the DOM exists.
  const chartContainer = $('exercise-chart');
  if (chartContainer) renderExerciseChart(history, chartContainer, isCardio);

  // Wire up the 1RM calculator.
  const weightInput = $('detail-1rm-weight');
  const repsInput = $('detail-1rm-reps');
  const resultEl = $('detail-1rm-result');
  if (weightInput && repsInput && resultEl) {
    const update = () => {
      const result = calculateOneRepMax(weightInput.value, repsInput.value);
      resultEl.textContent = formatOneRm(result ? (result.epley + result.brzycki) / 2 : null, units);
    };
    weightInput.addEventListener('input', update);
    repsInput.addEventListener('input', update);
    // Prefill with the best historical set if available.
    if (records && records.heaviestSet) {
      weightInput.value = records.heaviestSet.weight;
      repsInput.value = records.heaviestSet.reps;
      update();
    }
  }

  // Wire up modal buttons and accessibility.
  const closeBtn = $('exercise-detail-close');
  const addBtn = $('exercise-detail-add-to-workout');
  if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
  if (addBtn) {
    addBtn.onclick = () => {
      modal.classList.add('hidden');
      const workout = getActiveWorkout();
      if (workout) {
        workout.exercises.push(createWorkoutExercise(exerciseId));
        setActiveWorkout(workout);
        renderActiveWorkout();
      } else {
        showToast('No active workout. Start one from the dashboard or plans.', 'error');
      }
    };
  }

  modal.classList.remove('hidden');
  if (closeBtn) closeBtn.focus();

  // Focus trap for accessibility.
  const focusable = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  let focusables = Array.from(modal.querySelectorAll(focusable)).filter((el) => !el.disabled);

  function onDetailKeydown(e) {
    if (e.key === 'Escape') {
      modal.classList.add('hidden');
      cleanup();
      return;
    }
    if (e.key === 'Tab' && focusables.length > 0) {
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  function onDetailBackdrop(e) {
    if (e.target === modal) {
      modal.classList.add('hidden');
      cleanup();
    }
  }
  function cleanup() {
    document.removeEventListener('keydown', onDetailKeydown);
    modal.removeEventListener('click', onDetailBackdrop);
    focusables = [];
  }
  document.addEventListener('keydown', onDetailKeydown);
  modal.addEventListener('click', onDetailBackdrop);
}

function renderPlans() {
  const list = $('plans-list');
  const startEmptyPlansBtn = $('start-empty-workout-plans');
  if (startEmptyPlansBtn) {
    startEmptyPlansBtn.onclick = () => startEmptyWorkout();
  }
  if (session.data.plans.length === 0) {
    session.data.plans = seedPlans();
    syncData();
  }

  list.innerHTML = session.data.plans
    .map(
      (plan) => `
      <div class="plan-card" data-id="${plan.id}">
        <div class="plan-header">
          <h3>${plan.name}</h3>
          <span class="plan-meta">${plan.exercises.length} exercises</span>
        </div>
        <ul class="plan-exercises">
          ${plan.exercises.map((e) => `<li>${getExercise(e.exerciseId).name} - ${e.targetSets}x${e.targetReps}</li>`).join('')}
        </ul>
        <div class="plan-actions">
          <button class="btn-start" data-id="${plan.id}">Start Workout</button>
          <button class="secondary btn-edit-plan" data-id="${plan.id}">Edit</button>
          <button class="secondary btn-delete-plan" data-id="${plan.id}">🗑</button>
        </div>
      </div>
    `
    )
    .join('');

  list.querySelectorAll('.btn-start').forEach((btn) =>
    btn.addEventListener('click', () => startWorkout(btn.dataset.id))
  );
  list.querySelectorAll('.btn-edit-plan').forEach((btn) =>
    btn.addEventListener('click', () => openPlanEditor(btn.dataset.id))
  );
  list.querySelectorAll('.btn-delete-plan').forEach((btn) =>
    btn.addEventListener('click', () => deletePlan(btn.dataset.id))
  );

  const createBtn = $('create-plan-btn');
  if (createBtn) {
    createBtn.onclick = () => openPlanEditor(null);
  }
}

async function deletePlan(planId) {
  const confirmed = await openAppModal({
    title: 'Delete Plan',
    message: 'Delete this plan? This cannot be undone.',
    confirmText: 'Delete',
    cancelText: 'Cancel',
  });
  if (!confirmed) return;
  session.data.plans = session.data.plans.filter((p) => p.id !== planId);
  syncDataImmediate();
  renderPlans();
}

let planEditorDraft = null;
let planEditorCallback = null;

function openPlanEditor(planId) {
  showView('plan-editor-view');
  const container = $('plan-editor');
  const isNew = !planId;
  planEditorDraft = isNew
    ? { id: crypto.randomUUID(), name: 'New Plan', createdAt: new Date().toISOString(), exercises: [] }
    : JSON.parse(JSON.stringify(session.data.plans.find((p) => p.id === planId)));

  $('plan-editor-title').textContent = isNew ? 'Create Plan' : 'Edit Plan';

  function renderEditor() {
    container.innerHTML = `
      <div class="panel">
        <label>Plan Name</label>
        <input id="plan-name-input" type="text" value="${escapeHtml(planEditorDraft.name)}" />
        <div class="plan-editor-actions">
          <button id="save-plan-btn" class="btn-start">Save Plan</button>
          <button id="cancel-plan-btn" class="secondary">Cancel</button>
          <button id="add-exercise-to-plan" class="secondary">+ Add Exercise</button>
        </div>
      </div>
      <div id="plan-exercises-list" class="plan-exercises-edit">
        ${planEditorDraft.exercises
          .map(
            (e, idx) => `
          <div class="plan-exercise-row" data-idx="${idx}">
            <div class="plan-exercise-info">
              <strong>${getExercise(e.exerciseId).name}</strong>
              <span>${e.targetSets} sets × ${e.targetReps} reps • ${e.restSeconds}s rest</span>
            </div>
            <div class="plan-exercise-fields">
              <label>Sets <input type="number" data-idx="${idx}" data-field="targetSets" value="${e.targetSets}" /></label>
              <label>Reps <input type="number" data-idx="${idx}" data-field="targetReps" value="${e.targetReps}" /></label>
              <label>Rest <input type="number" data-idx="${idx}" data-field="restSeconds" value="${e.restSeconds}" /></label>
            </div>
            <button class="secondary btn-remove-plan-ex" data-idx="${idx}">Remove</button>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    $('save-plan-btn').addEventListener('click', () => {
      const name = $('plan-name-input').value.trim();
      if (!name) {
        showToast('Plan name is required.', 'error');
        return;
      }
      planEditorDraft.name = name;
      const idx = session.data.plans.findIndex((p) => p.id === planEditorDraft.id);
      if (idx >= 0) {
        session.data.plans[idx] = planEditorDraft;
      } else {
        session.data.plans.push(planEditorDraft);
      }
      planEditorCallback = null;
      exerciseSelectCallback = null;
      syncDataImmediate();
      showView('plans-view');
      renderPlans();
    });

    $('cancel-plan-btn').addEventListener('click', () => {
      planEditorCallback = null;
      exerciseSelectCallback = null;
      showView('plans-view');
      renderPlans();
    });

    $('add-exercise-to-plan').addEventListener('click', () => {
      planEditorCallback = (exerciseId) => {
        planEditorCallback = null;
        planEditorDraft.exercises.push(createWorkoutExercise(exerciseId));
        showView('plan-editor-view');
        renderEditor();
      };
      showView('exercises-view');
      exerciseSelectCallback = (exerciseId) => {
        if (planEditorCallback) {
          planEditorCallback(exerciseId);
        }
        exerciseSelectCallback = null;
      };
      renderExercises('Add to Plan');
    });

    container.querySelectorAll('.plan-exercise-fields input').forEach((input) => {
      input.addEventListener('change', (e) => {
        const idx = Number(e.target.dataset.idx);
        const field = e.target.dataset.field;
        const val = e.target.value === '' ? 0 : Number(e.target.value);
        planEditorDraft.exercises[idx][field] = val;
      });
    });

    container.querySelectorAll('.btn-remove-plan-ex').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        planEditorDraft.exercises.splice(idx, 1);
        renderEditor();
      });
    });
  }

  renderEditor();
}

let exerciseSelectCallback = null;
let exerciseSelectButtonText = 'Add to Workout';

function renderExercises(buttonText = null) {
  const container = $('exercises-list');
  exerciseSelectButtonText = buttonText || exerciseSelectButtonText || 'Add to Workout';
  const cats = ['All', ...new Set(EXERCISE_CATALOG.map((e) => e.category))];

  container.innerHTML = `
    <div class="exercise-search-box">
      <span aria-hidden="true">🔍</span>
      <input id="exercise-search" type="search" placeholder="Search exercises, categories, or equipment…" aria-label="Search exercises" autocomplete="off" />
      <button id="toggle-custom-ex" type="button" aria-expanded="false" aria-controls="custom-exercise-panel" title="Add a custom exercise">+</button>
    </div>
    <div id="custom-exercise-panel" class="panel custom-exercise-form hidden" hidden>
      <h3>Add a Custom Exercise</h3>
      <div class="row">
        <input id="custom-ex-name" type="text" placeholder="Exercise name" />
        <select id="custom-ex-category">
          <option value="Custom">Custom</option>
          ${[...new Set(EXERCISE_CATALOG.map((e) => e.category))].map((c) => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <input id="custom-ex-equipment" type="text" placeholder="Equipment (optional)" />
        <button id="add-custom-ex" type="button">Add Exercise</button>
      </div>
    </div>
    <div class="filter-row" role="group" aria-label="Filter by category">
      ${cats.map((c) => `<button class="filter-btn" data-cat="${c}">${c}</button>`).join('')}
    </div>
    <div id="exercises-grid"></div>
  `;

  const customPanel = $('custom-exercise-panel');
  const toggleBtn = $('toggle-custom-ex');
  toggleBtn.addEventListener('click', () => {
    const isHidden = customPanel.classList.contains('hidden');
    customPanel.classList.toggle('hidden', !isHidden);
    customPanel.hidden = !isHidden;
    toggleBtn.setAttribute('aria-expanded', String(isHidden));
    toggleBtn.textContent = isHidden ? '−' : '+';
    if (isHidden) $('custom-ex-name').focus();
  });

  $('add-custom-ex').addEventListener('click', () => {
    const name = $('custom-ex-name').value.trim();
    const category = $('custom-ex-category').value;
    const equipment = $('custom-ex-equipment').value.trim() || 'Other';
    if (!name) {
      showToast('Exercise name is required.', 'error');
      return;
    }
    if (session.data.customExercises.some((ex) => ex.name.toLowerCase() === name.toLowerCase())) {
      showToast('An exercise with that name already exists.', 'error');
      return;
    }
    const id = `custom_${crypto.randomUUID()}`;
    session.data.customExercises.push({ id, name, category, equipment, defaultRestSeconds: 90 });
    syncDataImmediate();
    $('custom-ex-name').value = '';
    renderExercises();
    showToast(`${name} added to your exercise list.`, 'info');
  });

  function renderGrid(category, searchQuery = '') {
    const grid = $('exercises-grid');
    const custom = session.data.customExercises || [];

    const builtIn =
      category === 'All' ? EXERCISE_CATALOG : EXERCISE_CATALOG.filter((e) => e.category === category);
    let all = category === 'All' ? [...builtIn, ...custom] : [...builtIn, ...custom.filter((e) => e.category === category)];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const qTokens = q.split(/\s+/);
      const ranked = all
        .map((ex) => {
          const name = ex.name.toLowerCase();
          const cat = ex.category.toLowerCase();
          const equip = ex.equipment.toLowerCase();
          let score = 0;

          // Strong matches still win.
          if (name.startsWith(q)) score += 100;
          else if (name.includes(q)) score += 50;

          if (cat.startsWith(q)) score += 30;
          else if (cat.includes(q)) score += 15;
          if (equip.includes(q)) score += 10;

          // Fuzzy typo matching for each query token.
          if (score < 50) {
            const nameTokens = name.split(/\s+/);
            for (const qWord of qTokens) {
              if (qWord.length <= 2) continue;
              let bestDist = Infinity;
              for (const nWord of nameTokens) {
                if (Math.abs(qWord.length - nWord.length) <= 2) {
                  bestDist = Math.min(bestDist, getLevenshteinDistance(qWord, nWord));
                }
              }
              if (bestDist <= 2) {
                score += 20 - bestDist * 5;
              }
            }
          }

          return { ex, score };
        })
        .filter((i) => i.score > 0)
        .sort((a, b) => b.score - a.score);
      all = ranked.map((i) => i.ex);
    }

    if (all.length === 0) {
      grid.innerHTML = `<p class="muted">No exercises match your search. Try a different term or add a custom exercise.</p>`;
      return;
    }

    const customIds = new Set((session.data.customExercises || []).map((ex) => ex.id));
    const inSelectionMode = Boolean(exerciseSelectCallback);

    grid.innerHTML = all
      .map(
        (ex) => `
        <div class="exercise-card" data-id="${ex.id}">
          <h4 class="exercise-card-name" data-id="${ex.id}">${ex.name}</h4>
          <span class="tag">${ex.category}</span>
          <span class="tag">${ex.equipment}</span>
          <div class="exercise-card-actions">
            ${inSelectionMode ? `<button class="secondary btn-add-to-workout" data-id="${ex.id}">${exerciseSelectButtonText || 'Add to Workout'}</button>` : ''}
            ${!inSelectionMode && customIds.has(ex.id) ? `<button class="secondary btn-delete-custom-ex" data-id="${ex.id}" aria-label="Delete ${escapeHtml(ex.name)}">🗑</button>` : ''}
          </div>
        </div>
      `
      )
      .join('');

    if (exerciseSelectCallback) {
      grid.querySelectorAll('.btn-add-to-workout').forEach((btn) => {
        btn.addEventListener('click', () => exerciseSelectCallback(btn.dataset.id));
      });
    }

    // Click exercise name to view details.
    grid.querySelectorAll('.exercise-card-name').forEach((title) => {
      title.addEventListener('click', (e) => {
        e.stopPropagation();
        openExerciseDetail(title.dataset.id);
      });
    });

    grid.querySelectorAll('.btn-delete-custom-ex').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const confirmed = await openAppModal({
          title: 'Delete Custom Exercise',
          message: 'Delete this custom exercise? It will no longer appear in your catalog; existing workouts that use it will fall back to the raw exercise ID.',
          confirmText: 'Delete',
          cancelText: 'Cancel',
        });
        if (!confirmed) return;
        session.data.customExercises = session.data.customExercises.filter((ex) => ex.id !== btn.dataset.id);
        syncDataImmediate();
        const activeCat = container.querySelector('.filter-btn.active')?.dataset.cat || 'All';
        renderGrid(activeCat, searchInput ? searchInput.value : '');
      });
    });
  }

  const searchInput = $('exercise-search');
  let searchDebounce;
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      const activeCat = container.querySelector('.filter-btn.active')?.dataset.cat || 'All';
      searchDebounce = setTimeout(() => renderGrid(activeCat, e.target.value), 150);
    });
  }

  container.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const query = searchInput ? searchInput.value : '';
      renderGrid(btn.dataset.cat, query);
    });
  });

  const initialActive = container.querySelector('[data-cat="All"]');
  if (initialActive) initialActive.classList.add('active');
  renderGrid('All');
}

async function startWorkout(planId, nameOverride) {
  const plan = planId ? session.data.plans.find((p) => p.id === planId) : null;

  if (getActiveWorkout()) {
    const confirmed = await openAppModal({
      title: 'Active Workout',
      message: 'You already have an active workout. Start a new one and discard it?',
      confirmText: 'Start New',
      cancelText: 'Keep Current',
    });
    if (!confirmed) return;
  }

  const workout = {
    id: crypto.randomUUID(),
    planId: plan ? plan.id : null,
    name: nameOverride || (plan ? plan.name : 'Freestyle Workout'),
    date: new Date().toISOString(),
    startTime: Date.now(),
    exercises: plan ? plan.exercises.map((e) => createWorkoutExercise(e.exerciseId, e.targetSets, e.targetReps, e.restSeconds)) : [],
    setsCount: 0,
    xp: 0,
  };

  setActiveWorkout(workout);
  startGlobalTimer();
  showView('workout-view');
  renderActiveWorkout();
}

function startEmptyWorkout() {
  startWorkout(null, 'Freestyle Workout');
}

function resumeWorkout() {
  const workout = getActiveWorkout();
  if (!workout) return;
  showView('workout-view');
  renderActiveWorkout();
}

function renderActiveWorkout(pastWorkoutId) {
  const workout = pastWorkoutId ? session.data.workouts.find((w) => w.id === pastWorkoutId) : getActiveWorkout();
  if (!workout) return;
  const isPastEdit = !!pastWorkoutId;
  const persist = () => { if (!isPastEdit) setActiveWorkout(workout); };
  const view = $('workout-view');

  if (!isPastEdit && workout.restUntil && workout.restUntil > Date.now()) {
    clearInterval(restTimerInterval);
    restTimerInterval = null;
    restEndTime = workout.restUntil;
    renderRestTimer(workout.restExerciseIndex ?? 0);
  }

  view.innerHTML = `
    <div class="workout-header">
      <div>
        <h2>${workout.name}${isPastEdit ? ' (History Edit)' : ''}</h2>
        <div class="workout-meta">
          ${isPastEdit ? `<div class="muted">${new Date(workout.date).toLocaleString()}</div>` : `<div class="timer" id="workout-timer">${formatDuration(workout.startTime)}</div>`}
          <button class="secondary units-toggle-workout">Units: ${session.data.preferences.units || 'kg'}</button>
        </div>
      </div>
      <div class="rest-big" id="rest-big"></div>
    </div>
    <div id="active-exercises"></div>
    <div class="workout-actions">
      <button id="finish-workout" class="btn-finish">${isPastEdit ? 'Save Changes' : 'Finish Workout'}</button>
      ${isPastEdit ? '<button id="cancel-edit" class="secondary">Cancel</button>' : '<button id="cancel-workout" class="secondary">Cancel</button>'}
    </div>
  `;

  const container = $('active-exercises');
  container.innerHTML = workout.exercises
    .map((exercise, exIndex) => {
      const ex = getExercise(exercise.exerciseId);
      const pr = getPR(session.data.workouts, exercise.exerciseId);
      const isCardio = isCardioExercise(exercise.exerciseId);
      return `
        <div class="active-exercise" data-idx="${exIndex}">
          <div class="active-exercise-header">
            <div class="exercise-title-row">
              <div class="drag-handle" role="button" aria-label="Drag to reorder" tabindex="0" data-idx="${exIndex}">☰</div>
              ${isPastEdit ? '' : `<button class="secondary btn-move" data-dir="up" data-idx="${exIndex}" ${exIndex === 0 ? 'disabled' : ''} aria-label="Move exercise up">↑</button>`}
              ${isPastEdit ? '' : `<button class="secondary btn-move" data-dir="down" data-idx="${exIndex}" ${exIndex === workout.exercises.length - 1 ? 'disabled' : ''} aria-label="Move exercise down">↓</button>`}
              <div>
                <h3><button class="btn-exercise-title" data-exercise-id="${exercise.exerciseId}" title="View exercise details">${ex.name}</button></h3>
                ${!isCardio && pr.weight > 0 ? `<span class="pr-badge">PR ${pr.weight}${session.data.preferences.units} × ${pr.reps}</span>` : ''}
              </div>
            </div>
            <div class="exercise-actions">
              <button class="secondary btn-exercise-info" data-exercise-id="${exercise.exerciseId}" title="View exercise history, records, and 1RM"> Info</button>
              <div class="rest-setting" title="Rest time between sets">
                <label>Rest</label>
                <input type="number" value="${exercise.restSeconds}" data-idx="${exIndex}" data-field="restSeconds" />
                <span>s</span>
              </div>
              ${!isCardio ? `<button class="secondary btn-add-warmup" data-idx="${exIndex}">+ Warmup</button>` : ''}
              <button class="secondary btn-remove-ex" data-idx="${exIndex}">Remove</button>
            </div>
          </div>
          <div class="sets">
            ${exercise.sets
              .map(
                (set, setIndex) => `
              <div class="set-row ${set.type} ${isCardio ? 'cardio' : ''}" data-set-idx="${setIndex}">
                <span class="set-type">${set.type === 'warmup' ? 'W' : isCardio ? 'C' : 'S'}</span>
                ${renderSetFields(exercise, set, exIndex, setIndex, isCardio)}
                <button class="set-done ${set.done ? 'done' : ''}" data-idx="${exIndex}" data-set="${setIndex}">✓</button>
                <button class="secondary btn-delete-set" data-idx="${exIndex}" data-set="${setIndex}">🗑</button>
              </div>
            `
              )
              .join('')}
          </div>
          <button class="secondary btn-add-set" data-idx="${exIndex}">+ Set</button>
          <div class="rest-section" id="rest-${exIndex}"></div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', (e) => {
      const exIdx = Number(e.target.dataset.idx);
      const setIdx = e.target.dataset.set;
      const field = e.target.dataset.field;
      if (field === 'restSeconds') {
        workout.exercises[exIdx][field] = e.target.value === '' ? 90 : Number(e.target.value);
      } else {
        workout.exercises[exIdx].sets[setIdx][field] = e.target.value === '' ? '' : Number(e.target.value);
      }
      persist();
    });
  });

  container.querySelectorAll('.set-done').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      const setIdx = Number(btn.dataset.set);
      const set = workout.exercises[exIdx].sets[setIdx];
      set.weight = set.weight === '' ? 0 : Number(set.weight);
      set.reps = set.reps === '' ? 0 : Number(set.reps);
      set.distance = set.distance === '' ? 0 : Number(set.distance);
      set.durationMinutes = set.durationMinutes === '' ? 0 : Number(set.durationMinutes);
      set.heartRate = set.heartRate === '' ? 0 : Number(set.heartRate);
      set.calories = set.calories === '' ? 0 : Number(set.calories);
      set.done = !set.done;
      set.xp = set.done ? xpForSet(set) : 0;
      persist();
      renderActiveWorkout(pastWorkoutId);
      if (!isPastEdit) {
        if (set.done) {
          startRestTimer(exIdx, workout.exercises[exIdx].restSeconds);
        } else if (workout.restExerciseIndex === exIdx) {
          skipRestTimer();
        }
      }
    });
  });

  container.querySelectorAll('.btn-add-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      const exercise = workout.exercises[exIdx];
      exercise.sets.push(createSet('working', exercise.exerciseId));
      persist();
      renderActiveWorkout(pastWorkoutId);
    });
  });

  container.querySelectorAll('.btn-delete-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      const setIdx = Number(btn.dataset.set);
      workout.exercises[exIdx].sets.splice(setIdx, 1);
      persist();
      renderActiveWorkout(pastWorkoutId);
    });
  });

  container.querySelectorAll('.btn-add-warmup').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const exIdx = Number(btn.dataset.idx);
      const ex = workout.exercises[exIdx];
      let weight = findWorkingWeight(ex);
      if (!weight || weight <= 0) {
        const input = await openAppModal({
          title: 'Warmup Weight',
          message: 'Enter your target working weight to generate warmup sets:',
          prompt: true,
          promptLabel: 'Target working weight',
          confirmText: 'Generate',
          cancelText: 'Cancel',
        });
        if (!input) return;
        weight = Number(input);
        if (!weight || weight <= 0) {
          showToast('Please enter a valid working weight.', 'error');
          return;
        }
      }
      addWarmupSets(ex, weight);
      persist();
      renderActiveWorkout(pastWorkoutId);
    });
  });

  container.querySelectorAll('.btn-remove-ex').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const exIdx = Number(btn.dataset.idx);
      const confirmed = await openAppModal({
        title: 'Remove Exercise',
        message: 'Remove this exercise from the workout?',
        confirmText: 'Remove',
        cancelText: 'Cancel',
      });
      if (!confirmed) return;
      workout.exercises.splice(exIdx, 1);
      persist();
      renderActiveWorkout(pastWorkoutId);
    });
  });

  container.querySelectorAll('.btn-exercise-info').forEach((btn) => {
    btn.addEventListener('click', () => {
      openExerciseDetail(btn.dataset.exerciseId);
    });
  });

  container.querySelectorAll('.btn-exercise-title').forEach((btn) => {
    btn.addEventListener('click', () => {
      openExerciseDetail(btn.dataset.exerciseId);
    });
  });

  if (!isPastEdit) {
    container.querySelectorAll('.btn-move').forEach((btn) => {
      btn.addEventListener('click', () => {
        const exIdx = Number(btn.dataset.idx);
        const dir = btn.dataset.dir;
        const newIdx = dir === 'up' ? exIdx - 1 : exIdx + 1;
        if (newIdx < 0 || newIdx >= workout.exercises.length) return;
        [workout.exercises[exIdx], workout.exercises[newIdx]] = [workout.exercises[newIdx], workout.exercises[exIdx]];
        persist();
        renderActiveWorkout();
      });
    });
  }

  $('finish-workout').addEventListener('click', () => {
    if (isPastEdit) {
      savePastWorkoutChanges(workout);
    } else {
      finishWorkout();
    }
  });

  const unitsToggleBtn = view.querySelector('.units-toggle-workout');
  if (unitsToggleBtn) {
    unitsToggleBtn.addEventListener('click', () => {
      toggleUnits();
      renderActiveWorkout(pastWorkoutId);
    });
  }

  const cancelBtn = isPastEdit ? $('cancel-edit') : $('cancel-workout');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      if (isPastEdit) {
        showView('history-view');
        renderHistory();
      } else {
        const confirmed = await openAppModal({
          title: 'Discard Workout',
          message: 'Discard this workout?',
          confirmText: 'Discard',
          cancelText: 'Keep',
        });
        if (!confirmed) return;
        clearActiveWorkout();
        stopGlobalTimer();
        clearInterval(restTimerInterval);
        showView('dashboard-view');
        renderDashboard();
      }
    });
  }

  if (!isPastEdit) {
    const addExerciseBtn = document.createElement('button');
    addExerciseBtn.className = 'secondary';
    addExerciseBtn.textContent = '+ Add Exercise';
    addExerciseBtn.style.marginTop = '1rem';
    addExerciseBtn.addEventListener('click', openExerciseSelector);
    container.appendChild(addExerciseBtn);
  }

  if (!isPastEdit) {
    initExerciseDragAndDrop(container, workout);
  }

  initWeightInputPopover(container);
}

function initExerciseDragAndDrop(container, workout) {
  let draggedEl = null;
  let ghostEl = null;
  let startY = 0;
  let startX = 0;
  let hasMoved = false;

  function swapDomElements(targetEl, draggedEl) {
    const all = [...container.querySelectorAll('.active-exercise')];
    const draggedIdx = all.indexOf(draggedEl);
    const targetIdx = all.indexOf(targetEl);
    if (draggedIdx === -1 || targetIdx === -1) return;
    if (targetIdx < draggedIdx) {
      targetEl.before(draggedEl);
    } else {
      targetEl.after(draggedEl);
    }
  }

  container.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.addEventListener('keydown', (e) => {
      const exIdx = Number(handle.dataset.idx);
      if (exIdx === 0 && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) return;
      if (exIdx === workout.exercises.length - 1 && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        [workout.exercises[exIdx], workout.exercises[exIdx - 1]] = [workout.exercises[exIdx - 1], workout.exercises[exIdx]];
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        [workout.exercises[exIdx], workout.exercises[exIdx + 1]] = [workout.exercises[exIdx + 1], workout.exercises[exIdx]];
      } else {
        return;
      }
      e.preventDefault();
      setActiveWorkout(workout);
      renderActiveWorkout();
    });

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      draggedEl = handle.closest('.active-exercise');
      if (!draggedEl) return;
      startX = e.clientX;
      startY = e.clientY;
      hasMoved = false;

      const rect = draggedEl.getBoundingClientRect();
      ghostEl = draggedEl.cloneNode(true);
      ghostEl.classList.add('ghost-element');
      ghostEl.style.width = `${rect.width}px`;
      ghostEl.style.top = `${rect.top}px`;
      ghostEl.style.left = `${rect.left}px`;
      document.body.appendChild(ghostEl);
      draggedEl.classList.add('dragging');

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
    });
  });

  function onPointerMove(e) {
    if (!ghostEl || !draggedEl) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!hasMoved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    hasMoved = true;

    ghostEl.style.transform = `translate(${dx}px, ${dy}px)`;

    const target = document.elementFromPoint(e.clientX, e.clientY);
    const targetEl = target ? target.closest('.active-exercise') : null;
    if (targetEl && targetEl !== draggedEl) {
      swapDomElements(targetEl, draggedEl);
    }
  }

  function onPointerUp(e) {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);

    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl = null;
    }

    if (!hasMoved) return;

    const newOrder = Array.from(container.querySelectorAll('.active-exercise')).map((el) => {
      const originalIdx = Number(el.dataset.idx);
      return workout.exercises[originalIdx];
    });
    workout.exercises = newOrder;
    setActiveWorkout(workout);
    renderActiveWorkout();
  }
}

function openExerciseSelector() {
  showView('exercises-view');
  exerciseSelectCallback = (exerciseId) => {
    const workout = getActiveWorkout();
    if (workout) {
      workout.exercises.push(createWorkoutExercise(exerciseId));
      setActiveWorkout(workout);
    }
    exerciseSelectCallback = null;
    showView('workout-view');
    renderActiveWorkout();
  };
  renderExercises('Add to Workout');
}

function startRestTimer(exIdx, seconds) {
  clearInterval(restTimerInterval);
  restTimerInterval = null;
  restEndTime = Date.now() + seconds * 1000;
  const workout = getActiveWorkout();
  if (workout) {
    workout.restUntil = restEndTime;
    workout.restExerciseIndex = exIdx;
    setActiveWorkout(workout);
  }
  renderRestTimer(exIdx);
}

function changeRestTimer(seconds) {
  const workout = getActiveWorkout();
  if (!workout) return;
  restEndTime = Math.max(Date.now(), restEndTime + seconds * 1000);
  workout.restUntil = restEndTime;
  workout.restExerciseIndex = workout.restExerciseIndex ?? 0;
  setActiveWorkout(workout);
  renderRestTimer(workout.restExerciseIndex);
}

function skipRestTimer() {
  clearInterval(restTimerInterval);
  restTimerInterval = null;
  const workout = getActiveWorkout();
  if (workout) {
    delete workout.restUntil;
    delete workout.restExerciseIndex;
    setActiveWorkout(workout);
  }
  const big = $('rest-big');
  if (big) big.innerHTML = '';
  document.querySelectorAll('.rest-section').forEach((el) => {
    el.innerHTML = '';
  });
}

function renderRestTimer(exIdx) {
  const workout = getActiveWorkout();
  const remaining = Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
  const big = $('rest-big');
  const section = exIdx !== null ? $(`rest-${exIdx}`) : null;

  const timerHtml = `
    <div class="rest-timer">
      Rest: ${remaining}s
      <div class="rest-controls">
        <button class="secondary rest-adjust" data-delta="-30">-30s</button>
        <button class="secondary rest-adjust" data-delta="30">+30s</button>
        <button class="secondary rest-skip">Skip</button>
      </div>
    </div>
  `;
  const doneHtml = `<div class="rest-timer done">Rest complete</div>`;

  if (remaining > 0) {
    if (section) section.innerHTML = timerHtml;
    if (big) big.innerHTML = timerHtml;
  } else {
    if (section) section.innerHTML = doneHtml;
    if (big) big.innerHTML = doneHtml;
  }

  document.querySelectorAll('.rest-adjust').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.delta);
      changeRestTimer(delta);
    });
  });

  document.querySelectorAll('.rest-skip').forEach((btn) => {
    btn.addEventListener('click', () => skipRestTimer());
  });

  if (remaining > 0 && !restTimerInterval) {
    restTimerInterval = setInterval(() => renderRestTimer(exIdx), 1000);
  } else if (remaining <= 0) {
    clearInterval(restTimerInterval);
    restTimerInterval = null;
    if (workout) {
      delete workout.restUntil;
      delete workout.restExerciseIndex;
      setActiveWorkout(workout);
    }
    if (remaining === 0) {
      playSound('rest-done');
    }
  }
}

async function finishWorkout() {
  const workout = getActiveWorkout();
  if (!workout) return;
  workout.endTime = Date.now();
  workout.durationSeconds = Math.floor((workout.endTime - workout.startTime) / 1000);

  workout.exercises.forEach((ex) => {
    const cardio = isCardioExercise(ex.exerciseId);
    ex.sets = ex.sets
      .filter((s) => {
        if (cardio) return s.durationMinutes !== '' && Number(s.durationMinutes) > 0;
        return s.weight !== '' && s.reps !== '' && Number(s.weight) > 0 && Number(s.reps) > 0;
      })
      .map((s) => ({
        ...s,
        weight: Number(s.weight),
        reps: Number(s.reps),
        distance: Number(s.distance),
        durationMinutes: Number(s.durationMinutes),
        heartRate: Number(s.heartRate),
        calories: Number(s.calories),
        xp: xpForSet(s),
        done: true,
      }));
  });

  const dropped = workout.exercises.reduce((count, ex) => {
    const cardio = isCardioExercise(ex.exerciseId);
    const invalid = ex.sets.filter((s) => {
      if (cardio) return s.durationMinutes === '' || Number(s.durationMinutes) <= 0;
      return s.weight === '' || s.reps === '' || Number(s.weight) <= 0 || Number(s.reps) <= 0;
    }).length;
    return count + invalid;
  }, 0);
  if (dropped > 0) {
    const confirmed = await openAppModal({
      title: 'Incomplete Sets',
      message: `${dropped} set(s) have missing weight or reps and will be discarded. Finish anyway?`,
      confirmText: 'Finish Anyway',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;
  }

  workout.exercises = workout.exercises.filter((ex) => ex.sets.length > 0);
  if (workout.exercises.length === 0) {
    showToast('Add at least one completed set before finishing the workout.', 'error');
    return;
  }
  workout.setsCount = workout.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
  workout.xp = xpForWorkout(workout.exercises.flatMap((ex) => ex.sets));

  session.data.workouts.unshift(workout);
  clearActiveWorkout();
  stopGlobalTimer();
  clearInterval(restTimerInterval);
  syncDataImmediate();
  playSound('success');
  fireConfetti();
  showView('dashboard-view');
  renderDashboard();
}

function savePastWorkoutChanges(workout) {
  workout.exercises.forEach((ex) => {
    const cardio = isCardioExercise(ex.exerciseId);
    ex.sets = ex.sets
      .filter((s) => {
        if (cardio) return s.durationMinutes !== '' && Number(s.durationMinutes) > 0;
        return s.weight !== '' && s.reps !== '' && Number(s.weight) > 0 && Number(s.reps) > 0;
      })
      .map((s) => ({
        ...s,
        weight: Number(s.weight),
        reps: Number(s.reps),
        distance: Number(s.distance),
        durationMinutes: Number(s.durationMinutes),
        heartRate: Number(s.heartRate),
        calories: Number(s.calories),
        xp: xpForSet(s),
        done: true,
      }));
  });
  workout.exercises = workout.exercises.filter((ex) => ex.sets.length > 0);
  const idx = session.data.workouts.findIndex((w) => w.id === workout.id);
  if (workout.exercises.length === 0) {
    if (idx >= 0) {
      session.data.workouts.splice(idx, 1);
      syncDataImmediate();
    }
    showView('history-view');
    renderHistory();
    return;
  }
  workout.setsCount = workout.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
  workout.xp = xpForWorkout(workout.exercises.flatMap((ex) => ex.sets));

  if (idx >= 0) {
    session.data.workouts[idx] = workout;
  }
  syncDataImmediate();
  showView('history-view');
  renderHistory();
  showToast('Workout history updated.');
}

function formatSetSummary(ex, s) {
  if (isCardioExercise(ex.exerciseId)) {
    const parts = [];
    if (s.distance > 0 && s.durationMinutes > 0) {
      const pace = (s.durationMinutes / s.distance).toFixed(1);
      parts.push(`${pace} min/${session.data.preferences.units === 'kg' ? 'km' : 'mi'}`);
    }
    if (s.distance > 0) parts.push(`${s.distance}${session.data.preferences.units === 'kg' ? 'km' : 'mi'}`);
    if (s.durationMinutes > 0) parts.push(`${s.durationMinutes}min`);
    if (s.calories > 0) parts.push(`${s.calories}kcal`);
    if (s.heartRate > 0) parts.push(`${s.heartRate}bpm`);
    return parts.join(' ');
  }
  return s.weight > 0 && s.reps > 0 ? `${s.weight}${session.data.preferences.units}×${s.reps}` : '';
}

// ─── Workout Calendar ───────────────────────────────────────────────────────

function getWorkoutDates() {
  const dates = new Map();
  session.data.workouts.forEach((w) => {
    const d = new Date(w.date);
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().split('T')[0];
    if (!dates.has(key)) dates.set(key, []);
    dates.get(key).push(w);
  });
  return dates;
}

function renderWorkoutCalendar() {
  let calendarDate = new Date();
  const container = $('history-calendar');
  if (!container) return;

  function render() {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startDay = firstDay.getDay();
    const workoutDates = getWorkoutDates();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let html = `
      <div class="history-calendar-header">
        <button id="cal-prev" type="button" aria-label="Previous month">←</button>
        <h3>${calendarDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</h3>
        <button id="cal-next" type="button" aria-label="Next month">→</button>
      </div>
    `;

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayLabels.forEach((d) => {
      html += `<div class="history-calendar-day-label" aria-hidden="true">${d}</div>`;
    });

    for (let i = 0; i < startDay; i++) {
      html += '<div class="history-calendar-day empty" aria-hidden="true"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(year, month, day);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().split('T')[0];
      const hasWorkout = workoutDates.has(key);
      const isToday = d.getTime() === today.getTime();
      const classes = ['history-calendar-day', hasWorkout ? 'has-workout' : '', isToday ? 'today' : ''].filter(Boolean).join(' ');
      if (hasWorkout) {
        const title = `${workoutDates.get(key).length} workout${workoutDates.get(key).length > 1 ? 's' : ''}`;
        const labelDate = new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
        html += `<button type="button" class="${classes}" data-date="${key}" title="${title}" aria-label="${labelDate}: ${title}">${day}</button>`;
      } else {
        html += `<div class="${classes}" aria-hidden="true">${day}</div>`;
      }
    }

    container.innerHTML = html;

    $('cal-prev')?.addEventListener('click', () => {
      calendarDate.setMonth(calendarDate.getMonth() - 1);
      render();
    });
    $('cal-next')?.addEventListener('click', () => {
      calendarDate.setMonth(calendarDate.getMonth() + 1);
      render();
    });

    container.querySelectorAll('.history-calendar-day.has-workout').forEach((el) => {
      el.addEventListener('click', () => {
        const date = el.dataset.date;
        const list = session.data.workouts.filter((w) => w.date.startsWith(date));
        if (list.length === 0) return;
        // Scroll to the first workout for that date in the history list below.
        const first = document.querySelector(`[data-id="${list[0].id}"]`);
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    container.querySelectorAll('.history-calendar-day.has-workout').forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.click();
        }
      });
    });
  }

  render();
}

function renderHistory() {
  const container = $('history-list');
  renderWorkoutCalendar();
  if (session.data.workouts.length === 0) {
    container.innerHTML = '<p class="muted">No completed workouts yet-your first session is waiting for you.</p>';
    return;
  }

  container.innerHTML = session.data.workouts
    .map(
      (w) => `
      <div class="history-card" data-id="${w.id}">
        <div class="history-header">
          <div>
            <h3>${w.name}</h3>
            <span class="muted">${new Date(w.date).toLocaleString()}</span>
          </div>
          <div class="history-stats">
            <span>${w.exercises.length} exercises</span>
            <span>${w.setsCount || 0} sets</span>
            <span>${w.xp || 0} XP</span>
          </div>
        </div>
        <div class="history-exercises">
          ${w.exercises
            .map(
              (ex) => {
                const best1rm = getBestOneRepMax(session.data.workouts, ex.exerciseId);
                const units = session.data.preferences.units || 'kg';
                const exName = escapeHtml(getExercise(ex.exerciseId).name);
                return `
            <div class="history-exercise">
              <div class="history-exercise-main">
                <button type="button" class="btn-exercise-title" data-exercise-id="${ex.exerciseId}" title="View details for ${exName}">${exName}</button>
                <span>${ex.sets
                  .map((s) => formatSetSummary(ex, s))
                  .filter(Boolean)
                  .join(' • ')}</span>
              </div>
              ${best1rm ? `<span class="history-1rm">Est. 1RM: ${Math.round(best1rm.avg)} ${units}</span>` : ''}
            </div>
          `;
              }
            )
            .join('')}
        </div>
        <div class="history-actions">
          <button class="secondary btn-edit-workout" data-id="${w.id}">Edit Workout</button>
          <button class="secondary btn-delete-workout" data-id="${w.id}">Delete</button>
        </div>
      </div>
    `
    )
    .join('');

  container.querySelectorAll('.btn-edit-workout').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView('workout-view');
      renderActiveWorkout(btn.dataset.id);
    });
  });

  container.querySelectorAll('.btn-delete-workout').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const confirmed = await openAppModal({
        title: 'Delete Workout',
        message: 'Delete this workout from history?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
      });
      if (!confirmed) return;
      session.data.workouts = session.data.workouts.filter((w) => w.id !== btn.dataset.id);
      syncDataImmediate();
      renderHistory();
    });
  });

  container.querySelectorAll('.history-exercise .btn-exercise-title').forEach((btn) => {
    btn.addEventListener('click', () => openExerciseDetail(btn.dataset.exerciseId));
  });
}

// ─── Barbell Math ───────────────────────────────────────────────────────────

function calculatePlates(totalWeight) {
  const units = session.data.preferences.units || 'kg';
  const barWeight = units === 'kg' ? 20 : 45;
  let remaining = (totalWeight - barWeight) / 2;
  if (remaining <= 0) return { plates: [], remaining: 0, barWeight, perSide: totalWeight / 2 };

  const plateValues = units === 'kg' ? [25, 20, 15, 10, 5, 2.5, 1.25] : [45, 35, 25, 10, 5, 2.5];
  const plates = [];
  for (const plate of plateValues) {
    while (remaining >= plate - 0.001) {
      plates.push(plate);
      remaining -= plate;
    }
  }
  return { plates, remaining, barWeight, perSide: (totalWeight - barWeight) / 2 };
}

function formatPlates(totalWeight) {
  const { plates, remaining, perSide } = calculatePlates(totalWeight);
  const units = session.data.preferences.units || 'kg';
  if (plates.length === 0) {
    // Not useful: hide the popover when the weight is empty-barbell or un-loadable.
    return '';
  }
  const counts = {};
  plates.forEach((p) => (counts[p] = (counts[p] || 0) + 1));
  const plateStr = Object.entries(counts)
    .map(([plate, count]) => `${count}×${plate}${units}`)
    .join(', ');
  return `${plateStr} per side${remaining > 0.01 ? ` (remainder ${Math.round(remaining * 100) / 100}${units})` : ''}`;
}

function updateBarbellPopover(input) {
  let popover = input.parentElement.querySelector('.barbell-popover');
  const weight = Number(input.value);
  const text = weight > 0 ? formatPlates(weight) : '';
  if (!text) {
    if (popover) popover.classList.remove('visible');
    return;
  }
  if (!popover) {
    popover = document.createElement('div');
    popover.className = 'barbell-popover';
    input.parentElement.style.position = 'relative';
    input.parentElement.appendChild(popover);
  }
  popover.textContent = text;
  popover.classList.add('visible');
}

function initBarbellMath(container) {
  // No-op: handled by popover below for cleaner UX.
}

function initWeightInputPopover(container) {
  container.querySelectorAll('input.weight-input').forEach((input) => {
    if ((input.dataset.equipment || '').toLowerCase() !== 'barbell') return;
    input.addEventListener('focus', () => updateBarbellPopover(input));
    input.addEventListener('input', () => updateBarbellPopover(input));
    input.addEventListener('blur', () => {
      setTimeout(() => {
        const popover = input.parentElement.querySelector('.barbell-popover');
        if (popover) popover.classList.remove('visible');
      }, 200);
    });
  });
}

// ─── Sounds (Web Audio API) ─────────────────────────────────────────────────

function playSound(type) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    function beep(freq, start, duration, vol = 0.1) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(vol, now + start);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + duration);
      osc.start(now + start);
      osc.stop(now + start + duration);
    }

    if (type === 'rest-done') {
      beep(880, 0, 0.3, 0.15);
      beep(880, 0.35, 0.3, 0.15);
    } else if (type === 'success') {
      beep(523, 0, 0.15, 0.12);
      beep(659, 0.15, 0.15, 0.12);
      beep(880, 0.3, 0.4, 0.15);
    }
  } catch (e) {
    // Audio playback is optional; ignore errors.
  }
}

// ─── Confetti ───────────────────────────────────────────────────────────────

function fireConfetti() {
  const canvas = $('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#2563eb', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6'];
  for (let i = 0; i < 120; i++) {
    particles.push({
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 18,
      vy: (Math.random() - 1) * 18 - 4,
      size: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 1,
    });
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.4;
      p.life -= 0.015;
      if (p.life > 0) {
        alive = true;
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    if (alive) {
      requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  animate();
}

// ─── Sync ───────────────────────────────────────────────────────────────────

async function loadSync() {
  try {
    const res = await api('/sync');
    if (res.exists && res.encryptedBlob) {
      const encrypted = JSON.parse(res.encryptedBlob);
      // The KEM ciphertext is stored separately on the server.
      if (res.kemCiphertext) encrypted.kemCiphertext = res.kemCiphertext;
      if (!isDemoMode && !encrypted.kemCiphertext && !session.kemKeyPair) {
        throw new Error('No KEM keypair available to decrypt sync data.');
      }
      // In demo mode the AES key is a CryptoKey; in real mode the KEM secret
      // key is a Uint8Array used to recover the AES data key.
      const key = isDemoMode ? session.encKey : session.kemKeyPair.secretKey;
      const data = await decryptData(encrypted, key);
      session.data = { ...session.data, ...data };
      if (!session.data.plans) session.data.plans = seedPlans();
      if (!session.data.customExercises) session.data.customExercises = [];
      if (!session.data.preferences) session.data.preferences = { defaultRestSeconds: 90, units: 'kg' };
      if (getActiveWorkout()) startGlobalTimer();
      if ($('sync-status')) $('sync-status').textContent = isDemoMode ? 'Demo data loaded from localStorage.' : 'Loaded latest encrypted state from cloud.';
    } else {
      session.data.plans = seedPlans();
      if ($('sync-status')) $('sync-status').textContent = isDemoMode ? 'Starting fresh demo.' : 'No prior sync found. Starting fresh.';
    }
  } catch (err) {
    reportApiError(err, (failure) => {
      if ($('sync-status')) $('sync-status').textContent = `Sync load failed: ${failure.message}`;
      showToast(`Sync load failed: ${failure.message}`, 'error');
    });
  }
}

function scheduleSync() {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => performSync(), 1200);
}

async function performSync() {
  syncTimeout = null;
  const status = $('sync-status');
  if (status) status.textContent = isDemoMode ? 'Saving demo data...' : 'Syncing encrypted state...';
  try {
    // Real users encrypt with their ML-KEM public key; demo users use a
    // fixed AES key stored only in memory.
    const encrypted = isDemoMode
      ? await encryptData(session.data, session.encKey)
      : await encryptData(session.data, session.kemKeyPair.publicKey);
    await api('/sync', {
      method: 'PUT',
      body: JSON.stringify({
        encryptedBlob: JSON.stringify({ iv: encrypted.iv, ciphertext: encrypted.ciphertext }),
        kemCiphertext: encrypted.kemCiphertext || 'demo-kem-ciphertext-placeholder',
      }),
    });
    if (status) status.textContent = isDemoMode ? 'Demo data saved locally.' : 'Encrypted state synced successfully.';
  } catch (err) {
    reportApiError(err, (failure) => {
      if (status) status.textContent = `Sync failed: ${failure.message}`;
      showToast(`Sync failed: ${failure.message}`, 'error');
    });
  }
}

async function syncData() {
  scheduleSync();
}

async function syncDataImmediate() {
  if (syncTimeout) clearTimeout(syncTimeout);
  await performSync();
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────
async function bootstrap() {
  let attempts = 0;
  while ((typeof argon2 === 'undefined' || typeof argon2.hash !== 'function') && attempts < 20) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    attempts += 1;
  }

  if (typeof argon2 === 'undefined' || typeof argon2.hash !== 'function') {
    const msg = 'Could not load the Argon2 library. Please check your network connection and reload the page.';
    console.error(msg);
    const errorEl = document.getElementById('auth-error');
    if (errorEl) errorEl.textContent = msg;
    return;
  }

  initTheme();
  initAuthUI();
  renderNav();
  initLogo();
  const resumeBtn = $('resume-workout-btn');
  if (resumeBtn) resumeBtn.addEventListener('click', resumeWorkout);
}

function initLogo() {
  const logo = document.querySelector('.logo');
  if (!logo) return;
  logo.setAttribute('role', 'button');
  logo.setAttribute('tabindex', '0');
  logo.setAttribute('aria-label', 'Go to Dashboard');
  logo.title = 'Go to Dashboard';
  logo.addEventListener('click', () => {
    if (isAuthenticated) {
      showView('dashboard-view');
      renderDashboard();
    }
  });
  logo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isAuthenticated) {
        showView('dashboard-view');
        renderDashboard();
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
