const ZK_RUNTIME = './vendor/snarkjs.min.js';
const ZK_WASM = './vendor/zk-fitness.wasm';
const ZK_ZKEY = './vendor/zk-fitness.zkey';
const CIRCUIT_VERSION = 'workout-validity-v1';
const DEFAULT_MIN_WORKOUTS = 0;
const DEFAULT_MIN_MINUTES = 0;
const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let runtimePromise;

function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = new Promise((resolve, reject) => {
      if (window.snarkjs) return resolve(window.snarkjs);
      const script = document.createElement('script');
      script.src = ZK_RUNTIME;
      script.onload = () => window.snarkjs ? resolve(window.snarkjs) : reject(new Error('The ZK runtime did not load.'));
      script.onerror = () => reject(new Error('Could not load the ZK proving runtime.'));
      document.head.appendChild(script);
    });
  }
  return runtimePromise;
}

function randomFieldElement() {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value.toString();
}

function toField(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Workout proof values must be non-negative integers.');
  return String(number);
}

function fieldElement(value) {
  const stringValue = String(value);
  if (!/^\d+$/.test(stringValue)) throw new Error('Proof field values must be decimal integers.');
  const number = BigInt(stringValue);
  if (number >= BN254_FIELD) throw new Error('Proof field value is outside the BN254 field.');
  return stringValue;
}

function countCompletedSets(data) {
  return (data.workouts || []).reduce((total, workout) => total + (workout.exercises || []).reduce(
    (exerciseTotal, exercise) => exerciseTotal + (exercise.sets || []).filter((set) => set.done && set.type !== 'warmup').length,
    0,
  ), 0);
}

function totalMinutes(data) {
  return Math.floor((data.workouts || []).reduce((total, workout) => total + (workout.durationSeconds || 0), 0) / 60);
}

function totalDistance(data) {
  return Math.floor((data.workouts || []).reduce((total, workout) => total + (workout.exercises || []).reduce(
    (exerciseTotal, exercise) => exerciseTotal + (exercise.sets || []).reduce(
      (setTotal, set) => setTotal + Number(set.distance || 0),
      0,
    ),
    0,
  ), 0));
}

function proofSummary(data) {
  return {
    workoutCount: toField(countCompletedSets(data)),
    totalMinutes: toField(totalMinutes(data)),
    totalDistance: toField(totalDistance(data)),
  };
}

async function sha256Field(value) {
  const encoded = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  let number = 0n;
  for (const byte of digest) number = (number << 8n) | BigInt(byte);
  return (number % BN254_FIELD).toString();
}

let poseidonModulePromise;

async function poseidon(values) {
  poseidonModulePromise ||= import('../vendor/poseidon.js');
  const { poseidonHash } = await poseidonModulePromise;
  return poseidonHash(values);
}

export async function deriveZkSecret(dsaSecretKey) {
  return sha256Field(Array.from(new Uint8Array(dsaSecretKey)));
}

export async function createIdentityCommitment(secret) {
  return poseidon([secret]);
}

export async function createWorkoutProof(data, secret, identityCommitment, options = {}) {
  const runtime = await loadRuntime();
  const summary = proofSummary(data);
  const workoutHash = await poseidon([summary.workoutCount, summary.totalMinutes, summary.totalDistance]);
  const nonce = options.nonce || randomFieldElement();
  const payloadBinding = fieldElement(options.payloadBinding);
  const commitment = await poseidon([secret, nonce, workoutHash, payloadBinding]);
  const nullifier = await poseidon([secret, nonce]);
  const minWorkoutCount = toField(options.minWorkoutCount ?? DEFAULT_MIN_WORKOUTS);
  const minMinutes = toField(options.minMinutes ?? DEFAULT_MIN_MINUTES);

  const input = {
    secret,
    nonce,
    workoutCount: summary.workoutCount,
    totalMinutes: summary.totalMinutes,
    totalDistance: summary.totalDistance,
    workoutHash,
    identityCommitment,
    commitment,
    nullifier,
    payloadBinding,
    minWorkoutCount,
    minMinutes,
  };
  const { proof, publicSignals } = await runtime.groth16.fullProve(input, ZK_WASM, ZK_ZKEY);
  return {
    circuitVersion: CIRCUIT_VERSION,
    proof,
    publicSignals,
    commitment,
    nullifier,
    identityCommitment,
    payloadBinding,
    workoutHash,
    summary,
    minWorkoutCount,
    minMinutes,
  };
}

export {
  BN254_FIELD,
  CIRCUIT_VERSION,
  DEFAULT_MIN_MINUTES,
  DEFAULT_MIN_WORKOUTS,
  proofSummary,
  sha256Field,
};
