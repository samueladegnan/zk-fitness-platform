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
  getExerciseRecords,
  getBestOneRepMax,
} from '../lib/fitness.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function strengthSet(weight, reps, type = 'working') {
  return { type, weight, reps, distance: '', durationMinutes: '', calories: '', heartRate: '' };
}

function cardioSet(distance, durationMinutes, calories = 0, type = 'working') {
  return { type, weight: '', reps: '', distance, durationMinutes, calories, heartRate: '' };
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
});

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

  it('uses user-entered calories for cardio', () => {
    const kcal = getCaloriesForSet(cardioSet(5, 30, 300), true, 'kg');
    assert.strictEqual(kcal, 300);
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
    const expectedStrengthKcal = (100 * 5 + 120 * 5) * 0.015;
    assert.strictEqual(stats.calories, 300 + expectedStrengthKcal);
  });

  it('returns zeroed stats for no workouts', () => {
    const stats = computeStats([], () => false, 'kg');
    assert.strictEqual(stats.totalXp, 0);
    assert.strictEqual(stats.workouts, 0);
    assert.strictEqual(stats.tonnage, 0);
    assert.strictEqual(stats.distance, 0);
    assert.strictEqual(stats.calories, 0);
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

  it('ignores unrelated exercises', () => {
    const history = getExerciseHistory(workouts, 'bench_press');
    assert.strictEqual(history.length, 0);
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
