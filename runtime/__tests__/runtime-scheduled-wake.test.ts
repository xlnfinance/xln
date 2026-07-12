import { describe, expect, test } from 'bun:test';

import { initCrontab, scheduleHook } from '../entity/scheduler';
import { applyEntityFrame } from '../entity-consensus';
import { createEmptyEnv } from '../runtime';
import {
  assertScheduledWakeTxAuthorized,
  createDueScheduledWakeInputs,
  getNextScheduledWakeTimestamp,
  MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS,
  refreshScheduledWakeIndex,
  type ScheduledWakeTx,
} from '../runtime-scheduled-wake';
import { safeStringify } from '../serialization-utils';
import type { EntityReplica, EntityState } from '../types';
import { buildCanonicalRuntimeStateSnapshot, restoreDurableRuntimeSnapshot } from '../wal/snapshot';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;

const makeState = (id: string, proposer: string, timestamp: number): EntityState => ({
  entityId: id,
  height: 0,
  timestamp,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [proposer],
    shares: { [proposer]: 1n },
  },
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  profile: { name: 'wake-test', isHub: false, avatar: '', bio: '', website: '' },
  entityEncPubKey: `0x${'11'.repeat(32)}`,
  entityEncPrivKey: `0x${'22'.repeat(32)}`,
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
  crontabState: initCrontab(),
});

const makeReplica = (state: EntityState, signer: string, isProposer: boolean): EntityReplica => ({
  entityId: state.entityId,
  signerId: signer,
  state,
  mempool: [],
  isProposer,
});

