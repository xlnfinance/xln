/** Canonical BrainVault V1 root fold. No CLI, workers, wallet library, I/O, or network. */
import { blake3 } from '@noble/hashes/blake3.js';
import { resolveKdfParams } from './primitives/kdf.ts';
import type { BrainvaultKdfParams } from './primitives/kdf.ts';
import { bytesToHex } from './primitives/encoding.ts';

export function rootDomain(
  factor: number,
  shardCount: number,
  params: BrainvaultKdfParams = {},
): string {
  const kdf = resolveKdfParams(params);
  if (!Number.isSafeInteger(factor) || factor < 1) {
    throw new Error(`BRAINVAULT_FACTOR_INVALID:${factor}`);
  }
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${shardCount}`);
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
  return blake3(input);
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
