import { withRetainedStorageWriterLock } from '../../../storage/runtime-dbs';
import type { RuntimeReplica } from '../../../runtime/types';

const [namespace] = Bun.argv.slice(2);
if (!namespace) throw new Error('namespace is required');
const env = {
  dbNamespace: namespace,
  runtimeId: namespace,
  state: { height: 1 },
} as RuntimeReplica;

await withRetainedStorageWriterLock(env, async () => {});
process.kill(process.pid, 'SIGKILL');
