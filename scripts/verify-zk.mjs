import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');
const { buildPoseidonReference } = require('circomlibjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const circuitDir = join(root, 'zk', 'circuits');
const artifactFiles = [
  'main.r1cs',
  'main.zkey',
  'verification_key.json',
  'main_js/main.wasm',
];

for (const file of artifactFiles) {
  if (!existsSync(join(circuitDir, file))) {
    throw new Error(`Missing ZK artifact: zk/circuits/${file}. Run npm run zk:build first.`);
  }
}

const poseidon = await buildPoseidonReference();
const hash = (values) => poseidon.F.toString(poseidon(values));
const secret = '12345';
const nonce = '67890';
const workoutCount = '2';
const totalMinutes = '30';
const totalDistance = '10';
const payloadBinding = '5';
const minWorkoutCount = '1';
const minMinutes = '1';
const workoutHash = hash([workoutCount, totalMinutes, totalDistance]);
const identityCommitment = hash([secret]);
const commitment = hash([secret, nonce, workoutHash, payloadBinding]);
const nullifier = hash([secret, nonce]);
const input = {
  secret,
  nonce,
  workoutCount,
  totalMinutes,
  totalDistance,
  workoutHash,
  identityCommitment,
  commitment,
  nullifier,
  payloadBinding,
  minWorkoutCount,
  minMinutes,
};

const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input,
  join(circuitDir, 'main_js', 'main.wasm'),
  join(circuitDir, 'main.zkey'),
);
const verificationKey = JSON.parse(readFileSync(join(circuitDir, 'verification_key.json'), 'utf8'));
const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
if (!verified) throw new Error('Generated Groth16 proof did not verify.');

const expectedSignals = [identityCommitment, commitment, nullifier, payloadBinding, minWorkoutCount, minMinutes];
if (publicSignals.map(String).join(',') !== expectedSignals.join(',')) {
  throw new Error('Generated public signals do not match the expected circuit order.');
}

console.log('ZK artifact self-test passed. Groth16 proof verified with six public signals.');
process.exit(0);
