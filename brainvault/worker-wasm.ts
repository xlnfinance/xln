/**
 * Bun worker transport for the portable Wasm backend.
 * All cryptographic choices remain in spec.ts/kdf.ts; this file only moves one
 * indexed shard across a worker-thread boundary and returns strict hex.
 */
import { parentPort } from 'worker_threads';
import { bytesToHex } from './primitives/encoding.ts';
import { deriveShardWithParams } from './primitives/kdf.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt, shardRequestFingerprint } from './primitives/spec.ts';

parentPort?.on('message', async ({ specId, name, passphrase, shardIndex, shardCount, shardMemoryKb, algId }) => {
  if (specId !== BRAINVAULT_V1_SPEC_ID) {
    throw new Error(`BRAINVAULT_WORKER_SPEC_MISMATCH:${String(specId)}:${BRAINVAULT_V1_SPEC_ID}`);
  }
  const memoryKb = shardMemoryKb ?? BRAINVAULT_V1.SHARD_MEMORY_KB;
  const effectiveAlgId = algId ?? BRAINVAULT_V1.ALG_ID;
  const salt = await createShardSalt(name, shardIndex, shardCount, effectiveAlgId);
  const result = await deriveShardWithParams(passphrase, salt, {
    shardMemoryKb: memoryKb,
    algId: effectiveAlgId,
  });
  parentPort?.postMessage({
    specId: BRAINVAULT_V1_SPEC_ID,
    requestId: shardRequestFingerprint(shardIndex, shardCount, effectiveAlgId, memoryKb),
    shardIndex,
    result: bytesToHex(result),
  });
});
