import { parentPort } from 'worker_threads';
import { hashRaw as argon2Native } from '@node-rs/argon2';
import { createShardSalt, bytesToHex, BRAINVAULT_V1 } from './core.ts';

parentPort?.on('message', async ({ name, passphrase, shardIndex, shardCount, shardMemoryKb, algId }) => {
  const memoryKb = shardMemoryKb ?? BRAINVAULT_V1.SHARD_MEMORY_KB;
  const salt = await createShardSalt(name, shardIndex, shardCount, algId ?? BRAINVAULT_V1.ALG_ID);
  const normalized = passphrase.normalize('NFKD');

  const result = await argon2Native(normalized, {
    salt: Buffer.from(salt),
    memoryCost: memoryKb,
    timeCost: BRAINVAULT_V1.ARGON_TIME_COST,
    parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
    outputLen: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
    algorithm: 2, // argon2id
  });

  parentPort?.postMessage({ shardIndex, result: bytesToHex(Buffer.from(result)) });
});
