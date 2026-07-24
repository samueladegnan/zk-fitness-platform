/**
 * ZK Fitness — Client Application
 *
 * - Derives auth and encryption keys from the password using Argon2id + HKDF.
 * - Encrypts/decrypts workout data with Web Crypto API (AES-256-GCM).
 * - Runs the gamification engine (XP, tonnage, streak, levels, badges, PRs) in the browser.
 */

const API_BASE = 'http://localhost:3000/api';

// In-memory session state (never persists to disk unencrypted)
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
let globalTimerInterval = null;
let restTimerInterval = null;
let restEndTime = 0;
let currentView = 'auth-view';
let syncTimeout = null;

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

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(session.token && { Authorization: `Bearer ${session.token}` }),
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

// ─── Gamification Engine ────────────────────────────────────────────────────

function xpForSet(weight, reps) {
  return weight > 0 && reps > 0 ? Math.round(weight * reps * 0.15) : 0;
}

function xpForWorkout(sets) {
  const base = sets.reduce((sum, s) => sum + (s.xp || xpForSet(s.weight, s.reps)), 0);
  return base + 50;
}

function totalTonnage(sets) {
  return sets.reduce((sum, s) => sum + (s.weight || 0) * (s.reps || 0), 0);
}

function computeStats() {
  const workouts = session.data.workouts;
  const totalXp = workouts.reduce((sum, w) => sum + (w.xp || 0), 0);
  const tonnage = workouts.reduce((sum, w) => sum + totalTonnage(w.exercises.flatMap((e) => e.sets)), 0);
  return { totalXp, tonnage, workouts: workouts.length };
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
  if (stats.workouts >= 1) badges.push({ id: 'first_workout', name: 'First Workout', icon: '🏋️' });
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

  // Streak is broken if the last workout was before yesterday.
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
    done: false,
    xp: 0,
  };
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

function addWarmupSets(workoutExercise) {
  const lastWorkingSet = [...workoutExercise.sets].reverse().find((s) => s.type === 'working');
  const weight = lastWorkingSet ? lastWorkingSet.weight : 0;
  if (!weight || weight <= 0) return workoutExercise;
  const warmups = generateWarmupSets(weight);
  const newSets = warmups.map((w) => ({ ...createSet('warmup'), weight: w.weight, reps: w.reps }));
  workoutExercise.sets = [...newSets, ...workoutExercise.sets];
  return workoutExercise;
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

  // Also update the live timer inside the active workout view if visible.
  const workoutTimer = $('workout-timer');
  if (workoutTimer) workoutTimer.textContent = formatDuration(workout.startTime);

  // Hide the Resume button when already on the workout view.
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

function initAuthUI() {
  const authForm = $('auth-form');
  const authBtn = $('auth-btn');
  const toggleBtn = $('toggle-mode');

  toggleBtn.addEventListener('click', () => {
    isRegisterMode = !isRegisterMode;
    authBtn.textContent = isRegisterMode ? 'Register' : 'Log in';
    toggleBtn.textContent = isRegisterMode ? 'Already have an account? Log in' : 'Need an account? Register';
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('auth-error').textContent = '';
    const username = $('username').value.trim();
    const password = $('password').value;
    const salt = await deriveSalt(username);

    try {
      const { authKey, encKey } = await deriveKeys(password, salt);
      session = { ...session, username, encKey, salt };

      if (isRegisterMode) {
        const res = await api('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, authKeyHash: authKey, salt: arrayBufferToBase64(salt) }),
        });
        session.token = res.token;
      } else {
        const res = await api('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, authKeyHash: authKey }),
        });
        session.token = res.token;
      }

      isAuthenticated = true;
      renderNav();
      await loadSync();
      showView('dashboard-view');
      renderDashboard();
    } catch (err) {
      $('auth-error').textContent = err.message;
    }
  });
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
    <button class="link" id="nav-exercises">Exercises</button>
    <button class="link" id="nav-logout">Log out</button>
  `;
  $('nav-dashboard').addEventListener('click', () => { showView('dashboard-view'); renderDashboard(); });
  $('nav-plans').addEventListener('click', () => { showView('plans-view'); renderPlans(); });
  $('nav-exercises').addEventListener('click', () => { showView('exercises-view'); renderExercises(); });
  $('nav-logout').addEventListener('click', logout);
}

function logout() {
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
  renderNav();
  showView('auth-view');
  $('auth-error').textContent = 'You have been logged out.';
}

function renderDashboard() {
  const stats = computeStats();
  const level = getLevel(stats.totalXp);
  const xpInfo = xpToNextLevel(stats.totalXp);
  const badges = computeBadges(stats);
  const recentPRs = getRecentPRs();
  const units = session.data.preferences.units || 'kg';

  // Bind units toggle button if present.
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
    tr.innerHTML = `<td colspan="5" class="muted">No workouts yet. Start one from the Plans tab.</td>`;
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
        </div>
      </div>
    `
    )
    .join('');

  list.querySelectorAll('.btn-start').forEach((btn) =>
    btn.addEventListener('click', () => startWorkout(btn.dataset.id))
  );
}

