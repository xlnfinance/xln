import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { TIMING } from '../../../config/constants';
import { initCrontab, scheduleHook } from '../../../entity/scheduler';
import { generateLazyEntityId } from '../../../entity/factory';
import {
  createTestEntityImportRuntimeTx,
  provisionTestEntityEncryptionKey,
} from '../../../qa/entity-creation-fixture';
import { processEventBatch } from '../../../jurisdiction/adapter/watcher';
import { createRuntimeIngressReceiptStore } from '../../../runtime/mempool/ingress-receipts';
import { buildJEventRangeData } from '../../helpers/j-history';
import { recordValidatorJHistory } from '../../../jurisdiction/machine/local-history';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  entityNeedsPeriodicWake,
  hasRuntimeWork,
  processRuntime,
  registerRuntimeFrameCommitCallback,
  startRuntimeLoop,
} from '../../../runtime';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import type { AccountState } from '../../../types/account';
import type { EntityReplica, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { getWallClockMs } from '../../../support/time';
import { attachLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import { rebuildScheduledWakeIndex } from '../../../runtime/mempool/scheduled-wake';
import type { JAdapter } from '../../../jurisdiction/adapter/types';
import { applyEntityInputFrameCap, applyEntityTxFrameCap } from '../../../runtime/loop/loop-work.ts';

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

const createIsolatedEnv = (label: string): RuntimeReplica => createEmptyEnv(uniqueSeed(label));

const testJurisdiction = (name = TEST_JURISDICTION.name): JurisdictionConfig => ({
  ...TEST_JURISDICTION,
  name,
});

const addTestJurisdiction = (env: RuntimeReplica, name = TEST_JURISDICTION.name, jadapter?: unknown): void => {
  env.activeJurisdiction = env.activeJurisdiction || name;
  env.state.jReplicas.set(name, {
    name,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: env.state.timestamp,
    position: { x: 0, y: 0, z: 0 },
    contracts: {
      account: `0x${'33'.repeat(20)}`,
      depository: TEST_JURISDICTION.depositoryAddress,
      entityProvider: TEST_JURISDICTION.entityProviderAddress,
      deltaTransformer: `0x${'44'.repeat(20)}`,
    },
    rpcs: ['http://localhost:8545'],
    chainId: TEST_JURISDICTION.chainId,
  });
  if (jadapter) attachLiveJAdapter(env, name, jadapter as JAdapter);
};

const makeReplica = (
  entityId: string,
  timestamp: number,
  signerId = '1',
  env?: RuntimeReplica,
): EntityReplica => {
  const keys = env
    ? provisionTestEntityEncryptionKey(env, entityId)
    : { publicKey: '', privateKey: '' };
  return {
    entityId,
    signerId,
    entityEncPubKey: keys.publicKey,
    mempool: [],
    isProposer: true,
    state: {
      entityId,
      height: 0,
      timestamp,
      nonces: new Map(),
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
      profile: {
        name: 'Replica',
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      ...(keys.publicKey ? { entityEncryptionPublicKey: keys.publicKey } : {}),
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      lockBook: new Map(),
      swapTradingPairs: [],
      crontabState: initCrontab(),
    },
  } as EntityReplica;
};

const addSignableReplica = (
  env: RuntimeReplica,
  timestamp: number,
  signerLabel = '1',
): { entityId: string; signerId: string; replica: EntityReplica } => {
  const signerId = deriveSignerAddressSync(env.runtimeSeed!, signerLabel).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, signerLabel));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const replica = makeReplica(entityId, timestamp, signerId, env);
  env.state.eReplicas.set(`${entityId}:${signerId}`, replica);
  return { entityId, signerId, replica };
};

describe('runtime ingress timestamp', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('runtime loop does not restart once runtime state is sticky-halted', async () => {
    const env = createIsolatedEnv('sticky-halt');
    env.infrastructure = { halted: true, loopActive: false };
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

    expect(env.infrastructure?.loopActive).toBe(false);
    expect(startCalls).toBe(0);
  });

  test('direct process entry rejects a sticky-halted runtime before applying work', async () => {
    const env = createIsolatedEnv('direct-process-halt');
    env.infrastructure = { lifecyclePhase: 'halted', halted: true };
    const heightBefore = env.state.height;

    await expect(processRuntime(env)).rejects.toThrow('RUNTIME_PROCESS_HALTED');
    expect(env.state.height).toBe(heightBefore);
  });

  test('restored runtime does not fire future hooks without new ingress timestamp', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.state.timestamp = Date.now();

    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'restored-remote').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const replica = makeReplica(entityId, env.state.timestamp, signerId);
    env.state.eReplicas.set(`${entityId}:${signerId}`, replica);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:futuristic',
      triggerAt: env.state.timestamp + 60_000,
      type: 'watchdog',
      data: {},
    });

    await processRuntime(env);

    expect(env.state.timestamp).toBe(replica.state.timestamp);
    expect(replica.state.crontabState?.hooks?.has('watchdog:futuristic')).toBe(true);
  });

  test('runtime frame cap leaves excess entity inputs queued for later frames', async () => {
    const env = createIsolatedEnv('runtime-entity-input-frame-cap');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.state.timestamp = 1_000;
    env.infrastructure = {
      loopActive: false,
      halted: false,
      maxEntityInputsPerFrame: 1,
    };

    const replicas = ['cap-1', 'cap-2', 'cap-3'].map((label) => {
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
      const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
      env.state.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId, env));
      return { entityId, signerId };
    });
    const entityIds = replicas.map(({ entityId }) => entityId);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: replicas.map(({ entityId, signerId }) => ({ entityId, signerId, entityTxs: [] })),
    });

    await processRuntime(env);
    expect(env.runtimeMempool?.entityInputs.map(input => input.entityId)).toEqual(entityIds.slice(1));
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);

    await processRuntime(env);
    expect(env.runtimeMempool?.entityInputs.map(input => input.entityId)).toEqual(entityIds.slice(2));
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);

    await processRuntime(env);
    expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
    expect(env.runtimeMempool?.queuedAt).toBeUndefined();
  });

  test('runtime frame caps keep an atomic cross-j sibling cohort indivisible', () => {
    const marker = { phase: 'proposal' as const, pairKey: 'cross-j-cap-pair' };
    const sourceRuntimeFrame = { height: 7, timestamp: 1_000 };
    const inputs = [
      {
        entityId: 'ordinary', signerId: 'ordinary',
        entityTxs: [{ type: 'profile-update' as const, data: {} }],
      },
      {
        entityId: 'source', signerId: 'source', from: 'hub-runtime', sourceRuntimeFrame,
        atomicCrossJurisdictionPair: marker, entityTxs: [{ type: 'profile-update' as const, data: {} }],
      },
      {
        entityId: 'target', signerId: 'target', from: 'hub-runtime', sourceRuntimeFrame,
        atomicCrossJurisdictionPair: marker, entityTxs: [{ type: 'profile-update' as const, data: {} }],
      },
      { entityId: 'tail', signerId: 'tail', entityTxs: [] },
    ];
    const inputCapped = { runtimeTxs: [], entityInputs: structuredClone(inputs) };
    const inputMempool = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityInputFrameCap(inputCapped, inputMempool, 2, 1_000)).toBe(true);
    expect(inputCapped.entityInputs.map(input => input.entityId)).toEqual(['ordinary']);
    expect(inputMempool.entityInputs.map(input => input.entityId)).toEqual(['source', 'target', 'tail']);

    const txCapped = { runtimeTxs: [], entityInputs: structuredClone(inputs) };
    const txMempool = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityTxFrameCap(txCapped, txMempool, 2, 1_000)).toBe(true);
    expect(txCapped.entityInputs.map(input => input.entityId)).toEqual(['ordinary']);
    expect(txMempool.entityInputs.map(input => input.entityId)).toEqual(['source', 'target', 'tail']);

    const headPair = { runtimeTxs: [], entityInputs: structuredClone(inputs.slice(1)) };
    const headMempool = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityInputFrameCap(headPair, headMempool, 1, 1_000)).toBe(true);
    expect(headPair.entityInputs.map(input => input.entityId)).toEqual(['source', 'target']);
    expect(headMempool.entityInputs.map(input => input.entityId)).toEqual(['tail']);

    const headTxPair = { runtimeTxs: [], entityInputs: structuredClone(inputs.slice(1)) };
    const headTxMempool = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityTxFrameCap(headTxPair, headTxMempool, 1, 1_000)).toBe(true);
    expect(headTxPair.entityInputs.map(input => input.entityId)).toEqual(['source', 'target']);
    expect(headTxMempool.entityInputs.map(input => input.entityId)).toEqual(['tail']);

    const nextFrame = { height: 8, timestamp: 1_001 };
    const repeatedMarkerInputs = [
      ...inputs.slice(1, 3),
      { ...inputs[1]!, entityId: 'source-2', sourceRuntimeFrame: nextFrame },
      { ...inputs[2]!, entityId: 'target-2', sourceRuntimeFrame: nextFrame },
    ];
    const repeated = { runtimeTxs: [], entityInputs: structuredClone(repeatedMarkerInputs) };
    const repeatedMempool = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityInputFrameCap(repeated, repeatedMempool, 2, 1_000)).toBe(true);
    expect(repeated.entityInputs.map(input => input.entityId)).toEqual(['source', 'target']);
    expect(repeatedMempool.entityInputs.map(input => input.entityId)).toEqual(['source-2', 'target-2']);

    const third = { ...inputs[2]!, entityId: 'third' };
    const malformedHead = { runtimeTxs: [], entityInputs: structuredClone([...inputs.slice(1, 3), third, inputs[3]!]) };
    const malformedMempool = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityInputFrameCap(malformedHead, malformedMempool, 1, 1_000)).toBe(true);
    expect(malformedHead.entityInputs.map(input => input.entityId)).toEqual(['source', 'target', 'third']);
    expect(malformedMempool.entityInputs.map(input => input.entityId)).toEqual(['tail']);
  });

  test('stale queuedAt without payload cannot spin empty Runtime cycles', () => {
    const env = createIsolatedEnv('runtime-empty-queued-at');
    env.state.timestamp = 1_000;
    env.runtimeMempool = {
      runtimeTxs: [],
      entityInputs: [],
      queuedAt: 9_000,
    };

    expect(hasRuntimeWork(env)).toBe(false);
  });

  test('runtime drains the whole accepted Entity input bundle in one R-frame by default', async () => {
    const env = createIsolatedEnv('runtime-entity-input-no-default-cap');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.state.timestamp = 1_000;

    const replicas = Array.from({ length: 12 }, (_, index) => {
      const label = `uncapped-${index}`;
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
      registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, label));
      const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
      env.state.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId, env));
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

    await processRuntime(env);

    expect(env.state.height).toBe(1);
    expect(committedInputs).toEqual([{ height: 1, entityInputCount: 12 }]);
    expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
    expect(env.infrastructure?.maxEntityInputsPerFrame).toBeUndefined();
  });

  test('runtime tx frame cap never splits one accepted entity input', async () => {
    const env = createIsolatedEnv('runtime-entity-tx-frame-cap');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.state.timestamp = 1_000;
    env.infrastructure = {
      loopActive: false,
      halted: false,
      maxEntityTxsPerFrame: 2,
    };

    const signerLabel = '1';
    const signerAddress = deriveSignerAddressSync(env.runtimeSeed!, signerLabel).toLowerCase();
    registerSignerKey(env, signerAddress, deriveSignerKeySync(env.runtimeSeed!, signerLabel));
    const signerId = signerAddress;
    const entityId = generateLazyEntityId([signerAddress], 1n);
    env.state.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId, env));
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
      enqueuedHeight: env.state.height,
      runtimeInput: acceptedInput,
    });
    registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
      receipts.observeRuntimeInput(height, runtimeInput);
    });
    enqueueRuntimeInput(env, acceptedInput);

    await processRuntime(env);
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
    env.state.timestamp = 1_000;
    env.infrastructure = {
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
    env.state.eReplicas.set(
      `${normalEntityId}:${normalSignerId}`,
      makeReplica(normalEntityId, 1_000, normalSignerId, env),
    );
    env.state.eReplicas.set(
      `${jEventEntityId}:${jEventSignerId}`,
      makeReplica(jEventEntityId, 1_000, jEventSignerId, env),
    );
    const jEvent: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: jEventEntityId, tokenId: 1, newBalance: '100' },
    };
    const blockNumber = 1;
    const blockHash = `0x${'ab'.repeat(32)}`;
    const transactionHash = `0x${'cd'.repeat(32)}`;
    const jEventReplica = env.state.eReplicas.get(`${jEventEntityId}:${jEventSignerId}`)!;
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

    await processRuntime(env);
    const deferredUserInputs = env.runtimeMempool?.entityInputs ?? [];
    expect(deferredUserInputs.map(input => input.entityId)).toEqual([normalEntityId]);
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);
  });

  test('new ingress timestamp is clamped in live mode and still fires due hooks', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    env.state.timestamp = getWallClockMs();
    const initialTimestamp = env.state.timestamp;
    addTestJurisdiction(env);
    const committedScheduledWakePresence: boolean[] = [];
    registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
      committedScheduledWakePresence.push(runtimeInput.entityInputs.some(input =>
        input.entityTxs?.some(tx => tx.type === 'scheduledWake')));
    });

    const { entityId: existingEntityId, signerId, replica } = addSignableReplica(env, env.state.timestamp);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:due-after-ingress',
      triggerAt: env.state.timestamp + 1_000,
      type: 'watchdog',
      data: {},
    });

    const importedSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'imported').toLowerCase();
    const importedEntityId = generateLazyEntityId([importedSignerId], 1n).toLowerCase();
    env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
    await processRuntime(env, undefined);
    expect(replica.state.crontabState?.hooks?.has('watchdog:due-after-ingress')).toBe(true);

    const futureIngressTimestamp = Date.now() + 365 * 24 * 60 * 60 * 1000;
    enqueueRuntimeInput(env, {
      timestamp: futureIngressTimestamp,
      runtimeTxs: [
        createTestEntityImportRuntimeTx(env, {
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
        }),
      ],
      entityInputs: [],
    });

    await processRuntime(env);

    expect(env.state.timestamp).toBeLessThan(futureIngressTimestamp);
    expect(env.state.timestamp).toBeGreaterThan(initialTimestamp);
    expect(env.state.timestamp).toBeLessThanOrEqual(getWallClockMs() + TIMING.TIMESTAMP_DRIFT_MS);
    const updatedReplica = env.state.eReplicas.get(`${existingEntityId}:${signerId}`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-ingress')).toBe(false);
    expect(committedScheduledWakePresence.at(-1)).toBe(true);
  });

  test('direct live process inputs stamp R-frame from block creation time', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;

    const { entityId, signerId } = addSignableReplica(env, 1_000);

    const before = getWallClockMs();
    await processRuntime(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'profile-update',
        data: { profile: { entityId, name: 'Live timestamp input' } },
      }],
    }]);

    expect(env.state.timestamp).toBeGreaterThanOrEqual(before);
    expect(env.state.timestamp).toBeLessThanOrEqual(Date.now() + TIMING.TIMESTAMP_DRIFT_MS);
  });

  test('explicit live ingress timestamp controls delayed R-frame timestamp', async () => {
    const env = createIsolatedEnv('runtime-explicit-ingress-timestamp');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;

    const signerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, '1'));
    const entityId = generateLazyEntityId([signerId], 1n);
    const replica = makeReplica(entityId, 1_000, signerId, env);
    env.state.eReplicas.set(`${entityId}:${signerId}`, replica);
    let committedInput: RuntimeReplica['runtimeInput'] | null = null;
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
    await processRuntime(env);

    expect(env.state.timestamp).toBe(20_000);
    const updatedReplica = env.state.eReplicas.get(`${entityId}:${signerId}`);
    expect(updatedReplica?.state.timestamp).toBe(20_000);
    expect(committedInput?.entityInputs[0]?.entityTxs?.[0]).toMatchObject({
      type: 'profile-update',
      data: { profile: { entityId, name: 'Explicit Timestamp' } },
    });
  });

  test('explicit live ingress timestamp keeps canonical state hash deterministic across wall-clock delay', async () => {
    const seed = uniqueSeed('runtime-explicit-ingress-deterministic-hash');
    const buildEnv = (dbSuffix: string): { env: RuntimeReplica; entityId: string; signerId: string } => {
      const env = createEmptyEnv(seed);
      env.scenarioMode = false;
      env.dbNamespace = `${String(env.runtimeId || 'runtime')}-${dbSuffix}`;
      env.quietRuntimeLogs = true;
      env.state.timestamp = 1_000;
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
      registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, '1'));
      const entityId = generateLazyEntityId([signerId], 1n);
      env.state.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, 1_000, signerId, env));
      return { env, entityId, signerId };
    };
    const submit = async (env: RuntimeReplica, entityId: string, signerId: string): Promise<string> => {
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
      await processRuntime(env);
      expect(env.state.timestamp).toBe(20_000);
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
    env.state.timestamp = 1_000;

    const { entityId, signerId, replica } = addSignableReplica(env, 1_000);

    scheduleHook(replica.state.crontabState!, {
      id: 'watchdog:due-after-empty-ingress',
      triggerAt: 10_000,
      type: 'watchdog',
      data: {},
    });
    // Production rebuilds this ephemeral index after every committed frame.
    // This fixture mutates committed state directly, so mirror that boundary.
    rebuildScheduledWakeIndex(env);
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

    // A scheduled wake follows the normal Entity proposal/certification path;
    // drain its three bounded single-signer Runtime phases, not just ingress.
    for (let phase = 0; phase < 3 && !committedScheduledWake; phase += 1) {
      await processRuntime(env);
    }

    expect(env.state.timestamp).toBeGreaterThanOrEqual(10_000);
    expect(env.state.timestamp).toBeLessThanOrEqual(Date.now() + TIMING.TIMESTAMP_DRIFT_MS);
    const updatedReplica = env.state.eReplicas.get(`${entityId}:${signerId}`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:due-after-empty-ingress')).toBe(false);
    expect(committedScheduledWake).toBe(true);
  });

  test('idle runtime loop does not advance logical time from wall clock', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.state.timestamp = Date.now();

    const entityId = `0x${'77'.repeat(32)}`;
    const replica = makeReplica(entityId, env.state.timestamp);
    env.state.eReplicas.set(`${entityId}:1`, replica);

    const futureTriggerAt = env.state.timestamp + 60_000;
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

    expect(env.state.timestamp).toBeLessThan(futureTriggerAt);
    const updatedReplica = env.state.eReplicas.get(`${entityId}:1`);
    expect(updatedReplica?.state.crontabState?.hooks?.has('watchdog:idle-loop-must-not-fire')).toBe(true);
  });

  test('idle runtime loop advances to due hook timestamp once wall clock reaches it', async () => {
    const env = createIsolatedEnv('runtime-ingress-timestamp-seed');
    env.quietRuntimeLogs = true;
    env.state.timestamp = Date.now();

    const { entityId, signerId, replica } = addSignableReplica(env, env.state.timestamp);

    const dueAt = env.state.timestamp + 30;
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

    expect(env.state.timestamp).toBeGreaterThanOrEqual(dueAt);
    const updatedReplica = env.state.eReplicas.get(`${entityId}:${signerId}`);
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
    } as AccountState);

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
        runtimeTxs: [createTestEntityImportRuntimeTx(env, {
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
            isProposer: true,
            profileName: label,
          },
        })],
        entityInputs: [],
      });
      await processRuntime(env);
    };

    await importReplica('zero-delay-first');
    const firstHeight = env.state.height;
    expect(env.runtimeConfig?.minFrameDelayMs).toBe(0);
    await importReplica('zero-delay-second');
    expect(env.state.height).toBe(firstHeight + 1);
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
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
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
          isProposer: true,
          profileName: 'First Replica',
        },
      })],
      entityInputs: [],
    });

    await processRuntime(env);
    env.runtimeConfig = { minFrameDelayMs: 60, loopIntervalMs: 1 };

    enqueueRuntimeInput(env, {
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
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
          isProposer: true,
          profileName: 'Delayed Replica',
        },
      })],
      entityInputs: [],
    });

    const stop = startRuntimeLoop(env, { tickDelayMs: 1 });
    try {
      await sleep(20);
      expect(env.state.eReplicas.get(`${delayedEntityId}:${delayedSignerId}`)).toBeUndefined();

      await sleep(100);
      expect(env.state.eReplicas.get(`${delayedEntityId}:${delayedSignerId}`)).toBeDefined();
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
    env.state.timestamp = Date.now();

    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'late-watcher-remote').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const replica = makeReplica(entityId, env.state.timestamp, signerId);
    env.state.eReplicas.set(`${entityId}:${signerId}`, replica);

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
    env.state.timestamp = 1_000;

    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const replica = makeReplica(entityId, 1_000, signerId, env);
    replica.isProposer = true;
    env.state.eReplicas.set(`${entityId}:${signerId}`, replica);

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
        const observed = env.state.eReplicas.get(`${entityId}:${signerId}`)?.jHistory?.eventBlocks.get(12);
        if (observed?.events.some(event => event.type === 'ReserveUpdated')) break;
        await sleep(10);
      }

      const observedReplica = env.state.eReplicas.get(`${entityId}:${signerId}`);
      expect(observedReplica?.jHistory?.eventBlocks.get(12)?.events.some(
        event => event.type === 'ReserveUpdated',
      )).toBe(true);
      expect(observedReplica?.state.reserves.get(2)).toBeUndefined();
    } finally {
      stop();
    }
  });

});
