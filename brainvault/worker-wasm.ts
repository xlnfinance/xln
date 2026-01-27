import { parentPort } from 'worker_threads';
import { createShardSalt, deriveShard, hexToBytes, bytesToHex } from './core.ts';

parentPort?.on('message', async ({ nameHashHex, passphrase, shardIndex, shardCount }) => {
  const salt = await createShardSalt(hexToBytes(nameHashHex), shardIndex, shardCount);
  const result = await deriveShard(passphrase, salt);
  parentPort?.postMessage({ shardIndex, result: bytesToHex(result) });
});
