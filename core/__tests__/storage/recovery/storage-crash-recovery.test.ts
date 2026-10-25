import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { deriveSignerAddressSync } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeStorageDb,
  getRuntimeWalDb,
  processRuntime,
  saveEnvToDB,
} from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { createTestJReplica } from '../../helpers/j-replica';
import { recoverStorageDbFromWal } from '../../../storage';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { KEY_HEAD } from '../../../storage/keys';
import { resolveDbPath } from '../../../storage/runtime-db-path';
import { preparePathKeyedAuxiliaryRows } from '../../../storage/schema/nodes/path-keyed-auxiliary-nodes';
import { validatePersistedCertifiedBoardPathNode } from '../../../storage/schema/authoritative-schema';
import type { StorageHead, StorageRuntimeConfig } from '../../../storage/types';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  cacheCertifiedBoardNodes,
  createEmptyCertifiedBoardRegistryState,
  getCertifiedBoardStackKey,
  putCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';

const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 1_000_000,
  materializePeriodFrames: 1,
  accountMerkleRadix: 16,
};
let env: RuntimeReplica;

beforeEach(() => {
  const seed = `storage-crash-recovery ${process.pid} ${crypto.randomUUID()}`;
  env = createEmptyEnv(seed);
  env.runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  env.dbNamespace = env.runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { ...env.runtimeConfig, storage: config };
});

afterEach(async () => {
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-events', '-infra']) {
    rmSync(`${resolveDbPath(env)}${suffix}`, { recursive: true, force: true });
  }
});

describe('storage crash recovery', () => {
  test('copies path-keyed certified-board nodes before publishing recovered current head', async () => {
    if (!env.runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    const signerId = env.runtimeId;
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const jurisdiction = {
      name: 'storage-crash-recovery',
      address: 'browservm://storage-crash-recovery',
      chainId: 31_337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      entityProviderAddress: `0x${'22'.repeat(20)}`,
    };
    env.state.jReplicas.set(
      jurisdiction.name,
      createTestJReplica({
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
      }),
    );
    enqueueRuntimeInput(env, {
      runtimeTxs: [
        createTestEntityImportRuntimeTx(env, {
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
        }),
      ],
      entityInputs: [],
    });
    await processRuntime(env);
    const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
    if (!replica) throw new Error('TEST_ENTITY_REPLICA_MISSING');
    const stackKey = getCertifiedBoardStackKey(jurisdiction);
    const update = putCertifiedBoardRecord(new Map(), EMPTY_CERTIFIED_BOARD_ROOT, {
      stackKey,
      entityId,
      boardHash: `0x${'33'.repeat(32)}`,
      boardEpoch: 0,
      previousBoardHash: `0x${'00'.repeat(32)}`,
      previousBoardValidUntil: 0,
      source: 'EntityRegistered',
    });
    const boardStore = new Map(update.newNodes);
    replica.state = {
      ...replica.state,
      certifiedBoardState: { ...createEmptyCertifiedBoardRegistryState(jurisdiction), boardRegistryRoot: update.root },
    };
    cacheCertifiedBoardNodes(env, boardStore);
    env.state.height += 1;
    env.state.timestamp += 1;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
    const [row] = preparePathKeyedAuxiliaryRows({
      owners: [{ entityId, certifiedBoardRoot: update.root, accounts: [] }],
      certifiedBoardStore: boardStore,
      accountJClaimStore: new Map(),
    }).certifiedBoardNodes;
    if (!row) throw new Error('expected board path row');
    const currentDb = getRuntimeStorageDb(env);
    const historyDb = getRuntimeWalDb(env);
    expect(await historyDb.get(row.key)).toEqual(row.value);
    await currentDb.clear();
    const progress: string[] = [];
    const recovered = await recoverStorageDbFromWal({
      db: currentDb,
      walDb: historyDb,
      config,
      onPersistenceProgress: stage => {
        progress.push(stage);
      },
    });
    expect(recovered.recovered).toBe(true);
    expect(validatePersistedCertifiedBoardPathNode(decodeBuffer(await currentDb.get(row.key))).node).toEqual(
      [...boardStore.values()][0],
    );
    expect(await currentDb.get(KEY_HEAD)).toEqual(await historyDb.get(KEY_HEAD));
    expect(progress.indexOf('recovery-current-nodes-written')).toBeGreaterThanOrEqual(0);
    expect(progress.indexOf('recovery-current-head-published')).toBeGreaterThan(
      progress.indexOf('recovery-current-nodes-written'),
    );
  });

  test('rejects current DB state that is ahead of the authoritative Runtime WAL', async () => {
    env.state.height = 1;
    env.state.timestamp = 1_000;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
    const currentDb = getRuntimeStorageDb(env);
    const historyDb = getRuntimeWalDb(env);
    const head = decodeBuffer<StorageHead>(await currentDb.get(KEY_HEAD));
    await currentDb.put(KEY_HEAD, encodeBuffer({ ...head, latestHeight: head.latestHeight + 1 }));

    await expect(recoverStorageDbFromWal({ db: currentDb, walDb: historyDb, config })).rejects.toThrow(
      'STORAGE_CURRENT_AHEAD_OF_WAL',
    );
  });
});
