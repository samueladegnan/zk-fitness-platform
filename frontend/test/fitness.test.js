/**
 * ZK Fitness - Pure domain logic unit tests
 *
 * Run with: npm test
 * Uses Node's built-in test runner so no extra test framework is required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateOneRepMax,
  formatOneRm,
  averageOneRm,
  xpForSet,
  xpForWorkout,
  totalTonnage,
  computeStats,
  getCaloriesForSet,
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
  computeBadges,
} from '../lib/fitness.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function strengthSet(weight, reps, type = 'working') {
  return { type, weight, reps, done: true, distance: '', durationMinutes: '', calories: '', heartRate: '' };
}

function cardioSet(distance, durationMinutes, calories = 0, type = 'working') {
  return { type, weight: '', reps: '', done: true, distance, durationMinutes, calories, heartRate: '' };
}

function timeSet(weight, time, type = 'working') {
  return { type, weight, reps: '', done: true, time, distance: '', durationMinutes: '', calories: '', heartRate: '' };
}

function makeWorkout({ id = nextId(), name = 'Test Workout', date, exercises = [], xp = 0, setsCount = 0 } = {}) {
  return { id, name, date: date || new Date().toISOString(), exercises, xp, setsCount };
}

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `test-workout-${idCounter}`;
}

// ─── One-Rep Max ─────────────────────────────────────────────────────────────

describe('calculateOneRepMax', () => {
  it('returns null for invalid input', () => {
    assert.strictEqual(calculateOneRepMax(0, 5), null);
    assert.strictEqual(calculateOneRepMax(100, 0), null);
    assert.strictEqual(calculateOneRepMax(-10, 5), null);
    assert.strictEqual(calculateOneRepMax('', 5), null);
  });

  it('estimates 1RM from weight and reps', () => {
    const result = calculateOneRepMax(100, 5);
    assert.ok(result.epley > 100);
    assert.ok(result.brzycki > 100);
  });

  it('is deterministic for the same inputs', () => {
    assert.deepStrictEqual(calculateOneRepMax(80, 8), calculateOneRepMax(80, 8));
  });
});

describe('averageOneRm', () => {
  it('returns the average of Epley and Brzycki', () => {
    const avg = averageOneRm(100, 5);
    const { epley, brzycki } = calculateOneRepMax(100, 5);
    assert.strictEqual(avg, (epley + brzycki) / 2);
  });

  it('returns 0 for invalid input', () => {
    assert.strictEqual(averageOneRm(0, 5), 0);
  });
});

describe('formatOneRm', () => {
  it('formats a number with units', () => {
    assert.strictEqual(formatOneRm(123.4, 'kg'), '123 kg');
  });

  it('returns a dash for null or NaN', () => {
    assert.strictEqual(formatOneRm(null, 'kg'), '-');
    assert.strictEqual(formatOneRm(Number.NaN, 'kg'), '-');
  });
});

// ─── XP & Tonnage ───────────────────────────────────────────────────────────

describe('xpForWorkout', () => {
  it('adds a 50 XP bonus to the sum of set XP', () => {
    const sets = [strengthSet(100, 10), strengthSet(80, 8)];
    const expected = xpForSet(sets[0]) + xpForSet(sets[1]) + 50;
    assert.strictEqual(xpForWorkout(sets), expected);
  });

  it('returns 0 for an empty workout', () => {
    assert.strictEqual(xpForWorkout([]), 0);
  });
});

describe('totalTonnage', () => {
  it('sums weight × reps across sets', () => {
    const sets = [strengthSet(100, 10), strengthSet(80, 8)];
    assert.strictEqual(totalTonnage(sets), 100 * 10 + 80 * 8);
  });
});

describe('getCaloriesForSet', () => {
  it('estimates strength calories from weight and reps', () => {
    const kcal = getCaloriesForSet(strengthSet(100, 10), false, 'kg');
    assert.strictEqual(kcal, 100 * 10 * 0.015);
  });

  it('recomputes cardio calories from distance and duration', () => {
    // 5 km in 30 min -> 5*60 + 30*10 = 600 kcal (formula is based on canonical km).
    const kcal = getCaloriesForSet(cardioSet(5, 30, 300), true, 'kg');
    assert.strictEqual(kcal, 600);
  });

  it('converts cardio distance to km before computing calories', () => {
    // 3.11 mi is ~5 km; should give the same calories as 5 km.
    const kcalMi = getCaloriesForSet(cardioSet(3.11, 30, 0), true, 'lbs');
    const kcalKm = getCaloriesForSet(cardioSet(5, 30, 0), true, 'kg');
    assert.strictEqual(kcalMi, kcalKm);
  });

  it('converts lbs to kg for strength estimates', () => {
    const kcalKg = getCaloriesForSet(strengthSet(100, 10), false, 'kg');
    const kcalLbs = getCaloriesForSet(strengthSet(220.462, 10), false, 'lbs');
    assert.ok(Math.abs(kcalKg - kcalLbs) < 0.001);
  });
});

// ─── Stats & Levels ─────────────────────────────────────────────────────────

describe('computeStats', () => {
  const workouts = [
    makeWorkout({
      exercises: [
        { exerciseId: 'squat', sets: [strengthSet(100, 5), strengthSet(120, 5)] },
      ],
      xp: 100,
    }),
    makeWorkout({
      exercises: [
        { exerciseId: 'running', sets: [cardioSet(5, 30, 300)] },
      ],
      xp: 50,
    }),
  ];

  it('totals XP, tonnage, workouts, distance, and calories', () => {
    const isCardio = (id) => id === 'running';
    const stats = computeStats(workouts, isCardio, 'kg');
    assert.strictEqual(stats.totalXp, 150);
    assert.strictEqual(stats.workouts, 2);
    assert.strictEqual(stats.tonnage, 100 * 5 + 120 * 5);
    assert.strictEqual(stats.distance, 5);
    const expectedStrengthKcal = Math.round((100 * 5 + 120 * 5) * 0.015);
    // Cardio calories are recomputed from distance/duration: 5 km * 60 + 30 min * 10 = 600.
    assert.strictEqual(stats.calories, 600 + expectedStrengthKcal);
  });

  it('returns zeroed stats for no workouts', () => {
    const stats = computeStats([], () => false, 'kg');
    assert.strictEqual(stats.totalXp, 0);
    assert.strictEqual(stats.workouts, 0);
    assert.strictEqual(stats.tonnage, 0);
    assert.strictEqual(stats.distance, 0);
    assert.strictEqual(stats.calories, 0);
  });

  it('returns tonnage in canonical kg when display unit is lbs', () => {
    const workouts = [
      makeWorkout({
        exercises: [{ exerciseId: 'squat', sets: [strengthSet(10000, 1)] }],
        xp: 0,
      }),
    ];
    const stats = computeStats(workouts, () => false, 'lbs');
    assert.ok(Math.abs(stats.tonnage - 4535.9237) < 0.01);
  });

  it('returns distance in canonical km when display unit is lbs (miles)', () => {
    const workouts = [
      makeWorkout({
        exercises: [{ exerciseId: 'running', sets: [cardioSet(1, 10, 0)] }],
        xp: 0,
      }),
    ];
    const stats = computeStats(workouts, () => true, 'lbs');
    assert.ok(Math.abs(stats.distance - 1.609344) < 0.001);
  });

  it('produces identical canonical stats regardless of display unit', () => {
    const kgWorkouts = [
      makeWorkout({ exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5)] }] }),
    ];
    const lbWorkouts = [
      makeWorkout({ exercises: [{ exerciseId: 'squat', sets: [strengthSet(220.462, 5)] }] }),
    ];
    const kgStats = computeStats(kgWorkouts, () => false, 'kg');
    const lbStats = computeStats(lbWorkouts, () => false, 'lbs');
    assert.ok(Math.abs(kgStats.tonnage - lbStats.tonnage) < 0.1);
  });

  it('does not unlock the 10,000 kg Heavy Lifter badge from 10,000 lbs', () => {
    const workouts = [
      makeWorkout({ exercises: [{ exerciseId: 'squat', sets: [strengthSet(10000, 1)] }] }),
    ];
    const stats = computeStats(workouts, () => false, 'lbs');
    const badges = computeBadges(stats, 0, 1);
    const heavy = badges.find((b) => b.id === 'heavy_lifter');
    assert.ok(!heavy.unlocked);
  });

  it('ignores incomplete sets when computing tonnage, distance and calories', () => {
    const workouts = [
      makeWorkout({
        exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5), { ...strengthSet(200, 5), done: false }] }],
      }),
      makeWorkout({
        exercises: [{ exerciseId: 'running', sets: [cardioSet(5, 30, 300), { ...cardioSet(10, 60, 600), done: false }] }],
      }),
    ];
    const stats = computeStats(workouts, () => true, 'kg');
    assert.strictEqual(stats.tonnage, 100 * 5);
    assert.strictEqual(stats.distance, 5);
    assert.ok(stats.calories < 1200);
  });
});

describe('getLevel', () => {
  it('starts at level 1', () => {
    assert.strictEqual(getLevel(0), 1);
  });

  it('scales with total XP', () => {
    assert.ok(getLevel(10000) > 1);
  });
});

describe('xpToNextLevel', () => {
  it('returns progress toward the next level', () => {
    const info = xpToNextLevel(150);
    assert.ok(info.current >= 0);
    assert.ok(info.range > 0);
    assert.ok(info.next > info.current);
  });
});

// ─── Personal Records ───────────────────────────────────────────────────────

describe('getPR', () => {
  const workouts = [
    makeWorkout({
      exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5), strengthSet(120, 3)] }],
    }),
    makeWorkout({
      exercises: [{ exerciseId: 'squat', sets: [strengthSet(120, 5)] }],
    }),
  ];

  it('finds the heaviest weight for an exercise', () => {
    const pr = getPR(workouts, 'squat');
    assert.strictEqual(pr.weight, 120);
  });

  it('ties on weight are broken by higher reps', () => {
    const tieWorkouts = [
      makeWorkout({ exercises: [{ exerciseId: 'bench_press', sets: [strengthSet(100, 5)] }] }),
      makeWorkout({ exercises: [{ exerciseId: 'bench_press', sets: [strengthSet(100, 8)] }] }),
    ];
    const pr = getPR(tieWorkouts, 'bench_press');
    assert.strictEqual(pr.weight, 100);
    assert.strictEqual(pr.reps, 8);
  });

  it('returns zero when no records exist', () => {
    const pr = getPR(workouts, 'bench_press');
    assert.strictEqual(pr.weight, 0);
  });

  it('ignores incomplete sets', () => {
    const mixed = [
      makeWorkout({ exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5), { ...strengthSet(500, 1), done: false }] }] }),
    ];
    const pr = getPR(mixed, 'squat');
    assert.strictEqual(pr.weight, 100);
  });

  it('finds the longest hold time for time-based exercises', () => {
    const timeWorkouts = [
      makeWorkout({ exercises: [{ exerciseId: 'plank', sets: [timeSet(0, 45)] }] }),
      makeWorkout({ exercises: [{ exerciseId: 'plank', sets: [timeSet(0, 60)] }] }),
    ];
    const pr = getPR(timeWorkouts, 'plank');
    assert.strictEqual(pr.time, 60);
  });
});

describe('getRecentPRs', () => {
  const workouts = [
    makeWorkout({ exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5)] }] }),
    makeWorkout({ exercises: [{ exerciseId: 'bench_press', sets: [strengthSet(80, 5)] }] }),
  ];

  it('returns up to the requested number of PRs', () => {
    const prs = getRecentPRs(workouts, 3);
    assert.strictEqual(prs.length, 2);
  });

  it('respects a limit smaller than the number of PRs', () => {
    const prs = getRecentPRs(workouts, 1);
    assert.strictEqual(prs.length, 1);
  });

  it('uses the provided name resolver', () => {
    const prs = getRecentPRs(workouts, 3, (id) => (id === 'squat' ? 'Squat' : id));
    assert.ok(prs.some((p) => p.name === 'Squat'));
  });
});

// ─── Streaks ─────────────────────────────────────────────────────────────────

describe('currentStreak', () => {
  it('returns 0 with no workouts', () => {
    assert.strictEqual(currentStreak([]), 0);
  });

  it('counts consecutive days ending today or yesterday', () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const workouts = [
      makeWorkout({ date: yesterday.toISOString() }),
      makeWorkout({ date: today.toISOString() }),
    ];
    assert.strictEqual(currentStreak(workouts), 2);
  });

  it('resets after a gap of more than one day', () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const workouts = [makeWorkout({ date: threeDaysAgo.toISOString() })];
    assert.strictEqual(currentStreak(workouts), 0);
  });
});

// ─── Text Utilities ─────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes dangerous HTML characters', () => {
    assert.strictEqual(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('leaves plain text untouched', () => {
    assert.strictEqual(escapeHtml('Squat'), 'Squat');
  });
});

describe('getLevenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    assert.strictEqual(getLevenshteinDistance('squat', 'squat'), 0);
  });

  it('measures single-character edits', () => {
    assert.strictEqual(getLevenshteinDistance('sqwat', 'squat'), 1);
  });

  it('handles empty strings', () => {
    assert.strictEqual(getLevenshteinDistance('', 'abc'), 3);
    assert.strictEqual(getLevenshteinDistance('abc', ''), 3);
  });
});

// ─── Exercise History & Records ─────────────────────────────────────────────

describe('getExerciseHistory', () => {
  const workouts = [
    makeWorkout({
      name: 'Leg Day',
      exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5), strengthSet(120, 3)] }],
    }),
    makeWorkout({
      name: 'Another Leg Day',
      exercises: [{ exerciseId: 'squat', sets: [strengthSet(130, 2)] }],
    }),
  ];

  it('returns one entry per working set sorted by date', () => {
    const history = getExerciseHistory(workouts, 'squat');
    assert.strictEqual(history.length, 3);
    assert.ok(history[0].date <= history[history.length - 1].date);
  });

  it('includes 1RM estimates for strength sets', () => {
    const history = getExerciseHistory(workouts, 'squat');
    assert.ok(history.every((h) => h.oneRm > 0));
  });

  it('includes speed for cardio sets', () => {
    const cardioWorkouts = [
      makeWorkout({ exercises: [{ exerciseId: 'running', sets: [cardioSet(5, 30, 300)] }] }),
    ];
    const history = getExerciseHistory(cardioWorkouts, 'running', 'kg');
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].speed, roundConverted(5 / 0.5));
  });

  it('ignores unrelated exercises', () => {
    const history = getExerciseHistory(workouts, 'bench_press');
    assert.strictEqual(history.length, 0);
  });

  it('ignores incomplete working sets', () => {
    const mixed = [
      makeWorkout({
        exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5), { ...strengthSet(200, 1), done: false }] }],
      }),
    ];
    const history = getExerciseHistory(mixed, 'squat');
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].weight, 100);
  });
});

describe('getExerciseChartHistory', () => {
  it('aggregates multiple sets of the same exercise within one workout', () => {
    const workouts = [
      makeWorkout({
        name: 'Run Day',
        exercises: [{ exerciseId: 'running', sets: [cardioSet(2, 15, 100), cardioSet(3, 20, 150)] }],
      }),
    ];
    const history = getExerciseHistory(workouts, 'running', 'kg');
    const chart = getExerciseChartHistory(history);
    assert.strictEqual(chart.length, 1);
    assert.strictEqual(chart[0].distance, 5);
    assert.strictEqual(chart[0].durationMinutes, 35);
  });

  it('keeps separate workouts as separate points', () => {
    const workouts = [
      makeWorkout({ name: 'Day 1', exercises: [{ exerciseId: 'running', sets: [cardioSet(5, 30, 300)] }] }),
      makeWorkout({ name: 'Day 2', exercises: [{ exerciseId: 'running', sets: [cardioSet(6, 35, 350)] }] }),
    ];
    const chart = getExerciseChartHistory(getExerciseHistory(workouts, 'running', 'kg'));
    assert.strictEqual(chart.length, 2);
    assert.strictEqual(chart[0].distance, 5);
    assert.strictEqual(chart[1].distance, 6);
  });
});

describe('getExerciseRecords', () => {
  const strengthWorkouts = [
    makeWorkout({
      exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 5), strengthSet(120, 3)] }],
    }),
    makeWorkout({
      exercises: [{ exerciseId: 'squat', sets: [strengthSet(130, 1)] }],
    }),
  ];

  it('returns max weight, reps, and best 1RM for strength exercises', () => {
    const records = getExerciseRecords(strengthWorkouts, 'squat', () => false);
    assert.strictEqual(records.maxWeight, 130);
    assert.strictEqual(records.maxReps, 5);
    assert.ok(records.best1rm > 0);
  });

  it('returns distance and duration records for cardio exercises', () => {
    const cardioWorkouts = [
      makeWorkout({ exercises: [{ exerciseId: 'running', sets: [cardioSet(5, 30, 300)] }] }),
      makeWorkout({ exercises: [{ exerciseId: 'running', sets: [cardioSet(10, 60, 600)] }] }),
    ];
    const records = getExerciseRecords(cardioWorkouts, 'running', () => true);
    assert.strictEqual(records.distance, 10);
    assert.strictEqual(records.duration, 60);
    assert.strictEqual(records.maxSpeed, roundConverted(10 / 1));
    assert.strictEqual(records.distUnit, 'km');
  });

  it('returns max time and weight for time-based exercises', () => {
    const timeWorkouts = [
      makeWorkout({ exercises: [{ exerciseId: 'plank', sets: [timeSet(0, 45), timeSet(10, 60)] }] }),
    ];
    const records = getExerciseRecords(timeWorkouts, 'plank', () => false);
    assert.strictEqual(records.maxTime, 60);
    assert.strictEqual(records.maxWeight, 10);
  });

  it('includes the heaviest historical set', () => {
    const records = getExerciseRecords(strengthWorkouts, 'squat', () => false);
    assert.strictEqual(records.heaviestSet.weight, 130);
  });

  it('returns null when no history exists', () => {
    const records = getExerciseRecords(strengthWorkouts, 'bench_press', () => false);
    assert.strictEqual(records, null);
  });
});

describe('convertWeight', () => {
  it('converts kg to lbs and back', () => {
    assert.strictEqual(roundConverted(convertWeight(5, 'kg', 'lbs')), 11.02);
    assert.strictEqual(roundConverted(convertWeight(11.02, 'lbs', 'kg')), 5);
  });

  it('returns the value unchanged when units match', () => {
    assert.strictEqual(convertWeight(100, 'kg', 'kg'), 100);
    assert.strictEqual(convertWeight(225, 'lbs', 'lbs'), 225);
  });
});describe('convertDistance', () => {
  it('converts km to mi and back', () => {
    assert.strictEqual(roundConverted(convertDistance(5, 'km', 'mi')), 3.11);
    assert.strictEqual(roundConverted(convertDistance(3.11, 'mi', 'km')), 5.01);
  });

  it('returns the value unchanged when units match', () => {
    assert.strictEqual(convertDistance(10, 'km', 'km'), 10);
    assert.strictEqual(convertDistance(10, 'mi', 'mi'), 10);
  });

  it('round-trips exactly without intermediate rounding', () => {
    const mi = convertDistance(45, 'km', 'mi');
    const km = convertDistance(mi, 'mi', 'km');
    assert.ok(Math.abs(km - 45) < 1e-9);
  });
});

import { formatSetValue } from '../lib/fitness.js';

describe('formatSetValue', () => {
  it('rounds numbers to the requested decimals for display', () => {
    assert.strictEqual(formatSetValue(27.961704, 2), 27.96);
    assert.strictEqual(formatSetValue(45.1234, 2), 45.12);
    assert.strictEqual(formatSetValue(45.1234, 0), 45);
  });

  it('returns an empty string for empty or null values', () => {
    assert.strictEqual(formatSetValue(''), '');
    assert.strictEqual(formatSetValue(null), '');
    assert.strictEqual(formatSetValue(undefined), '');
  });

  it('returns the raw value for non-numeric input', () => {
    assert.strictEqual(formatSetValue('abc'), 'abc');
  });
});

describe('xpForSet', () => {
  it('awards XP based on weight × reps', () => {
    assert.strictEqual(xpForSet(strengthSet(100, 10)), Math.round(100 * 10 * 0.15));
  });

  it('returns 0 when weight or reps are missing', () => {
    assert.strictEqual(xpForSet(strengthSet(0, 10)), 0);
    assert.strictEqual(xpForSet(strengthSet(100, 0)), 0);
  });

  it('awards cardio XP from duration and calories', () => {
    const set = cardioSet(0, 30, 100);
    assert.strictEqual(xpForSet(set), Math.max(10, Math.round(30 * 1.5 + 100 * 0.1)));
  });

  it('normalizes lbs weight to kg before computing XP', () => {
    const kgSet = strengthSet(100, 10);
    const lbSet = strengthSet(220.46, 10);
    assert.strictEqual(xpForSet(kgSet, 'kg'), xpForSet(lbSet, 'lbs'));
  });

  it('awards XP for time-based holds using time and optional weight', () => {
    assert.ok(xpForSet(timeSet(0, 60)) > 0);
    assert.ok(xpForSet(timeSet(20, 60)) > xpForSet(timeSet(0, 60)));
  });
});

describe('getBestOneRepMax', () => {
  const workouts = [
    makeWorkout({
      exercises: [{ exerciseId: 'squat', sets: [strengthSet(100, 10), strengthSet(120, 5)] }],
    }),
  ];

  it('finds the best estimated 1RM across all workouts', () => {
    const best = getBestOneRepMax(workouts, 'squat');
    assert.ok(best.avg > 0);
  });

  it('returns null when there is no usable data', () => {
    const best = getBestOneRepMax(workouts, 'bench_press');
    assert.strictEqual(best, null);
  });
});

describe('computeBadges', () => {
  it('returns all badges with locked state for empty stats', () => {
    const badges = computeBadges({ totalXp: 0, tonnage: 0, workouts: 0, distance: 0, calories: 0 }, 0, 1);
    assert.ok(badges.length > 10);
    assert.ok(badges.every((b) => !b.unlocked));
    assert.ok(badges.every((b) => b.progress >= 0 && b.progress < b.target));
  });

  it('unlocks volume badges based on workout count', () => {
    const badges = computeBadges({ totalXp: 0, tonnage: 0, workouts: 10, distance: 0, calories: 0 }, 0, 1);
    const first = badges.find((b) => b.id === 'first_workout');
    const consistent = badges.find((b) => b.id === 'consistent');
    const dedicated = badges.find((b) => b.id === 'dedicated');
    assert.ok(first.unlocked);
    assert.ok(consistent.unlocked);
    assert.ok(!dedicated.unlocked);
    assert.strictEqual(first.progress, 1);
    assert.strictEqual(consistent.progress, 10);
  });

  it('unlocks strength badges based on tonnage', () => {
    const badges = computeBadges({ totalXp: 0, tonnage: 50000, workouts: 0, distance: 0, calories: 0 }, 0, 1);
    const heavy = badges.find((b) => b.id === 'heavy_lifter');
    const iron = badges.find((b) => b.id === 'iron_warrior');
    const beast = badges.find((b) => b.id === 'beast_mode');
    assert.ok(heavy.unlocked);
    assert.ok(iron.unlocked);
    assert.ok(!beast.unlocked);
  });

  it('unlocks cardio badges based on distance', () => {
    const badges = computeBadges({ totalXp: 0, tonnage: 0, workouts: 0, distance: 100, calories: 0 }, 0, 1);
    const first = badges.find((b) => b.id === 'first_mile');
    const runner = badges.find((b) => b.id === 'road_runner');
    assert.ok(first.unlocked);
    assert.ok(runner.unlocked);
  });

  it('unlocks XP badges based on total XP', () => {
    const badges = computeBadges({ totalXp: 6000, tonnage: 0, workouts: 0, distance: 0, calories: 0 }, 0, 1);
    const rookie = badges.find((b) => b.id === 'xp_rookie');
    const grinder = badges.find((b) => b.id === 'xp_grinder');
    const master = badges.find((b) => b.id === 'xp_master');
    assert.ok(rookie.unlocked);
    assert.ok(grinder.unlocked);
    assert.ok(!master.unlocked);
  });

  it('unlocks streak and level badges', () => {
    const badges = computeBadges({ totalXp: 0, tonnage: 0, workouts: 0, distance: 0, calories: 0 }, 5, 10);
    const onFire = badges.find((b) => b.id === 'on_fire');
    const unstoppable = badges.find((b) => b.id === 'unstoppable');
    const risingStar = badges.find((b) => b.id === 'rising_star');
    const guru = badges.find((b) => b.id === 'fitness_guru');
    assert.ok(onFire.unlocked);
    assert.ok(!unstoppable.unlocked);
    assert.ok(risingStar.unlocked);
    assert.ok(!guru.unlocked);
  });

  it('caps progress at the target', () => {
    const badges = computeBadges({ totalXp: 0, tonnage: 2000000, workouts: 0, distance: 0, calories: 0 }, 0, 1);
    const titan = badges.find((b) => b.id === 'titan');
    assert.ok(titan.unlocked);
    assert.strictEqual(titan.progress, titan.target);
    assert.strictEqual(titan.progressPercent, 100);
  });
});

describe('formatPlanExerciseTarget', () => {
  it('formats strength targets with sets and reps', () => {
    assert.strictEqual(formatPlanExerciseTarget({ targetSets: 3, targetReps: 8, restSeconds: 90 }, false, false, 'kg', false), '3x8');
    assert.strictEqual(formatPlanExerciseTarget({ targetSets: 3, targetReps: 8, restSeconds: 90 }, false, false, 'kg', true), '3 sets × 8 reps • 90s rest');
  });

  it('falls back for missing strength reps', () => {
    assert.strictEqual(formatPlanExerciseTarget({ targetSets: 3, targetReps: 0, restSeconds: 90 }, false, false, 'kg', false), '3 sets');
    assert.strictEqual(formatPlanExerciseTarget({ targetSets: 3, restSeconds: 90 }, false, false, 'kg', true), '3 sets • 90s rest');
  });

  it('formats time-based targets and falls back when time is missing', () => {
    assert.strictEqual(formatPlanExerciseTarget({ targetSets: 3, targetTime: 30, restSeconds: 60 }, false, true, 'kg', false), '3x30s');
    assert.strictEqual(formatPlanExerciseTarget({ targetSets: 3, targetTime: 0, restSeconds: 60 }, false, true, 'kg', true), '3 sets • 60s rest');
    assert.strictEqual(formatPlanExerciseTarget({ targetSets: 3, restSeconds: 60 }, false, true, 'kg', false), '3 sets');
  });

  it('formats cardio targets and falls back when values are missing', () => {
    assert.strictEqual(formatPlanExerciseTarget({ targetDistance: 5, targetDuration: 30 }, true, false, 'kg', false), '5km in 30m');
    assert.strictEqual(formatPlanExerciseTarget({ targetDistance: 5 }, true, false, 'kg', false), '5km');
    assert.strictEqual(formatPlanExerciseTarget({ targetDuration: 30 }, true, false, 'kg', false), '30m');
    assert.strictEqual(formatPlanExerciseTarget({}, true, false, 'kg', false), 'Cardio');
    assert.strictEqual(formatPlanExerciseTarget({}, true, false, 'kg', true), 'Cardio');
    assert.strictEqual(formatPlanExerciseTarget({ targetDistance: 5 }, true, false, 'kg', true), '5 km');
    assert.strictEqual(formatPlanExerciseTarget({ targetDuration: 30 }, true, false, 'kg', true), '30 min');
    assert.strictEqual(formatPlanExerciseTarget({ targetDistance: 3.1, targetDuration: 20 }, true, false, 'lbs', true), '3.1 mi • 20 min');
  });
});
