/**
 * ZK Fitness - Frontend integration tests
 *
 * Exercises the client-side core modules together:
 *   - lib/workout.js (state transitions)
 *   - lib/fitness.js (XP, PRs, stats, history)
 *
 * No DOM is required, so the full workout lifecycle can be validated
 * quickly with Node's built-in test runner.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSet,
  createWorkoutExercise,
  toggleSetStatus,
  finalizeWorkout,
  applyPastWorkoutChanges,
} from '../lib/workout.js';
import {
  xpForSet,
  xpForWorkout,
  totalTonnage,
  computeStats,
  getPR,
  getExerciseHistory,
  getExerciseRecords,
  getBestOneRepMax,
  currentStreak,
} from '../lib/fitness.js';

const isCardio = (id) => id === 'running';

function makeDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}

describe('Workout lifecycle integration', () => {
  it('builds, finalizes, and scores a mixed strength/cardio workout', () => {
    const startTime = Date.now() - 60_000;
    const workout = {
      id: 'wk-1',
      name: 'Mixed Session',
      startTime,
      exercises: [
        createWorkoutExercise('squat', 3, 5, 90, { weight: 100, reps: 5, rpe: '', distance: '', durationMinutes: '', heartRate: '', calories: '' }),
        createWorkoutExercise('running', 1, 1, 0, { weight: '', reps: '', rpe: '', distance: 5, durationMinutes: 30, heartRate: 150, calories: 300 }),
      ],
    };

    // Complete the first strength set with heavy values.
    workout.exercises[0].sets[0].weight = 120;
    workout.exercises[0].sets[0].reps = 5;
    workout.exercises[0].sets[0] = toggleSetStatus(workout.exercises[0].sets[0]);

    // Leave the cardio set incomplete on purpose.
    const finished = finalizeWorkout(workout, isCardio);

    assert.equal(finished.exercises.length, 2);
    assert.equal(finished.exercises[0].sets[0].done, true);
    assert.ok(finished.exercises[0].sets[0].xp > 0);
    assert.equal(finished.exercises[1].sets[0].done, false);
    assert.equal(finished.exercises[1].sets[0].xp, 0);
    assert.ok(finished.xp > 0);
    assert.equal(finished.durationSeconds, 60);
  });

  it('preserves empty values when toggling a set and recomputes XP correctly', () => {
    const workout = {
      id: 'wk-empty',
      startTime: Date.now() - 10_000,
      exercises: [
        { exerciseId: 'squat', sets: [createSet('working')] },
      ],
    };

    // Toggle an empty set; it should remain empty but be marked done.
    workout.exercises[0].sets[0] = toggleSetStatus(workout.exercises[0].sets[0]);
    assert.equal(workout.exercises[0].sets[0].done, true);
    assert.equal(workout.exercises[0].sets[0].weight, '');
    assert.equal(workout.exercises[0].sets[0].xp, 0);

    const finished = finalizeWorkout(workout, isCardio);
    assert.equal(finished.exercises[0].sets[0].weight, '');
    assert.equal(finished.xp, 50); // workout bonus only
  });

  it('keeps incomplete sets editable after finishing', () => {
    const workout = {
      id: 'wk-edit',
      startTime: Date.now() - 30_000,
      exercises: [
        { exerciseId: 'bench_press', sets: [createSet('working')] },
      ],
    };

    const finished = finalizeWorkout(workout, isCardio);
    assert.equal(finished.exercises[0].sets.length, 1);
    assert.equal(finished.exercises[0].sets[0].done, false);

    // Simulate a later edit where the user fills in values.
    finished.exercises[0].sets[0].weight = 80;
    finished.exercises[0].sets[0].reps = 8;
    finished.exercises[0].sets[0] = toggleSetStatus(finished.exercises[0].sets[0]);

    const edited = applyPastWorkoutChanges(finished);
    assert.equal(edited.exercises[0].sets[0].weight, 80);
    assert.equal(edited.exercises[0].sets[0].done, true);
    assert.ok(edited.exercises[0].sets[0].xp > 0);
  });
});

describe('History, records and stats integration', () => {
  const workouts = [];

  before(() => {
    const w1 = {
      id: 'wk-history-1',
      name: 'Upper Day',
      date: makeDate(-2),
      exercises: [
        { exerciseId: 'squat', sets: [{ weight: 100, reps: 5, done: true, type: 'working', distance: '', durationMinutes: '', calories: '', heartRate: '' }] },
        { exerciseId: 'bench_press', sets: [{ weight: 80, reps: 8, done: true, type: 'working', distance: '', durationMinutes: '', calories: '', heartRate: '' }] },
      ],
    };
    const w2 = {
      id: 'wk-history-2',
      name: 'Upper Day 2',
      date: makeDate(-1),
      exercises: [
        { exerciseId: 'squat', sets: [{ weight: 120, reps: 3, done: true, type: 'working', distance: '', durationMinutes: '', calories: '', heartRate: '' }] },
        { exerciseId: 'running', sets: [{ distance: 5, durationMinutes: 30, calories: 300, done: true, type: 'working', weight: '', reps: '', heartRate: 150 }] },
      ],
    };

    // Compute XP for each set/workout so aggregate stats match real app behavior.
    [w1, w2].forEach((w) => {
      w.exercises.forEach((ex) => {
        ex.sets.forEach((s) => { s.xp = s.done !== false ? xpForSet(s) : 0; });
      });
      w.xp = xpForWorkout(w.exercises.flatMap((ex) => ex.sets));
    });

    workouts.push(w1, w2);
  });

  it('computes aggregate stats across multiple workouts', () => {
    const stats = computeStats(workouts, isCardio, 'kg');
    assert.ok(stats.totalXp > 0);
    assert.equal(stats.workouts, 2);
    assert.equal(stats.tonnage, 100 * 5 + 80 * 8 + 120 * 3);
    assert.equal(stats.distance, 5);
    assert.ok(stats.calories > 0);
  });

  it('tracks personal records across workouts', () => {
    const pr = getPR(workouts, 'squat');
    assert.equal(pr.weight, 120);
    assert.equal(pr.reps, 3);
  });

  it('returns exercise history sorted by date', () => {
    const history = getExerciseHistory(workouts, 'squat');
    assert.equal(history.length, 2);
    assert.ok(history[0].date <= history[1].date);
  });

  it('computes best one-rep max across all workouts', () => {
    const best = getBestOneRepMax(workouts, 'squat');
    assert.ok(best.avg > 0);
  });

  it('produces cardio-specific records', () => {
    const records = getExerciseRecords(workouts, 'running', isCardio);
    assert.equal(records.distance, 5);
    assert.equal(records.duration, 30);
  });

  it('tracks a workout streak across consecutive days', () => {
    const streak = currentStreak(workouts);
    assert.ok(streak >= 0);
  });
});

describe('Tonnage and bonus XP integration', () => {
  it('matches tonnage to xpForWorkout for a finished workout', () => {
    const sets = [
      { weight: 100, reps: 10, type: 'working', done: true },
      { weight: 80, reps: 8, type: 'working', done: true },
    ];
    const tonnage = totalTonnage(sets);
    const xp = xpForWorkout(sets);
    assert.equal(tonnage, 100 * 10 + 80 * 8);
    assert.ok(xp >= tonnage * 0.15 + 50);
  });
});
