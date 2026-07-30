import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  processRuntime,
  readPersistedEntityFrameHistory,
} from '../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import type { RuntimeState } from '../runtime/types';
import type { JReplica } from '../types/jurisdiction-runtime';

const created: RuntimeState[] = [];

afterEach(async () => {
  for (const env of created.splice(0)) {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    const root = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
    const namespace = String(env.dbNamespace || env.runtimeId || '').toLowerCase();
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-infra']) {
      rmSync(join(root, `${namespace}${suffix}`), { recursive: true, force: true });
    }
  }
});

test('live Entity memory keeps certified lineage while LevelDB keeps frame history', async () => {
  const seed = `frame-memory-invariant-${Date.now()} alpha beta gamma`;
  const env = createEmptyEnv(seed);
  created.push(env);
  env.runtimeId = deriveSignerAddressSync(seed, 'runtime').toLowerCase();
  env.dbNamespace = env.runtimeId;
  env.quietRuntimeLogs = true;
  env.scenarioMode = true;
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    storage: {
      ...(env.runtimeConfig?.storage || {}),
      materializePeriodFrames: 100,
      snapshotPeriodFrames: 10_000,
    },
  };

  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const jurisdiction = {
    name: 'frame-memory-testnet',
    chainId: 31_337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    ...jurisdiction,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
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
  await processRuntime(env, []);

  for (const name of ['first', 'second']) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{ type: 'profile-update', data: { profile: { entityId, name } } }],
      }],
    });
    await processRuntime(env, []);
  }

  const replica = [...env.eReplicas.values()].find(candidate => candidate.entityId === entityId);
  expect(replica?.state.height).toBe(2);
  expect(replica?.certifiedFrameLineage?.map(link => link.frame.height)).toEqual([1, 2]);
  expect(env.history).toEqual([]);

  const persisted = await readPersistedEntityFrameHistory(env, entityId, 10);
  expect(persisted.map(link => link.frame.height)).toEqual([1, 2]);
  expect(persisted.every(link => link.frame.collectedSigs instanceof Map)).toBeTrue();
});
