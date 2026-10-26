import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { deriveDelta } from '../../../account/utils';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import {
  closeInfraDb, closeRuntimeDb, createEmptyEnv, enqueueRuntimeInput, getRuntimeWalDb, loadEnvFromDB, processRuntime,
  handleInboundP2PEntityInput, hasRuntimeWork, registerRuntimePublishedCallback,
  resumeRuntimeAfterPersistenceQuiesce, setRuntimeDeliveryReady, startRuntimeLoop, stopRuntimeLoopAndWait,
  validateRuntimeInputAdmission,
} from '../../../runtime';
import { BROWSER_RUNTIME_STORAGE_CONFIG, readRuntimeMetadata } from '../../../runtime/loop/loop-environment';
import { generateHookPings } from '../../../runtime/loop/loop-work';
import { rebuildScheduledWakeIndex } from '../../../runtime/mempool/scheduled-wake';
import { initCrontab, scheduleHook } from '../../../entity/scheduler';
import { LIMITS } from '../../../config/constants';
import { isRuntimeMempoolCapacityError } from '../../../runtime/mempool/input-queue';
import type { RuntimeReplica } from '../../../runtime/types';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { readStorageFrameRecord } from '../../../storage';
import { encodeBuffer } from '../../../storage/codec/codec';
import { keyFrame } from '../../../storage/keys';
import { resolveDbPath } from '../../../storage/runtime-db-path';
import { createTestJReplica } from '../../helpers/j-replica';
import { checkpointNodeRuntime } from '../../../orchestrator/process/node-runtime-quiesce';

// A browser wallet reopens its Runtime on every unlock and reload. Recovery
// replays each frame after the last materialized graph through full Entity and
// Account consensus, so unlock cost grew with the frames since that graph (up
// to 99 at the hub cadence). The browser cadence must leave nothing to replay
// after a quiescent commit, with the same verified state, including after a
// crash that lost the current-graph cache written after the authoritative
// WAL+graph batch, and with an Account frame still awaiting its peer.
const PAYMENTS = 4;

type Ending = 'clean' | 'current-cache-lost' | 'pending-account-frame' | 'tampered-tip-frame';
type Owner = { signerId: string; entityId: string };
type Inspect = (restored: RuntimeReplica, user: Owner, hub: Owner) => Promise<void>;

type ReplayMeta = { checkpointHeight: number; latestHeight: number; replayedFrameCount: number };

