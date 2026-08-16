import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getPersistedLatestHeight,
  getRuntimeWalDb,
  processRuntime,
  readPersistedAccountFrameHistory,
  readPersistedEntityFrameHistory,
  saveEnvToDB,
} from '../../../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { recordAccountFrameHistory } from '../../../runtime/observability/env-events';
import { closeHistoryViewDb } from '../../../storage/runtime-dbs';
import { pruneHistoryBeforeHeight } from '../../../storage/database/lifecycle';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';

const created: RuntimeReplica[] = [];

afterEach(async () => {
  for (const env of created.splice(0)) {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    const root = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
    const namespace = String(env.dbNamespace || env.runtimeId || '').toLowerCase();
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-infra']) {
      rmSync(join(root, `${namespace}${suffix}`), { recursive: true, force: true });
    }
  }
});

test('live Entity memory keeps only the post-checkpoint tail while LevelDB keeps frame history', async () => {
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
    address: 'browservm://frame-memory-testnet',
    name: 'frame-memory-testnet',
    chainId: 31_337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, {
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

  const replica = [...env.state.eReplicas.values()].find(candidate => candidate.entityId === entityId);
  expect(replica?.state.height).toBe(2);
  expect(replica?.certifiedFrameAnchor?.height).toBe(1);
  expect(replica?.certifiedFrameHead?.frame.height).toBe(2);
  expect('history' in env).toBe(false);

  const persisted = await readPersistedEntityFrameHistory(env, entityId, 10);
  expect(persisted.map(link => link.frame.height)).toEqual([1, 2]);
  expect(persisted.every(link => link.frame.collectedSigs instanceof Map)).toBeTrue();
  await closeHistoryViewDb(env);
  const root = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
  rmSync(join(root, `${env.runtimeId}-history-views`), { recursive: true, force: true });
  const afterViewDeletion = await readPersistedEntityFrameHistory(env, entityId, 10);
  expect(afterViewDeletion).toEqual(persisted);
});

test('certified history fork aborts before authoritative HEAD advances', async () => {
  const seed = `certified-history-conflict-${Date.now()} alpha beta gamma`;
  const env = createEmptyEnv(seed);
  created.push(env);
  env.runtimeId = deriveSignerAddressSync(seed, 'runtime').toLowerCase();
  env.dbNamespace = env.runtimeId;
  env.quietRuntimeLogs = true;
  env.scenarioMode = true;
  const entityId = `0x${'31'.repeat(32)}`;
  const counterpartyId = `0x${'42'.repeat(32)}`;
  const zeroHash = `0x${'00'.repeat(32)}`;
  const frame = {
    height: 1,
    timestamp: 100,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: zeroHash,
    stateHash: zeroHash,
    byLeft: true,
    deltas: [],
  };

  env.state.height = 1;
  env.state.timestamp = 100;
  recordAccountFrameHistory(env, {
    entityId,
    counterpartyId,
    accountHeight: 1,
    source: 'peerCommit',
    frame,
  });
  await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], undefined, new Map());
  expect(await getPersistedLatestHeight(env)).toBe(1);

  env.state.height = 2;
  env.state.timestamp = 200;
  recordAccountFrameHistory(env, {
    entityId,
    counterpartyId,
    accountHeight: 1,
    source: 'ackCommit',
    frame: { ...frame, stateHash: `0x${'ff'.repeat(32)}` },
  });
  await expect(saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], undefined, new Map()))
    .rejects.toThrow('STORAGE_CERTIFIED_FRAME_CONFLICT');
  expect(await getPersistedLatestHeight(env)).toBe(1);

  await pruneHistoryBeforeHeight(getRuntimeWalDb(env), 1);
  await closeHistoryViewDb(env);
  const root = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
  rmSync(join(root, `${env.runtimeId}-history-views`), { recursive: true, force: true });
  expect(await readPersistedAccountFrameHistory(
    env,
    entityId,
    counterpartyId,
    10,
  )).toEqual([frame]);
});
