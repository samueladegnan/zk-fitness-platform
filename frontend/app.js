/**
 * ZK Fitness — Client Application
 *
 * - Derives auth and encryption keys from the password using Argon2id + HKDF.
 * - Encrypts/decrypts workout data with Web Crypto API (AES-256-GCM).
 * - Runs the gamification engine (XP, tonnage, streak, levels, badges, PRs) in the browser.
 * - NEW: Demo/portfolio mode, empty workouts, rest +/-30s, warmup helper,
 *        barbell math, confetti, sounds, plan editor, and history editing.
 */

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
  encKey: null,
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

// ─── Demo Mode Constants ────────────────────────────────────────────────────
const DEMO_KEY_BASE64 = 'demo-demo-demo-demo-demo-demo-demo-demo'; // 32 bytes placeholder handled below
const DEMO_STORAGE_KEY = 'zkfitness_demo_data';

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
  const derive = async (info) =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: bufferFromString('zkfitness'), info: bufferFromString(info) },
      keyMaterial,
      256
    );

  const authKeyBuffer = await derive('auth-v1');
  const encKeyBuffer = await derive('enc-v1');

  const authKey = arrayBufferToBase64(authKeyBuffer);
  const encKey = await crypto.subtle.importKey('raw', encKeyBuffer, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);

  return { authKey, encKey };
}

async function getDemoEncKey() {
  // Demo mode uses a fixed, non-secret key because data lives only in localStorage.
  const raw = new Uint8Array(32);
  for (let i = 0; i < raw.length; i++) raw[i] = i;
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptData(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = bufferFromString(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext),
  };
}

async function decryptData(encrypted, key) {
  const iv = new Uint8Array(base64ToArrayBuffer(encrypted.iv));
  const ciphertext = base64ToArrayBuffer(encrypted.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
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
    throw new Error('Could not reach the server. Is the backend running on http://localhost:3000?');
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);
  return body;
}

async function demoApi(path, options) {
  await new Promise((r) => setTimeout(r, 30)); // Simulate network latency
  const method = options.method || 'GET';
  if (path === '/sync' && method === 'GET') {
    const stored = localStorage.getItem(DEMO_STORAGE_KEY);
    return { exists: !!stored, encryptedBlob: stored };
  }
  if (path === '/sync' && method === 'PUT') {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.parse(options.body).encryptedBlob);
    return { message: 'Demo sync stored' };
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

function xpForSet(set) {
  // Cardio: reward duration + intensity (calories proxy)
  if (set.durationMinutes > 0) {
    return Math.max(10, Math.round((set.durationMinutes || 0) * 1.5 + (set.calories || 0) * 0.1));
  }
  const weight = set.weight || 0;
  const reps = set.reps || 0;
  return weight > 0 && reps > 0 ? Math.round(weight * reps * 0.15) : 0;
}

function xpForWorkout(sets) {
  const base = sets.reduce((sum, s) => sum + (s.xp || xpForSet(s)), 0);
  return base + 50;
}

function totalTonnage(sets) {
  return sets.reduce((sum, s) => sum + (s.weight || 0) * (s.reps || 0), 0);
}

function totalCardioDistance(sets) {
  return sets.reduce((sum, s) => sum + (s.distance || 0), 0);
}

function totalCardioCalories(sets) {
  return sets.reduce((sum, s) => sum + (s.calories || 0), 0);
}

function totalCardioDuration(sets) {
  return sets.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);
}

function computeStats() {
  const workouts = session.data.workouts;
  const totalXp = workouts.reduce((sum, w) => sum + (w.xp || 0), 0);
  const tonnage = workouts.reduce((sum, w) => sum + totalTonnage(w.exercises.flatMap((e) => e.sets)), 0);
  const allSets = workouts.flatMap((w) => w.exercises.flatMap((e) => e.sets));
  const distance = totalCardioDistance(allSets);
  const calories = totalCardioCalories(allSets);
  return { totalXp, tonnage, workouts: workouts.length, distance, calories };
}

function getLevel(totalXp) {
  return Math.max(1, Math.floor(Math.sqrt((totalXp || 0) / 100)) + 1);
}

