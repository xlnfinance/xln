import { parentPort } from 'worker_threads';
import { bytesToHex } from './encoding.ts';
import { deriveShardWithParams } from './kdf.ts';
import { BRAINVAULT_V1, createShardSalt } from './spec.ts';

parentPort?.on('message', async ({ name, passphrase, shardIndex, shardCount, shardMemoryKb, algId }) => {
  const memoryKb = shardMemoryKb ?? BRAINVAULT_V1.SHARD_MEMORY_KB;
  const salt = await createShardSalt(name, shardIndex, shardCount, algId ?? BRAINVAULT_V1.ALG_ID);
  const result = await deriveShardWithParams(passphrase, salt, {
    shardMemoryKb: memoryKb,
    algId: algId ?? BRAINVAULT_V1.ALG_ID,
  });
  parentPort?.postMessage({ shardIndex, result: bytesToHex(result) });
});