const restoreAfterPayments = async (storage: Record<string, number>, ending: Ending = 'clean', inspect?: Inspect) => {
  const seed = `browser-restore-cadence-${process.pid}-${Date.now()}-${storage['materializePeriodFrames']}`;
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, ...storage } };
  const [user, hub] = [1, 2].map(index => {
    const signerId = deriveSignerAddressSync(seed, String(index)).toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(seed, String(index)));
    return { signerId, entityId: generateLazyEntityId([signerId], 1n).toLowerCase() };
  });
  if (!user || !hub) throw new Error('RESTORE_CADENCE_OWNERS_MISSING');
  const jurisdiction = {
    name: 'browser-restore-cadence', address: 'browservm://browser-restore-cadence', chainId: 31337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name, chainId: jurisdiction.chainId,
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress,
      account: '0x000000000000000000000000000000000000ac01',
      deltaTransformer: '0x000000000000000000000000000000000000de17' },
  }));
  const balance = (runtime: RuntimeReplica): bigint => {
    const owner = [...runtime.state.eReplicas.values()].find(replica => replica.entityId === user.entityId);
    const state = owner?.state.accounts.get(hub.entityId)?.state;
    const delta = state?.deltas.get(1);
    if (!state || !delta) throw new Error('RESTORE_CADENCE_ACCOUNT_MISSING');
    const derived = deriveDelta(delta, state.leftEntity.toLowerCase() === user.entityId);
    return derived.outCollateral + derived.outPeerCredit;
  };
  const drain = async () => {
    for (let step = 0; step < 12; step += 1) await processRuntime(env, []);
  };
  enqueueRuntimeInput(env, {
    runtimeTxs: [user, hub].map(({ entityId, signerId }) => createTestEntityImportRuntimeTx(env, {
      entityId, signerId, data: { isProposer: true, config: {
        mode: 'proposer-based', threshold: 1n, validators: [signerId], shares: { [signerId]: 1n }, jurisdiction,
      } },
    })), entityInputs: [],
  });
  await processRuntime(env, []);
  enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{ ...user, entityTxs: [{
    type: 'openAccount', data: { targetEntityId: hub.entityId, creditAmount: 1000n, tokenId: 1,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 } },
  }] }] });
  await drain();
  const pay = (index: number) => processRuntime(env, [{ ...hub, entityTxs: [{ type: 'directPayment', data: {
    targetEntityId: user.entityId, tokenId: 1, amount: 10n, route: [hub.entityId, user.entityId],
    deliveryMode: 'direct', description: `restore cadence ${index}`,
  } }] }]);
  for (let index = 0; index < PAYMENTS; index += 1) {
    await pay(index);
    await drain();
  }
  expect(balance(env)).toBe(BigInt(PAYMENTS) * 10n);
  // One more payment whose bilateral frame is proposed but not yet answered.
  if (ending === 'pending-account-frame') await pay(PAYMENTS);
  const pendingFrames = (runtime: RuntimeReplica): number => [...runtime.state.eReplicas.values()]
    .reduce((count, replica) => count + [...replica.state.accounts.values()].filter(account => account.pendingFrame).length, 0);
  const live = {
    height: env.state.height, hash: computeCanonicalStateHashFromEnv(env), balance: balance(env), pending: pendingFrames(env),
  };
  if (ending === 'pending-account-frame') expect(live.pending).toBeGreaterThan(0);
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  if (ending === 'current-cache-lost') rmSync(`${resolveDbPath(env)}-storage-current`, { recursive: true, force: true });
  if (ending === 'tampered-tip-frame') {
    // The open no longer re-hashes the WAL; restore must bind the frame it trusts.
    const wal = getRuntimeWalDb(env);
    await wal.open();
    const frame = await readStorageFrameRecord(wal, live.height);
    if (!frame) throw new Error('RESTORE_CADENCE_TIP_FRAME_MISSING');
    await wal.put(keyFrame(live.height), encodeBuffer({ ...frame, frameHash: `0x${'00'.repeat(32)}` }));
    await closeRuntimeDb(env);
    await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow('STORAGE_RESTORE_FRAME_HASH_MISMATCH');
    return { height: live.height, meta: null as unknown as ReplayMeta };
  }
  const restored = await loadEnvFromDB(runtimeId, seed);
  if (!restored) throw new Error('RESTORE_CADENCE_RUNTIME_MISSING');
  try {
    expect(restored.state.height).toBe(live.height);
    expect(computeCanonicalStateHashFromEnv(restored)).toBe(live.hash);
    expect(balance(restored)).toBe(live.balance);
    expect(pendingFrames(restored)).toBe(live.pending);
    await inspect?.(restored, user, hub);
    return { height: live.height, meta: readRuntimeMetadata(restored, '__replayMeta') as ReplayMeta };
  } finally {
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);
  }
};

test('a browser wallet restore replays no committed frame after a quiescent commit', async () => {
  const hub = await restoreAfterPayments({ materializePeriodFrames: 100 });
  // Control: the hub cadence replays every frame after genesis materialization.
  expect(hub.meta.replayedFrameCount).toBe(hub.height - 1);
  const browser = await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG });
  expect(browser.meta).toMatchObject({ checkpointHeight: browser.height, replayedFrameCount: 0 });
}, 60_000);

test('the browser cadence recovers the same state after losing the current-graph cache', async () => {
  const lost = await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'current-cache-lost');
  expect(lost.meta).toMatchObject({ checkpointHeight: lost.height, replayedFrameCount: 0 });
}, 60_000);

