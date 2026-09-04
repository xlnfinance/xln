/**
 * Bun worker transport for the portable Wasm backend.
 * All cryptographic choices remain in spec.ts/kdf.ts; this file only moves one
 * indexed shard across a worker-thread boundary and returns strict hex.
 */
import { parentPort } from 'worker_threads';
import { bytesToHex } from '../../core/primitives/encoding.ts';
import { deriveShardWithParams } from '../../core/primitives/kdf.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt, shardRequestFingerprint } from '../../core/primitives/spec.ts';

parentPort?.on('message', async ({ specId, name, passphrase, shardIndex, shardCount, shardMemoryKb, algId }) => {
  if (specId !== BRAINVAULT_V1_SPEC_ID) {
    throw new Error('BRAINVAULT_WORKER_SPEC_MISMATCH');
  }
  const memoryKb = shardMemoryKb === undefined ? BRAINVAULT_V1.SHARD_MEMORY_KB : shardMemoryKb;
  const effectiveAlgId = algId === undefined ? BRAINVAULT_V1.ALG_ID : algId;
  const salt = await createShardSalt(name, shardIndex, shardCount, effectiveAlgId);
  const result = await deriveShardWithParams(passphrase, salt, {
    shardMemoryKb: memoryKb,
    algId: effectiveAlgId,
  });
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
