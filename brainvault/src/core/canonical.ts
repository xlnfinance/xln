/** Canonical BrainVault V1 root fold. No CLI, workers, wallet library, I/O, or network. */
import { blake3 } from '@noble/hashes/blake3.js';
import { resolveKdfParams } from './primitives/kdf.ts';
import type { BrainvaultKdfParams } from './primitives/kdf.ts';
import { bytesToHex } from './primitives/encoding.ts';
import { BRAINVAULT_MAX_SHARD_COUNT } from './primitives/spec.ts';

/** Frozen V1 factor for an exact positive shard count. */
export function factorForShardCount(shardCount: number): number {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > BRAINVAULT_MAX_SHARD_COUNT) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${shardCount}`);
  }
  return shardCount === 1 ? 1 : String(shardCount - 1).length + 1;
}

export function rootDomain(
  factor: number,
  shardCount: number,
  params: BrainvaultKdfParams = {},
): string {
  const kdf = resolveKdfParams(params);
  if (!Number.isSafeInteger(factor) || factor < 1) {
    throw new Error(`BRAINVAULT_FACTOR_INVALID:${factor}`);
  }
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > BRAINVAULT_MAX_SHARD_COUNT) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${shardCount}`);
  }
  const expectedFactor = factorForShardCount(shardCount);
  if (factor !== expectedFactor) {
    throw new Error(`BRAINVAULT_FACTOR_SHARD_MISMATCH:${factor}:${expectedFactor}:${shardCount}`);
  }
  return `${kdf.algId}|mem=${kdf.shardMemoryKb}|t=${kdf.argonTimeCost}`
    + `|p=${kdf.argonParallelism}|out=${kdf.shardOutputBytes}`
    + `|shards=${shardCount}|factor=${factor}`;
}

export async function combineShardsWithParams(
  shards: readonly Uint8Array[],
  factor: number,
  params: BrainvaultKdfParams = {},
): Promise<Uint8Array> {
  // Array position is the canonical shard index at this pure boundary. Opaque
  // Argon2 outputs carry no recoverable provenance of their own; every
  // concurrent/native caller must first use shard-collector, which rejects a
  // duplicate, missing, malformed, wrong-index, or foreign response and then
  // materializes this array in numeric index order.
  const kdf = resolveKdfParams(params);
  if (shards.length < 1) throw new Error('BRAINVAULT_SHARDS_EMPTY');
  for (const [index, shard] of shards.entries()) {
    if (!(shard instanceof Uint8Array) || shard.length !== kdf.shardOutputBytes) {
      throw new Error(`BRAINVAULT_SHARD_LENGTH_INVALID:${index}:${shard?.length ?? 'not-bytes'}`);
    }
  }
  const domain = new TextEncoder().encode(rootDomain(factor, shards.length, params));
  const input = new Uint8Array((shards.length * kdf.shardOutputBytes) + domain.length);
  for (const [index, shard] of shards.entries()) input.set(shard, index * kdf.shardOutputBytes);
  input.set(domain, shards.length * kdf.shardOutputBytes);
  try {
    return blake3(input);
  } finally {
    input.fill(0);
    domain.fill(0);
  }
}

export async function combineShards(shards: readonly Uint8Array[], factor: number): Promise<Uint8Array> {
  return combineShardsWithParams(shards, factor);
}

export function rootFingerprint(root: Uint8Array): string {
  if (!(root instanceof Uint8Array) || root.length !== 32) {
    throw new Error(`BRAINVAULT_ROOT_LENGTH_INVALID:${root?.length ?? 'not-bytes'}`);
  }
  return bytesToHex(root.subarray(0, 4));
}
