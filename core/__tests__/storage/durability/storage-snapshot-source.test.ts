import { afterEach, expect, test } from 'bun:test';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeStorageDb,
  getRuntimeWalDb,
  processRuntime,
  saveEnvToDB,
} from '../../../runtime.ts';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { deleteKeyRange } from '../../../storage/database/level';
import { readSnapshotDocs } from '../../../storage/database/lifecycle';
import {
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
} from '../../../storage/keys';
import { cleanupRuntimeStorage } from '../../fixtures/jurisdiction/j-submit-crash-helpers';
import { createTestJReplica } from '../../helpers/j-replica';
import type { JurisdictionConfig } from '../../../entity/types';

const envs: Array<ReturnType<typeof createEmptyEnv>> = [];

afterEach(async () => {
  for (const env of envs.splice(0)) {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    if (env.runtimeId) cleanupRuntimeStorage(env.runtimeId);
  }
});

const buildSnapshottingEnv = async () => {
  const seed = `snapshot-source ${process.pid} ${Date.now()} alpha beta gamma`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  cleanupRuntimeStorage(runtimeId);
  const env = createEmptyEnv(seed);
  envs.push(env);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: { ...env.runtimeConfig?.storage, snapshotPeriodFrames: 1 },
  };
  const jurisdiction: JurisdictionConfig = {
    name: 'SnapshotSource', address: 'browservm://snapshot-source', chainId: 31337,
    depositoryAddress: `0x${'11'.repeat(20)}`, entityProviderAddress: `0x${'12'.repeat(20)}`,
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name, rpcs: [], chainId: jurisdiction.chainId,
    contracts: {
      depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress,
      account: `0x${'13'.repeat(20)}`, deltaTransformer: `0x${'14'.repeat(20)}`,
    },
  }));
  registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([runtimeId], 1n).toLowerCase();
  enqueueRuntimeInput(env, {
    runtimeTxs: [createTestEntityImportRuntimeTx(env, {
      entityId, signerId: runtimeId,
      data: {
        isProposer: true,
        config: {
          mode: 'proposer-based', threshold: 1n, validators: [runtimeId], shares: { [runtimeId]: 1n }, jurisdiction,
        },
      },
    })],
    entityInputs: [],
  });
  await processRuntime(env, []);
  return { env, entityId };
};

test('a snapshot is copied from the authoritative WAL, never from a divergent current cache', async () => {
  // createSnapshot read live Entity/Account/Book rows from the disposable
  // current cache. Under matching heads the pre-snapshot check is structural,
  // so a cache that lost rows froze that loss into the durable snapshot.
  const { env, entityId } = await buildSnapshottingEnv();
  const current = getRuntimeStorageDb(env);
  for (const tag of [KEY_LIVE_ENTITY, KEY_LIVE_ENTITY_FIELD, KEY_LIVE_ENTITY_BRANCH, KEY_LIVE_ENTITY_LEAF]) {
    await deleteKeyRange(current, { prefix: Buffer.from([tag]) });
  }
  env.state.height += 1;
  env.state.timestamp += 1;
  await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());

  const docs = await readSnapshotDocs(getRuntimeWalDb(env), env.state.height);
  expect(docs.filter(doc => doc.family === 'entity').map(doc => doc.entityId)).toEqual([entityId]);
});