function xpToNextLevel(totalXp) {
  const currentLevel = getLevel(totalXp);
  const next = currentLevel * currentLevel * 100;
  const prev = (currentLevel - 1) * (currentLevel - 1) * 100;
  return { next, prev, current: totalXp - prev, range: next - prev };
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

function currentStreak() {
  const dates = [...new Set(session.data.workouts.map((w) => new Date(w.date).toDateString()))].sort();
  if (dates.length === 0) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last = new Date(dates[dates.length - 1]);
  last.setHours(0, 0, 0, 0);
  const daysSinceLast = Math.floor((today - last) / (1000 * 60 * 60 * 24));

  if (daysSinceLast > 1) return 0;

  let streak = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    const d1 = new Date(dates[i]);
    const d2 = new Date(dates[i - 1]);
    d1.setHours(0, 0, 0, 0);
    d2.setHours(0, 0, 0, 0);
    if ((d1 - d2) / (1000 * 60 * 60 * 24) === 1) streak += 1;
    else break;
  }
  return streak;
}

function getPR(exerciseId) {
  let pr = { weight: 0, reps: 0, date: null };
  session.data.workouts.forEach((w) => {
    w.exercises.forEach((e) => {
      if (e.exerciseId !== exerciseId) return;
      e.sets.forEach((s) => {
        if (s.type !== 'working') return;
        if (s.weight > pr.weight || (s.weight === pr.weight && s.reps > pr.reps)) {
          pr = { weight: s.weight, reps: s.reps, date: w.date };
        }
      });
    });
  });
  return pr;
}

function getRecentPRs(limit = 3) {
  const all = [];
  const seen = new Set();
  [...session.data.workouts].reverse().forEach((w) => {
    w.exercises.forEach((e) => {
      if (seen.has(e.exerciseId)) return;
      const pr = getPR(e.exerciseId);
      if (pr.weight > 0) {
        all.push({ exerciseId: e.exerciseId, ...pr });
        seen.add(e.exerciseId);
      }
    });
  });
  return all.slice(0, limit);
}

// ─── Exercise & Workout Helpers ─────────────────────────────────────────────

function getExercise(id) {
  const custom = (session.data.customExercises || []).find((ex) => ex.id === id);
  if (custom) return custom;
  return getExerciseById(id) || { id, name: id, category: 'Custom', equipment: 'Other', defaultRestSeconds: 90 };
}

function createSet(type = 'working') {
  return {
    id: crypto.randomUUID(),
    type,
    weight: '',
    reps: '',
    rpe: '',
    // Cardio fields
    distance: '',
    durationMinutes: '',
    heartRate: '',
    calories: '',
    done: false,
    xp: 0,
  };
}

function renderSetFields(exercise, set, exIndex, setIndex, isCardio) {
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
      <label>Weight</label>
      <input type="number" placeholder="kg" value="${set.weight}" data-idx="${exIndex}" data-set="${setIndex}" data-field="weight" class="weight-input" />
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
  return {
    id: crypto.randomUUID(),
    exerciseId,
    targetSets,
    targetReps,
    restSeconds,
    sets: [createSet('working')],
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
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = type === 'error' ? 'toast toast-error' : 'toast toast-info';
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 4000);
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

async function performPasswordAuth(username, password) {
  const salt = await deriveSalt(username);
  const { authKey, encKey } = await deriveKeys(password, salt);
  session = { ...session, username, encKey, salt };

  if (isRegisterMode) {
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, authKeyHash: authKey }),
    });
  } else {
    await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, authKeyHash: authKey }),
    });
  }

  isAuthenticated = true;
  renderNav();
  await loadSync();
  showView('dashboard-view');
  renderDashboard();
}

