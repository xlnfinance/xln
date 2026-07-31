/**
 * BrainVault V1 frozen derivation parameters and shard-domain separation.
 * Changing any byte here derives different wallets.
 */

import { blake3 } from '@noble/hashes/blake3.js';

export const BRAINVAULT_V1 = Object.freeze({
  ALG_ID: 'brainvault/argon2id-sharded/v1.0',
  ARGON_VERSION: 0x13,
  SHARD_MEMORY_KB: 256 * 1024,
  ARGON_TIME_COST: 1,
  ARGON_PARALLELISM: 1,
  SHARD_OUTPUT_BYTES: 32,
  MIN_NAME_LENGTH: 1,
  MIN_PASSPHRASE_LENGTH: 6,
  MIN_FACTOR: 1,
  MAX_FACTOR: 9,
} as const);

/** Browser worker cache key and runtime handshake for the complete V1 shard KDF. */
export const BRAINVAULT_V1_SPEC_ID = [
  BRAINVAULT_V1.ALG_ID,
  `argon2id-v${BRAINVAULT_V1.ARGON_VERSION}-m${BRAINVAULT_V1.SHARD_MEMORY_KB}-t${BRAINVAULT_V1.ARGON_TIME_COST}-p${BRAINVAULT_V1.ARGON_PARALLELISM}`,
  `out${BRAINVAULT_V1.SHARD_OUTPUT_BYTES}`,
  'nfkd-utf8',
].join('|');

/** salt = BLAKE3(name_NFKD || ALG_ID || shardCount_u32be || shardIndex_u32be) */
export async function createShardSalt(
  name: string,
  shardIndex: number,
  shardCount: number,
  algId: string = BRAINVAULT_V1.ALG_ID,
): Promise<Uint8Array> {
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
