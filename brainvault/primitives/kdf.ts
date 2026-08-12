/**
 * Canonical Wasm Argon2 shard implementation.
 *
 * Browser and native workers import this function instead of copying
 * options. Password bytes are exact input after NFKD: trimming, case folding,
 * replacement characters, library defaults, or an Argon version upgrade would
 * all create a different wallet. resolveKdfParams owns the CLI's explicitly
 * domain-separated custom mode; canonical callers use the frozen defaults.
 *
 * AUDITOR NOTE: t=1 and p=1 describe one shard, not the whole recovery. The
 * outer protocol repeats that 256 MiB unit for every shard. Keeping each shard
 * independent lets a low-memory device run them sequentially while a node runs
 * them concurrently without changing a byte of output or total Argon work.
 */

import { argon2id } from 'hash-wasm';
import { assertBrainVaultPassphrase, BRAINVAULT_V1 } from './spec.ts';

export interface BrainvaultKdfParams {
  algId?: string;
  shardMemoryKb?: number;
  argonTimeCost?: number;
  argonParallelism?: number;
  shardOutputBytes?: number;
}

export function resolveKdfParams(params: BrainvaultKdfParams = {}) {
  return {
    algId: params.algId ?? BRAINVAULT_V1.ALG_ID,
    shardMemoryKb: params.shardMemoryKb ?? BRAINVAULT_V1.SHARD_MEMORY_KB,
    argonTimeCost: params.argonTimeCost ?? BRAINVAULT_V1.ARGON_TIME_COST,
    argonParallelism: params.argonParallelism ?? BRAINVAULT_V1.ARGON_PARALLELISM,
    shardOutputBytes: params.shardOutputBytes ?? BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
  };
}

export async function deriveShard(
  passphrase: string,
  shardSalt: Uint8Array,
): Promise<Uint8Array> {
  return deriveShardWithParams(passphrase, shardSalt);
}

export async function deriveShardWithParams(
  passphrase: string,
  shardSalt: Uint8Array,
  params: BrainvaultKdfParams = {},
): Promise<Uint8Array> {
  assertBrainVaultPassphrase(passphrase);
  const kdf = resolveKdfParams(params);
  // TextEncoder defines malformed UTF-16 replacement identically for browser,
  // Bun Wasm and the native bridge; passing a JS string directly would delegate
  // that boundary behavior to whichever Argon wrapper happened to be installed.
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const result = await argon2id({
    password,
    salt: shardSalt,
    parallelism: kdf.argonParallelism,
    iterations: kdf.argonTimeCost,
    memorySize: kdf.shardMemoryKb,
    hashLength: kdf.shardOutputBytes,
    outputType: 'binary',
  });
  return new Uint8Array(result);
}
