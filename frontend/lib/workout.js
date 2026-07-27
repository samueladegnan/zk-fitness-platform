/**
 * ZK Fitness - Pure workout state transitions.
 *
 * These functions have no side effects and no DOM dependencies.
 * They make the active-workout flow unit-testable.
 */

import { xpForSet, xpForWorkout } from './fitness.js';

function createSet(type = 'working', lastSetValues = null) {
  return {
    id: crypto.randomUUID(),
    type,
    weight: lastSetValues ? lastSetValues.weight : '',
    reps: lastSetValues ? lastSetValues.reps : '',
    rpe: lastSetValues ? lastSetValues.rpe : '',
    distance: lastSetValues ? lastSetValues.distance : '',
    durationMinutes: lastSetValues ? lastSetValues.durationMinutes : '',
    heartRate: lastSetValues ? lastSetValues.heartRate : '',
    calories: lastSetValues ? lastSetValues.calories : '',
    done: false,
    xp: 0,
  };
}

function createWorkoutExercise(exerciseId, targetSets, targetReps, restSeconds, lastSetValues = null) {
  return {
    id: crypto.randomUUID(),
    exerciseId,
    targetSets,
    targetReps,
    restSeconds,
    sets: [createSet('working', lastSetValues)],
  };
}

function toggleSetStatus(set) {
  const updated = { ...set, done: !set.done };
  updated.xp = updated.done ? xpForSet(updated) : 0;
  return updated;
}

function normalizeSetValue(value) {
  return value === '' ? '' : Number(value);
}

function normalizeSet(set) {
  return {
    ...set,
    weight: normalizeSetValue(set.weight),
    reps: normalizeSetValue(set.reps),
    distance: normalizeSetValue(set.distance),
    durationMinutes: normalizeSetValue(set.durationMinutes),
    heartRate: normalizeSetValue(set.heartRate),
    calories: normalizeSetValue(set.calories),
  };
}

function finalizeWorkout(workout, isCardioFn) {
  const finished = {
    ...workout,
    endTime: Date.now(),
    durationSeconds: Math.floor((Date.now() - workout.startTime) / 1000),
    exercises: workout.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => {
        const normalized = normalizeSet(s);
        normalized.xp = normalized.done ? xpForSet(normalized) : 0;
        return normalized;
      }),
    })),
  };

  finished.setsCount = finished.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
  finished.xp = xpForWorkout(finished.exercises.flatMap((ex) => ex.sets));
  return finished;
}

function applyPastWorkoutChanges(workout) {
  const updated = {
    ...workout,
    exercises: workout.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => {
        const normalized = normalizeSet(s);
        normalized.xp = normalized.done ? xpForSet(normalized) : 0;
        return normalized;
      }),
    })),
  };
  updated.setsCount = updated.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
  updated.xp = xpForWorkout(updated.exercises.flatMap((ex) => ex.sets));
  return updated;
}

export {
  createSet,
  createWorkoutExercise,
  toggleSetStatus,
  normalizeSet,
  finalizeWorkout,
  applyPastWorkoutChanges,
};
