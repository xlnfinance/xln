import {
  withStorageWriterLock,
  type StorageWriterLockBoundary,
} from '../../storage/runtime-dbs';
import type { Env } from '../../types';

const [namespace, requestedBoundary] = Bun.argv.slice(2);
if (!namespace || !requestedBoundary) throw new Error('namespace and writer-lock boundary are required');
const boundary = requestedBoundary as StorageWriterLockBoundary;
const env = { dbNamespace: namespace, runtimeId: namespace, height: 1 } as Env;

await withStorageWriterLock(env, async () => {
  throw new Error(`writer-lock crash boundary was not reached: ${boundary}`);
}, {
  onBoundary: (reached) => {
    if (reached === boundary) process.kill(process.pid, 'SIGKILL');
  },
});
