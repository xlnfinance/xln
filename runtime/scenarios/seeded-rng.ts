/**
 * Seeded RNG for Deterministic Scenarios
 *
 * Provides deterministic "randomness" for scenarios using a seed + counter.
 * This keeps the RJEA flow pure: runtime never generates randomness,
 * all randomness is an explicit input from the scenario.
 *
 * Usage:
 *   const rng = createScenarioRng('my-seed');
 *   const { secret, hashlock } = rng.nextHashlock();
 *   const randomBigInt = rng.nextBigInt(1000n); // 0-999
 */

import { ethers } from 'ethers';
import { hashHtlcSecret } from '../htlc-utils';

export interface ScenarioRng {
  /** Get current counter value */
  counter: () => bigint;

  /** Generate next deterministic bytes (32 bytes as hex) */
  nextBytes32: () => string;

  /** Generate next HTLC secret/hashlock pair */
  nextHashlock: () => { secret: string; hashlock: string };

  /** Generate next bigint in range [0, max) */
  nextBigInt: (max: bigint) => bigint;

  /** Generate next number in range [0, max) */
  nextNumber: (max: number) => number;

  /** Fork RNG with sub-seed (for isolated sub-sequences) */
  fork: (subseed: string) => ScenarioRng;
}

/**
 * Create a seeded RNG for deterministic scenario execution.
 *
 * @param seed - Base seed string (e.g., env.runtimeSeed or 'test-seed-42')
 * @param initialCounter - Starting counter value (default 0)
 */
export function createScenarioRng(seed: string, initialCounter: bigint = 0n): ScenarioRng {
  let _counter = initialCounter;

  const nextBytes32 = (): string => {
    _counter += 1n;
    // keccak256(seed || counter) gives deterministic 32 bytes
    const hash = ethers.keccak256(
      ethers.solidityPacked(['string', 'uint256'], [seed, _counter])
    );
    return hash;
  };

  const nextHashlock = (): { secret: string; hashlock: string } => {
    const secret = nextBytes32();
    const hashlock = hashHtlcSecret(secret);
    return { secret, hashlock };
  };

  const nextBigInt = (max: bigint): bigint => {
    const bytes = nextBytes32();
    const value = BigInt(bytes);
    return value % max;
  };

  const nextNumber = (max: number): number => {
    return Number(nextBigInt(BigInt(max)));
  };

  const fork = (subseed: string): ScenarioRng => {
    return createScenarioRng(`${seed}:${subseed}`, 0n);
  };

  return {
    counter: () => _counter,
    nextBytes32,
    nextHashlock,
    nextBigInt,
    nextNumber,
    fork,
  };
}

/**
 * Create RNG from Env (uses env.runtimeSeed)
 */
export function createRngFromEnv(env: { runtimeSeed?: string }): ScenarioRng {
  if (env.runtimeSeed === undefined || env.runtimeSeed === null) {
    throw new Error('Scenario RNG requires runtimeSeed (unlock vault or set XLN_RUNTIME_SEED)');
  }
  return createScenarioRng(env.runtimeSeed);
}
