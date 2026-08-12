import { describe, expect, test } from 'bun:test';

import {
  createDetachedRuntimeViewEnv,
  createRuntimeViewEnv,
  isRuntimeLikeEnv,
  unwrapLiveRuntimeEnv,
} from '../../frontend/src/lib/utils/runtime/liveRuntimeEnv';

function makeLiveEnv() {
  const profiles = new Map();
  return {
    state: {
      eReplicas: new Map(),
      jReplicas: new Map(),
      height: 1,
      timestamp: 1,
    },
    runtimeMempool: { runtimeTxs: [], entityInputs: [], jInputs: [] },
    history: [],
    gossip: {
      profiles,
      announce: () => undefined,
      getProfiles: () => Array.from(profiles.values()),
      getHubs: () => [],
      getNetworkGraph: () => ({ findPaths: async () => [] }),
    },
    frameLogs: [],
    log: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    emit: () => undefined,
  };
}

function makeSnapshot() {
  return {
    state: {
      eReplicas: new Map(),
      jReplicas: new Map(),
      height: 1,
      timestamp: 1,
    },
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
    const account = { deltas: new Map([[1, { offdelta: 10n }]]) };
    const entity = { state: { accounts: new Map([['peer', account]]) } };
    const liveEnv = makeLiveEnv();
    liveEnv.state.eReplicas.set('entity:signer', entity);
    const detached = createDetachedRuntimeViewEnv(liveEnv as never);

    expect(isRuntimeLikeEnv(detached)).toBe(true);
    expect(detached).not.toBe(liveEnv);
    expect(detached.state.eReplicas).not.toBe(liveEnv.state.eReplicas);
    expect(detached.state.jReplicas).not.toBe(liveEnv.state.jReplicas);
    account.deltas.get(1)!.offdelta = 99n;
    const detachedEntity = detached.state.eReplicas.get('entity:signer') as typeof entity;
    expect(detachedEntity.state.accounts.get('peer')?.deltas.get(1)?.offdelta).toBe(10n);
    expect(unwrapLiveRuntimeEnv(detached)).toBe(detached);
  });

  test('detached runtime view cannot alias or pause live Runtime infrastructure', () => {
    const liveEnv = makeLiveEnv();
    Object.assign(liveEnv, {
      infrastructure: { persistencePaused: false },
      runtimeConfig: { storage: { enabled: true } },
    });
    const detached = createDetachedRuntimeViewEnv(liveEnv as never);

    expect(detached.infrastructure).toBeUndefined();
    expect(detached.runtimeMempool).not.toBe(liveEnv.runtimeMempool);
    expect(detached.history).not.toBe(liveEnv.history);
    expect(detached.gossip.profiles).not.toBe(liveEnv.gossip.profiles);

    detached.runtimeConfig = { storage: { enabled: false } };
    expect(liveEnv.runtimeConfig.storage.enabled).toBe(true);
    expect(liveEnv.infrastructure.persistencePaused).toBe(false);
    expect(() => detached.log('forbidden')).toThrow('DETACHED_RUNTIME_VIEW_MUTATION_FORBIDDEN');
  });
});
