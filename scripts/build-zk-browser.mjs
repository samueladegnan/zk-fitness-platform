import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const frontendVendor = join(root, 'frontend', 'vendor');
mkdirSync(frontendVendor, { recursive: true });

function run(args) {
  if (process.platform === 'win32') {
    execFileSync(process.execPath, [join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), ...args], { stdio: 'inherit' });
  } else {
    execFileSync(esbuild, args, { stdio: 'inherit' });
  }
}

run([
  join(root, 'zk', 'poseidon-browser-entry.js'),
  '--bundle',
  '--format=esm',
  '--platform=browser',
  `--outfile=${join(frontendVendor, 'poseidon.js')}`,
  `--alias:assert=${join(root, 'zk', 'shims', 'assert.js')}`,
  `--alias:events=${join(root, 'zk', 'shims', 'events.js')}`,
  `--alias:buffer=${join(root, 'zk', 'shims', 'buffer.js')}`,
  `--alias:fs=${join(root, 'zk', 'shims', 'fs.js')}`,
]);

cpSync(join(root, 'node_modules', 'snarkjs', 'build', 'snarkjs.min.js'), join(frontendVendor, 'snarkjs.min.js'));
cpSync(join(root, 'zk', 'circuits', 'main_js', 'main.wasm'), join(frontendVendor, 'zk-fitness.wasm'));
cpSync(join(root, 'zk', 'circuits', 'main.zkey'), join(frontendVendor, 'zk-fitness.zkey'));
cpSync(join(root, 'zk', 'circuits', 'verification_key.json'), join(frontendVendor, 'zk-fitness-verification-key.json'));
mkdirSync(join(root, 'backend', 'zk'), { recursive: true });
cpSync(join(root, 'zk', 'circuits', 'verification_key.json'), join(root, 'backend', 'zk', 'verification_key.json'));
console.log('Browser and backend ZK runtimes built.');