let exerciseSelectCallback = null;

function renderExercises() {
  const container = $('exercises-list');
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
          ${exerciseSelectCallback ? `<button class="secondary btn-add-to-workout" data-id="${ex.id}">Add to Workout</button>` : ''}
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

function startWorkout(planId) {
  const plan = session.data.plans.find((p) => p.id === planId);
  if (!plan) return;

  if (getActiveWorkout()) {
    if (!confirm('You already have an active workout. Start a new one and discard it?')) return;
  }

  const workout = {
    id: crypto.randomUUID(),
    planId: plan.id,
    name: plan.name,
    date: new Date().toISOString(),
    startTime: Date.now(),
    exercises: plan.exercises.map((e) => createWorkoutExercise(e.exerciseId, e.targetSets, e.targetReps, e.restSeconds)),
    setsCount: 0,
    xp: 0,
  };

  setActiveWorkout(workout);
  startGlobalTimer();
  showView('workout-view');
  renderActiveWorkout();
}

function resumeWorkout() {
  const workout = getActiveWorkout();
  if (!workout) return;
  showView('workout-view');
  renderActiveWorkout();
}

function renderActiveWorkout() {
  const workout = getActiveWorkout();
  if (!workout) return;
  const view = $('workout-view');

  // Restore an active rest timer when returning to the workout view.
  if (workout.restUntil && workout.restUntil > Date.now()) {
    clearInterval(restTimerInterval);
    restTimerInterval = null;
    restEndTime = workout.restUntil;
    renderRestTimer(workout.restExerciseIndex ?? 0);
  }

  view.innerHTML = `
    <div class="workout-header">
      <div>
        <h2>${workout.name}</h2>
        <div class="timer" id="workout-timer">${formatDuration(workout.startTime)}</div>
      </div>
      <div class="rest-big" id="rest-big"></div>
    </div>
    <div id="active-exercises"></div>
    <div class="workout-actions">
      <button id="finish-workout" class="btn-finish">Finish Workout</button>
      <button id="cancel-workout" class="secondary">Cancel</button>
    </div>
  `;

  const container = $('active-exercises');
  container.innerHTML = workout.exercises
    .map((exercise, exIndex) => {
      const ex = getExercise(exercise.exerciseId);
      const pr = getPR(exercise.exerciseId);
      return `
        <div class="active-exercise" data-idx="${exIndex}">
          <div class="active-exercise-header">
            <div class="exercise-title-row">
              <div class="drag-handle" role="button" aria-label="Drag to reorder" tabindex="0" data-idx="${exIndex}">☰</div>
              <button class="secondary btn-move" data-dir="up" data-idx="${exIndex}" ${exIndex === 0 ? 'disabled' : ''} aria-label="Move exercise up">↑</button>
              <button class="secondary btn-move" data-dir="down" data-idx="${exIndex}" ${exIndex === workout.exercises.length - 1 ? 'disabled' : ''} aria-label="Move exercise down">↓</button>
              <div>
                <h3>${ex.name}</h3>
                ${pr.weight > 0 ? `<span class="pr-badge">PR ${pr.weight}${session.data.preferences.units} × ${pr.reps}</span>` : ''}
              </div>
            </div>
            <div class="exercise-actions">
              <div class="rest-setting" title="Rest time between sets">
                <label>Rest</label>
                <input type="number" value="${exercise.restSeconds}" data-idx="${exIndex}" data-field="restSeconds" />
                <span>s</span>
              </div>
              <button class="secondary btn-add-warmup" data-idx="${exIndex}">+ Warmup</button>
              <button class="secondary btn-remove-ex" data-idx="${exIndex}">Remove</button>
            </div>
          </div>
          <div class="sets">
            ${exercise.sets
              .map(
                (set, setIndex) => `
              <div class="set-row ${set.type}" data-set-idx="${setIndex}">
                <span class="set-type">${set.type === 'warmup' ? 'W' : 'S'}</span>
                <div class="set-field">
                  <label>Weight</label>
                  <input type="number" placeholder="kg" value="${set.weight}" data-idx="${exIndex}" data-set="${setIndex}" data-field="weight" />
                </div>
                <div class="set-field">
                  <label>Reps</label>
                  <input type="number" placeholder="reps" value="${set.reps}" data-idx="${exIndex}" data-set="${setIndex}" data-field="reps" />
                </div>
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
      setActiveWorkout(workout);
    });
  });

  container.querySelectorAll('.set-done').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      const setIdx = Number(btn.dataset.set);
      const set = workout.exercises[exIdx].sets[setIdx];
      // Convert any string inputs to numbers before computing XP.
      set.weight = set.weight === '' ? 0 : Number(set.weight);
      set.reps = set.reps === '' ? 0 : Number(set.reps);
      set.done = !set.done;
      set.xp = set.done ? xpForSet(set.weight, set.reps) : 0;
      setActiveWorkout(workout);
      renderActiveWorkout();
      if (set.done) startRestTimer(exIdx, workout.exercises[exIdx].restSeconds);
    });
  });

  container.querySelectorAll('.btn-add-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      workout.exercises[exIdx].sets.push(createSet('working'));
      setActiveWorkout(workout);
      renderActiveWorkout();
    });
  });

  container.querySelectorAll('.btn-delete-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      const setIdx = Number(btn.dataset.set);
      workout.exercises[exIdx].sets.splice(setIdx, 1);
      setActiveWorkout(workout);
      renderActiveWorkout();
    });
  });

  container.querySelectorAll('.btn-add-warmup').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      workout.exercises[exIdx] = addWarmupSets(workout.exercises[exIdx]);
      setActiveWorkout(workout);
      renderActiveWorkout();
    });
  });

  container.querySelectorAll('.btn-remove-ex').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      if (confirm('Remove this exercise from the workout?')) {
        workout.exercises.splice(exIdx, 1);
        setActiveWorkout(workout);
        renderActiveWorkout();
      }
    });
  });

  container.querySelectorAll('.btn-move').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.idx);
      const dir = btn.dataset.dir;
      const newIdx = dir === 'up' ? exIdx - 1 : exIdx + 1;
      if (newIdx < 0 || newIdx >= workout.exercises.length) return;
      [workout.exercises[exIdx], workout.exercises[newIdx]] = [workout.exercises[newIdx], workout.exercises[exIdx]];
      setActiveWorkout(workout);
      renderActiveWorkout();
    });
  });

  $('finish-workout').addEventListener('click', finishWorkout);
  $('cancel-workout').addEventListener('click', () => {
    if (confirm('Discard this workout?')) {
      clearActiveWorkout();
      stopGlobalTimer();
      clearInterval(restTimerInterval);
      showView('dashboard-view');
      renderDashboard();
    }
  });

  const addExerciseBtn = document.createElement('button');
  addExerciseBtn.className = 'secondary';
  addExerciseBtn.textContent = '+ Add Exercise';
  addExerciseBtn.style.marginTop = '1rem';
  addExerciseBtn.addEventListener('click', openExerciseSelector);
  container.appendChild(addExerciseBtn);

  initExerciseDragAndDrop(container, workout);
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

    // Re-map the workout.exercises array based on the new DOM order.
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

