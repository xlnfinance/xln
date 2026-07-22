import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { TIMING } from '../constants';
import { initCrontab, scheduleHook } from '../entity/scheduler';
import { generateLazyEntityId } from '../entity/factory';
import { processEventBatch } from '../jadapter/watcher';
import { createRuntimeIngressReceiptStore } from '../server/ingress-receipts';
import { buildJEventRangeData } from './helpers/j-history';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  entityNeedsPeriodicWake,
  hasRuntimeWork,
  process,
  registerRuntimeFrameCommitCallback,
  startRuntimeLoop,
} from '../runtime';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import type { AccountMachine, EntityReplica, Env, JurisdictionConfig, JurisdictionEvent } from '../types';
import { getWallClockMs } from '../utils';

const TEST_JURISDICTION = {
  address: `0x${'22'.repeat(20)}`,
  name: 'Testnet',
  entityProviderAddress: `0x${'22'.repeat(20)}`,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  chainId: 31337,
} satisfies JurisdictionConfig;
const TEST_RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let testSeedCounter = 0;

const uniqueSeed = (label: string): string => `${label}-${TEST_RUN_ID}-${++testSeedCounter}`;

const createIsolatedEnv = (label: string): Env => createEmptyEnv(uniqueSeed(label));

const testJurisdiction = (name = TEST_JURISDICTION.name): JurisdictionConfig => ({
  ...TEST_JURISDICTION,
  name,
});

const addTestJurisdiction = (env: Env, name = TEST_JURISDICTION.name, jadapter?: unknown): void => {
  env.activeJurisdiction = env.activeJurisdiction || name;
  env.jReplicas.set(name, {
    name,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: env.timestamp,
    position: { x: 0, y: 0, z: 0 },
    depositoryAddress: TEST_JURISDICTION.depositoryAddress,
    entityProviderAddress: TEST_JURISDICTION.entityProviderAddress,
    contracts: {
      account: `0x${'33'.repeat(20)}`,
      depository: TEST_JURISDICTION.depositoryAddress,
      entityProvider: TEST_JURISDICTION.entityProviderAddress,
      deltaTransformer: `0x${'44'.repeat(20)}`,
    },
    rpcs: ['http://localhost:8545'],
    chainId: TEST_JURISDICTION.chainId,
    ...(jadapter ? { jadapter: jadapter as never } : {}),
  });
};

const makeReplica = (entityId: string, timestamp: number, signerId = '1'): EntityReplica =>
  ({
    entityId,
    signerId,
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
        validators: [signerId],
        shares: { [signerId]: 1n },
        jurisdiction: testJurisdiction(),
      },
      reserves: new Map(),
      accounts: new Map(),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
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
      lockBook: new Map(),
      swapTradingPairs: [],
      pendingSwapFillRatios: new Map(),
      crontabState: initCrontab(),
    },
  }) as EntityReplica;

const addSignableReplica = (
  env: Env,
  timestamp: number,
  signerLabel = '1',
): { entityId: string; signerId: string; replica: EntityReplica } => {
  const signerId = deriveSignerAddressSync(env.runtimeSeed!, signerLabel).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, signerLabel));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const replica = makeReplica(entityId, timestamp, signerId);
  env.eReplicas.set(`${entityId}:${signerId}`, replica);
  return { entityId, signerId, replica };
};

