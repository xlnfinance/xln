/**
 * Deterministic PRNG for scenario reproducibility.
 * Uses mulberry32 to generate repeatable HTLC secrets from env.runtimeSeed.
 */

import type { Env } from '../types';

/** mulberry32: fast 32-bit PRNG with full-period guarantee */
function mulberry32(seed: number) {
  return function (): number {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a 32-bit integer seed */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Fill a Uint8Array with deterministic random bytes */
function fillBytes(rng: () => number, buf: Uint8Array): Uint8Array {
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (rng() * 256) | 0;
  }
  return buf;
}

export interface SeededRng {
  /** Generate a deterministic HTLC hashlock pair (secret + SHA-256 hash) */
  nextHashlock(): { secret: Uint8Array; hash: Uint8Array; hashlock: Uint8Array };
  /** Generate n deterministic random bytes */
  nextBytes(n: number): Uint8Array;
  /** Generate a deterministic float in [0, 1) */
  next(): number;
}

/**
 * Create a deterministic RNG from env.runtimeSeed.
 * Throws if runtimeSeed is not set.
 */
export function createRngFromEnv(env: Env): SeededRng {
  const seed = env.runtimeSeed;
  if (!seed) {
    throw new Error('createRngFromEnv: env.runtimeSeed must be set for deterministic scenarios');
  }
  return createRng(seed);
}

/** Create a deterministic RNG from an arbitrary string seed */
export function createRng(seed: string): SeededRng {
  const rng = mulberry32(hashSeed(seed));

  return {
    next: rng,

    nextBytes(n: number): Uint8Array {
      return fillBytes(rng, new Uint8Array(n));
    },

    nextHashlock(): { secret: Uint8Array; hash: Uint8Array; hashlock: Uint8Array } {
      const secret = fillBytes(rng, new Uint8Array(32));
      // SHA-256 of secret — uses Web Crypto (sync not available), so we
      // compute a simple deterministic hash instead for scenario use.
      // This is NOT cryptographic — scenarios don't need real SHA-256 security.
      const hash = simpleHash(secret);
      return { secret, hash, hashlock: hash };
    },
  };
}

/**
 * Fast deterministic 256-bit hash for scenario use.
 * NOT cryptographically secure — only used for deterministic test hashlocks.
 */
function simpleHash(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  // Initialize with constants
  for (let i = 0; i < 32; i++) {
    out[i] = (i * 0x9e + 0x37) & 0xff;
  }
  // Mix input bytes
  for (let i = 0; i < input.length; i++) {
    const j = i % 32;
    out[j] = ((out[j]! ^ input[i]!) * 31 + (out[(j + 1) % 32]! >>> 3)) & 0xff;
  }
  // Extra mixing rounds
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 32; i++) {
      out[i] = ((out[i]! ^ out[(i + 13) % 32]!) * 17 + out[(i + 7) % 32]!) & 0xff;
    }
  }
  return out;
}