describe('runtime scheduled wake', () => {
  test('creates a wake only for the explicit proposer replica', () => {
    const env = createEmptyEnv('scheduled-wake-proposer-test');
    env.timestamp = 10_000;
    const id = entityId('31');
    const proposer = signerId('41');
    const validator = signerId('42');
    const proposerState = makeState(id, proposer, env.timestamp);
    const validatorState = structuredClone(proposerState);
    scheduleHook(proposerState.crontabState!, {
      id: 'watchdog:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    scheduleHook(validatorState.crontabState!, {
      id: 'watchdog:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.eReplicas.set(`${id}:${proposer}`, makeReplica(proposerState, proposer, true));
    env.eReplicas.set(`${id}:${validator}`, makeReplica(validatorState, validator, false));

    const inputs = createDueScheduledWakeInputs(env, env.timestamp);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ entityId: id, signerId: proposer });
    expect(inputs[0]?.entityTxs[0]?.data.jobs).toEqual([
      { kind: 'hook', id: 'watchdog:due', dueAt: 9_000 },
    ]);
  });

  test('rejects a scheduled wake forged through external ingress', () => {
    const tx: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: signerId('51'),
        dueAt: 1,
        jobs: [{ kind: 'hook', id: 'forged', dueAt: 1 }],
      },
    };
    expect(() => assertScheduledWakeTxAuthorized(tx, false)).toThrow(
      /SCHEDULED_WAKE_EXTERNAL_INGRESS_REJECTED/,
    );
  });

  test('replays the same crontab mutation on proposer and validator state', async () => {
    const env = createEmptyEnv('scheduled-wake-replay-test');
    env.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('61');
    const proposer = signerId('62');
    const state = makeState(id, proposer, env.timestamp);
    scheduleHook(state.crontabState!, {
      id: 'watchdog:deterministic',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    const tx: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'watchdog:deterministic', dueAt: 9_000 }],
      },
    };

    const proposerResult = await applyEntityFrame(env, state, [tx], env.timestamp);
    const validatorResult = await applyEntityFrame(env, state, [tx], env.timestamp);

    expect(safeStringify(validatorResult.deterministicState)).toBe(
      safeStringify(proposerResult.deterministicState),
    );
    expect(proposerResult.newState.crontabState?.hooks.has('watchdog:deterministic')).toBe(false);
  });

  test('accepts newly due jobs while a canonical wake waits for its frame', async () => {
    const env = createEmptyEnv('scheduled-wake-frame-delay-test');
    env.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('63');
    const proposer = signerId('64');
    const state = makeState(id, proposer, 9_200);
    scheduleHook(state.crontabState!, {
      id: 'already:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    scheduleHook(state.crontabState!, {
      id: 'became:due',
      triggerAt: 9_500,
      type: 'watchdog',
      data: {},
    });
    const tx: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'already:due', dueAt: 9_000 }],
      },
    };

    const result = await applyEntityFrame(env, state, [tx], env.timestamp);

    expect(result.newState.crontabState?.hooks.size).toBe(0);
  });

  test('treats canceled wake jobs as diagnostics while executing current frame state', async () => {
    const env = createEmptyEnv('scheduled-wake-canceled-job-test');
    env.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('65');
    const proposer = signerId('66');
    const state = makeState(id, proposer, env.timestamp);
    const staleWake: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'canceled:by-j-event', dueAt: 9_000 }],
      },
    };

    const result = await applyEntityFrame(env, state, [staleWake], env.timestamp);

    expect(result.newState.crontabState?.hooks.size).toBe(0);
  });

  test('rejects a wake that is not the first and only wake in an entity frame', async () => {
    const env = createEmptyEnv('scheduled-wake-order-test');
    env.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('67');
    const proposer = signerId('68');
    const state = makeState(id, proposer, env.timestamp);
    const wake: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'order:test', dueAt: 9_000 }],
      },
    };

    await expect(applyEntityFrame(env, state, [
      { type: 'chatMessage', data: { message: 'before wake', timestamp: 9_000 } },
      wake,
    ], env.timestamp)).rejects.toThrow('SCHEDULED_WAKE_FRAME_ORDER_INVALID');
    await expect(applyEntityFrame(env, state, [wake, wake], env.timestamp)).rejects.toThrow(
      'SCHEDULED_WAKE_FRAME_ORDER_INVALID',
    );
  });

  test('indexes imported replicas and invalidates detached replicas without rebuilding the loop', () => {
    const env = createEmptyEnv('scheduled-wake-index-sync-test');
    env.timestamp = 10_000;
    refreshScheduledWakeIndex(env, new Set());
    const id = entityId('71');
    const proposer = signerId('72');
    const state = makeState(id, proposer, env.timestamp);
    scheduleHook(state.crontabState!, {
      id: 'imported:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.eReplicas.set(`${id}:${proposer}`, makeReplica(state, proposer, true));

    refreshScheduledWakeIndex(env, new Set());
    expect(getNextScheduledWakeTimestamp(env)).toBe(9_000);

    env.eReplicas.clear();
    refreshScheduledWakeIndex(env, new Set());
    expect(getNextScheduledWakeTimestamp(env)).toBeNull();
  });

  test('does not revive stale heap entries when a replica is removed and re-added', () => {
    const env = createEmptyEnv('scheduled-wake-generation-tombstone-test');
    env.timestamp = 10_000;
    const id = entityId('73');
    const proposer = signerId('74');
    const firstState = makeState(id, proposer, env.timestamp);
    scheduleHook(firstState.crontabState!, {
      id: 'first:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.eReplicas.set(`${id}:${proposer}`, makeReplica(firstState, proposer, true));
    refreshScheduledWakeIndex(env, new Set());

    env.eReplicas.clear();
    refreshScheduledWakeIndex(env, new Set());

    const replacementState = makeState(id, proposer, env.timestamp);
    scheduleHook(replacementState.crontabState!, {
      id: 'replacement:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.eReplicas.set(`${id}:${proposer}`, makeReplica(replacementState, proposer, true));
    refreshScheduledWakeIndex(env, new Set());

    const inputs = createDueScheduledWakeInputs(env, env.timestamp);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.entityTxs[0]?.data.jobs).toEqual([
      { kind: 'hook', id: 'replacement:due', dueAt: 9_000 },
    ]);
  });

  test('bounds advisory jobs while draining every due hook from canonical state', async () => {
    const env = createEmptyEnv('scheduled-wake-bounded-diagnostics-test');
    env.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('75');
    const proposer = signerId('76');
    const state = makeState(id, proposer, env.timestamp);
    for (let index = 0; index < MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS + 1; index += 1) {
      scheduleHook(state.crontabState!, {
        id: `due:${String(index).padStart(4, '0')}`,
        triggerAt: 9_000,
        type: 'watchdog',
        data: {},
      });
    }
    env.eReplicas.set(`${id}:${proposer}`, makeReplica(state, proposer, true));

    const [input] = createDueScheduledWakeInputs(env, env.timestamp);
    expect(input?.entityTxs[0]?.data.jobs).toHaveLength(MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS);

    const result = await applyEntityFrame(env, state, input!.entityTxs, env.timestamp);
    expect(result.newState.crontabState?.hooks.size).toBe(0);
  });

  test('history records wake diagnostics while restart restore discards ephemeral wake work', () => {
    const env = createEmptyEnv('scheduled-wake-snapshot-filter-test');
    const id = entityId('77');
    const proposer = signerId('78');
    const wake: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'snapshot:due', dueAt: 9_000 }],
      },
    };
    env.runtimeMempool = {
      runtimeTxs: [],
      entityInputs: [{
        entityId: id,
        signerId: proposer,
        entityTxs: [wake, { type: 'chatMessage', data: { message: 'keep', timestamp: 9_000 } }],
      }],
    };

    const snapshot = buildCanonicalRuntimeStateSnapshot(env);
    const persistedInput = snapshot['runtimeInput'] as typeof env.runtimeMempool;
    expect(persistedInput?.entityInputs[0]?.entityTxs?.map(tx => tx.type)).toEqual(['scheduledWake', 'chatMessage']);

    const restored = createEmptyEnv('scheduled-wake-snapshot-filter-restored');
    restoreDurableRuntimeSnapshot(restored, snapshot);
    expect(restored.runtimeMempool?.entityInputs[0]?.entityTxs?.map(tx => tx.type)).toEqual(['chatMessage']);
  });

  test('does not enqueue another wake while one is awaiting entity consensus', () => {
    const env = createEmptyEnv('scheduled-wake-multisig-dedup-test');
    env.timestamp = 10_000;
    const id = entityId('81');
    const proposer = signerId('82');
    const state = makeState(id, proposer, env.timestamp);
    scheduleHook(state.crontabState!, {
      id: 'pending:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    const replica = makeReplica(state, proposer, true);
    env.eReplicas.set(`${id}:${proposer}`, replica);
    const [input] = createDueScheduledWakeInputs(env, env.timestamp);
    expect(input).toBeDefined();
    replica.mempool.push(input!.entityTxs[0]!);
    refreshScheduledWakeIndex(env, new Set([id]));

    expect(createDueScheduledWakeInputs(env, env.timestamp)).toEqual([]);
  });
});
