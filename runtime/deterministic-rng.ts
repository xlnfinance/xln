/**
 * Deterministic Random Number Generator
 *
 * All random operations inside runtime frames must be deterministic for consensus.
 * This RNG is seeded from runtime state (height + timestamp) to ensure all replicas
 * generate identical "random" values.
 *
 * Pattern: Seed from brainvault or static seed for reproducibility
 */

import type { Env } from './types';

/**
 * Deterministic RNG state
 */
interface RNGState {
  seed: string;
  counter: number; // Increments with each random call
}

// Static seed for demo (can be replaced with brainvault-derived seed)
const STATIC_SEED = 'xln-deterministic-seed-2025';

/**
 * Initialize RNG from runtime state
 */
export function initRNG(env: Env): RNGState {
  // Derive seed from runtime state (height + timestamp for uniqueness per frame)
  // In production, this should come from brainvault or entity consensus
  const seedContent = `${STATIC_SEED}-${env.height}-${env.timestamp}`;

  return {
    seed: seedContent,
    counter: 0,
  };
}

/**
 * Generate deterministic random number [0, 1)
 * Uses keccak256 for cryptographic quality randomness
 */
export async function deterministicRandom(rngState: RNGState): Promise<number> {
  const { ethers } = await import('ethers');

  // Increment counter for uniqueness
  rngState.counter++;

  // Hash seed + counter
  const input = `${rngState.seed}-${rngState.counter}`;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(input));

  // Convert first 8 bytes to number [0, 1)
  const hex = hash.slice(2, 18); // Take 16 hex chars (8 bytes)
  const num = parseInt(hex, 16);
  const max = parseInt('f'.repeat(16), 16);

  return num / max;
}

/**
 * Generate deterministic random integer in range [min, max)
 */
export async function deterministicRandomInt(
  rngState: RNGState,
  min: number,
  max: number
): Promise<number> {
  const rand = await deterministicRandom(rngState);
  return Math.floor(rand * (max - min)) + min;
}

/**
 * Select random element from array (deterministic)
 */
export async function deterministicChoice<T>(
  rngState: RNGState,
  array: T[]
): Promise<T> {
  if (array.length === 0) {
    throw new Error('Cannot choose from empty array');
  }

  const index = await deterministicRandomInt(rngState, 0, array.length);
  return array[index]!;
}

/**
 * Shuffle array (deterministic Fisher-Yates)
 */
export async function deterministicShuffle<T>(
  rngState: RNGState,
  array: T[]
): Promise<T[]> {
  const shuffled = [...array];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = await deterministicRandomInt(rngState, 0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  return shuffled;
}