function initAuthUI() {
  const authForm = $('auth-form');
  const authBtn = $('auth-btn');
  const toggleBtn = $('toggle-mode');

  toggleBtn.addEventListener('click', () => {
    isRegisterMode = !isRegisterMode;
    authBtn.textContent = isRegisterMode ? 'Register' : 'Log in';
    toggleBtn.textContent = isRegisterMode ? 'Already have an account? Log in' : 'Need an account? Register';
  });

  const passwordInput = $('password');
  if (passwordInput) {
    passwordInput.addEventListener('input', (e) => renderPasswordStrength(e.target.value));
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('auth-error').textContent = '';
    const username = $('username').value.trim();
    const password = $('password').value;

    if (isRegisterMode) {
      const score = evaluatePasswordStrength(password);
      if (score < 3) {
        $('auth-error').textContent = 'Password is too weak. Use at least 12 characters with mixed case, numbers, and symbols.';
        return;
      }
    }

    try {
      await performPasswordAuth(username, password);
    } catch (err) {
      $('auth-error').textContent = err.message;
    }
  });

  const demoBtn = $('demo-mode-btn');
  if (demoBtn) {
    demoBtn.addEventListener('click', () => {
      const modal = $('demo-modal');
      if (modal) modal.classList.remove('hidden');
    });
  }

  const confirmDemoBtn = $('start-demo-confirm-btn');
  if (confirmDemoBtn) {
    confirmDemoBtn.addEventListener('click', () => {
      const modal = $('demo-modal');
      if (modal) modal.classList.add('hidden');
      startDemoMode();
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
    showToast('Demo mode active — your data is stored locally', 'info');
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
  $('nav-exercises').addEventListener('click', () => { showView('exercises-view'); renderExercises(); });
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

  const stats = computeStats();
  const level = getLevel(stats.totalXp);
  const xpInfo = xpToNextLevel(stats.totalXp);
  const badges = computeBadges(stats);
  const recentPRs = getRecentPRs();
  const units = session.data.preferences.units || 'kg';

  const unitsBtn = $('units-toggle');
  if (unitsBtn) {
    unitsBtn.textContent = `Units: ${units}`;
    unitsBtn.onclick = () => {
      session.data.preferences.units = units === 'kg' ? 'lbs' : 'kg';
      syncDataImmediate();
      renderDashboard();
    };
  }

  $('stat-xp').textContent = stats.totalXp.toLocaleString();
  $('stat-tonnage').textContent = `${stats.tonnage.toLocaleString()} ${units}`;
  $('stat-workouts').textContent = stats.workouts;
  $('stat-streak').textContent = currentStreak();
  $('stat-level').textContent = level;
  $('stat-distance').textContent = `${stats.distance.toFixed(1)} ${session.data.preferences.units === 'kg' ? 'km' : 'mi'}`;
  $('stat-calories').textContent = `${stats.calories.toLocaleString()} kcal`;

  const progressPercent = Math.min(100, Math.round((xpInfo.current / xpInfo.range) * 100));
  $('xp-progress').style.width = `${progressPercent}%`;
  $('xp-progress-text').textContent = `${xpInfo.current}/${xpInfo.range} XP to next level`;

  const badgeContainer = $('badges-list');
  if (badges.length === 0) {
    badgeContainer.innerHTML = '<p class="muted">Complete workouts to earn your first badge.</p>';
  } else {
    badgeContainer.innerHTML = badges.map((b) => `<span class="badge" title="${b.name}">${b.icon} ${b.name}</span>`).join('');
  }

  const prContainer = $('pr-list');
  if (recentPRs.length === 0) {
    prContainer.innerHTML = '<p class="muted">Log a workout to start tracking personal records.</p>';
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
    tr.innerHTML = `<td colspan="5" class="muted">No workouts yet. Start one from the Plans tab or the button below.</td>`;
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
          ${plan.exercises.map((e) => `<li>${getExercise(e.exerciseId).name} — ${e.targetSets}x${e.targetReps}</li>`).join('')}
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

function deletePlan(planId) {
  if (!confirm('Delete this plan? This cannot be undone.')) return;
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
      syncDataImmediate();
      showView('plans-view');
      renderPlans();
    });

    $('cancel-plan-btn').addEventListener('click', () => {
      showView('plans-view');
      renderPlans();
    });

    $('add-exercise-to-plan').addEventListener('click', () => {
      planEditorCallback = (exerciseId) => {
        planEditorCallback = null;
        planEditorDraft.exercises.push(createWorkoutExercise(exerciseId));
        renderEditor();
      };
      showView('exercises-view');
      exerciseSelectCallback = (exerciseId) => {
        if (planEditorCallback) {
          planEditorCallback(exerciseId);
        }
      };
      exerciseSelectButtonText = 'Add to Plan';
      renderExercises();
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

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let exerciseSelectCallback = null;
let exerciseSelectButtonText = 'Add to Workout';

function renderExercises() {
  const container = $('exercises-list');
  exerciseSelectButtonText = 'Add to Workout';
  const cats = ['All', ...new Set(EXERCISE_CATALOG.map((e) => e.category))];
  const filterHtml = `<div class="filter-row">${cats
    .map((c) => `<button class="filter-btn" data-cat="${c}">${c}</button>`)
    .join('')}</div>`;

  const customForm = `
    <div class="panel custom-exercise-form">
      <h3>Add Custom Exercise</h3>
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
  `;

  container.innerHTML = customForm + filterHtml + '<div id="exercises-grid"></div>';

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
  });

  function renderGrid(category) {
    const grid = $('exercises-grid');
    const builtIn = category === 'All' ? EXERCISE_CATALOG : EXERCISE_CATALOG.filter((e) => e.category === category);
    const custom = session.data.customExercises || [];
    const all = category === 'All' ? [...builtIn, ...custom] : [...builtIn, ...custom.filter((e) => e.category === category)];

    grid.innerHTML = all
      .map(
        (ex) => `
        <div class="exercise-card">
          <h4>${ex.name}</h4>
          <span class="tag">${ex.category}</span>
          <span class="tag">${ex.equipment}</span>
          ${exerciseSelectCallback ? `<button class="secondary btn-add-to-workout" data-id="${ex.id}">${exerciseSelectButtonText || 'Add to Workout'}</button>` : ''}
        </div>
      `
      )
      .join('');

    if (exerciseSelectCallback) {
      grid.querySelectorAll('.btn-add-to-workout').forEach((btn) => {
        btn.addEventListener('click', () => exerciseSelectCallback(btn.dataset.id));
      });
    }
  }

  container.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => renderGrid(btn.dataset.cat));
  });

  renderGrid('All');
}

