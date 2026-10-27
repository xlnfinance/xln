import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  hasRuntimeWork,
  loadEnvFromDB,
  processRuntime,
  readPersistedStorageHead,
} from '../../../runtime';
import { generateLazyEntityId } from '../../../entity/factory';
import type { JurisdictionConfig } from '../../../entity/types';
import { createHubControlRequestHandler } from '../../../orchestrator/hub/node/hub-http';
import { NODE_BOOTSTRAP_IN_PROGRESS } from '../../../orchestrator/process/node-runtime-quiesce';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { resolveDbPath } from '../../../storage/runtime-dbs';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import type { RuntimeReplica } from '../../../runtime/types';

const removeRuntimeStorage = (basePath: string): void => {
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
    rmSync(`${basePath}${suffix}`, { recursive: true, force: true });
  }
};

const jurisdiction: JurisdictionConfig = {
  name: 'bootstrap-quiesce',
  address: 'browservm://bootstrap-quiesce',
  chainId: 31_337,
  depositoryAddress: '0x000000000000000000000000000000000000dead',
  entityProviderAddress: '0x000000000000000000000000000000000000beef',
};

const installJurisdiction = (env: RuntimeReplica): void => {
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
      account: '0x000000000000000000000000000000000000a11c',
      deltaTransformer: '0x000000000000000000000000000000000000d317',
    },
  } as JReplica);
};

// The startup bootstrap stage of scripts/bootstrap-hub.ts: enqueue a local
// entity import and commit it through the canonical Runtime frame.
const runBootstrapStage = async (env: RuntimeReplica, signerId: string): Promise<string> => {
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
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
  await processRuntime(env);
  return entityId;
};

const post = (handler: ReturnType<typeof createHubControlRequestHandler>, path: string) =>
  handler(new Request(`http://127.0.0.1${path}`, { method: 'POST' }), new URL(`http://127.0.0.1${path}`));

describe('quiesce during node startup bootstrap', () => {
  test('is refused without fencing ingress; bootstrap commits and survives restart', async () => {
    const seed = `node-bootstrap-quiesce-${process.pid}-${Date.now()}`;
    const env = createEmptyEnv(seed);
    const runtimeId = env.runtimeId;
    if (!runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    env.quietRuntimeLogs = true;
    const storageBasePath = resolveDbPath(env, 'core');
    installJurisdiction(env);
    let bootstrapComplete = false;
    let shuttingDown = false;
    let pauses = 0;
    const handler = createHubControlRequestHandler({
      state: env,
      nodeName: 'H2',
      pauseBootstrap: async () => {
        pauses += 1;
        return () => {};
      },
      markShuttingDown: () => {
        shuttingDown = true;
      },
      isBootstrapComplete: () => bootstrapComplete,
    });
    let restored: RuntimeReplica | null = null;
    try {
      // Adversarial order seen in E2E run 17: the orchestrator quiesces H2
      // after H1 died while H2 is still between bootstrap stages.
      for (const path of ['/api/control/core/quiesce', '/api/control/p2p/stop', '/api/control/runtime/snapshot']) {
        const refused = await post(handler, path);
        expect(refused?.status).toBe(409);
        expect(await refused?.json()).toEqual({ ok: false, error: NODE_BOOTSTRAP_IN_PROGRESS });
      }
      expect(env.infrastructure?.persistenceQuiescing ?? false).toBe(false);
      expect(shuttingDown).toBe(false);
      expect(pauses).toBe(0);

      // The next bootstrap stage enqueues instead of throwing
      // RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE and exiting the hub.
      const entityId = await runBootstrapStage(env, runtimeId);
      expect(env.state.height).toBe(1);
      expect(env.state.eReplicas.has(`${entityId}:${runtimeId}`)).toBe(true);

      bootstrapComplete = true;
      const accepted = await post(handler, '/api/control/core/quiesce');
      expect(accepted?.status).toBe(200);
      expect(await accepted?.json()).toEqual({ ok: true, runtimeDrained: true, runtimeIdle: true });
      expect(shuttingDown).toBe(true);
      expect(pauses).toBe(1);
      // The fail-closed ingress fence is unchanged after an admitted quiesce.
      expect(() => enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{ entityId, signerId: runtimeId, entityTxs: [] }],
      })).toThrow('RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE');
      expect(hasRuntimeWork(env)).toBe(false);
      expect((await readPersistedStorageHead(env))?.latestHeight).toBe(1);
      const committedOf = (runtime: RuntimeReplica) => {
        const entity = runtime.state.eReplicas.get(`${entityId}:${runtimeId}`)?.state;
        return {
          runtimeHeight: runtime.state.height,
          runtimeTimestamp: runtime.state.timestamp,
          entityHeight: entity?.height,
          entityPrevFrameHash: entity?.prevFrameHash,
          validators: entity?.config.validators,
        };
      };
      const committed = committedOf(env);

      await closeRuntimeDb(env);
      await closeInfraDb(env);
      restored = await loadEnvFromDB(runtimeId, seed);
      if (!restored) throw new Error('BOOTSTRAP_QUIESCE_RESTORE_MISSING');
      expect(committedOf(restored)).toEqual(committed);
      expect(committed.runtimeHeight).toBe(1);
      expect(hasRuntimeWork(restored)).toBe(false);
      expect(restored.infrastructure?.persistenceQuiescing ?? false).toBe(false);
    } finally {
      if (restored) {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      } else {
        await closeRuntimeDb(env);
        await closeInfraDb(env);
      }
      removeRuntimeStorage(storageBasePath);
    }
  }, 30_000);

  test('hub and market maker admit quiesce only after their last startup stage', () => {
    const read = (file: string): string => readFileSync(join(process.cwd(), 'core/orchestrator', file), 'utf8');
    const hub = read('hub-node.ts');
    expect(hub).toContain('isBootstrapComplete: () => live.externalIngressReady,');
    expect(hub.indexOf('await ensurePendingNumberedRegistrationsResumed(env);')).toBeLessThan(
      hub.indexOf('live.externalIngressReady = true;'),
    );
    const mm = read('market-maker/node/mm-node-run.ts');
    expect(mm).toContain('isBootstrapComplete: () => state.externalIngressReady,');
    const quiesce = mm.slice(mm.indexOf('const quiesceMarketMakerRuntime = async ('));
    expect(quiesce.indexOf('if (!deps.isBootstrapComplete()) return refuseQuiesceDuringBootstrap();')).toBeLessThan(
      quiesce.indexOf('deps.stopRuntimeLoops();'),
    );
    expect(mm.indexOf('await ensurePendingNumberedRegistrationsResumed(env);')).toBeLessThan(
      mm.indexOf('state.externalIngressReady = true;'),
    );
  });
});
