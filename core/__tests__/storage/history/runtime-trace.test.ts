import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { buildCanonicalEnvSnapshot } from '../../../storage/wal/snapshot';
import {
  recordRuntimeTraceForTesting,
  startRuntimeTraceForTesting,
} from '../../../runtime/observability/runtime-trace';

test('RuntimeReplica has no timeline; an explicit collector owns a trace', () => {
  const seed = 'explicit runtime trace alpha beta gamma';
  const env = createEmptyEnv(seed);
  expect('history' in env).toBe(false);

  const trace = startRuntimeTraceForTesting(env);
  recordRuntimeTraceForTesting(env, buildCanonicalEnvSnapshot(env, {
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeOutputs: [],
    description: 'external-trace-only',
    logs: [],
    gossipProfiles: [],
  }));
  trace.stop();

  expect('history' in env).toBe(false);
  expect(trace.snapshots).toHaveLength(1);
  expect(trace.snapshots[0]?.description).toBe('external-trace-only');
});
