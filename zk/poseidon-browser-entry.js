import { buildPoseidonReference } from 'circomlibjs';

let poseidonPromise;

export async function poseidonHash(values) {
  poseidonPromise ||= buildPoseidonReference();
  const poseidon = await poseidonPromise;
  return poseidon.F.toString(poseidon(values));
}
