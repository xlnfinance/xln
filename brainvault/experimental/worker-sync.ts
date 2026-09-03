import { parentPort } from 'node:worker_threads';
import { hashRawSync as argon2NativeSync } from '@node-rs/argon2';
import { bytesToHex } from '../primitives/encoding.ts';
import {
  assertBrainVaultName,
  assertBrainVaultPassphrase,
  BRAINVAULT_V1,
  BRAINVAULT_V1_SPEC_ID,
  createShardSalt,
  shardRequestFingerprint,
} from '../primitives/spec.ts';

parentPort?.on('message', async ({ specId, name, passphrase, shardIndex, shardCount, shardMemoryKb, algId }) => {
  if (specId !== BRAINVAULT_V1_SPEC_ID) {
    throw new Error('BRAINVAULT_WORKER_SPEC_MISMATCH');
  }
  assertBrainVaultName(name);
  assertBrainVaultPassphrase(passphrase);
  const memoryKb = shardMemoryKb === undefined ? BRAINVAULT_V1.SHARD_MEMORY_KB : shardMemoryKb;
  const effectiveAlgId = algId === undefined ? BRAINVAULT_V1.ALG_ID : algId;
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  try {
    const result = new Uint8Array(argon2NativeSync(password, {
      salt: Buffer.from(await createShardSalt(name, shardIndex, shardCount, effectiveAlgId)),
      memoryCost: memoryKb,
      timeCost: BRAINVAULT_V1.ARGON_TIME_COST,
      parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
      outputLen: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
      algorithm: 2,
      version: 1,
    }));
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
  } finally {
    password.fill(0);
  }
});