function startWorkout(planId, nameOverride) {
  const plan = planId ? session.data.plans.find((p) => p.id === planId) : null;

  if (getActiveWorkout()) {
    if (!confirm('You already have an active workout. Start a new one and discard it?')) return;
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
        ${isPastEdit ? `<div class="muted">${new Date(workout.date).toLocaleString()}</div>` : `<div class="timer" id="workout-timer">${formatDuration(workout.startTime)}</div>`}
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
      const pr = getPR(exercise.exerciseId);
      const isCardio = isCardioExercise(exercise.exerciseId);
      return `
        <div class="active-exercise" data-idx="${exIndex}">
          <div class="active-exercise-header">
            <div class="exercise-title-row">
              <div class="drag-handle" role="button" aria-label="Drag to reorder" tabindex="0" data-idx="${exIndex}">☰</div>
              ${isPastEdit ? '' : `<button class="secondary btn-move" data-dir="up" data-idx="${exIndex}" ${exIndex === 0 ? 'disabled' : ''} aria-label="Move exercise up">↑</button>`}
              ${isPastEdit ? '' : `<button class="secondary btn-move" data-dir="down" data-idx="${exIndex}" ${exIndex === workout.exercises.length - 1 ? 'disabled' : ''} aria-label="Move exercise down">↓</button>`}
              <div>
                <h3>${ex.name}</h3>
                ${!isCardio && pr.weight > 0 ? `<span class="pr-badge">PR ${pr.weight}${session.data.preferences.units} × ${pr.reps}</span>` : ''}
              </div>
            </div>
            <div class="exercise-actions">
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
      if (!isPastEdit && set.done) startRestTimer(exIdx, workout.exercises[exIdx].restSeconds);
    });
  });

  container.querySelectorAll('.btn-add-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      workout.exercises[exIdx].sets.push(createSet('working'));
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
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      const ex = workout.exercises[exIdx];
      let weight = findWorkingWeight(ex);
      if (!weight || weight <= 0) {
        const input = prompt('Enter your target working weight to generate warmup sets:');
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
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      if (confirm('Remove this exercise from the workout?')) {
        workout.exercises.splice(exIdx, 1);
        persist();
        renderActiveWorkout(pastWorkoutId);
      }
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

  const cancelBtn = isPastEdit ? $('cancel-edit') : $('cancel-workout');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (isPastEdit) {
        showView('history-view');
        renderHistory();
      } else if (confirm('Discard this workout?')) {
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
  exerciseSelectButtonText = 'Add to Workout';
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
  renderExercises();
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

function finishWorkout() {
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
  if (dropped > 0 && !confirm(`${dropped} set(s) have missing weight or reps and will be discarded. Finish anyway?`)) {
    return;
  }

  workout.exercises = workout.exercises.filter((ex) => ex.sets.length > 0);
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
  workout.setsCount = workout.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
  workout.xp = xpForWorkout(workout.exercises.flatMap((ex) => ex.sets));

  const idx = session.data.workouts.findIndex((w) => w.id === workout.id);
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

function renderHistory() {
  const container = $('history-list');
  if (session.data.workouts.length === 0) {
    container.innerHTML = '<p class="muted">No completed workouts yet.</p>';
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
              (ex) => `
            <div class="history-exercise">
              <strong>${getExercise(ex.exerciseId).name}</strong>
              <span>${ex.sets
                .map((s) => formatSetSummary(ex, s))
                .filter(Boolean)
                .join(' • ')}</span>
            </div>
          `
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
    btn.addEventListener('click', () => {
      if (!confirm('Delete this workout from history?')) return;
      session.data.workouts = session.data.workouts.filter((w) => w.id !== btn.dataset.id);
      syncDataImmediate();
      renderHistory();
    });
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
    if (totalWeight <= (units === 'kg' ? 20 : 45)) return 'Empty barbell or less';
    return 'No standard plate combination';
  }
  const counts = {};
  plates.forEach((p) => (counts[p] = (counts[p] || 0) + 1));
  const plateStr = Object.entries(counts)
    .map(([plate, count]) => `${count}×${plate}${units}`)
    .join(', ');
  return `${plateStr} per side${remaining > 0.01 ? ` (remainder ${Math.round(remaining * 100) / 100}${units})` : ''}`;
}

function initBarbellMath(container) {
  // No-op: handled by popover below for cleaner UX.
}

function initWeightInputPopover(container) {
  container.querySelectorAll('input.weight-input').forEach((input) => {
    input.addEventListener('focus', () => {
      let popover = input.parentElement.querySelector('.barbell-popover');
      if (!popover) {
        popover = document.createElement('div');
        popover.className = 'barbell-popover';
        input.parentElement.style.position = 'relative';
        input.parentElement.appendChild(popover);
      }
      const weight = Number(input.value);
      popover.textContent = weight > 0 ? formatPlates(weight) : 'Enter weight to see plates';
      popover.classList.add('visible');
    });

    input.addEventListener('input', () => {
      const popover = input.parentElement.querySelector('.barbell-popover');
      const weight = Number(input.value);
      if (popover) {
        popover.textContent = weight > 0 ? formatPlates(weight) : 'Enter weight to see plates';
      }
    });

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
      const data = await decryptData(encrypted, session.encKey);
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
    if ($('sync-status')) $('sync-status').textContent = `Sync load failed: ${err.message}`;
  }
}

function scheduleSync() {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => performSync(), 1200);
}

async function performSync() {
  syncTimeout = null;
  const status = $('sync-status');
  try {
    const encrypted = await encryptData(session.data, session.encKey);
    await api('/sync', {
      method: 'PUT',
      body: JSON.stringify({ encryptedBlob: JSON.stringify(encrypted) }),
    });
    if (status) status.textContent = isDemoMode ? 'Demo data saved locally.' : 'Encrypted state synced successfully.';
  } catch (err) {
    if (status) status.textContent = `Sync failed: ${err.message}`;
    showToast(`Sync failed: ${err.message}`, 'error');
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
  const resumeBtn = $('resume-workout-btn');
  if (resumeBtn) resumeBtn.addEventListener('click', resumeWorkout);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
