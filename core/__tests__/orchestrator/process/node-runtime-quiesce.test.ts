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
  startJurisdictionWatchers,
  stopP2PAndWait,
  stopRuntimeLoopAndWait,
} from '../../../runtime';
import { generateLazyEntityId } from '../../../entity/factory';
import {
  checkpointNodeRuntime,
  quiesceNodeRuntime,
  requestChildQuiesce,
} from '../../../orchestrator/process/node-runtime-quiesce';
import { resolveDbPath } from '../../../storage/runtime-dbs';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { bootScenario } from '../../../scenarios/harness/boot';
import type { JurisdictionConfig } from '../../../entity/types';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';

const removeRuntimeStorage = (basePath: string): void => {
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
    rmSync(`${basePath}${suffix}`, { recursive: true, force: true });
  }
};

describe('node runtime quiesce', () => {
  test('a child that refuses or cannot be reached for quiesce is logged, not dropped', async () => {
    const originalFetch = globalThis.fetch;
    const events: Array<[string, Record<string, unknown>]> = [];
    const log = (event: string, details: Record<string, unknown>): void => {
      events.push([event, details]);
    };
    try {
      globalThis.fetch = (async () => new Response('runtime quiesce failed', { status: 503 })) as unknown as typeof fetch;
      await requestChildQuiesce('http://127.0.0.1:1/api/control/core/quiesce', 1_000, log);
      globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      await requestChildQuiesce('http://127.0.0.1:2/api/control/core/quiesce', 1_000, log);
      globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
      await requestChildQuiesce('http://127.0.0.1:3/api/control/core/quiesce', 1_000, log);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(events).toEqual([
      ['quiesce.refused', { url: 'http://127.0.0.1:1/api/control/core/quiesce', status: 503, body: 'runtime quiesce failed' }],
      ['quiesce.post_failed', { url: 'http://127.0.0.1:2/api/control/core/quiesce', error: 'ECONNREFUSED' }],
    ]);
  });

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
    const { env, jadapter } = await bootScenario({
      name: 'quiesce-watcher', seed: 'quiesce-watcher', signerIds: ['1'],
      storageEnabled: false, mode: 'browservm',
    });
    try {
      startRuntimeLoop(env, { tickDelayMs: 0 });
      expect(jadapter.isWatching()).toBe(true);
      const result = await quiesceNodeRuntime(env, {
        workTimeoutMs: 100, loopTimeoutMs: 100, quietMs: 1,
      });
      expect(result).toEqual({ runtimeDrained: true, runtimeIdle: true });
      expect(env.infrastructure.persistenceQuiescing).toBe(true);
      expect(jadapter.isWatching()).toBe(false);
      startJurisdictionWatchers(env);
      expect(jadapter.isWatching()).toBe(false);
    } finally {
      await stopRuntimeLoopAndWait(env);
      await jadapter.close();
    }
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
    env.state.jReplicas.set(jurisdiction.name, {
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
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
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
      })],
      entityInputs: [],
    });
    expect(env.infrastructure?.loopActive ?? false).toBe(false);
    expect(hasRuntimeWork(env)).toBe(true);

    const result = await quiesceNodeRuntime(env, {
      workTimeoutMs: 1_000,
      loopTimeoutMs: 20,
      quietMs: 1,
    });

    expect(result).toEqual({ runtimeDrained: true, runtimeIdle: true });
    expect(env.state.height).toBe(1);
    expect(env.state.eReplicas.has(`${entityId}:${signerId}`)).toBe(true);
    expect(hasRuntimeWork(env)).toBe(false);
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    removeRuntimeStorage(storageBasePath);
  });

  test('fails closed when work appears after durable persistence was paused', async () => {
    const env = createEmptyEnv(null);
    env.infrastructure ??= {};
    env.infrastructure.persistencePaused = true;
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
    expect(env.infrastructure?.persistenceQuiescing).toBe(true);
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
    env.state.jReplicas.set(jurisdiction.name, {
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
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
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
      })],
      entityInputs: [],
    });
    expect(env.runtimeMempool?.runtimeTxs).toHaveLength(1);
    expect(hasRuntimeWork(env)).toBe(true);
    expect(env.state.height).toBe(0);
    expect('history' in env).toBe(false);

    let persisted = false;
    try {
      const result = await checkpointNodeRuntime(env, {
        workTimeoutMs: 5_000,
        loopTimeoutMs: 5_000,
        quietMs: 1,
        loopConfig: { tickDelayMs: 0 },
        persist: async () => {
          expect(env.infrastructure?.loopActive).toBe(false);
          expect(env.infrastructure?.p2p).toBeNull();
          expect(env.infrastructure?.persistenceQuiescing).toBe(true);
          expect(env.infrastructure?.persistencePaused).toBe(true);
          expect(env.state.height).toBeGreaterThanOrEqual(1);
          expect(env.state.eReplicas.has(`${entityId}:${runtimeId}`)).toBe(true);
          expect(env.runtimeMempool?.runtimeTxs).toHaveLength(0);
          expect(env.runtimeMempool?.entityInputs).toHaveLength(0);
          expect(hasRuntimeWork(env)).toBe(false);
          expect((await readPersistedStorageHead(env))?.latestHeight).toBe(env.state.height);
          const journals = await readPersistedFrameJournals(env, {
            fromHeight: 1,
            toHeight: env.state.height,
            limit: env.state.height,
          });
          expect(journals.at(-1)?.height).toBe(env.state.height);
          expect(journals.at(-1)?.runtimeInput).toEqual({
            runtimeTxs: [{ type: 'checkpointBarrier', data: {} }],
            entityInputs: [],
          });
          expect((await readPersistedStorageHead(env))?.latestMaterializedHeight)
            .toBe(env.state.height);
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
      expect(env.infrastructure?.loopActive).toBe(true);
      expect(env.infrastructure?.persistenceQuiescing).toBe(false);
      expect(env.infrastructure?.persistencePaused).toBe(false);
      expect(env.infrastructure?.p2p).not.toBeNull();
      expect(env.infrastructure?.p2p).not.toBe(originalP2P);
      expect(env.infrastructure?.lastP2PConfig).toEqual({ runtimeId });
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
    env.runtimeConfig = { ...env.runtimeConfig, storage: { enabled: false } };
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
      expect(env.infrastructure?.loopActive).toBe(true);
      expect(env.infrastructure?.persistenceQuiescing).toBe(false);
      expect(env.infrastructure?.persistencePaused).toBe(false);
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
    env.state.jReplicas.set(jurisdiction.name, {
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
    env.infrastructure ??= {};
    env.infrastructure.persistencePaused = true;
    enqueueRuntimeInput(env, {
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
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
      })],
      entityInputs: [],
    });

    try {
      const result = await checkpointNodeRuntime(env, {
        workTimeoutMs: 1_000,
        loopTimeoutMs: 1_000,
        quietMs: 1,
        resumePersistenceAfterCheckpoint: true,
        persist: async () => {
          expect(env.state.height).toBe(1);
          expect(env.state.eReplicas.has(`${entityId}:${signerId}`)).toBe(true);
          expect(await readPersistedStorageHead(env)).toBeNull();
          await persistRestoredEnvToDB(env);
        },
      });

      expect(result.wasPersistencePaused).toBe(true);
      expect(env.infrastructure.persistencePaused).toBe(false);
      expect(env.infrastructure.persistenceQuiescing).toBe(false);
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
    env.infrastructure ??= {};
    env.infrastructure.persistencePaused = true;
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

      expect(env.infrastructure.persistencePaused).toBe(true);
      expect(env.infrastructure.persistenceQuiescing).toBe(false);
      expect(env.infrastructure.lifecyclePhase).toBe('stopped');
      expect(env.infrastructure.loopActive).toBe(false);
      expect(env.infrastructure.p2p).toBeNull();
    } finally {
      await stopRuntimeLoopAndWait(env, 50);
      await stopP2PAndWait(env, 50);
    }
  });

  test('successful checkpoint does not restart producers while persistence remains paused', async () => {
    const env = createEmptyEnv(`paused-checkpoint-${process.pid}-${Date.now()}`);
    const runtimeId = env.runtimeId;
    if (!runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    env.infrastructure ??= {};
    env.infrastructure.persistencePaused = true;
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
      expect(env.infrastructure.persistencePaused).toBe(true);
      expect(env.infrastructure.lifecyclePhase).toBe('stopped');
      expect(env.infrastructure.loopActive).toBe(false);
      expect(env.infrastructure.p2p).toBeNull();
    } finally {
      await stopRuntimeLoopAndWait(env, 50);
      await stopP2PAndWait(env, 50);
    }
  });
});
