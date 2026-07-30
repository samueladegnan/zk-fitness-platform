/**
 * ZK Fitness - Pure, testable domain logic.
 *
 * These functions have no side effects and no DOM/browser dependencies,
 * so they can be unit tested in Node with no special setup.
 */

import { isTimeBasedExercise } from '../exercises.js';

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

/**
 * Formats a plan exercise target summary for any workout type.
 * Falls back gracefully when target values are missing/empty.
 */
function formatPlanExerciseTarget(ex, isCardio, isTimeBased, units, detailed = false) {
  if (isCardio) {
    const dist = formatSetValue(ex.targetDistance || 0);
    const dur = ex.targetDuration || 0;
    const distUnit = getDistanceUnit(units);
    if (dist > 0 && dur > 0) return detailed ? `${dist} ${distUnit} • ${dur} min` : `${dist}${distUnit} in ${dur}m`;
    if (dist > 0) return detailed ? `${dist} ${distUnit}` : `${dist}${distUnit}`;
    if (dur > 0) return detailed ? `${dur} min` : `${dur}m`;
    return 'Cardio';
  }

  const sets = ex.targetSets || 1;
  const rest = ex.restSeconds || 0;

  if (isTimeBased) {
    const time = ex.targetTime || 0;
    if (detailed) {
      const timeStr = time > 0 ? ` × ${time} sec` : '';
      return `${sets} sets${timeStr} • ${rest}s rest`;
    }
    return time > 0 ? `${sets}x${time}s` : `${sets} sets`;
  }

  const reps = ex.targetReps || 0;
  if (detailed) {
    const repsStr = reps > 0 ? ` × ${reps} reps` : '';
    return `${sets} sets${repsStr} • ${rest}s rest`;
  }
  return reps > 0 ? `${sets}x${reps}` : `${sets} sets`;
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

/**
 * Formats a numeric value for display/input without changing the stored value.
 * Keeps full precision in storage; only tidies what the user sees.
 */
function formatSetValue(value, decimals = 2) {
  if (value === '' || value == null) return '';
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  return Number(num.toFixed(decimals));
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
  if (set.time > 0) {
    // Time-based holds: scale XP by hold time (seconds) and optional added weight.
    return Math.max(1, Math.round((set.time / 60) * 10 + weightKg * (set.time / 60) * 0.15));
  }
  const reps = set.reps || 0;
  return weightKg > 0 && reps > 0 ? Math.round(weightKg * reps * 0.15) : 0;
}

function xpForWorkout(sets, units = 'kg') {
  const base = sets.reduce((sum, s) => sum + (s.xp || xpForSet(s, units)), 0);
  return sets.length > 0 ? base + 50 : 0;
}

function totalTonnage(sets, units = 'kg') {
  return sets.reduce((sum, s) => {
    if (!s.done) return sum;
    const weight = Number(s.weight) || 0;
    const reps = Number(s.reps) || 0;
    const weightKg = units === 'lbs' ? weight * KG_PER_LB : weight;
    return sum + weightKg * reps;
  }, 0);
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
  if (set.time > 0) {
    // Time-based holds: estimate calories from hold time and optional weight.
    const weightKg = weight > 0 ? convertWeight(weight, units, 'kg') : 70;
    return Math.round((set.time / 60) * weightKg * 0.05);
  }
  const reps = Number(set.reps);
  if (!weight || weight <= 0 || !reps || reps <= 0) return 0;
  const weightKg = convertWeight(weight, units, 'kg');
  return weightKg * reps * 0.015;
}

function computeStats(workouts, isCardioFn, units) {
  const totalXp = workouts.reduce((sum, w) => sum + (w.xp || 0), 0);
  // Tonnage is always returned in kg so badge thresholds and totals stay consistent
  // regardless of whether the user is currently displaying kg or lbs.
  const tonnage = workouts.reduce(
    (sum, w) => sum + totalTonnage(w.exercises.flatMap((e) => e.sets), units),
    0
  );
  let distance = 0;
  let calories = 0;
  workouts.forEach((w) => {
    w.exercises.forEach((ex) => {
      const isCardio = isCardioFn ? isCardioFn(ex.exerciseId) : false;
      ex.sets.forEach((s) => {
        if (!s.done) return;
        if (isCardio) {
          const dist = Number(s.distance) || 0;
          // Distance is always returned in km for the same consistency.
          distance += units === 'lbs' ? convertDistance(dist, 'mi', 'km') : dist;
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

// ─── Badges ─────────────────────────────────────────────────────────────────

const BADGE_DEFINITIONS = [
  // Volume
  { id: 'first_workout', name: 'First Step', description: 'Complete your first workout', icon: '🏃', tier: 'bronze', category: 'Volume', progress: (s) => Math.min(s.workouts, 1), target: 1 },
  { id: 'consistent', name: 'Consistent', description: 'Complete 10 workouts', icon: '🔥', tier: 'silver', category: 'Volume', progress: (s) => Math.min(s.workouts, 10), target: 10 },
  { id: 'dedicated', name: 'Dedicated', description: 'Complete 50 workouts', icon: '⚡', tier: 'gold', category: 'Volume', progress: (s) => Math.min(s.workouts, 50), target: 50 },
  { id: 'workout_legend', name: 'Workout Legend', description: 'Complete 100 workouts', icon: '👑', tier: 'diamond', category: 'Volume', progress: (s) => Math.min(s.workouts, 100), target: 100 },

  // Strength
  { id: 'heavy_lifter', name: 'Heavy Lifter', description: 'Move 10,000 kg of total volume', icon: '🏋️', tier: 'bronze', category: 'Strength', progress: (s) => Math.min(s.tonnage, 10000), target: 10000 },
  { id: 'iron_warrior', name: 'Iron Warrior', description: 'Move 50,000 kg of total volume', icon: '🦾', tier: 'silver', category: 'Strength', progress: (s) => Math.min(s.tonnage, 50000), target: 50000 },
  { id: 'beast_mode', name: 'Beast Mode', description: 'Move 250,000 kg of total volume', icon: '🐻', tier: 'gold', category: 'Strength', progress: (s) => Math.min(s.tonnage, 250000), target: 250000 },
  { id: 'titan', name: 'Titan', description: 'Move 1,000,000 kg of total volume', icon: '⚔️', tier: 'diamond', category: 'Strength', progress: (s) => Math.min(s.tonnage, 1000000), target: 1000000 },

  // Cardio
  { id: 'first_mile', name: 'First Mile', description: 'Travel 1 km of cardio distance', icon: '🏃', tier: 'bronze', category: 'Cardio', progress: (s) => Math.min(s.distance, 1), target: 1 },
  { id: 'road_runner', name: 'Road Runner', description: 'Travel 50 km of cardio distance', icon: '🦅', tier: 'silver', category: 'Cardio', progress: (s) => Math.min(s.distance, 50), target: 50 },
  { id: 'marathoner', name: 'Marathoner', description: 'Travel 500 km of cardio distance', icon: '🏅', tier: 'gold', category: 'Cardio', progress: (s) => Math.min(s.distance, 500), target: 500 },
  { id: 'ultra_runner', name: 'Ultra Runner', description: 'Travel 2,000 km of cardio distance', icon: '🔥', tier: 'diamond', category: 'Cardio', progress: (s) => Math.min(s.distance, 2000), target: 2000 },

  // XP
  { id: 'xp_rookie', name: 'XP Rookie', description: 'Earn 1,000 XP', icon: '🌱', tier: 'bronze', category: 'XP', progress: (s) => Math.min(s.totalXp, 1000), target: 1000 },
  { id: 'xp_grinder', name: 'XP Grinder', description: 'Earn 5,000 XP', icon: '⭐', tier: 'silver', category: 'XP', progress: (s) => Math.min(s.totalXp, 5000), target: 5000 },
  { id: 'xp_master', name: 'XP Master', description: 'Earn 20,000 XP', icon: '💫', tier: 'gold', category: 'XP', progress: (s) => Math.min(s.totalXp, 20000), target: 20000 },
  { id: 'xp_legend', name: 'XP Legend', description: 'Earn 100,000 XP', icon: '✨', tier: 'diamond', category: 'XP', progress: (s) => Math.min(s.totalXp, 100000), target: 100000 },

  // Streak
  { id: 'on_fire', name: 'On Fire', description: 'Log workouts 3 days in a row', icon: '🔥', tier: 'bronze', category: 'Streak', progress: (s, streak) => Math.min(streak, 3), target: 3 },
  { id: 'unstoppable', name: 'Unstoppable', description: 'Log workouts 7 days in a row', icon: '⚡', tier: 'silver', category: 'Streak', progress: (s, streak) => Math.min(streak, 7), target: 7 },
  { id: 'streak_beast', name: 'Streak Beast', description: 'Log workouts 14 days in a row', icon: '🦍', tier: 'gold', category: 'Streak', progress: (s, streak) => Math.min(streak, 14), target: 14 },

  // Level
  { id: 'rising_star', name: 'Rising Star', description: 'Reach Level 5', icon: '🌟', tier: 'bronze', category: 'Level', progress: (s, streak, level) => Math.min(level, 5), target: 5 },
  { id: 'fitness_guru', name: 'Fitness Guru', description: 'Reach Level 25', icon: '👑', tier: 'gold', category: 'Level', progress: (s, streak, level) => Math.min(level, 25), target: 25 },
];

/**
 * Compute all available badges and the user's progress toward each.
 *
 * @param {Object} stats - Result of computeStats ({ totalXp, tonnage, workouts, distance, calories })
 * @param {number} streak - Current streak (e.g. from currentStreak())
 * @param {number} level - Current level (e.g. from getLevel())
 * @returns {Object[]} Ordered array of badge objects with progress, target, unlocked, etc.
 */
function computeBadges(stats, streak = 0, level = 1) {
  const safeStats = stats || {};
  const badgeStats = {
    totalXp: safeStats.totalXp || 0,
    tonnage: safeStats.tonnage || 0,
    workouts: safeStats.workouts || 0,
    distance: safeStats.distance || 0,
    calories: safeStats.calories || 0,
  };

  return BADGE_DEFINITIONS.map((def) => {
    const progress = def.progress(badgeStats, streak, level);
    const target = def.target;
    const unlocked = progress >= target;
    const progressPercent = Math.min(100, Math.round((progress / target) * 100));
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      icon: def.icon,
      tier: def.tier,
      category: def.category,
      progress,
      target,
      unlocked,
      progressPercent,
    };
  });
}

function xpToNextLevel(totalXp) {
  const currentLevel = getLevel(totalXp);
  const next = currentLevel * currentLevel * 100;
  const prev = (currentLevel - 1) * (currentLevel - 1) * 100;
  return { next, prev, current: totalXp - prev, range: next - prev };
}

function getPR(workouts, exerciseId) {
  let pr = { weight: 0, reps: 0, time: 0, date: null };
  const isTimeBased = isTimeBasedExercise(exerciseId);
  workouts.forEach((w) => {
    w.exercises.forEach((e) => {
      if (e.exerciseId !== exerciseId) return;
      e.sets.forEach((s) => {
        if (s.type !== 'working' || !s.done) return;
        if (isTimeBased) {
          if (s.time > pr.time || (s.time === pr.time && s.weight > pr.weight)) {
            pr = { weight: s.weight, time: s.time, reps: 0, date: w.date };
          }
        } else if (s.weight > pr.weight || (s.weight === pr.weight && s.reps > pr.reps)) {
          pr = { weight: s.weight, reps: s.reps, time: 0, date: w.date };
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
      if (pr.weight > 0 || pr.reps > 0 || pr.time > 0) {
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
      if (s.type !== 'working' || !s.done) continue;
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
        time: Number(s.time) || 0,
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
      if (s.type !== 'working' || !s.done || !s.weight || s.weight <= 0 || !s.reps || s.reps <= 0) continue;
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

/**
 * Aggregate per-workout exercise history for progress charts.
 * Multiple completed sets of the same exercise within a single workout are
 * collapsed into one point so the chart shows progress per workout.
 */
function getExerciseChartHistory(history) {
  if (!history.length) return [];
  const byWorkout = new Map();
  for (const h of history) {
    const existing = byWorkout.get(h.workoutId);
    if (!existing) {
      byWorkout.set(h.workoutId, {
        workoutId: h.workoutId,
        workoutName: h.workoutName,
        date: h.date,
        weight: h.weight,
        reps: h.reps,
        time: h.time,
        distance: h.distance,
        durationMinutes: h.durationMinutes,
        oneRm: h.oneRm,
        speed: h.speed,
      });
      continue;
    }
    existing.distance += h.distance;
    existing.durationMinutes += h.durationMinutes;
    if (h.time > existing.time) {
      existing.time = h.time;
      existing.weight = h.weight;
    }
    if (h.oneRm > existing.oneRm) {
      existing.oneRm = h.oneRm;
      existing.weight = h.weight;
      existing.reps = h.reps;
    }
  }
  return Array.from(byWorkout.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
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
  if (isTimeBasedExercise(exerciseId)) {
    const maxTime = history.reduce((max, h) => Math.max(max, h.time), 0);
    const maxWeight = history.reduce((max, h) => Math.max(max, h.weight), 0);
    return { maxTime, maxWeight };
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
  getExerciseChartHistory,
  getExerciseRecords,
  getBestOneRepMax,
  convertWeight,
  convertDistance,
  roundConverted,
  getDistanceUnit,
  formatPlanExerciseTarget,
  formatSetValue,
  computeBadges,
};
