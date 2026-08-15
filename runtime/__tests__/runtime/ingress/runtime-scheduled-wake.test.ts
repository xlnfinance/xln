import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import {
  ACCOUNT_MAINTENANCE_INTERVAL_MS,
  HUB_REBALANCE_INTERVAL_MS,
  initCrontab,
  scheduleHook,
} from '../../../entity/scheduler';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { buildSignedEntityCommand } from '../../../entity/command';
import { signedEntityCommandTx } from '../../../entity/command/command-codec';
import { provisionTestEntityEncryptionKey } from '../../../qa/entity-creation-fixture';
import { generateLazyEntityId } from '../../../entity/factory';
import { applyEntityInput } from '../../../entity/consensus/index';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';
import {
  createEmptyEnv,
  hasRuntimeWork,
  processRuntime,
  registerRuntimeFrameCommitCallback,
  waitForRuntimeWorkDrained,
} from '../../../runtime';
import {
  assertScheduledWakeTxAuthorized,
  collectDueScheduledWakeJobs,
  createDueScheduledWakeInputs,
  entityNeedsPeriodicWake,
  getNextScheduledWakeTimestamp,
  refreshScheduledWakeIndex,
} from '../../../runtime/input-pipeline/scheduled-wake';
import {
  MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS,
  type ScheduledWakeTx,
} from '../../../entity/scheduler/scheduled-wake-validation';
import { safeStringify } from '../../../protocol/serialization';
import {
  computeCanonicalEntityHash,
  computeCanonicalStateHashFromEnv,
} from '../../../storage/canonical-hash';
import type { EntityReplica, EntityState } from '../../../entity/types';
import type { RuntimeInput } from '../../../runtime/types';
import {
  buildCanonicalRuntimeStateSnapshot,
  buildDurableRuntimeMempool,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';
import { buildLocalEntityProfile } from '../../../network/p2p/gossip/helper';
import { computeProfileHash } from '../../../entity/profile/profile-signing';
import { makeAccount } from '../../helpers/cross-j';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;
const commandJurisdiction = {
  name: 'ScheduledWakeCommandTest',
  address: 'browservm://scheduled-wake-command-test',
  chainId: 31_337,
  depositoryAddress: signerId('91'),
  entityProviderAddress: signerId('92'),
};

const makeState = (id: string, proposer: string, timestamp: number): EntityState => ({
  entityId: id,
  height: 0,
  timestamp,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [proposer],
    shares: { [proposer]: 1n },
    jurisdiction: commandJurisdiction,
  },
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  profile: { name: 'wake-test', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  swapTradingPairs: [],
  crontabState: initCrontab(),
});

const makeReplica = (state: EntityState, signer: string, isProposer: boolean): EntityReplica => ({
  entityId: state.entityId,
  signerId: signer,
  entityEncPubKey: '',
  state,
  mempool: [],
  isProposer,
});

const attachLocalEntityKeys = (
  env: ReturnType<typeof createEmptyEnv>,
  replica: EntityReplica,
): EntityReplica => {
  const keys = provisionTestEntityEncryptionKey(env, replica.entityId);
  replica.state.entityEncryptionPublicKey = keys.publicKey;
  return replica;
};

describe('runtime scheduled wake', () => {
  test('rejects an Entity frame timestamp regression before applying transactions', async () => {
    const proposer = signerId('30');
    const state = makeState(entityId('20'), proposer, 2_000);
    const env = createEmptyEnv('entity-frame-timestamp-regression');
    env.state.timestamp = 2_100;

    await expect(applyEntityFrameWithMaterializedTestInfraContext(env, state, [], 1_999)).rejects.toThrow(
      'ENTITY_FRAME_TIMESTAMP_REGRESSION:previous=2000:proposed=1999',
    );
    expect(state.timestamp).toBe(2_000);
    expect(state.height).toBe(0);
  });

  test('a pending account frame does not activate the unrelated one-second hub rebalance task', () => {
    const id = entityId('20');
    const proposer = signerId('30');
    const counterparty = entityId('21');
    const state = makeState(id, proposer, 0);
    state.hubRebalanceConfig = {} as never;
    const account = makeAccount(id, counterparty);
    account.pendingFrame = { ...account.currentFrame, height: 1, timestamp: 0, accountTxs: [] };
    state.accounts.set(counterparty, account);
    const replica = makeReplica(state, proposer, true);

    expect(entityNeedsPeriodicWake(replica)).toBe(true);
    expect(collectDueScheduledWakeJobs(state, HUB_REBALANCE_INTERVAL_MS, true)).toEqual([]);
    expect(collectDueScheduledWakeJobs(state, ACCOUNT_MAINTENANCE_INTERVAL_MS, true)).toEqual([
      {
        kind: 'task',
        id: 'maintainPendingAccounts',
        dueAt: ACCOUNT_MAINTENANCE_INTERVAL_MS,
      },
    ]);
  });

  test('real rebalance demand still activates the one-second hub task', () => {
    const id = entityId('22');
    const proposer = signerId('32');
    const counterparty = entityId('23');
    const state = makeState(id, proposer, 0);
    state.hubRebalanceConfig = {} as never;
    const account = makeAccount(id, counterparty);
    account.state.requestedRebalance = new Map([[1, 1n]]);
    state.accounts.set(counterparty, account);
    const replica = makeReplica(state, proposer, true);

    expect(entityNeedsPeriodicWake(replica)).toBe(true);
    expect(collectDueScheduledWakeJobs(state, HUB_REBALANCE_INTERVAL_MS, true)).toEqual([
      { kind: 'task', id: 'hubRebalance', dueAt: HUB_REBALANCE_INTERVAL_MS },
    ]);
  });

  test('quiesce preserves newly-due hooks without treating them as drainable work', async () => {
    const env = createEmptyEnv('scheduled-wake-quiesce');
    env.scenarioMode = false;
    const id = entityId('29');
    const proposer = signerId('39');
    const state = makeState(id, proposer, Date.now() - 1_000);
    scheduleHook(state.crontabState!, {
      id: 'due-after-runtime-stopped',
      triggerAt: Date.now() - 1,
      type: 'watchdog',
      data: {},
    });
    env.state.eReplicas.set(`${id}:${proposer}`, makeReplica(state, proposer, true));
    env.infrastructure!.persistenceQuiescing = true;

    expect(hasRuntimeWork(env)).toBe(false);
    expect(await waitForRuntimeWorkDrained(env, 20, 1)).toBe(true);
    expect(state.crontabState?.hooks.has('due-after-runtime-stopped')).toBe(true);
  });

  test('full drain does not report idle while reliable ingress remains pending', async () => {
    const env = createEmptyEnv('reliable-ingress-drain-test');
    env.infrastructure!.pendingReliableIngress = new Map([['pending', {} as never]]);
    env.infrastructure!.loopPromise = new Promise<void>(() => undefined);

    // Pending consensus is a drain barrier, not scheduler work: treating it as
    // runnable would spin empty Runtime frames while waiting for the peer.
    expect(hasRuntimeWork(env)).toBe(false);
    expect(await waitForRuntimeWorkDrained(env, 20, 1)).toBe(false);
    env.infrastructure!.loopPromise = null;
  });

  test('does not initialize consensus crontab state outside a committed Entity frame', async () => {
    const env = createEmptyEnv('scheduled-wake-noop-state-test');
    env.state.timestamp = 10_000;
    env.scenarioMode = false;
    const id = entityId('30');
    const proposer = signerId('40');
    const state = makeState(id, proposer, 9_000);
    delete state.crontabState;
    const replica = makeReplica(state, proposer, true);
    const before = computeCanonicalEntityHash(replica).hash;

    const result = await applyEntityInput(env, replica, {
      entityId: id,
      signerId: proposer,
      entityTxs: [],
    });

    expect(computeCanonicalEntityHash(result.workingReplica).hash).toBe(before);
    expect(result.workingReplica.state.crontabState).toBeUndefined();
    expect(result.workingReplica.state.timestamp).toBe(9_000);
  });

  test('places a newly due wake before transactions already waiting in proposer mempool', async () => {
    const seed = 'scheduled wake existing mempool ordering';
    const env = createEmptyEnv(seed);
    env.state.timestamp = 10_000;
    env.scenarioMode = true;
    const proposer = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(env, proposer, deriveSignerKeySync(seed, '1'));
    const id = generateLazyEntityId([proposer], 1n).toLowerCase();
    const state = makeState(id, proposer, 9_000);
    scheduleHook(state.crontabState!, {
      id: 'existing-mempool:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    const replica = attachLocalEntityKeys(env, makeReplica(state, proposer, true));
    replica.mempool.push(signedEntityCommandTx(buildSignedEntityCommand(env, state, proposer, [{
      type: 'chat',
      data: { from: proposer, message: 'already waiting' },
    }])));
    const wake: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'existing-mempool:due', dueAt: 9_000 }],
      },
    };

    const result = await applyEntityInput(env, replica, {
      entityId: id,
      signerId: proposer,
      entityTxs: [wake],
    });

    expect(result.outcome.kind).toBe('committed');
    expect(readEntityFrameEventMessages(result.workingReplica.state)).toContain(`${proposer}: already waiting`);
    expect(result.workingReplica.state.crontabState?.hooks.has('existing-mempool:due')).toBe(false);
  });

  test('drives an idle active proposer when committed work remains in Entity mempool', async () => {
    const seed = 'entity mempool proposer wake';
    const env = createEmptyEnv(seed);
    env.state.timestamp = 1;
    env.scenarioMode = true;
    env.runtimeConfig = { storage: { enabled: false } };
    const proposer = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(env, proposer, deriveSignerKeySync(seed, '1'));
    const id = generateLazyEntityId([proposer], 1n).toLowerCase();
    const replica = attachLocalEntityKeys(env, makeReplica(makeState(id, proposer, 1), proposer, true));
    env.state.eReplicas.set(`${id}:${proposer}`, replica);
    const profileHash = computeProfileHash(buildLocalEntityProfile(env, replica.state, 1));
    replica.hankoWitness = new Map([[profileHash, {
      hanko: '0x01',
      type: 'profile',
      entityHeight: 0,
      createdAt: 1,
    }]]);
    replica.mempool.push(signedEntityCommandTx(buildSignedEntityCommand(
      env,
      replica.state,
      proposer,
      [{
        type: 'chat',
        data: { from: proposer, message: 'left after prior commit' },
      }],
    )));
    const committedInputs: Array<{ height: number; entityInputs: RuntimeInput['entityInputs'] }> = [];
    registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
      committedInputs.push({ height, entityInputs: structuredClone(runtimeInput.entityInputs) });
    });
    await processRuntime(env);

    expect(env.state.height).toBe(1);
    expect(env.state.eReplicas.get(`${id}:${proposer}`)?.state.height).toBe(1);
    const committedReplica = env.state.eReplicas.get(`${id}:${proposer}`);
    expect(committedReplica && readEntityFrameEventMessages(committedReplica.state))
      .toContain(`${proposer}: left after prior commit`);
    expect(env.state.eReplicas.get(`${id}:${proposer}`)?.mempool).toHaveLength(0);
    expect(committedInputs).toEqual([{
      height: 1,
      entityInputs: [{
        entityId: id,
        signerId: proposer,
        entityTxs: [],
      }],
    }]);
  });

  test('creates a wake only for the explicit proposer replica', () => {
    const env = createEmptyEnv('scheduled-wake-proposer-test');
    env.state.timestamp = 10_000;
    const id = entityId('31');
    const proposer = signerId('41');
    const validator = signerId('42');
    const proposerState = makeState(id, proposer, env.state.timestamp);
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
    env.state.eReplicas.set(`${id}:${proposer}`, makeReplica(proposerState, proposer, true));
    env.state.eReplicas.set(`${id}:${validator}`, makeReplica(validatorState, validator, false));

    const inputs = createDueScheduledWakeInputs(env, env.state.timestamp);

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

  test('does not persist process-local scheduled wakes in pending Runtime input', () => {
    const env = createEmptyEnv('scheduled-wake-durable-mempool');
    env.state.timestamp = 10_000;
    const id = entityId('52');
    const proposer = signerId('53');
    const state = makeState(id, proposer, env.state.timestamp);
    scheduleHook(state.crontabState!, {
      id: 'durable:regenerate',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.state.eReplicas.set(`${id}:${proposer}`, makeReplica(state, proposer, true));
    const [wakeInput] = createDueScheduledWakeInputs(env, env.state.timestamp);
    if (!wakeInput) throw new Error('scheduled wake fixture missing');

    const durable = buildDurableRuntimeMempool({
      runtimeTxs: [],
      entityInputs: [wakeInput],
      queuedAt: env.state.timestamp,
    });

    expect(durable.entityInputs).toEqual([]);
    expect(durable.queuedAt).toBeUndefined();
    expect(state.crontabState?.hooks.has('durable:regenerate')).toBe(true);
  });

  test('replays the same crontab mutation on proposer and validator state', async () => {
    const env = createEmptyEnv('scheduled-wake-replay-test');
    env.state.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('61');
    const proposer = signerId('62');
    const state = makeState(id, proposer, env.state.timestamp);
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

    const proposerResult = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [tx], env.state.timestamp);
    const validatorResult = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [tx], env.state.timestamp);

    expect(safeStringify(validatorResult.newState)).toBe(
      safeStringify(proposerResult.newState),
    );
    expect(proposerResult.newState.crontabState?.hooks.has('watchdog:deterministic')).toBe(false);
  });

  test('applies deterministic self-actions in the scheduled wake frame', async () => {
    const env = createEmptyEnv('scheduled-wake-self-action-test');
    env.state.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('60');
    const proposer = signerId('61');
    const state = makeState(id, proposer, env.state.timestamp);
    scheduleHook(state.crontabState!, {
      id: 'cross-j-sweep:self',
      triggerAt: 9_000,
      type: 'cross_j_orderbook_sweep',
      data: { reason: 'scheduled-wake-self-action-test' },
    });
    const tx: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'cross-j-sweep:self', dueAt: 9_000 }],
      },
    };

    const result = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [tx], env.state.timestamp);

    expect(result.outputs).toEqual([]);
    expect(readEntityFrameEventMessages(result.newState)).toContain(
      '🌉 Cross-j orderbook sweep: scheduled-wake-self-action-test expired=0 closedOffers=0 waiting=0',
    );
  });

  test('accepts newly due jobs while a canonical wake waits for its frame', async () => {
    const env = createEmptyEnv('scheduled-wake-frame-delay-test');
    env.state.timestamp = 10_000;
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

    const result = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [tx], env.state.timestamp);

    expect(result.newState.crontabState?.hooks.size).toBe(0);
  });

  test('treats canceled wake jobs as diagnostics while executing current frame state', async () => {
    const env = createEmptyEnv('scheduled-wake-canceled-job-test');
    env.state.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('65');
    const proposer = signerId('66');
    const state = makeState(id, proposer, env.state.timestamp);
    const staleWake: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'canceled:by-j-event', dueAt: 9_000 }],
      },
    };

    const result = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [staleWake], env.state.timestamp);

    expect(result.newState.crontabState?.hooks.size).toBe(0);
  });

  test('rejects a wake that is not the first and only wake in an entity frame', async () => {
    const env = createEmptyEnv('scheduled-wake-order-test');
    env.state.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('67');
    const proposer = signerId('68');
    const state = makeState(id, proposer, env.state.timestamp);
    const wake: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: proposer,
        dueAt: 9_000,
        jobs: [{ kind: 'hook', id: 'order:test', dueAt: 9_000 }],
      },
    };

    await expect(applyEntityFrameWithMaterializedTestInfraContext(env, state, [
      { type: 'chatMessage', data: { message: 'before wake', timestamp: 9_000 } },
      wake,
    ], env.state.timestamp)).rejects.toThrow('SCHEDULED_WAKE_FRAME_ORDER_INVALID');
    await expect(applyEntityFrameWithMaterializedTestInfraContext(env, state, [wake, wake], env.state.timestamp)).rejects.toThrow(
      'SCHEDULED_WAKE_FRAME_ORDER_INVALID',
    );
  });

  test('indexes imported replicas and invalidates detached replicas without rebuilding the loop', () => {
    const env = createEmptyEnv('scheduled-wake-index-sync-test');
    env.state.timestamp = 10_000;
    refreshScheduledWakeIndex(env, new Set());
    const id = entityId('71');
    const proposer = signerId('72');
    const state = makeState(id, proposer, env.state.timestamp);
    scheduleHook(state.crontabState!, {
      id: 'imported:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.state.eReplicas.set(`${id}:${proposer}`, makeReplica(state, proposer, true));

    refreshScheduledWakeIndex(env, new Set());
    expect(getNextScheduledWakeTimestamp(env)).toBe(9_000);

    env.state.eReplicas.clear();
    refreshScheduledWakeIndex(env, new Set());
    expect(getNextScheduledWakeTimestamp(env)).toBeNull();
  });

  test('does not revive stale heap entries when a replica is removed and re-added', () => {
    const env = createEmptyEnv('scheduled-wake-generation-tombstone-test');
    env.state.timestamp = 10_000;
    const id = entityId('73');
    const proposer = signerId('74');
    const firstState = makeState(id, proposer, env.state.timestamp);
    scheduleHook(firstState.crontabState!, {
      id: 'first:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.state.eReplicas.set(`${id}:${proposer}`, makeReplica(firstState, proposer, true));
    refreshScheduledWakeIndex(env, new Set());

    env.state.eReplicas.clear();
    refreshScheduledWakeIndex(env, new Set());

    const replacementState = makeState(id, proposer, env.state.timestamp);
    scheduleHook(replacementState.crontabState!, {
      id: 'replacement:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    env.state.eReplicas.set(`${id}:${proposer}`, makeReplica(replacementState, proposer, true));
    refreshScheduledWakeIndex(env, new Set());

    const inputs = createDueScheduledWakeInputs(env, env.state.timestamp);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.entityTxs[0]?.data.jobs).toEqual([
      { kind: 'hook', id: 'replacement:due', dueAt: 9_000 },
    ]);
  });

  test('bounds advisory jobs while draining every due hook from canonical state', async () => {
    const env = createEmptyEnv('scheduled-wake-bounded-diagnostics-test');
    env.state.timestamp = 10_000;
    env.scenarioMode = true;
    const id = entityId('75');
    const proposer = signerId('76');
    const state = makeState(id, proposer, env.state.timestamp);
    for (let index = 0; index < MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS + 1; index += 1) {
      scheduleHook(state.crontabState!, {
        id: `due:${String(index).padStart(4, '0')}`,
        triggerAt: 9_000,
        type: 'watchdog',
        data: {},
      });
    }
    env.state.eReplicas.set(`${id}:${proposer}`, makeReplica(state, proposer, true));

    const [input] = createDueScheduledWakeInputs(env, env.state.timestamp);
    expect(input?.entityTxs[0]?.data.jobs).toHaveLength(MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS);

    const result = await applyEntityFrameWithMaterializedTestInfraContext(env, state, input!.entityTxs, env.state.timestamp);
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
    expect(persistedInput?.entityInputs[0]?.entityTxs?.map(tx => tx.type)).toEqual(['chatMessage']);

    const restored = createEmptyEnv('scheduled-wake-snapshot-filter-restored');
    restored.state.height = env.state.height;
    restored.state.timestamp = env.state.timestamp;
    restoreDurableRuntimeSnapshot(restored, snapshot);
    expect(restored.runtimeMempool?.entityInputs[0]?.entityTxs?.map(tx => tx.type)).toEqual(['chatMessage']);
    expect(computeCanonicalStateHashFromEnv(restored)).toBe(computeCanonicalStateHashFromEnv(env));
  });

  test('does not enqueue another wake while one is awaiting entity consensus', () => {
    const env = createEmptyEnv('scheduled-wake-multisig-dedup-test');
    env.state.timestamp = 10_000;
    const id = entityId('81');
    const proposer = signerId('82');
    const state = makeState(id, proposer, env.state.timestamp);
    scheduleHook(state.crontabState!, {
      id: 'pending:due',
      triggerAt: 9_000,
      type: 'watchdog',
      data: {},
    });
    const replica = makeReplica(state, proposer, true);
    env.state.eReplicas.set(`${id}:${proposer}`, replica);
    const [input] = createDueScheduledWakeInputs(env, env.state.timestamp);
    expect(input).toBeDefined();
    replica.mempool.push(input!.entityTxs[0]!);
    refreshScheduledWakeIndex(env, new Set([id]));

    expect(createDueScheduledWakeInputs(env, env.state.timestamp)).toEqual([]);
  });
});
