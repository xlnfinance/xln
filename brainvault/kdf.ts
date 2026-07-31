/** Argon2id shard derivation shared by library and Wasm workers. */

import { argon2id } from 'hash-wasm';
import { BRAINVAULT_V1 } from './spec.ts';

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
  const kdf = resolveKdfParams(params);
  // Canonical bytes also make malformed UTF-16 deterministic across JS and native engines.
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
