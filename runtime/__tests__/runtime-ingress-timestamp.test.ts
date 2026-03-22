import { describe, expect, test } from 'bun:test';

import { initCrontab, scheduleHook } from '../entity-crontab';
import { createEmptyEnv, enqueueRuntimeInput, process, startRuntimeLoop } from '../runtime';
import type { EntityReplica } from '../types';

const makeReplica = (entityId: string, timestamp: number): EntityReplica =>
  ({
    entityId,
    signerId: '1',
    mempool: [],
    isProposer: true,
    state: {
      entityId,
      height: 0,
      timestamp,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: ['1'],
        shares: { '1': 1n },
      },
      reserves: new Map(),
      accounts: new Map(),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
      jBlockObservations: [],
      jBlockChain: [],
      entityEncPubKey: `${'0x'}${'11'.repeat(32)}`,
      entityEncPrivKey: `${'0x'}${'22'.repeat(32)}`,
      profile: {
        name: 'Replica',
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      htlcNotes: new Map(),
      swapBook: new Map(),
      lockBook: new Map(),
      swapTradingPairs: [],
      pendingSwapFillRatios: new Map(),
      crontabState: initCrontab(),
    },
  }) as EntityReplica;

describe('runtime ingress timestamp', () => {
  test('restored runtime does not fire future hooks without new ingress timestamp', async () => {
    const env = createEmptyEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = Date.now();

    const entityId = `0x${'11'.repeat(32)}`;
    const replica = makeReplica(entityId, env.timestamp);
    env.eReplicas.set(`${entityId}:1`, replica);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:futuristic',
      triggerAt: env.timestamp + 60_000,
      type: 'watchdog',
      data: {},
    });

    await process(env);

    expect(env.timestamp).toBe(replica.state.timestamp);
    expect(replica.state.crontabState?.hooks?.has('watchdog:futuristic')).toBe(true);
  });

  test('new ingress timestamp advances runtime clock and fires due hooks', async () => {
    const env = createEmptyEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const existingEntityId = `0x${'11'.repeat(32)}`;
    const replica = makeReplica(existingEntityId, 1_000);
    env.eReplicas.set(`${existingEntityId}:1`, replica);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:due-after-ingress',
      triggerAt: 10_000,
      type: 'watchdog',
      data: {},
    });

    const importedEntityId = `0x${'33'.repeat(32)}`;
    env.runtimeInput = { runtimeTxs: [], entityInputs: [] };
    await process(env, undefined);
    expect(replica.state.crontabState?.hooks?.has('watchdog:due-after-ingress')).toBe(true);

    const futureIngressTimestamp = Date.now() + 365 * 24 * 60 * 60 * 1000;
    enqueueRuntimeInput(env, {
      timestamp: futureIngressTimestamp,
      runtimeTxs: [
        {
          type: 'importReplica',
          entityId: importedEntityId,
          signerId: '1',
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: ['1'],
              shares: { '1': 1n },
            },
            isProposer: true,
            profileName: 'Imported',
          },
        },
      ],
      entityInputs: [],
    });

    await process(env);

    expect(env.timestamp).toBe(futureIngressTimestamp);
    const updatedReplica = env.eReplicas.get(`${existingEntityId}:1`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-ingress')).toBe(false);
  });

  test('empty entity ingress advances runtime clock and fires due hooks', async () => {
    const env = createEmptyEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const entityId = `0x${'55'.repeat(32)}`;
    const replica = makeReplica(entityId, 1_000);
    env.eReplicas.set(`${entityId}:1`, replica);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:due-after-empty-ingress',
      triggerAt: 10_000,
      type: 'watchdog',
      data: {},
    });

    enqueueRuntimeInput(env, {
      timestamp: 20_000,
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId: '1', entityTxs: [] }],
    });

    await process(env);

    expect(env.timestamp).toBe(20_000);
    const updatedReplica = env.eReplicas.get(`${entityId}:1`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-empty-ingress')).toBe(false);
  });

  test('idle runtime loop does not advance logical time from wall clock', async () => {
    const env = createEmptyEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = Date.now();

    const entityId = `0x${'77'.repeat(32)}`;
    const replica = makeReplica(entityId, env.timestamp);
    env.eReplicas.set(`${entityId}:1`, replica);

    const futureTriggerAt = env.timestamp + 60_000;
    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:idle-loop-must-not-fire',
      triggerAt: futureTriggerAt,
      type: 'watchdog',
      data: {},
    });

    env.runtimeState.clockPrimed = true;

    const stop = startRuntimeLoop(env, { tickDelayMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      stop();
    }

    expect(env.timestamp).toBeLessThan(futureTriggerAt);
    const updatedReplica = env.eReplicas.get(`${entityId}:1`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:idle-loop-must-not-fire')).toBe(true);
  });

  test('idle runtime loop advances to due hook timestamp once wall clock reaches it', async () => {
    const env = createEmptyEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = Date.now();

    const entityId = `0x${'88'.repeat(32)}`;
    const replica = makeReplica(entityId, env.timestamp);
    env.eReplicas.set(`${entityId}:1`, replica);

    const dueAt = env.timestamp + 30;
    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:idle-loop-due-after-wall-clock',
      triggerAt: dueAt,
      type: 'watchdog',
      data: {},
    });

    env.runtimeState.clockPrimed = true;

    const stop = startRuntimeLoop(env, { tickDelayMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      stop();
    }

    expect(env.timestamp).toBeGreaterThanOrEqual(dueAt);
    const updatedReplica = env.eReplicas.get(`${entityId}:1`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:idle-loop-due-after-wall-clock')).toBe(false);
  });
});
