import {
  createEmptyEnv,
  enqueueRuntimeInput,
  startRuntimeLoop,
} from '../../runtime';
import { reportManagedChildFatal } from '../../orchestrator/managed-child-fatal-ipc';
import type { RuntimeTx } from '../../types';

const env = createEmptyEnv(`managed-child-fatal-ipc-${process.pid}`);
enqueueRuntimeInput(env, {
  runtimeTxs: [{ type: 'managed-child-fatal-ipc-fixture' } as unknown as RuntimeTx],
  entityInputs: [],
});
startRuntimeLoop(env, {
  onFatal: async payload => {
    const fingerprint = await reportManagedChildFatal({
      runtimeId: env.runtimeId,
      ...payload,
    });
    console.log(`MANAGED_CHILD_FATAL_IPC_ACK:${fingerprint}`);
  },
});

setTimeout(() => {
  console.error('MANAGED_CHILD_FATAL_IPC_FIXTURE_TIMEOUT');
  process.exit(2);
}, 5_000);