test('the browser cadence recovers an Account frame still awaiting its peer', async () => {
  const pending = await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'pending-account-frame');
  // Entity replicas are quiescent with only an Account proposal in flight.
  expect(pending.meta.replayedFrameCount).toBe(0);
}, 60_000);

test('a restored browser runtime holds HTLC admission behind the j-catchup fence', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'clean', async (restored, user, hub) => {
    startRuntimeLoop(restored);
    try {
      // hosted.ts closes the fence before P2P starts and opens it only after
      // every attached watcher completes its first authenticated pass.
      const notices: Array<boolean> = [];
      const offPublished = registerRuntimePublishedCallback(restored, notice => notices.push(notice.commandReady));
      setRuntimeDeliveryReady(restored, false);
      const lock = { runtimeTxs: [], entityInputs: [{ ...user, entityTxs: [{ type: 'htlcPayment' as const, data: {
        targetEntityId: hub.entityId, tokenId: 1, amount: 1n, maxSenderDebit: 1n,
        route: [user.entityId, hub.entityId], deliveryMode: 'instant' as const,
        hashlock: `0x${'99'.repeat(32)}`, description: 'fenced lock',
      } }] }] };
      expect(() => validateRuntimeInputAdmission(restored, lock)).toThrow('RUNTIME_COMMAND_NOT_READY:j-catchup');
      setRuntimeDeliveryReady(restored, true);
      expect(() => validateRuntimeInputAdmission(restored, lock)).not.toThrow();
      // Observers see the fence close and open without waiting for a frame.
      expect(notices).toEqual([false, true]);
      offPublished();
    } finally {
      await stopRuntimeLoopAndWait(restored);
    }
  });
}, 60_000);

test('a browser wallet restore rejects a tip frame record that no longer matches its hash', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'tampered-tip-frame');
}, 60_000);

test('a restored browser runtime holds a due hook behind the j-catchup fence and runs it after', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'clean', async (restored, user) => {
    const replica = [...restored.state.eReplicas.values()].find(candidate => candidate.entityId === user.entityId);
    if (!replica) throw new Error('RESTORE_CADENCE_USER_REPLICA_MISSING');
    replica.state.crontabState ??= initCrontab();
    // A hook already due when the wallet reopens: firing it on stale J state
    // would create a new Entity frame (and its Account/J obligations).
    scheduleHook(replica.state.crontabState, { id: 'due-at-unlock', triggerAt: 1, type: 'watchdog', data: {} });
    rebuildScheduledWakeIndex(restored);
    const now = restored.state.timestamp + 60_000;
    const mempool = restored.runtimeMempool;
    setRuntimeDeliveryReady(restored, false);
    generateHookPings(restored, now, now);
    expect(mempool.entityInputs).toHaveLength(0);
    expect(hasRuntimeWork(restored)).toBe(false);
    setRuntimeDeliveryReady(restored, true);
    expect(hasRuntimeWork(restored)).toBe(true);
    generateHookPings(restored, now, now);
    expect(mempool.entityInputs.some(input => input.entityId === user.entityId)).toBe(true);
  });
}, 60_000);

