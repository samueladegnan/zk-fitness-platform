/**
 * ZK Fitness - Pure workout state transitions.
 *
 * These functions have no side effects and no DOM dependencies.
 * They make the active-workout flow unit-testable.
 */

import { xpForSet, xpForWorkout, calculateCardioCalories } from './fitness.js';

function createSet(type = 'working', lastSetValues = null) {
  return {
    id: crypto.randomUUID(),
    type,
    weight: lastSetValues ? lastSetValues.weight : '',
    reps: lastSetValues ? lastSetValues.reps : '',
    time: lastSetValues ? lastSetValues.time : '',
    rpe: lastSetValues ? lastSetValues.rpe : '',
    distance: lastSetValues ? lastSetValues.distance : '',
    durationMinutes: lastSetValues ? lastSetValues.durationMinutes : '',
    heartRate: lastSetValues ? lastSetValues.heartRate : '',
    calories: lastSetValues ? lastSetValues.calories : '',
    done: false,
    xp: 0,
  };
}

function createWorkoutExercise(exerciseId, targetSets, targetReps, restSeconds, lastSetValues = null, targetTime = null) {
  return {
    id: crypto.randomUUID(),
    exerciseId,
    targetSets,
    targetReps,
    targetTime,
    restSeconds,
    sets: [createSet('working', lastSetValues)],
  };
}

function normalizeSetValue(value) {
  return value === '' ? '' : Number(value);
}

function normalizeSet(set, units = 'kg') {
  const normalized = {
    ...set,
    weight: normalizeSetValue(set.weight),
    reps: normalizeSetValue(set.reps),
    time: normalizeSetValue(set.time),
    distance: normalizeSetValue(set.distance),
    durationMinutes: normalizeSetValue(set.durationMinutes),
    heartRate: normalizeSetValue(set.heartRate),
    calories: normalizeSetValue(set.calories),
  };
  if (normalized.distance > 0 || normalized.durationMinutes > 0) {
    normalized.calories = calculateCardioCalories(normalized, units);
  }
  return normalized;
}

function toggleSetStatus(set, units = 'kg') {
  const updated = { ...set, done: !set.done };
  if (updated.done && (updated.distance > 0 || updated.durationMinutes > 0)) {
    updated.calories = calculateCardioCalories(updated, units);
  }
  updated.xp = updated.done ? xpForSet(updated, units) : 0;
  return updated;
}

function finalizeWorkout(workout, isCardioFn, units = 'kg') {
  const finished = {
    ...workout,
    endTime: Date.now(),
    durationSeconds: Math.floor((Date.now() - workout.startTime) / 1000),
    exercises: workout.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => {
        const normalized = normalizeSet(s, units);
        normalized.xp = normalized.done ? xpForSet(normalized, units) : 0;
        return normalized;
      }),
    })),
  };

  finished.setsCount = finished.exercises.reduce(
    (sum, ex) => sum + ex.sets.filter((s) => s.type === 'working' && s.done).length,
    0
  );
  finished.xp = xpForWorkout(finished.exercises.flatMap((ex) => ex.sets), units);
  return finished;
}

function applyPastWorkoutChanges(workout, units = 'kg') {
  const updated = {
    ...workout,
    exercises: workout.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => {
        const normalized = normalizeSet(s, units);
        normalized.xp = normalized.done ? xpForSet(normalized, units) : 0;
        return normalized;
      }),
    })),
  };
  updated.setsCount = updated.exercises.reduce(
    (sum, ex) => sum + ex.sets.filter((s) => s.type === 'working' && s.done).length,
    0
  );
  updated.xp = xpForWorkout(updated.exercises.flatMap((ex) => ex.sets), units);
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
