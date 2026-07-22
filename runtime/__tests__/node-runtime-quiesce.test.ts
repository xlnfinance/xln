import { describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  hasRuntimeWork,
  persistRestoredEnvToDB,
  readPersistedFrameJournals,
  readPersistedStorageHead,
  startP2P,
  startRuntimeLoop,
  stopP2PAndWait,
  stopRuntimeLoopAndWait,
} from '../runtime';
import { generateLazyEntityId } from '../entity/factory';
import {
  checkpointNodeRuntime,
  quiesceNodeRuntime,
} from '../orchestrator/node-runtime-quiesce';
import { resolveDbPath } from '../storage/runtime-dbs';
import type { JReplica, JurisdictionConfig } from '../types';

const removeRuntimeStorage = (basePath: string): void => {
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
    rmSync(`${basePath}${suffix}`, { recursive: true, force: true });
  }
};

describe('node runtime quiesce', () => {
  test('drains runtime work, loop, and P2P before reporting success', async () => {
    const env = createEmptyEnv(null);
    const result = await quiesceNodeRuntime(env, {
      workTimeoutMs: 20,
      loopTimeoutMs: 20,
      quietMs: 1,
    });

    expect(result).toEqual({ runtimeDrained: true, runtimeIdle: true });
  });

  test('fences the runtime loop from resurrecting a stopped J watcher during quiesce', async () => {
    const env = createEmptyEnv(null);
    let watching = false;
    let startCount = 0;
    let stopCount = 0;
    const adapter = {
      mode: 'rpc' as const,
      chainId: 31_337,
      addresses: {
        account: '0x0000000000000000000000000000000000000001',
        depository: '0x0000000000000000000000000000000000000002',
        entityProvider: '0x0000000000000000000000000000000000000003',
        deltaTransformer: '0x0000000000000000000000000000000000000004',
      },
      provider: { _getConnection: () => ({ url: 'http://127.0.0.1:8545' }) },
      startWatching: () => {
        startCount += 1;
        watching = true;
      },
      stopWatching: () => {
        stopCount += 1;
        watching = false;
      },
      stopWatchingAndWait: async () => {
        stopCount += 1;
        watching = false;
      },
      isWatching: () => watching,
    };
    env.jReplicas.set('quiesce-race', {
      name: 'quiesce-race',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: adapter.addresses.depository,
      entityProviderAddress: adapter.addresses.entityProvider,
      contracts: adapter.addresses,
      rpcs: ['http://127.0.0.1:8545'],
      chainId: adapter.chainId,
      jadapter: adapter,
    } as unknown as JReplica);

    startRuntimeLoop(env, { tickDelayMs: 0 });
    expect(startCount).toBe(1);
    expect(watching).toBe(true);

    const result = await quiesceNodeRuntime(env, {
      workTimeoutMs: 100,
      loopTimeoutMs: 100,
      quietMs: 1,
    });

    expect(result).toEqual({ runtimeDrained: true, runtimeIdle: true });
    expect(startCount).toBe(1);
    expect(stopCount).toBe(1);
    expect(watching).toBe(false);
  });

  test('drains accepted runtime work even when the runtime loop was already stopped', async () => {
    const env = createEmptyEnv(`node-quiesce-stopped-drain-${process.pid}-${Date.now()}`);
    const storageBasePath = resolveDbPath(env, 'core');
    const signerId = `0x${'11'.repeat(20)}`;
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const jurisdiction: JurisdictionConfig = {
      name: 'stopped-runtime-drain',
      address: 'rpc://stopped-runtime-drain',
      chainId: 31_337,
      depositoryAddress: '0x000000000000000000000000000000000000dead',
      entityProviderAddress: '0x000000000000000000000000000000000000beef',
    };
    env.activeJurisdiction = jurisdiction.name;
    env.jReplicas.set(jurisdiction.name, {
      ...jurisdiction,
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      rpcs: [jurisdiction.address!],
      position: { x: 0, y: 0, z: 0 },
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
      },
    } as JReplica);
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
            jurisdiction,
          },
        },
      }],
      entityInputs: [],
    });
    expect(env.runtimeState?.loopActive ?? false).toBe(false);
    expect(hasRuntimeWork(env)).toBe(true);

    const result = await quiesceNodeRuntime(env, {
      workTimeoutMs: 1_000,
      loopTimeoutMs: 20,
      quietMs: 1,
    });

    expect(result).toEqual({ runtimeDrained: true, runtimeIdle: true });
    expect(env.height).toBe(1);
    expect(env.eReplicas.has(`${entityId}:${signerId}`)).toBe(true);
    expect(hasRuntimeWork(env)).toBe(false);
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    removeRuntimeStorage(storageBasePath);
  });

  test('fails closed when work appears after durable persistence was paused', async () => {
    const env = createEmptyEnv(null);
    env.runtimeState ??= {};
    env.runtimeState.persistencePaused = true;
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: `0x${'22'.repeat(32)}`,
        signerId: `0x${'33'.repeat(20)}`,
        entityTxs: [],
      }],
    });

    await expect(quiesceNodeRuntime(env, {
      workTimeoutMs: 1,
      loopTimeoutMs: 20,
      quietMs: 1,
    })).rejects.toThrow('NODE_RUNTIME_QUIESCE_FAILED:work_drain:RUNTIME_WORK_DRAIN_PERSISTENCE_PAUSED');
    expect(env.runtimeState?.persistenceQuiescing).toBe(true);
  });

  test('checkpoint atomically persists only after full quiesce and resumes prior loop and P2P', async () => {
    const env = createEmptyEnv(`node-checkpoint-lifecycle-${process.pid}-${Date.now()}`);
    const runtimeId = env.runtimeId;
    if (!runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    env.quietRuntimeLogs = true;
    const storageBasePath = resolveDbPath(env, 'core');
    const jurisdiction: JurisdictionConfig = {
      name: 'node-checkpoint-lifecycle',
      address: 'rpc://node-checkpoint-lifecycle',
      chainId: 31_337,
      depositoryAddress: '0x000000000000000000000000000000000000dead',
      entityProviderAddress: '0x000000000000000000000000000000000000beef',
    };
    env.activeJurisdiction = jurisdiction.name;
    env.jReplicas.set(jurisdiction.name, {
      ...jurisdiction,
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      rpcs: [jurisdiction.address!],
      position: { x: 0, y: 0, z: 0 },
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
      },
    } as JReplica);
    const entityId = generateLazyEntityId([runtimeId], 1n).toLowerCase();
    const originalP2P = startP2P(env, { runtimeId });
    if (!originalP2P) throw new Error('TEST_P2P_START_FAILED');
    startRuntimeLoop(env, { tickDelayMs: 0 });
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId: runtimeId,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [runtimeId],
            shares: { [runtimeId]: 1n },
            jurisdiction,
          },
        },
      }],
      entityInputs: [],
    });
    expect(env.runtimeMempool?.runtimeTxs).toHaveLength(1);
    expect(hasRuntimeWork(env)).toBe(true);
    expect(env.height).toBe(0);
    expect(env.history).toHaveLength(0);

    let persisted = false;
    try {
      const result = await checkpointNodeRuntime(env, {
        workTimeoutMs: 5_000,
        loopTimeoutMs: 5_000,
        quietMs: 1,
        loopConfig: { tickDelayMs: 0 },
        persist: async () => {
          expect(env.runtimeState?.loopActive).toBe(false);
          expect(env.runtimeState?.p2p).toBeNull();
          expect(env.runtimeState?.persistenceQuiescing).toBe(true);
          expect(env.runtimeState?.persistencePaused).toBe(true);
          expect(env.height).toBeGreaterThanOrEqual(1);
          expect(env.eReplicas.has(`${entityId}:${runtimeId}`)).toBe(true);
          expect(env.runtimeMempool?.runtimeTxs).toHaveLength(0);
          expect(env.runtimeMempool?.entityInputs).toHaveLength(0);
          expect(hasRuntimeWork(env)).toBe(false);
          expect((await readPersistedStorageHead(env))?.latestHeight).toBe(env.height);
          const journals = await readPersistedFrameJournals(env, {
            fromHeight: 1,
            toHeight: env.height,
            limit: env.height,
          });
          expect(journals.at(-1)?.height).toBe(env.height);
          expect(journals.some(journal => journal.runtimeInput.runtimeTxs.some(
            tx => tx.type === 'importReplica' && tx.entityId === entityId,
          ))).toBe(true);
          persisted = true;
        },
      });

      expect(result).toEqual({
        runtimeDrained: true,
        runtimeIdle: true,
        wasLoopActive: true,
        wasP2PActive: true,
        wasPersistencePaused: false,
      });
      expect(persisted).toBe(true);
      expect(env.runtimeState?.loopActive).toBe(true);
      expect(env.runtimeState?.persistenceQuiescing).toBe(false);
      expect(env.runtimeState?.persistencePaused).toBe(false);
      expect(env.runtimeState?.p2p).not.toBeNull();
      expect(env.runtimeState?.p2p).not.toBe(originalP2P);
      expect(env.runtimeState?.lastP2PConfig).toEqual({ runtimeId });
    } finally {
      await stopRuntimeLoopAndWait(env, 5_000);
      await stopP2PAndWait(env, 5_000);
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      removeRuntimeStorage(storageBasePath);
    }
  });

  test('checkpoint resumes prior runtime state after a loud persistence failure', async () => {
    const env = createEmptyEnv(null);
    startRuntimeLoop(env, { tickDelayMs: 0 });

    try {
      await expect(checkpointNodeRuntime(env, {
        workTimeoutMs: 50,
        loopTimeoutMs: 50,
        quietMs: 1,
        loopConfig: { tickDelayMs: 0 },
        persist: async () => {
          throw new Error('disk-write-failed');
        },
      })).rejects.toThrow('NODE_RUNTIME_CHECKPOINT_FAILED:persist:disk-write-failed');
      expect(env.runtimeState?.loopActive).toBe(true);
      expect(env.runtimeState?.persistenceQuiescing).toBe(false);
      expect(env.runtimeState?.persistencePaused).toBe(false);
    } finally {
      await stopRuntimeLoopAndWait(env, 50);
    }
  });

  test('bootstrap checkpoint drains accepted in-memory work before publishing the first durable snapshot', async () => {
    const env = createEmptyEnv(`node-bootstrap-checkpoint-${process.pid}-${Date.now()}`);
    env.quietRuntimeLogs = true;
    const storageBasePath = resolveDbPath(env, 'core');
    const signerId = `0x${'44'.repeat(20)}`;
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const jurisdiction: JurisdictionConfig = {
      name: 'bootstrap-paused-drain',
      address: 'rpc://bootstrap-paused-drain',
      chainId: 31_337,
      depositoryAddress: '0x000000000000000000000000000000000000dead',
      entityProviderAddress: '0x000000000000000000000000000000000000beef',
    };
    env.activeJurisdiction = jurisdiction.name;
    env.jReplicas.set(jurisdiction.name, {
      ...jurisdiction,
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      rpcs: [jurisdiction.address!],
      position: { x: 0, y: 0, z: 0 },
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
      },
    } as JReplica);
    env.runtimeState ??= {};
    env.runtimeState.persistencePaused = true;
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
            jurisdiction,
          },
        },
      }],
      entityInputs: [],
    });

    try {
      const result = await checkpointNodeRuntime(env, {
        workTimeoutMs: 1_000,
        loopTimeoutMs: 1_000,
        quietMs: 1,
        resumePersistenceAfterCheckpoint: true,
        persist: async () => {
          expect(env.height).toBe(1);
          expect(env.eReplicas.has(`${entityId}:${signerId}`)).toBe(true);
          expect(await readPersistedStorageHead(env)).toBeNull();
          await persistRestoredEnvToDB(env);
        },
      });

      expect(result.wasPersistencePaused).toBe(true);
      expect(env.runtimeState.persistencePaused).toBe(false);
      expect(env.runtimeState.persistenceQuiescing).toBe(false);
      expect((await readPersistedStorageHead(env))?.latestHeight).toBe(1);
    } finally {
      await stopRuntimeLoopAndWait(env, 1_000);
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      removeRuntimeStorage(storageBasePath);
    }
  });

  test('failed first bootstrap snapshot stays persistence-paused with loop and P2P stopped', async () => {
    const env = createEmptyEnv(`failed-bootstrap-checkpoint-${process.pid}-${Date.now()}`);
    const runtimeId = env.runtimeId;
    if (!runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    env.runtimeState ??= {};
    env.runtimeState.persistencePaused = true;
    const originalP2P = startP2P(env, { runtimeId });
    if (!originalP2P) throw new Error('TEST_P2P_START_FAILED');
    startRuntimeLoop(env, { tickDelayMs: 0 });

    try {
      await expect(checkpointNodeRuntime(env, {
        workTimeoutMs: 50,
        loopTimeoutMs: 50,
        quietMs: 1,
        resumePersistenceAfterCheckpoint: true,
        persist: async () => {
          throw new Error('bootstrap-base-write-failed');
        },
      })).rejects.toThrow('NODE_RUNTIME_CHECKPOINT_FAILED:persist:bootstrap-base-write-failed');

      expect(env.runtimeState.persistencePaused).toBe(true);
      expect(env.runtimeState.persistenceQuiescing).toBe(false);
      expect(env.runtimeState.lifecyclePhase).toBe('stopped');
      expect(env.runtimeState.loopActive).toBe(false);
      expect(env.runtimeState.p2p).toBeNull();
    } finally {
      await stopRuntimeLoopAndWait(env, 50);
      await stopP2PAndWait(env, 50);
    }
  });

  test('successful checkpoint does not restart producers while persistence remains paused', async () => {
    const env = createEmptyEnv(`paused-checkpoint-${process.pid}-${Date.now()}`);
    const runtimeId = env.runtimeId;
    if (!runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    env.runtimeState ??= {};
    env.runtimeState.persistencePaused = true;
    const originalP2P = startP2P(env, { runtimeId });
    if (!originalP2P) throw new Error('TEST_P2P_START_FAILED');
    startRuntimeLoop(env, { tickDelayMs: 0 });

    try {
      const result = await checkpointNodeRuntime(env, {
        workTimeoutMs: 50,
        loopTimeoutMs: 50,
        quietMs: 1,
        persist: async () => {},
      });

      expect(result.wasPersistencePaused).toBe(true);
      expect(env.runtimeState.persistencePaused).toBe(true);
      expect(env.runtimeState.lifecyclePhase).toBe('stopped');
      expect(env.runtimeState.loopActive).toBe(false);
      expect(env.runtimeState.p2p).toBeNull();
    } finally {
      await stopRuntimeLoopAndWait(env, 50);
      await stopP2PAndWait(env, 50);
    }
  });
});