function renderRestTimer(exIdx) {
  const workout = getActiveWorkout();
  const remaining = Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
  const big = $('rest-big');
  const section = exIdx !== null ? $(`rest-${exIdx}`) : null;

  if (remaining > 0) {
    const html = `<div class="rest-timer">Rest: ${remaining}s</div>`;
    if (section) section.innerHTML = html;
    if (big) big.innerHTML = html;
  } else {
    if (section) section.innerHTML = `<div class="rest-timer done">Rest complete</div>`;
    if (big) big.innerHTML = `<div class="rest-timer done">Rest complete</div>`;
  }

  if (remaining > 0 && !restTimerInterval) {
    restTimerInterval = setInterval(() => renderRestTimer(exIdx), 1000);
  } else if (remaining <= 0) {
    clearInterval(restTimerInterval);
    restTimerInterval = null;
    // Clear persisted rest state once the timer finishes.
    if (workout) {
      delete workout.restUntil;
      delete workout.restExerciseIndex;
      setActiveWorkout(workout);
    }
  }
}

function finishWorkout() {
  const workout = getActiveWorkout();
  if (!workout) return;
  workout.endTime = Date.now();
  workout.durationSeconds = Math.floor((workout.endTime - workout.startTime) / 1000);

  workout.exercises.forEach((ex) => {
    ex.sets = ex.sets
      .filter((s) => s.weight !== '' && s.reps !== '' && Number(s.weight) > 0 && Number(s.reps) > 0)
      .map((s) => ({
        ...s,
        weight: Number(s.weight),
        reps: Number(s.reps),
        xp: xpForSet(Number(s.weight), Number(s.reps)),
        done: true,
      }));
  });

  // Warn about sets that will be dropped because they are empty/invalid.
  const dropped = workout.exercises.reduce((count, ex) => {
    const invalid = ex.sets.filter((s) => s.weight === '' || s.reps === '' || Number(s.weight) <= 0 || Number(s.reps) <= 0).length;
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
  showView('dashboard-view');
  renderDashboard();
}

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
      if ($('sync-status')) $('sync-status').textContent = 'Loaded latest encrypted state from cloud.';
    } else {
      session.data.plans = seedPlans();
      if ($('sync-status')) $('sync-status').textContent = 'No prior sync found. Starting fresh.';
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
    if (status) status.textContent = 'Encrypted state synced successfully.';
  } catch (err) {
    if (status) status.textContent = `Sync failed: ${err.message}`;
    showToast(`Sync failed: ${err.message}`, 'error');
  }
}

async function syncData() {
  // Debounce sync so rapid edits (typing weight/reps, adding sets) don't spam the API.
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
