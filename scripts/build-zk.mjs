import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const circuitDir = join(root, 'zk', 'circuits');
const libDir = join(circuitDir, 'lib');
const circom = join(root, 'node_modules', 'circom2', 'cli.js');
const snarkjs = join(root, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
const circuit = 'main.circom';

function run(command, args, cwd = circuitDir) {
  const executable = process.platform === 'win32' ? process.execPath : command;
  const commandArgs = process.platform === 'win32' ? [command, ...args] : args;
  execFileSync(executable, commandArgs, { cwd, stdio: 'inherit' });
}

if (!existsSync(circom) || !existsSync(snarkjs)) {
  throw new Error('Install root dependencies before building the ZK circuit.');
}

rmSync(libDir, { recursive: true, force: true });
mkdirSync(libDir, { recursive: true });
const circomlibCircuits = join(root, 'node_modules', 'circomlib', 'circuits');
for (const file of readdirSync(circomlibCircuits)) {
  if (file.endsWith('.circom')) cpSync(join(circomlibCircuits, file), join(libDir, file));
}

for (const file of ['main.r1cs', 'main.sym', 'main_js', 'main_0000.zkey', 'main.zkey', 'verification_key.json', 'pot12_final.ptau']) {
  const path = join(circuitDir, file);
  rmSync(path, { recursive: true, force: true });
}

run(circom, [circuit, '--r1cs', '--wasm', '--sym', '-l', '.']);
run(snarkjs, ['powersoftau', 'new', 'bn128', '12', 'pot12_0000.ptau']);
run(snarkjs, ['powersoftau', 'prepare', 'phase2', 'pot12_0000.ptau', 'pot12_final.ptau']);
run(snarkjs, ['groth16', 'setup', 'main.r1cs', 'pot12_final.ptau', 'main_0000.zkey']);
run(snarkjs, ['zkey', 'contribute', 'main_0000.zkey', 'main.zkey', '--name=ZK Fitness local ceremony', '-e=zk-fitness-development-entropy']);
run(snarkjs, ['zkey', 'export', 'verificationkey', 'main.zkey', 'verification_key.json']);
rmSync(join(circuitDir, 'pot12_0000.ptau'), { force: true });
console.log('ZK circuit artifacts built in zk/circuits.');
