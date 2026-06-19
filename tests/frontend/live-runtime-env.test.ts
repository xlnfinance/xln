import { describe, expect, test } from 'bun:test';

import {
  createRuntimeViewEnv,
  isRuntimeLikeEnv,
  unwrapLiveRuntimeEnv,
} from '../../frontend/src/lib/utils/liveRuntimeEnv';

function makeLiveEnv() {
  return {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 1,
    timestamp: 1,
    runtimeInput: { runtimeTxs: [], entityInputs: [], jInputs: [] },
    history: [],
    gossip: { getProfiles: () => [] },
  };
}

function makeSnapshot() {
  return {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 1,
    timestamp: 1,
    runtimeInput: { runtimeTxs: [], entityInputs: [], jInputs: [] },
    runtimeOutputs: [],
    description: 'historical frame',
  };
}

describe('live runtime env helpers', () => {
  test('plain historical snapshots are not accepted as live runtime envs', () => {
    const snapshot = makeSnapshot();

    expect(isRuntimeLikeEnv(snapshot)).toBe(false);
    expect(unwrapLiveRuntimeEnv(snapshot as never)).toBe(null);
  });

  test('runtime view env unwraps to its original live env', () => {
    const liveEnv = makeLiveEnv();
    const viewEnv = createRuntimeViewEnv(liveEnv as never);

    expect(isRuntimeLikeEnv(liveEnv)).toBe(true);
    expect(isRuntimeLikeEnv(viewEnv)).toBe(true);
    expect(unwrapLiveRuntimeEnv(viewEnv)).toBe(liveEnv);
  });
});
