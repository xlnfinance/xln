/**
 * BrainVault V1 frozen derivation parameters and shard-domain separation.
 * Changing any byte here derives different wallets. Do not "strengthen" V1 in
 * place: publish a new spec ID and retain this implementation for recovery.
 * Defaults from Argon libraries are never a protocol; every relevant field is
 * explicit and the full fingerprint is exchanged before expensive work.
 *
 * THREAT MODEL (read this before filing "brainwallets are insecure"):
 *
 * A classic brainwallet hashes one memorable string once, so GPUs can test
 * candidates extremely cheaply. BrainVault makes every candidate reproduce
 * `shards x 256 MiB` of Argon2id work. At the default user level 3 that is
 * exactly 1,000 independent shards, or 250 GiB of cumulative memory traffic
 * per guess. Level names are UX presets; the frozen factor remains internal.
 * Attackers may parallelize too, but every concurrent lane consumes real RAM
 * and memory bandwidth; there is no shortcut that the legitimate user avoids.
 *
 * WHAT WE ACCEPT AND WHY (the paper-seed comparison):
 * A correctly generated 24-word seed has far more entropy and essentially no
 * brute-force surface. It is also a physical bearer secret: loss, fire, a
 * photograph or an accessible cloud copy can permanently lose or transfer the
 * wallet without any cracking. BrainVault offers a different recovery trade:
 * exact remembered inputs, paid for with slow memory-hard reconstruction. The
 * UI presents both choices because neither failure model is best for everyone.
 *
 * HONEST WEAKNESSES (known and inherent):
 * 1. A weak or reused passphrase can still be fatal. Work factor multiplies
 *    guessing cost; it cannot manufacture missing entropy.
 * 2. JavaScript strings cannot be reliably zeroed. Workers and request state
 *    are short-lived, but a compromised recovery device can steal the input.
 * 3. Users can forget exact capitalization, whitespace, name, passphrase or
 *    factor. Optional recovery rehearsal checks this; it cannot remember for them.
 */

import { blake3 } from '@noble/hashes/blake3.js';

/**
 * WALLET-BREAKING: every value below enters a salt, Argon call, validation
 * rule, or final domain tag. Never edit V1 in place; introduce a separately
 * versioned spec while preserving this one for recovery.
 */
export const BRAINVAULT_V1 = Object.freeze({
  ALG_ID: 'brainvault/argon2id-sharded/v1.0',
  ARGON_VERSION: 0x13,
  SHARD_MEMORY_KB: 256 * 1024,
  ARGON_TIME_COST: 1,
  ARGON_PARALLELISM: 1,
  SHARD_OUTPUT_BYTES: 32,
  MIN_NAME_LENGTH: 1,
  MIN_PASSPHRASE_LENGTH: 1,
  MIN_FACTOR: 1,
  MAX_FACTOR: 9,
} as const);

/** Exact wallet inputs: whitespace is significant, but an empty string is not a wallet identity. */
export function assertBrainVaultName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < BRAINVAULT_V1.MIN_NAME_LENGTH) {
    throw new Error('BRAINVAULT_NAME_INVALID');
  }
}

/** Password strength is user policy; the protocol only rejects the empty string consistently. */
export function assertBrainVaultPassphrase(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH) {
    throw new Error('BRAINVAULT_PASSPHRASE_INVALID');
  }
}

/** Browser worker cache key and runtime handshake for the complete V1 shard KDF. */
export const BRAINVAULT_V1_SPEC_ID = [
  BRAINVAULT_V1.ALG_ID,
  `argon2id-v${BRAINVAULT_V1.ARGON_VERSION}-m${BRAINVAULT_V1.SHARD_MEMORY_KB}-t${BRAINVAULT_V1.ARGON_TIME_COST}-p${BRAINVAULT_V1.ARGON_PARALLELISM}`,
  `out${BRAINVAULT_V1.SHARD_OUTPUT_BYTES}`,
  'nfkd-utf8',
].join('|');

/**
 * salt = BLAKE3(name_NFKD || ALG_ID || shardCount_u32be || shardIndex_u32be)
 *
 * AUDITOR NOTE: the name is public by design. A salt needs uniqueness, not
 * secrecy: it separates users and shards so work cannot be reused across them.
 * All secrecy is in the passphrase. The fixed-width big-endian integers avoid
 * ambiguous concatenations such as (1, 23) versus (12, 3).
 */
export async function createShardSalt(
  name: string,
  shardIndex: number,
  shardCount: number,
  algId: string = BRAINVAULT_V1.ALG_ID,
): Promise<Uint8Array> {
  assertBrainVaultName(name);
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 0xffff_ffff) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${shardCount}`);
  }
  if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`BRAINVAULT_SHARD_INDEX_INVALID:${shardIndex}`);
  }
  const nameBytes = new TextEncoder().encode(name.normalize('NFKD'));
  const algIdBytes = new TextEncoder().encode(algId);
  const countBytes = new Uint8Array(4);
  const indexBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, shardCount, false);
  new DataView(indexBytes.buffer).setUint32(0, shardIndex, false);

  const combined = new Uint8Array(nameBytes.length + algIdBytes.length + 8);
  combined.set(nameBytes, 0);
  combined.set(algIdBytes, nameBytes.length);
  combined.set(countBytes, nameBytes.length + algIdBytes.length);
  combined.set(indexBytes, nameBytes.length + algIdBytes.length + 4);
  return blake3(combined);
}
