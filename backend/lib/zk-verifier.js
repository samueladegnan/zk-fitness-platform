const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

const verificationKeyPath = path.join(__dirname, '..', 'zk', 'verification_key.json');
let verificationKey;

function getVerificationKey() {
  if (!verificationKey) {
    verificationKey = JSON.parse(fs.readFileSync(verificationKeyPath, 'utf8'));
  }
  return verificationKey;
}

async function verifyWorkoutProof(proof, publicSignals) {
  if (!proof || typeof proof !== 'object' || !Array.isArray(publicSignals)) return false;
  if (publicSignals.length !== 6 || getVerificationKey().nPublic !== 6) return false;
  return snarkjs.groth16.verify(getVerificationKey(), publicSignals, proof);
}

module.exports = { verifyWorkoutProof, getVerificationKey };