test('behind the j-catchup fence only chain joins are admitted and peer input waits for catch-up', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'clean', async (restored, user, hub) => {
    startRuntimeLoop(restored);
    try {
      setRuntimeDeliveryReady(restored, false);
      const join = { runtimeTxs: [{ type: 'importJ', data: { name: 'late-chain' } }], entityInputs: [] } as never;
      expect(() => validateRuntimeInputAdmission(restored, join)).not.toThrow('RUNTIME_COMMAND_NOT_READY');
      const command = { runtimeTxs: [], entityInputs: [{ ...user, entityTxs: [] }] };
      expect(() => validateRuntimeInputAdmission(restored, command)).toThrow('RUNTIME_COMMAND_NOT_READY:j-catchup');
      // A relay connected before the fence closed: its authenticated input is
      // held, not enqueued, until catch-up opens the fence.
      const before = restored.runtimeMempool.entityInputs.length;
      handleInboundP2PEntityInput(restored, String(restored.runtimeId), { ...hub, entityId: user.entityId, signerId: user.signerId, entityTxs: [] });
      expect(restored.runtimeMempool.entityInputs).toHaveLength(before);
      expect(restored.infrastructure?.fencedInboundEntityInputs?.count).toBe(1);
      setRuntimeDeliveryReady(restored, true);
      expect(restored.infrastructure?.fencedInboundEntityInputs).toBeUndefined();
      expect(restored.runtimeMempool.entityInputs.length).toBeGreaterThan(before);
    } finally {
      await stopRuntimeLoopAndWait(restored);
    }
  });
}, 60_000);

test('a stalled catch-up under a peer flood refuses past mempool capacity without halting', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'clean', async (restored, user) => {
    setRuntimeDeliveryReady(restored, false);
    const input = { entityId: user.entityId, signerId: user.signerId, entityTxs: [] };
    const room = LIMITS.MAX_RUNTIME_MEMPOOL_ENTITY_INPUTS - restored.runtimeMempool.entityInputs.length;
    for (let index = 0; index < room; index += 1) handleInboundP2PEntityInput(restored, String(restored.runtimeId), input);
    expect(restored.infrastructure?.fencedInboundEntityInputs?.count).toBe(room);
    let refusal: unknown = null;
    try {
      handleInboundP2PEntityInput(restored, String(restored.runtimeId), input);
    } catch (error) {
      refusal = error;
    }
    // The same typed backpressure an open-fence mempool raises; the hold stops growing.
    expect(isRuntimeMempoolCapacityError(refusal)).toBe(true);
    expect(restored.infrastructure?.fencedInboundEntityInputs?.count).toBe(room);
    expect(restored.infrastructure?.halted).toBeFalsy();
    delete restored.infrastructure!.fencedInboundEntityInputs;
  });
}, 60_000);

test('a release stopped by a persistence pause keeps the input and its tail held, closed until resume', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'clean', async restored => {
    setRuntimeDeliveryReady(restored, false);
    const released: number[] = [];
    const notices: boolean[] = [];
    const offPublished = registerRuntimePublishedCallback(restored, notice => notices.push(notice.commandReady));
    let paused = true;
    const entry = (id: number, count = 1) => ({
      count,
      enqueue: () => {
        if (paused && id === 2) throw new Error('RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE:test');
        released.push(id);
      },
    });
    restored.infrastructure!.fencedInboundEntityInputs = { count: 4, entries: [entry(1), entry(2, 2), entry(3)] };
    // Transport readiness as the P2P layer sees it.
    const transportReady: boolean[] = [];
    restored.infrastructure!.p2p = {
      setReady: (ready: boolean) => transportReady.push(ready),
      prepareEntityRoutes: () => {},
    } as never;
    expect(() => setRuntimeDeliveryReady(restored, true)).not.toThrow();
    expect(transportReady).toEqual([false]);
    // Nothing transport already accepted is dropped: the failed entry and the tail stay, in order.
    expect(released).toEqual([1]);
    expect(restored.infrastructure?.fencedInboundEntityInputs?.count).toBe(3);
    expect(restored.infrastructure?.fencedInboundEntityInputs?.entries).toHaveLength(2);
    expect(notices).toHaveLength(1);
    // Resume after the pause releases the rest; nothing is held afterwards.
    paused = false;
    restored.infrastructure!.persistenceQuiescing = true;
    resumeRuntimeAfterPersistenceQuiesce(restored);
    expect(released).toEqual([1, 2, 3]);
    expect(restored.infrastructure?.fencedInboundEntityInputs).toBeUndefined();
    expect(transportReady).toEqual([false, true]);
    delete restored.infrastructure!.p2p;
    await stopRuntimeLoopAndWait(restored);
    offPublished();
  });
}, 60_000);