describe('runtime ingress timestamp', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('runtime loop does not restart once runtime state is sticky-halted', async () => {
    const env = createIsolatedEnv('sticky-halt');
    env.runtimeState = { halted: true, loopActive: false };
    let startCalls = 0;
    addTestJurisdiction(env, 'Testnet', {
      startWatching() {
        startCalls += 1;
      },
      stopWatching() {},
      isWatching() {
        return false;
      },
    });

    const stop = startRuntimeLoop(env);
    stop();
    await sleep(20);

    expect(env.runtimeState?.loopActive).toBe(false);
    expect(startCalls).toBe(0);
  });

  test('restored runtime does not fire future hooks without new ingress timestamp', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = Date.now();

    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'restored-remote').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const replica = makeReplica(entityId, env.timestamp, signerId);
    env.eReplicas.set(`${entityId}:${signerId}`, replica);

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

  test('runtime frame cap leaves excess entity inputs queued for later frames', async () => {
    const env = createIsolatedEnv('runtime-entity-input-frame-cap');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    env.runtimeState = {
      loopActive: false,
      halted: false,
      maxEntityInputsPerFrame: 1,
    };

    const replicas = ['cap-1', 'cap-2', 'cap-3'].map((label) => {
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
      const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
      env.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId));
      return { entityId, signerId };
    });
    const entityIds = replicas.map(({ entityId }) => entityId);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: replicas.map(({ entityId, signerId }) => ({ entityId, signerId, entityTxs: [] })),
    });

    await process(env);
    expect(env.runtimeMempool?.entityInputs.map(input => input.entityId)).toEqual(entityIds.slice(1));
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);

    await process(env);
    expect(env.runtimeMempool?.entityInputs.map(input => input.entityId)).toEqual(entityIds.slice(2));
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);

    await process(env);
    expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
    expect(env.runtimeMempool?.queuedAt).toBeUndefined();
  });

  test('stale queuedAt without payload cannot spin empty Runtime cycles', () => {
    const env = createIsolatedEnv('runtime-empty-queued-at');
    env.timestamp = 1_000;
    env.runtimeMempool = {
      runtimeTxs: [],
      entityInputs: [],
      queuedAt: 9_000,
    };
    env.runtimeInput = env.runtimeMempool;

    expect(hasRuntimeWork(env)).toBe(false);
  });

  test('runtime drains the whole accepted Entity input bundle in one R-frame by default', async () => {
    const env = createIsolatedEnv('runtime-entity-input-no-default-cap');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;

    const replicas = Array.from({ length: 12 }, (_, index) => {
      const label = `uncapped-${index}`;
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
      registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, label));
      const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
      env.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId));
      return { entityId, signerId };
    });
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: replicas.map(({ entityId, signerId }, index) => ({
        entityId,
        signerId,
        entityTxs: [{
          type: 'profile-update' as const,
          data: { profile: { entityId, name: `uncapped-${index}` } },
        }],
      })),
    });
    const committedInputs: Array<{ height: number; entityInputCount: number }> = [];
    registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
      committedInputs.push({ height, entityInputCount: runtimeInput.entityInputs.length });
    });

    await process(env);

    expect(env.height).toBe(1);
    expect(committedInputs).toEqual([{ height: 1, entityInputCount: 12 }]);
    expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
    expect(env.runtimeState?.maxEntityInputsPerFrame).toBeUndefined();
  });

  test('runtime tx frame cap never splits one accepted entity input', async () => {
    const env = createIsolatedEnv('runtime-entity-tx-frame-cap');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    env.runtimeState = {
      loopActive: false,
      halted: false,
      maxEntityTxsPerFrame: 2,
    };

    const signerLabel = '1';
    const signerAddress = deriveSignerAddressSync(env.runtimeSeed!, signerLabel).toLowerCase();
    registerSignerKey(env, signerAddress, deriveSignerKeySync(env.runtimeSeed!, signerLabel));
    const signerId = signerAddress;
    const entityId = generateLazyEntityId([signerAddress], 1n);
    env.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId));
    const txs = Array.from({ length: 5 }, (_, index) => ({
      type: 'profile-update' as const,
      data: {
        profile: {
          entityId,
          name: `tx-${index + 1}`,
        },
      },
    }));

    const acceptedInput = {
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId, entityTxs: txs }],
    };
    const receipts = createRuntimeIngressReceiptStore({ now: () => 1_000 });
    receipts.register({
      id: 'capped-runtime-input',
      kind: 'test',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: env.height,
      runtimeInput: acceptedInput,
    });
    registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
      receipts.observeRuntimeInput(height, runtimeInput);
    });
    enqueueRuntimeInput(env, acceptedInput);

    await process(env);
    const deferredProfileUpdates = (env.runtimeMempool?.entityInputs ?? [])
      .flatMap(input => input.entityTxs ?? [])
      .filter(tx => tx.type === 'profile-update');
    expect(deferredProfileUpdates).toHaveLength(0);
    expect(receipts.get('capped-runtime-input')).toMatchObject({
      status: 'observed',
      observedHeight: 1,
      observedFingerprintCount: 5,
      requiredFingerprintCount: 5,
    });
    expect(receipts.get('capped-runtime-input')?.observedHeight).toBe(1);
  });

  test('runtime frame cap preserves watcher j_event priority across queued entity inputs', async () => {
    const env = createIsolatedEnv('runtime-entity-input-frame-cap-j-event');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    env.runtimeState = {
      loopActive: false,
      halted: false,
      maxEntityInputsPerFrame: 1,
    };

    const normalSignerLabel = '1';
    const jEventSignerLabel = '2';
    const normalSignerId = deriveSignerAddressSync(env.runtimeSeed!, normalSignerLabel).toLowerCase();
    const jEventSignerId = deriveSignerAddressSync(env.runtimeSeed!, jEventSignerLabel).toLowerCase();
    registerSignerKey(env, normalSignerId, deriveSignerKeySync(env.runtimeSeed!, normalSignerLabel));
    registerSignerKey(env, jEventSignerId, deriveSignerKeySync(env.runtimeSeed!, jEventSignerLabel));
    const normalEntityId = generateLazyEntityId([normalSignerId], 1n);
    const jEventEntityId = generateLazyEntityId([jEventSignerId], 1n);
    env.eReplicas.set(`${normalEntityId}:${normalSignerId}`, makeReplica(normalEntityId, 1_000, normalSignerId));
    env.eReplicas.set(`${jEventEntityId}:${jEventSignerId}`, makeReplica(jEventEntityId, 1_000, jEventSignerId));
    const jEvent: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: jEventEntityId, tokenId: 1, newBalance: '100' },
    };
    const blockNumber = 1;
    const blockHash = `0x${'ab'.repeat(32)}`;
    const transactionHash = `0x${'cd'.repeat(32)}`;
    const jEventReplica = env.eReplicas.get(`${jEventEntityId}:${jEventSignerId}`)!;
    const jEventRange = buildJEventRangeData(jEventReplica.state, {
      from: jEventSignerId,
      event: jEvent,
      observedAt: blockNumber,
      blockNumber,
      blockHash,
      transactionHash,
    }, env);
    const rangeBlock = jEventRange.blocks[0]!;
    jEventReplica.jHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef: jEventRange.jurisdictionRef,
      scannedThroughHeight: jEventRange.scannedThroughHeight,
      tipBlockHash: jEventRange.tipBlockHash,
      blocks: [{
        jurisdictionRef: jEventRange.jurisdictionRef,
        jHeight: rangeBlock.blockNumber,
        jBlockHash: rangeBlock.blockHash,
        eventsHash: rangeBlock.eventsHash,
        events: rangeBlock.events,
      }],
    });

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId: normalEntityId,
          signerId: normalSignerId,
          entityTxs: [{
            type: 'profile-update',
            data: {
              profile: {
                entityId: normalEntityId,
                name: 'Normal Input',
              },
            },
          }],
        },
        {
          entityId: jEventEntityId,
          signerId: jEventSignerId,
          entityTxs: [{
            type: 'j_event',
            data: jEventRange,
          }],
        },
      ],
    });

    await process(env);
    const deferredUserInputs = (env.runtimeMempool?.entityInputs ?? []).filter(input =>
      input.entityTxs?.some(tx => tx.type !== 'certifyProfile'));
    expect(deferredUserInputs.map(input => input.entityId)).toEqual([normalEntityId]);
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);
  });

  test('new ingress timestamp is clamped in live mode and still fires due hooks', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = getWallClockMs();
    addTestJurisdiction(env);
    const committedScheduledWakePresence: boolean[] = [];
    registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
      committedScheduledWakePresence.push(runtimeInput.entityInputs.some(input =>
        input.entityTxs?.some(tx => tx.type === 'scheduledWake')));
    });

    const { entityId: existingEntityId, signerId, replica } = addSignableReplica(env, env.timestamp);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:due-after-ingress',
      triggerAt: env.timestamp + 1_000,
      type: 'watchdog',
      data: {},
    });

    const importedSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'imported').toLowerCase();
    const importedEntityId = generateLazyEntityId([importedSignerId], 1n).toLowerCase();
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
          signerId: importedSignerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [importedSignerId],
              shares: { [importedSignerId]: 1n },
              jurisdiction: testJurisdiction(),
            },
            isProposer: true,
            profileName: 'Imported',
          },
        },
      ],
      entityInputs: [],
    });

    await process(env);

    expect(env.timestamp).toBeLessThan(futureIngressTimestamp);
    expect(env.timestamp).toBeGreaterThan(replica.state.timestamp);
    expect(env.timestamp).toBeLessThanOrEqual(getWallClockMs() + TIMING.TIMESTAMP_DRIFT_MS);
    const updatedReplica = env.eReplicas.get(`${existingEntityId}:${signerId}`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-ingress')).toBe(false);
    expect(committedScheduledWakePresence.at(-1)).toBe(true);
  });

  test('direct live process inputs stamp R-frame from block creation time', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const { entityId, signerId } = addSignableReplica(env, 1_000);

    const before = getWallClockMs();
    await process(env, [{ entityId, signerId, entityTxs: [] }]);

    expect(env.timestamp).toBeGreaterThanOrEqual(before);
    expect(env.timestamp).toBeLessThanOrEqual(Date.now() + TIMING.TIMESTAMP_DRIFT_MS);
  });

  test('explicit live ingress timestamp controls delayed R-frame timestamp', async () => {
    const env = createIsolatedEnv('runtime-explicit-ingress-timestamp');
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const signerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, '1'));
    const entityId = generateLazyEntityId([signerId], 1n);
    const replica = makeReplica(entityId, 1_000, signerId);
    env.eReplicas.set(`${entityId}:${signerId}`, replica);
    let committedInput: Env['runtimeInput'] | null = null;
    registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
      committedInput = structuredClone(runtimeInput);
    });

    enqueueRuntimeInput(env, {
      timestamp: 20_000,
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'profile-update',
          data: {
            profile: {
              entityId,
              name: 'Explicit Timestamp',
            },
          },
        }],
      }],
    });
    await sleep(20);
    await process(env);

    expect(env.timestamp).toBe(20_000);
    const updatedReplica = env.eReplicas.get(`${entityId}:${signerId}`);
    expect(updatedReplica?.state.timestamp).toBe(20_000);
    expect(committedInput?.entityInputs[0]?.entityTxs?.[0]).toMatchObject({
      type: 'profile-update',
      data: { profile: { entityId, name: 'Explicit Timestamp' } },
    });
  });

  test('explicit live ingress timestamp keeps canonical state hash deterministic across wall-clock delay', async () => {
    const seed = uniqueSeed('runtime-explicit-ingress-deterministic-hash');
    const buildEnv = (dbSuffix: string): { env: Env; entityId: string; signerId: string } => {
      const env = createEmptyEnv(seed);
      env.dbNamespace = `${String(env.runtimeId || 'runtime')}-${dbSuffix}`;
      env.quietRuntimeLogs = true;
      env.timestamp = 1_000;
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
      registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, '1'));
      const entityId = generateLazyEntityId([signerId], 1n);
      env.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId));
      return { env, entityId, signerId };
    };
    const submit = async (env: Env, entityId: string, signerId: string): Promise<string> => {
      enqueueRuntimeInput(env, {
        timestamp: 20_000,
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId,
          entityTxs: [{
            type: 'profile-update',
            data: { profile: { entityId, name: 'Deterministic Timestamp' } },
          }],
        }],
      });
      await process(env);
      expect(env.timestamp).toBe(20_000);
      return computeCanonicalStateHashFromEnv(env);
    };

    const first = buildEnv('deterministic-hash-a');
    const firstHash = await submit(first.env, first.entityId, first.signerId);
    await sleep(25);
    const second = buildEnv('deterministic-hash-b');
    const secondHash = await submit(second.env, second.entityId, second.signerId);

    expect(secondHash).toBe(firstHash);
  });

  test('empty entity ingress advances runtime clock and fires due hooks', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const { entityId, signerId, replica } = addSignableReplica(env, 1_000);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:due-after-empty-ingress',
      triggerAt: 10_000,
      type: 'watchdog',
      data: {},
    });
    let committedScheduledWake = false;
    registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
      committedScheduledWake = runtimeInput.entityInputs.some(input =>
        input.entityTxs?.some(tx => tx.type === 'scheduledWake'));
    });

    enqueueRuntimeInput(env, {
      timestamp: 20_000,
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId, entityTxs: [] }],
    });

    await process(env);

    expect(env.timestamp).toBeGreaterThanOrEqual(10_000);
    expect(env.timestamp).toBeLessThanOrEqual(Date.now() + TIMING.TIMESTAMP_DRIFT_MS);
    const updatedReplica = env.eReplicas.get(`${entityId}:${signerId}`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-empty-ingress')).toBe(false);
    expect(committedScheduledWake).toBe(true);
  });

  test('idle runtime loop does not advance logical time from wall clock', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
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
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = Date.now();

    const { entityId, signerId, replica } = addSignableReplica(env, env.timestamp);

    const dueAt = env.timestamp + 30;
    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:idle-loop-due-after-wall-clock',
      triggerAt: dueAt,
      type: 'watchdog',
      data: {},
    });

    const stop = startRuntimeLoop(env, { tickDelayMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      stop();
    }

    expect(env.timestamp).toBeGreaterThanOrEqual(dueAt);
    const updatedReplica = env.eReplicas.get(`${entityId}:${signerId}`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:idle-loop-due-after-wall-clock')).toBe(false);
  });

  test('non-hub pending account frames keep the runtime wakeable for ACK resend', () => {
    const entityId = `0x${'99'.repeat(32)}`;
    const counterpartyId = `0x${'aa'.repeat(32)}`;
    const replica = makeReplica(entityId, Date.now());
    replica.state.profile.isHub = false;
    delete replica.state.hubRebalanceConfig;
    replica.state.accounts.set(counterpartyId, {
      pendingFrame: {
        height: 10,
        timestamp: replica.state.timestamp - 20_000,
        accountTxs: [],
      },
    } as AccountMachine);

    expect(entityNeedsPeriodicWake(replica)).toBe(true);
  });

  test('default runtime cadence commits consecutive queued frames without a delay gate', async () => {
    const env = createIsolatedEnv('runtime-default-zero-delay');
    env.quietRuntimeLogs = true;
    addTestJurisdiction(env);

    const importReplica = async (label: string): Promise<void> => {
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
      const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
      enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: testJurisdiction(),
            },
            isProposer: false,
            profileName: label,
          },
        }],
        entityInputs: [],
      });
      await process(env);
    };

    await importReplica('zero-delay-first');
    const firstHeight = env.height;
    expect(env.runtimeConfig?.minFrameDelayMs).toBe(0);
    await importReplica('zero-delay-second');
    expect(env.height).toBe(firstHeight + 1);
  });

  test('runtime loop waits for minFrameDelayMs between processed cycles', async () => {
    const env = createIsolatedEnv('runtime-frame-delay-seed');
    env.quietRuntimeLogs = true;
    addTestJurisdiction(env);

    const firstSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'delay-first').toLowerCase();
    const delayedSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'delay-second').toLowerCase();
    const firstEntityId = generateLazyEntityId([firstSignerId], 1n).toLowerCase();
    const delayedEntityId = generateLazyEntityId([delayedSignerId], 1n).toLowerCase();

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: firstEntityId,
        signerId: firstSignerId,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [firstSignerId],
            shares: { [firstSignerId]: 1n },
            jurisdiction: testJurisdiction(),
          },
          isProposer: false,
          profileName: 'First Replica',
        },
      }],
      entityInputs: [],
    });

    await process(env);
    env.runtimeConfig = { minFrameDelayMs: 60, loopIntervalMs: 1 };

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: delayedEntityId,
        signerId: delayedSignerId,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [delayedSignerId],
            shares: { [delayedSignerId]: 1n },
            jurisdiction: testJurisdiction(),
          },
          isProposer: false,
          profileName: 'Delayed Replica',
        },
      }],
      entityInputs: [],
    });

    const stop = startRuntimeLoop(env, { tickDelayMs: 1 });
    try {
      await sleep(20);
      expect(env.eReplicas.get(`${delayedEntityId}:${delayedSignerId}`)).toBeUndefined();

      await sleep(100);
      expect(env.eReplicas.get(`${delayedEntityId}:${delayedSignerId}`)).toBeDefined();
    } finally {
      stop();
    }
  });

  test('runtime loop starts jurisdiction watchers exactly once per replica', async () => {
    const env = createIsolatedEnv('runtime-watcher-start-seed');
    env.quietRuntimeLogs = true;

    let startCount = 0;
    let started = false;
    const fakeJAdapter = {
      startWatching(_env: unknown) {
        if (started) return;
        started = true;
        startCount += 1;
      },
      isWatching() {
        return started;
      },
      setBlockTimestamp(_timestamp: number) {
        return undefined;
      },
    };

    addTestJurisdiction(env, 'Testnet', fakeJAdapter);

    const stop = startRuntimeLoop(env, { tickDelayMs: 1 });
    try {
      await sleep(10);
      expect(startCount).toBe(1);
    } finally {
      stop();
    }
  });

  test('runtime loop starts watcher for jReplica added after loop start', async () => {
    const env = createIsolatedEnv('runtime-late-watcher-start-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = Date.now();

    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'late-watcher-remote').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const replica = makeReplica(entityId, env.timestamp, signerId);
    env.eReplicas.set(`${entityId}:${signerId}`, replica);

    let startCount = 0;
    let started = false;
    const fakeJAdapter = {
      startWatching(_env: unknown) {
        if (started) return;
        started = true;
        startCount += 1;
      },
      isWatching() {
        return started;
      },
      setBlockTimestamp(_timestamp: number) {
        return undefined;
      },
    };

    const stop = startRuntimeLoop(env, { tickDelayMs: 1 });
    try {
      await sleep(10);
      expect(startCount).toBe(0);

      addTestJurisdiction(env, 'Testnet', fakeJAdapter);

      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{ entityId, signerId: replica.signerId, entityTxs: [] }],
      });

      await sleep(20);
      expect(startCount).toBe(1);
    } finally {
      stop();
    }
  });

  test('runtime loop starts exactly one watcher per rpc/depository per runtime', async () => {
    const env = createIsolatedEnv('runtime-watcher-dedup-seed');
    env.quietRuntimeLogs = true;
    env.activeJurisdiction = 'J1';

    let startCountA = 0;
    let startedA = false;
    const adapterA = {
      startWatching(_env: unknown) {
        startedA = true;
        startCountA += 1;
      },
      isWatching() {
        return startedA;
      },
      stopWatching() {
        startedA = false;
      },
      setBlockTimestamp(_timestamp: number) {
        return undefined;
      },
      mode: 'rpc',
      chainId: 31337,
      provider: {
        _getConnection() {
          return { url: 'http://localhost:8545' };
        },
      },
    };
    let startCountB = 0;
    let startedB = false;
    const adapterB = {
      startWatching(_env: unknown) {
        startedB = true;
        startCountB += 1;
      },
      isWatching() {
        return startedB;
      },
      stopWatching() {
        startedB = false;
      },
      setBlockTimestamp(_timestamp: number) {
        return undefined;
      },
      mode: 'rpc',
      chainId: 31337,
      provider: {
        _getConnection() {
          return { url: 'http://localhost:8545' };
        },
      },
    };

    addTestJurisdiction(env, 'J1', adapterA);
    addTestJurisdiction(env, 'J2', adapterB);

    const stop = startRuntimeLoop(env, { tickDelayMs: 1 });
    try {
      await sleep(10);
      expect(startCountA + startCountB).toBe(1);
    } finally {
      stop();
    }
  });

  test('watcher-fed receipts wake idle runtime but remain local observations before J-prefix quorum', async () => {
    const seed = uniqueSeed('runtime-watcher-wake-seed');
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const replica = makeReplica(entityId, 1_000, signerId);
    replica.isProposer = true;
    env.eReplicas.set(`${entityId}:${signerId}`, replica);

    const stop = startRuntimeLoop(env, { tickDelayMs: 1 });
    try {
      processEventBatch(
        [{
          name: 'ReserveUpdated',
          args: {
            entity: entityId,
            tokenId: 2,
            newBalance: 500n,
          },
          blockNumber: 12,
          blockHash: `0x${'bb'.repeat(32)}`,
          transactionHash: `0x${'cc'.repeat(32)}`,
          logIndex: 0,
        }],
        env,
        12,
        `0x${'bb'.repeat(32)}`,
        { value: 0 },
        'test',
      );

      for (let i = 0; i < 40; i += 1) {
        const observed = env.eReplicas.get(`${entityId}:${signerId}`)?.jHistory?.eventBlocks.get(12);
        if (observed?.events.some(event => event.type === 'ReserveUpdated')) break;
        await sleep(10);
      }

      const observedReplica = env.eReplicas.get(`${entityId}:${signerId}`);
      expect(observedReplica?.jHistory?.eventBlocks.get(12)?.events.some(
        event => event.type === 'ReserveUpdated',
      )).toBe(true);
      expect(observedReplica?.state.reserves.get(2)).toBeUndefined();
    } finally {
      stop();
    }
  });

});
