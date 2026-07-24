/**
 * Built-in exercise catalog for ZK Fitness.
 * Client-side only — the zero-knowledge server never sees this data.
 */

const EXERCISE_CATALOG = [
  { id: 'squat', name: 'Squat', category: 'Legs', equipment: 'Barbell', defaultRestSeconds: 180 },
  { id: 'front_squat', name: 'Front Squat', category: 'Legs', equipment: 'Barbell', defaultRestSeconds: 180 },
  { id: 'leg_press', name: 'Leg Press', category: 'Legs', equipment: 'Machine', defaultRestSeconds: 150 },
  { id: 'leg_extension', name: 'Leg Extension', category: 'Legs', equipment: 'Machine', defaultRestSeconds: 90 },
  { id: 'leg_curl', name: 'Leg Curl', category: 'Legs', equipment: 'Machine', defaultRestSeconds: 90 },
  { id: 'calf_raise', name: 'Calf Raise', category: 'Legs', equipment: 'Machine', defaultRestSeconds: 60 },
  { id: 'bench_press', name: 'Bench Press', category: 'Chest', equipment: 'Barbell', defaultRestSeconds: 150 },
  { id: 'incline_bench_press', name: 'Incline Bench Press', category: 'Chest', equipment: 'Barbell', defaultRestSeconds: 150 },
  { id: 'chest_dip', name: 'Chest Dip', category: 'Chest', equipment: 'Bodyweight', defaultRestSeconds: 120 },
  { id: 'chest_fly', name: 'Chest Fly', category: 'Chest', equipment: 'Dumbbell', defaultRestSeconds: 90 },
  { id: 'deadlift', name: 'Deadlift', category: 'Back', equipment: 'Barbell', defaultRestSeconds: 180 },
  { id: 'romanian_deadlift', name: 'Romanian Deadlift', category: 'Back', equipment: 'Barbell', defaultRestSeconds: 150 },
  { id: 'pull_up', name: 'Pull-Up', category: 'Back', equipment: 'Bodyweight', defaultRestSeconds: 120 },
  { id: 'chin_up', name: 'Chin-Up', category: 'Back', equipment: 'Bodyweight', defaultRestSeconds: 120 },
  { id: 'lat_pulldown', name: 'Lat Pulldown', category: 'Back', equipment: 'Machine', defaultRestSeconds: 120 },
  { id: 'seated_row', name: 'Seated Cable Row', category: 'Back', equipment: 'Machine', defaultRestSeconds: 120 },
  { id: 'face_pull', name: 'Face Pull', category: 'Back', equipment: 'Machine', defaultRestSeconds: 90 },
  { id: 'overhead_press', name: 'Overhead Press', category: 'Shoulders', equipment: 'Barbell', defaultRestSeconds: 150 },
  { id: 'dumbbell_shoulder_press', name: 'Dumbbell Shoulder Press', category: 'Shoulders', equipment: 'Dumbbell', defaultRestSeconds: 120 },
  { id: 'lateral_raise', name: 'Lateral Raise', category: 'Shoulders', equipment: 'Dumbbell', defaultRestSeconds: 90 },
  { id: 'rear_delt_fly', name: 'Rear Delt Fly', category: 'Shoulders', equipment: 'Dumbbell', defaultRestSeconds: 90 },
  { id: 'barbell_curl', name: 'Barbell Curl', category: 'Arms', equipment: 'Barbell', defaultRestSeconds: 90 },
  { id: 'dumbbell_curl', name: 'Dumbbell Curl', category: 'Arms', equipment: 'Dumbbell', defaultRestSeconds: 90 },
  { id: 'hammer_curl', name: 'Hammer Curl', category: 'Arms', equipment: 'Dumbbell', defaultRestSeconds: 90 },
  { id: 'tricep_pushdown', name: 'Tricep Pushdown', category: 'Arms', equipment: 'Machine', defaultRestSeconds: 90 },
  { id: 'skull_crusher', name: 'Skull Crusher', category: 'Arms', equipment: 'Barbell', defaultRestSeconds: 120 },
  { id: 'close_grip_bench_press', name: 'Close-Grip Bench Press', category: 'Arms', equipment: 'Barbell', defaultRestSeconds: 120 },
  { id: 'hip_thrust', name: 'Hip Thrust', category: 'Glutes', equipment: 'Barbell', defaultRestSeconds: 120 },
  { id: 'glute_bridge', name: 'Glute Bridge', category: 'Glutes', equipment: 'Bodyweight', defaultRestSeconds: 90 },
  { id: 'ab_wheel', name: 'Ab Wheel', category: 'Core', equipment: 'Bodyweight', defaultRestSeconds: 60 },
  { id: 'plank', name: 'Plank', category: 'Core', equipment: 'Bodyweight', defaultRestSeconds: 60 },
  { id: 'hanging_leg_raise', name: 'Hanging Leg Raise', category: 'Core', equipment: 'Bodyweight', defaultRestSeconds: 90 },
];

function getExerciseById(id) {
  return EXERCISE_CATALOG.find((ex) => ex.id === id);
}

function searchExercises(query) {
  const q = query.toLowerCase();
  return EXERCISE_CATALOG.filter(
    (ex) => ex.name.toLowerCase().includes(q) || ex.category.toLowerCase().includes(q)
  );
}

function getExercisesByCategory(category) {
  if (!category || category === 'All') return EXERCISE_CATALOG;
  return EXERCISE_CATALOG.filter((ex) => ex.category === category);
}

const CATEGORIES = ['All', ...new Set(EXERCISE_CATALOG.map((ex) => ex.category))];