test('a checkpoint during catch-up drains past held input; its rollback resume releases it once, in order', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'clean', async restored => {
    setRuntimeDeliveryReady(restored, false);
    startRuntimeLoop(restored);
    const state = restored.infrastructure!;
    const released: number[] = [];
    const entry = (id: number, count = 1) => ({
      count,
      enqueue: () => {
        if (state.persistencePaused || state.persistenceQuiescing) {
          throw new Error('RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE:test');
        }
        released.push(id);
      },
    });
    state.fencedInboundEntityInputs = { count: 4, entries: [entry(1), entry(2, 2), entry(3)] };
    // Transport readiness, with what was still held at each change.
    const transport: Array<{ ready: boolean; held: number }> = [];
    // Held input behind a closed fence does not block the checkpoint drain.
    await checkpointNodeRuntime(restored, {
      workTimeoutMs: 3_000,
      loopTimeoutMs: 3_000,
      persist: async () => {
        state.p2p = {
          setReady: (ready: boolean) => transport.push({ ready, held: state.fencedInboundEntityInputs?.count ?? 0 }),
          prepareEntityRoutes: () => {},
        } as never;
        // Catch-up opens while the checkpoint has persistence paused: the release is rejected.
        setRuntimeDeliveryReady(restored, true);
        expect(released).toEqual([]);
        expect(state.fencedInboundEntityInputs?.count).toBe(4);
      },
    });
    // The checkpoint resumes through resumeRuntimeLoop; that start releases the hold.
    expect(state.loopActive).toBe(true);
    expect(released).toEqual([1, 2, 3]);
    expect(state.fencedInboundEntityInputs).toBeUndefined();
    expect(transport).toEqual([{ ready: false, held: 4 }, { ready: true, held: 0 }]);
    setRuntimeDeliveryReady(restored, true);
    expect(released).toEqual([1, 2, 3]);
    delete state.p2p;
    await stopRuntimeLoopAndWait(restored);
  });
}, 60_000);

test('catch-up opening inside a checkpoint drain does not fail it; the resume releases held input once, in order', async () => {
  await restoreAfterPayments({ ...BROWSER_RUNTIME_STORAGE_CONFIG }, 'clean', async restored => {
    setRuntimeDeliveryReady(restored, false);
    startRuntimeLoop(restored);
    const state = restored.infrastructure!;
    const released: number[] = [];
    const entry = (id: number, count = 1) => ({
      count,
      enqueue: () => {
        if (state.persistencePaused || state.persistenceQuiescing) {
          throw new Error('RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE:test');
        }
        released.push(id);
      },
    });
    state.fencedInboundEntityInputs = { count: 4, entries: [entry(1), entry(2, 2), entry(3)] };
    // Catch-up opens after the quiesce began but before persist(): its release is rejected.
    let openedDuringDrain = false;
    const offPublished = registerRuntimePublishedCallback(restored, () => {
      if (openedDuringDrain || !state.persistenceQuiescing || state.persistencePaused) return;
      openedDuringDrain = true;
      setRuntimeDeliveryReady(restored, true);
    });
    let heldAtPersist: number | undefined;
    await checkpointNodeRuntime(restored, {
      workTimeoutMs: 3_000,
      loopTimeoutMs: 3_000,
      persist: async () => {
        heldAtPersist = state.fencedInboundEntityInputs?.count;
      },
    });
    offPublished();
    expect(openedDuringDrain).toBe(true);
    expect(heldAtPersist).toBe(4);
    expect(released).toEqual([1, 2, 3]);
    expect(state.fencedInboundEntityInputs).toBeUndefined();
    setRuntimeDeliveryReady(restored, true);
    expect(released).toEqual([1, 2, 3]);
    await stopRuntimeLoopAndWait(restored);
  });
}, 60_000);
