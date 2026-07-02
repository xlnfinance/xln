import { describe, expect, test } from 'bun:test';

import {
  createDetachedRuntimeViewEnv,
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

  test('detached runtime view env does not expose the live env handle', () => {
    const liveEnv = makeLiveEnv();
    const detached = createDetachedRuntimeViewEnv(liveEnv as never);

    expect(isRuntimeLikeEnv(detached)).toBe(true);
    expect(detached).not.toBe(liveEnv);
    expect(detached.eReplicas).not.toBe(liveEnv.eReplicas);
    expect(detached.jReplicas).not.toBe(liveEnv.jReplicas);
    expect(unwrapLiveRuntimeEnv(detached)).toBe(detached);
  });
});
