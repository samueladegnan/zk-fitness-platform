/**
 * ZK Fitness - Pure, testable domain logic.
 *
 * These functions have no side effects and no DOM/browser dependencies,
 * so they can be unit tested in Node with no special setup.
 */

const KG_PER_LB = 0.45359237;
const KM_PER_MI = 1.609344;

function convertWeight(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  const num = Number(value);
  if (!num || Number.isNaN(num)) return num;
  if (fromUnit === 'kg' && toUnit === 'lbs') return num / KG_PER_LB;
  if (fromUnit === 'lbs' && toUnit === 'kg') return num * KG_PER_LB;
  return num;
}

function getDistanceUnit(units) {
  return units === 'lbs' ? 'mi' : 'km';
}

function convertDistance(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  const num = Number(value);
  if (!num || Number.isNaN(num)) return num;
  if (fromUnit === 'km' && toUnit === 'mi') return num / KM_PER_MI;
  if (fromUnit === 'mi' && toUnit === 'km') return num * KM_PER_MI;
  return num;
}

function roundConverted(value) {
  return Number((Math.round(value * 100) / 100).toFixed(2));
}

function calculateOneRepMax(weight, reps) {
  if (!weight || weight <= 0 || !reps || reps < 1) return null;
  const w = Number(weight);
  const r = Number(reps);
  const epley = w * (1 + r / 30);
  const brzycki = w / (1.0278 - 0.0278 * r);
  return { epley, brzycki };
}

function formatOneRm(value, units) {
  if (value === null || Number.isNaN(value)) return '-';
  return `${Math.round(value)} ${units}`;
}

function averageOneRm(weight, reps) {
  const est = calculateOneRepMax(weight, reps);
  if (!est) return 0;
  return (est.epley + est.brzycki) / 2;
}

function xpForSet(set, units = 'kg') {
  if (set.durationMinutes > 0) {
    return Math.max(10, Math.round((set.durationMinutes || 0) * 1.5 + (set.calories || 0) * 0.1));
  }
  // XP is always based on the actual weight in kg so it doesn't drift when units change.
  const weightDisplay = set.weight || 0;
  const weightKg = units === 'lbs' ? weightDisplay * KG_PER_LB : weightDisplay;
  const reps = set.reps || 0;
  return weightKg > 0 && reps > 0 ? Math.round(weightKg * reps * 0.15) : 0;
}

function xpForWorkout(sets, units = 'kg') {
  const base = sets.reduce((sum, s) => sum + (s.xp || xpForSet(s, units)), 0);
  return sets.length > 0 ? base + 50 : 0;
}

function totalTonnage(sets) {
  return sets.reduce((sum, s) => sum + (s.weight || 0) * (s.reps || 0), 0);
}

function calculateCardioCalories(set, units = 'kg') {
  // Calories are always based on the actual distance in km, regardless of display unit.
  const distUnit = getDistanceUnit(units);
  const distanceKm = distUnit === 'mi' ? convertDistance(set.distance, 'mi', 'km') : Number(set.distance);
  if (distanceKm > 0 && set.durationMinutes > 0) {
    return Math.round(set.durationMinutes * 10 + distanceKm * 60);
  }
  if (distanceKm > 0) return Math.round(distanceKm * 60);
  if (set.durationMinutes > 0) return Math.round(set.durationMinutes * 10);
  return 0;
}

function getCaloriesForSet(set, isCardio, units) {
  if (isCardio) {
    return calculateCardioCalories(set, units);
  }
  const weight = Number(set.weight);
  const reps = Number(set.reps);
  if (!weight || weight <= 0 || !reps || reps <= 0) return 0;
  const weightKg = convertWeight(weight, units, 'kg');
  return weightKg * reps * 0.015;
}

