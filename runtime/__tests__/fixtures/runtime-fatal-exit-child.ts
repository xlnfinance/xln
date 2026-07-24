import {
  createEmptyEnv,
  enqueueRuntimeInput,
  startRuntimeLoop,
} from '../../runtime';
import type { RuntimeTx } from '../../types';

const env = createEmptyEnv(`runtime-fatal-exit-${process.pid}`);
enqueueRuntimeInput(env, {
  runtimeTxs: [{ type: 'fatal-exit-fixture' } as unknown as RuntimeTx],
  entityInputs: [],
});
startRuntimeLoop(env);

setTimeout(() => {
  console.error('RUNTIME_FATAL_EXIT_FIXTURE_TIMEOUT');
  process.exit(2);
}, 5_000);
