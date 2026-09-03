/**
 * Thin worker-thread transport for the CLI.
 *
 * Argon parameters live in native.ts; duplicating them here would let the CLI
 * and node server silently derive different wallets after a future edit.
 */
import { parentPort } from 'worker_threads';
import { hashRaw as argon2Native } from '@node-rs/argon2';
import { bytesToHex } from './primitives/encoding.ts';
import { deriveBrainVaultNativeShard } from './native.ts';
import {
  assertBrainVaultName,
  assertBrainVaultPassphrase,
  BRAINVAULT_V1,
  BRAINVAULT_V1_SPEC_ID,
  createShardSalt,
  shardRequestFingerprint,
} from './primitives/spec.ts';

parentPort?.on('message', async ({ specId, name, passphrase, shardIndex, shardCount, shardMemoryKb, algId }) => {
  if (specId !== BRAINVAULT_V1_SPEC_ID) {
    throw new Error('BRAINVAULT_WORKER_SPEC_MISMATCH');
  }
  assertBrainVaultName(name);
  assertBrainVaultPassphrase(passphrase);
  const memoryKb = shardMemoryKb === undefined ? BRAINVAULT_V1.SHARD_MEMORY_KB : shardMemoryKb;
  const effectiveAlgId = algId === undefined ? BRAINVAULT_V1.ALG_ID : algId;
  const standard = memoryKb === BRAINVAULT_V1.SHARD_MEMORY_KB && effectiveAlgId === BRAINVAULT_V1.ALG_ID;
  let result: Uint8Array;
  if (standard) {
    result = await deriveBrainVaultNativeShard(
      { name, passphrase, shardInput: shardCount, workers: 1 },
      shardIndex,
      shardCount,
    );
  } else {
    const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
    try {
      result = new Uint8Array(await argon2Native(password, {
        salt: Buffer.from(await createShardSalt(name, shardIndex, shardCount, effectiveAlgId)),
        memoryCost: memoryKb,
        timeCost: BRAINVAULT_V1.ARGON_TIME_COST,
        parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
        outputLen: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
        algorithm: 2,
        version: 1,
      }));
    } finally {
      password.fill(0);
    }
  }

  try {
    parentPort?.postMessage({
      specId: BRAINVAULT_V1_SPEC_ID,
      requestId: shardRequestFingerprint(shardIndex, shardCount, effectiveAlgId, memoryKb),
      shardIndex,
      result: bytesToHex(result),
    });
  } finally {
    result.fill(0);
  }
});