function computeStats(workouts, isCardioFn, units) {
  const totalXp = workouts.reduce((sum, w) => sum + (w.xp || 0), 0);
  const tonnage = workouts.reduce(
    (sum, w) => sum + totalTonnage(w.exercises.flatMap((e) => e.sets)),
    0
  );
  let distance = 0;
  let calories = 0;
  workouts.forEach((w) => {
    w.exercises.forEach((ex) => {
      const isCardio = isCardioFn ? isCardioFn(ex.exerciseId) : false;
      ex.sets.forEach((s) => {
        if (isCardio) {
          distance += Number(s.distance) || 0;
        }
        calories += getCaloriesForSet(s, isCardio, units);
      });
    });
  });
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

function getPR(workouts, exerciseId) {
  let pr = { weight: 0, reps: 0, date: null };
  workouts.forEach((w) => {
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

function getRecentPRs(workouts, limit = 3, getExerciseName) {
  const all = [];
  const seen = new Set();
  [...workouts].reverse().forEach((w) => {
    w.exercises.forEach((e) => {
      if (seen.has(e.exerciseId)) return;
      const pr = getPR(workouts, e.exerciseId);
      if (pr.weight > 0) {
        all.push({ exerciseId: e.exerciseId, name: getExerciseName ? getExerciseName(e.exerciseId) : undefined, ...pr });
        seen.add(e.exerciseId);
      }
    });
  });
  return all.slice(0, limit);
}

function currentStreak(workouts) {
  const uniqueTimestamps = [...new Set(workouts.map((w) => {
    const d = new Date(w.date);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }))].sort((a, b) => a - b);
  if (uniqueTimestamps.length === 0) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last = uniqueTimestamps[uniqueTimestamps.length - 1];
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceLast = Math.round((today.getTime() - last) / msPerDay);

  if (daysSinceLast > 1) return 0;

  let streak = 1;
  for (let i = uniqueTimestamps.length - 1; i > 0; i--) {
    const diff = (uniqueTimestamps[i] - uniqueTimestamps[i - 1]) / msPerDay;
    if (Math.round(diff) === 1) streak += 1;
    else break;
  }
  return streak;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getLevenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () => []);
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function getExerciseHistory(workouts, exerciseId, units = 'kg') {
  const history = [];
  const distUnit = getDistanceUnit(units);
  for (const w of workouts) {
    const ex = w.exercises.find((e) => e.exerciseId === exerciseId);
    if (!ex) continue;
    for (let i = 0; i < ex.sets.length; i += 1) {
      const s = ex.sets[i];
      if (s.type !== 'working') continue;
      const oneRm = averageOneRm(s.weight, s.reps);
      const distance = Number(s.distance) || 0;
      const durationMinutes = Number(s.durationMinutes) || 0;
      const speed = distance > 0 && durationMinutes > 0
        ? roundConverted(distance / (durationMinutes / 60))
        : 0;
      history.push({
        workoutId: w.id,
        workoutName: w.name,
        date: w.date,
        setIndex: i,
        weight: Number(s.weight) || 0,
        reps: Number(s.reps) || 0,
        distance,
        durationMinutes,
        oneRm,
        speed,
      });
    }
  }
  return history.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function getBestOneRepMax(workouts, exerciseId) {
  let best = null;
  for (const w of workouts) {
    const ex = w.exercises.find((e) => e.exerciseId === exerciseId);
    if (!ex) continue;
    for (const s of ex.sets) {
      if (s.type !== 'working' || !s.weight || s.weight <= 0 || !s.reps || s.reps <= 0) continue;
      const est = calculateOneRepMax(s.weight, s.reps);
      if (!est) continue;
      const avg = (est.epley + est.brzycki) / 2;
      if (!best || avg > best.avg) {
        best = { weight: s.weight, reps: s.reps, epley: est.epley, brzycki: est.brzycki, avg };
      }
    }
  }
  return best;
}

function getExerciseRecords(workouts, exerciseId, isCardioFn, units = 'kg') {
  const history = getExerciseHistory(workouts, exerciseId, units);
  const isCardio = isCardioFn ? isCardioFn(exerciseId) : false;
  if (history.length === 0) return null;
  if (isCardio) {
    const distance = history.reduce((max, h) => Math.max(max, h.distance), 0);
    const duration = history.reduce((max, h) => Math.max(max, h.durationMinutes), 0);
    const maxSpeed = history.reduce((max, h) => Math.max(max, h.speed), 0);
    return { distance, duration, maxSpeed, distUnit: getDistanceUnit(units) };
  }
  const maxWeight = history.reduce((max, h) => Math.max(max, h.weight), 0);
  const maxReps = history.reduce((max, h) => Math.max(max, h.reps), 0);
  const best1rm = history.reduce((max, h) => Math.max(max, h.oneRm), 0);
  const heaviestSet = history.find((h) => h.weight === maxWeight) || history[0];
  return { maxWeight, maxReps, best1rm, heaviestSet };
}

export {
  calculateOneRepMax,
  formatOneRm,
  averageOneRm,
  xpForSet,
  xpForWorkout,
  totalTonnage,
  computeStats,
  getCaloriesForSet,
  calculateCardioCalories,
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
  convertWeight,
  convertDistance,
  roundConverted,
  getDistanceUnit,
};
