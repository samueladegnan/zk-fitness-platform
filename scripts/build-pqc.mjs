import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const entry = `
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
if (typeof globalThis !== 'undefined') {
  globalThis.NoblePQC = { ml_dsa65, ml_kem768 };
}
`;

await esbuild.build({
  stdin: {
    contents: entry,
    resolveDir: __dirname,
    loader: 'js',
  },
  bundle: true,
  outfile: resolve(__dirname, '../frontend/vendor/noble-pqc.js'),
  format: 'iife',
  target: 'es2020',
  minify: false,
});

console.log('Vendored noble-post-quantum to frontend/vendor/noble-pqc.js');
