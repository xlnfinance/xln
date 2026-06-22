import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { TIMING } from '../constants';
import { initCrontab, scheduleHook } from '../entity-crontab';
import { generateLazyEntityId } from '../entity-factory';
import { processEventBatch } from '../jadapter/watcher';
import { createEmptyEnv, enqueueRuntimeInput, entityNeedsPeriodicWake, process, startRuntimeLoop } from '../runtime';
import type { AccountMachine, EntityReplica, Env, JurisdictionConfig } from '../types';

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
      lockBook: new Map(),
      swapTradingPairs: [],
      pendingSwapFillRatios: new Map(),
      crontabState: initCrontab(),
    },
  }) as EntityReplica;

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

    const entityIds = [`0x${'21'.repeat(32)}`, `0x${'22'.repeat(32)}`, `0x${'23'.repeat(32)}`];
    for (const entityId of entityIds) {
      env.eReplicas.set(`${entityId}:1`, makeReplica(entityId, 1_000));
    }

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: entityIds.map(entityId => ({ entityId, signerId: '1', entityTxs: [] })),
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

  test('runtime tx frame cap splits oversized entity input FIFO without dropping queuedAt', async () => {
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
    registerSignerKey(signerAddress, deriveSignerKeySync(env.runtimeSeed!, signerLabel));
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

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId, entityTxs: txs }],
    });

    await process(env);
    expect(env.runtimeMempool?.entityInputs).toHaveLength(1);
    expect(env.runtimeMempool?.entityInputs[0]?.entityTxs?.map(tx => tx.data.profile.name)).toEqual(['tx-3', 'tx-4', 'tx-5']);
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);

    await process(env);
    expect(env.runtimeMempool?.entityInputs[0]?.entityTxs?.map(tx => tx.data.profile.name)).toEqual(['tx-5']);
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);

    await process(env);
    expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
    expect(env.runtimeMempool?.queuedAt).toBeUndefined();
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

    const normalSignerId = '1';
    const jEventSignerId = '2';
    const normalSignerAddress = deriveSignerAddressSync(env.runtimeSeed!, normalSignerId).toLowerCase();
    const jEventSignerAddress = deriveSignerAddressSync(env.runtimeSeed!, jEventSignerId).toLowerCase();
    const normalEntityId = generateLazyEntityId([normalSignerAddress], 1n);
    const jEventEntityId = generateLazyEntityId([jEventSignerAddress], 1n);
    env.eReplicas.set(`${normalEntityId}:${normalSignerId}`, makeReplica(normalEntityId, 1_000, normalSignerId));
    env.eReplicas.set(`${jEventEntityId}:${jEventSignerId}`, makeReplica(jEventEntityId, 1_000, jEventSignerId));

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
            data: {
              from: jEventSignerId,
              observedAt: 1_000,
              blockNumber: 1,
              blockHash: `0x${'ab'.repeat(32)}`,
              transactionHash: `0x${'cd'.repeat(32)}`,
            },
          }],
        },
      ],
    });

    await process(env);
    expect(env.runtimeMempool?.entityInputs.map(input => input.entityId)).toEqual([normalEntityId]);
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);
  });

  test('new ingress timestamp is clamped in live mode and still fires due hooks', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    addTestJurisdiction(env);

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
    expect(env.timestamp).toBeGreaterThan(10_000);
    expect(env.timestamp).toBeLessThanOrEqual(Date.now() + TIMING.TIMESTAMP_DRIFT_MS);
    const updatedReplica = env.eReplicas.get(`${existingEntityId}:1`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-ingress')).toBe(false);
  });

  test('direct live process inputs stamp R-frame from block creation time', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const entityId = `0x${'44'.repeat(32)}`;
    const replica = makeReplica(entityId, 1_000);
    env.eReplicas.set(`${entityId}:1`, replica);

    const before = Date.now();
    await process(env, [{ entityId, signerId: '1', entityTxs: [] }]);

    expect(env.timestamp).toBeGreaterThanOrEqual(before);
    expect(env.timestamp).toBeLessThanOrEqual(Date.now() + TIMING.TIMESTAMP_DRIFT_MS);
  });

  test('empty entity ingress advances runtime clock and fires due hooks', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
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

    expect(env.timestamp).toBeGreaterThanOrEqual(10_000);
    expect(env.timestamp).toBeLessThanOrEqual(Date.now() + TIMING.TIMESTAMP_DRIFT_MS);
    const updatedReplica = env.eReplicas.get(`${entityId}:1`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-empty-ingress')).toBe(false);
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
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
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

  test('runtime loop waits for minFrameDelayMs between processed cycles', async () => {
    const env = createIsolatedEnv('runtime-frame-delay-seed');
    env.quietRuntimeLogs = true;
    addTestJurisdiction(env);

    const signerId = `0x${'ab'.repeat(20)}`;
    const firstEntityId = `0x${'91'.repeat(32)}`;
    const delayedEntityId = `0x${'92'.repeat(32)}`;

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: firstEntityId,
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
          profileName: 'Delayed Replica',
        },
      }],
      entityInputs: [],
    });

    const stop = startRuntimeLoop(env, { tickDelayMs: 1 });
    try {
      await sleep(20);
      expect(env.eReplicas.get(`${delayedEntityId}:${signerId}`)).toBeUndefined();

      await sleep(100);
      expect(env.eReplicas.get(`${delayedEntityId}:${signerId}`)).toBeDefined();
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

    const entityId = `0x${'66'.repeat(32)}`;
    const replica = makeReplica(entityId, env.timestamp);
    env.eReplicas.set(`${entityId}:1`, replica);

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

  test('watcher-fed j events wake idle runtime and apply reserve updates without manual polling', async () => {
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
        if (env.eReplicas.get(`${entityId}:${signerId}`)?.state.reserves.get(2) === 500n) break;
        await sleep(10);
      }

      expect(env.eReplicas.get(`${entityId}:${signerId}`)?.state.reserves.get(2)).toBe(500n);
    } finally {
      stop();
    }
  });

});
