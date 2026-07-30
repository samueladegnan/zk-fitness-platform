import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createSet,
  createWorkoutExercise,
  toggleSetStatus,
  normalizeSet,
  finalizeWorkout,
  applyPastWorkoutChanges,
} from '../lib/workout.js';

describe('createSet', () => {
  test('creates an empty working set by default', () => {
    const set = createSet('working');
    assert.equal(set.type, 'working');
    assert.equal(set.weight, '');
    assert.equal(set.reps, '');
    assert.equal(set.done, false);
    assert.equal(set.xp, 0);
  });

  test('creates a warmup set with last values applied', () => {
    const last = { weight: 100, reps: 5, rpe: '', distance: '', durationMinutes: '', heartRate: '', calories: '' };
    const set = createSet('warmup', last);
    assert.equal(set.type, 'warmup');
    assert.equal(set.weight, 100);
    assert.equal(set.reps, 5);
    assert.equal(set.done, false);
  });
});

describe('createWorkoutExercise', () => {
  test('creates an exercise with one working set', () => {
    const ex = createWorkoutExercise('squat', 3, 5, 90, null);
    assert.equal(ex.exerciseId, 'squat');
    assert.equal(ex.targetSets, 3);
    assert.equal(ex.targetReps, 5);
    assert.equal(ex.restSeconds, 90);
    assert.equal(ex.sets.length, 1);
    assert.equal(ex.sets[0].type, 'working');
  });

  test('applies last-set values to the initial set', () => {
    const last = { weight: 120, reps: 8, rpe: '', distance: '', durationMinutes: '', heartRate: '', calories: '' };
    const ex = createWorkoutExercise('squat', 3, 5, 90, last);
    assert.equal(ex.sets[0].weight, 120);
    assert.equal(ex.sets[0].reps, 8);
  });

  test('applies last-set time to time-based exercises', () => {
    const last = { weight: '', reps: '', time: 60, rpe: '', distance: '', durationMinutes: '', heartRate: '', calories: '' };
    const ex = createWorkoutExercise('plank', 3, null, 60, last, 45);
    assert.equal(ex.targetTime, 45);
    assert.equal(ex.sets[0].time, 60);
  });
});

describe('toggleSetStatus', () => {
  test('marks an empty set done without coercing empty values to 0', () => {
    const set = { weight: '', reps: '', done: false, xp: 0 };
    const updated = toggleSetStatus(set);
    assert.equal(updated.done, true);
    assert.equal(updated.weight, '');
    assert.equal(updated.reps, '');
  });

  test('awards XP when marking a valid set done', () => {
    const set = { weight: 100, reps: 10, done: false, xp: 0 };
    const updated = toggleSetStatus(set);
    assert.equal(updated.done, true);
    assert.ok(updated.xp > 0);
  });

  test('removes XP when toggling a set back to undone', () => {
    const set = { weight: 100, reps: 10, done: true, xp: 150 };
    const updated = toggleSetStatus(set);
    assert.equal(updated.done, false);
    assert.equal(updated.xp, 0);
  });

  test('preserves cardio values across toggles', () => {
    const set = { distance: 5, durationMinutes: 30, heartRate: 150, calories: '', done: false, xp: 0 };
    const updated = toggleSetStatus(set);
    assert.equal(updated.distance, 5);
    assert.equal(updated.durationMinutes, 30);
    assert.equal(updated.heartRate, 150);
    assert.equal(updated.calories, 600);
  });
});

describe('normalizeSet', () => {
  test('preserves empty string values', () => {
    const set = { weight: '', reps: '', done: true };
    const normalized = normalizeSet(set);
    assert.equal(normalized.weight, '');
    assert.equal(normalized.reps, '');
  });

  test('converts numeric strings to numbers', () => {
    const set = { weight: '100', reps: '5', distance: '5', durationMinutes: '30', heartRate: '150', calories: '', done: true };
    const normalized = normalizeSet(set);
    assert.equal(normalized.weight, 100);
    assert.equal(normalized.reps, 5);
    assert.equal(normalized.distance, 5);
    assert.equal(normalized.durationMinutes, 30);
    assert.equal(normalized.heartRate, 150);
    assert.equal(normalized.calories, 600);
  });
});

describe('finalizeWorkout', () => {
  test('keeps empty/incomplete sets and exercises', () => {
    const workout = {
      id: 'w1',
      startTime: Date.now() - 60000,
      exercises: [
        { exerciseId: 'squat', sets: [{ weight: '', reps: '', done: false, xp: 0 }] },
      ],
    };
    const finished = finalizeWorkout(workout, () => false);
    assert.equal(finished.exercises.length, 1);
    assert.equal(finished.exercises[0].sets.length, 1);
    assert.equal(finished.exercises[0].sets[0].done, false);
  });

  test('computes XP only for done sets', () => {
    const workout = {
      id: 'w1',
      startTime: Date.now() - 60000,
      exercises: [
        {
          exerciseId: 'squat',
          sets: [
            { weight: 100, reps: 5, done: true, xp: 0 },
            { weight: 100, reps: 5, done: false, xp: 0 },
          ],
        },
      ],
    };
    const finished = finalizeWorkout(workout, () => false);
    assert.ok(finished.exercises[0].sets[0].xp > 0);
    assert.equal(finished.exercises[0].sets[1].xp, 0);
  });

  test('normalizes string values to numbers while preserving empty values', () => {
    const workout = {
      id: 'w1',
      startTime: Date.now() - 60000,
      exercises: [
        {
          exerciseId: 'squat',
          sets: [
            { weight: '100', reps: '5', done: true, xp: 0 },
            { weight: '', reps: '', done: false, xp: 0 },
          ],
        },
      ],
    };
    const finished = finalizeWorkout(workout, () => false);
    assert.equal(finished.exercises[0].sets[0].weight, 100);
    assert.equal(finished.exercises[0].sets[1].weight, '');
  });

  test('handles cardio exercises without dropping empty cardio fields', () => {
    const workout = {
      id: 'w1',
      startTime: Date.now() - 60000,
      exercises: [
        { exerciseId: 'run', sets: [{ distance: '', durationMinutes: '', done: false, xp: 0 }] },
      ],
    };
    const finished = finalizeWorkout(workout, () => true);
    assert.equal(finished.exercises.length, 1);
    assert.equal(finished.exercises[0].sets[0].distance, '');
  });

  test('sets endTime and durationSeconds', () => {
    const start = Date.now() - 120000;
    const workout = { id: 'w1', startTime: start, exercises: [] };
    const finished = finalizeWorkout(workout, () => false);
    assert.ok(finished.endTime >= start);
    assert.equal(finished.durationSeconds, 120);
  });
});

describe('applyPastWorkoutChanges', () => {
  test('preserves done state and empty values when editing history', () => {
    const workout = {
      id: 'w1',
      exercises: [
        { exerciseId: 'squat', sets: [{ weight: '', reps: '', done: true, xp: 0 }] },
      ],
    };
    const updated = applyPastWorkoutChanges(workout);
    assert.equal(updated.exercises[0].sets[0].done, true);
    assert.equal(updated.exercises[0].sets[0].weight, '');
  });

  test('recalculates XP and setsCount after edits', () => {
    const workout = {
      id: 'w1',
      exercises: [
        { exerciseId: 'squat', sets: [{ weight: 100, reps: 5, type: 'working', done: true, xp: 0 }] },
      ],
    };
    const updated = applyPastWorkoutChanges(workout, () => false);
    assert.equal(updated.setsCount, 1);
    assert.ok(updated.xp > 0);
  });
});
