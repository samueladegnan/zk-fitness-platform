pragma circom 2.0.0;

include "lib/poseidon.circom";
include "lib/comparators.circom";

template WorkoutProof() {
    // Private witness values. The API never receives these values.
    signal input secret;
    signal input nonce;
    signal input workoutCount;
    signal input totalMinutes;
    signal input totalDistance;
    signal input workoutHash;

    // Public values. The verifier sees the registered identity commitment,
    // state commitment, nullifier, and claim thresholds.
    signal input identityCommitment;
    signal input commitment;
    signal input nullifier;
    signal input payloadBinding;
    signal input minWorkoutCount;
    signal input minMinutes;

    // Bind the private workout summary to a Poseidon hash.
    component summary = Poseidon(3);
    summary.inputs[0] <== workoutCount;
    summary.inputs[1] <== totalMinutes;
    summary.inputs[2] <== totalDistance;
    workoutHash === summary.out;

    // Bind the witness to the identity commitment registered for this account.
    component identity = Poseidon(1);
    identity.inputs[0] <== secret;
    identityCommitment === identity.out;

    // Bind the private summary to the user's secret and state nonce.
    component state = Poseidon(4);
    state.inputs[0] <== secret;
    state.inputs[1] <== nonce;
    state.inputs[2] <== workoutHash;
    state.inputs[3] <== payloadBinding;
    commitment === state.out;

    // A nullifier makes each state nonce single-use for replay protection.
    component spent = Poseidon(2);
    spent.inputs[0] <== secret;
    spent.inputs[1] <== nonce;
    nullifier === spent.out;

    // Public thresholds are proven against private workout totals.
    component countRule = GreaterEqThan(16);
    countRule.in[0] <== workoutCount;
    countRule.in[1] <== minWorkoutCount;
    countRule.out === 1;

    component minutesRule = GreaterEqThan(32);
    minutesRule.in[0] <== totalMinutes;
    minutesRule.in[1] <== minMinutes;
    minutesRule.out === 1;

    // Keep witness values inside the ranges used by the comparison circuits.
    component countRange = LessThan(16);
    countRange.in[0] <== workoutCount;
    countRange.in[1] <== 65535;
    countRange.out === 1;

    component minutesRange = LessThan(32);
    minutesRange.in[0] <== totalMinutes;
    minutesRange.in[1] <== 4294967295;
    minutesRange.out === 1;

    component distanceRange = LessThan(32);
    distanceRange.in[0] <== totalDistance;
    distanceRange.in[1] <== 4294967295;
    distanceRange.out === 1;
}

component main {public [identityCommitment, commitment, nullifier, payloadBinding, minWorkoutCount, minMinutes]} = WorkoutProof();
