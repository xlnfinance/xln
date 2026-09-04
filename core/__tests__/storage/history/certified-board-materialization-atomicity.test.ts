import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Level } from 'level';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import {
  cacheCertifiedBoardNodes,
  createEmptyCertifiedBoardRegistryState,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  putCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';
import { generateLazyEntityId } from '../../../entity/factory';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { applyRuntimeStorageChanges } from '../../../runtime/observability/env-events';
import { createEmptyEnv, enqueueRuntimeInput, processRuntime } from '../../../runtime';
import { saveRuntimeFrameToStorage } from '../../../storage';
import { keyLiveEntity } from '../../../storage/keys';
import { readStorageHead, hydrateCertifiedBoardRootNodesFromStorage } from '../../../storage/read/read';
import { readEntityStorageLayout } from '../../../storage/schema/entity/layout';
import type { EntityReplica, JurisdictionConfig } from '../../../entity/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import type { CertifiedBoardRecord } from '../../../types/entity-board-registry';
import { getPerfMs } from '../../../support/time';

const refreshGenesisAnchor = (replica: EntityReplica): void => {
  if (replica.certifiedFrameAnchor?.height !== 0) return;
  const { runtimeCheckpoint: _priorRuntimeCheckpoint, ...genesis } = replica.certifiedFrameAnchor;
  replica.certifiedFrameAnchor = {
    ...genesis,
    stateRoot: computeCanonicalEntityConsensusStateHash(replica.state),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replica.state)),
  };
};

test('materializes certified-board root and path nodes atomically', async () => {
  const seed = 'certified board materialization atomicity alpha beta gamma';
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(seed, signerId, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const jurisdiction: JurisdictionConfig = {
    name: 'certified-board-materialization-atomicity',
    address: 'browservm://certified-board-materialization-atomicity',
    chainId: 31_337,
    depositoryAddress: `0x${'31'.repeat(20)}`,
    entityProviderAddress: `0x${'32'.repeat(20)}`,
  };
  const rpcAddress = jurisdiction.address;
  if (!rpcAddress) throw new Error('TEST_JURISDICTION_RPC_MISSING');
  const env = createEmptyEnv(seed);
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { enabled: false } };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, {
    ...jurisdiction,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    rpcs: [rpcAddress],
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

  const replica = [...env.state.eReplicas.values()][0];
  if (!replica) throw new Error('TEST_ENTITY_REPLICA_MISSING');
  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  const dbRoot = mkdtempSync(join(tmpdir(), 'xln-certified-board-atomic-'));
  const currentDb = new Level<Buffer, Buffer>(join(dbRoot, 'current'), {
    keyEncoding: 'buffer', valueEncoding: 'buffer',
  });
  const walDb = new Level<Buffer, Buffer>(join(dbRoot, 'wal'), {
    keyEncoding: 'buffer', valueEncoding: 'buffer',
  });
  await Promise.all([currentDb.open(), walDb.open()]);
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: {
      enabled: true,
      materializePeriodFrames: 2,
      snapshotPeriodFrames: 10_000,
      canonicalHashPeriodFrames: 1,
    },
  };

  const save = () => saveRuntimeFrameToStorage({
    entityContexts: new Map(),
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => currentDb,
    tryOpenRuntimeWalDb: async () => true,
    getRuntimeWalDb: () => walDb,
    getPerfMs,
    formatPerfMs: value => value.toFixed(2),
  });
  const installBoard = (epoch: number): string => {
    const previous = replica.state.certifiedBoardState
      ?? createEmptyCertifiedBoardRegistryState(jurisdiction);
    const record: CertifiedBoardRecord = {
      stackKey,
      entityId,
      boardHash: `0x${epoch.toString(16).padStart(64, '0')}`,
      boardEpoch: epoch,
      previousBoardHash: `0x${Math.max(0, epoch - 1).toString(16).padStart(64, '0')}`,
      previousBoardValidUntil: 0,
      activatedAtJHeight: epoch,
      logIndex: 0,
      blockHash: `0x${(epoch + 10).toString(16).padStart(64, '0')}`,
      transactionHash: `0x${(epoch + 20).toString(16).padStart(64, '0')}`,
      source: epoch === 1 ? 'EntityRegistered' : 'BoardActivated',
    };
    const updated = putCertifiedBoardRecord(
      getCertifiedBoardNodeStore(env),
      previous.boardRegistryRoot,
      record,
    );
    cacheCertifiedBoardNodes(env, updated.newNodes);
    replica.state = {
      ...replica.state,
      certifiedBoardState: { ...previous, boardRegistryRoot: updated.root },
    };
    refreshGenesisAnchor(replica);
    applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
    return updated.root;
  };

  try {
    const rootA = installBoard(1);
    expect((await save()).materialized).toBe(true);

    env.state.height += 1;
    env.state.timestamp += 1;
    const rootB = installBoard(2);
    expect((await save()).materialized).toBe(false);
    expect((await readStorageHead(walDb))?.latestMaterializedHeight).toBe(1);
    expect(env.infrastructure?.pendingCertifiedBoardNodes?.size ?? 0).toBeGreaterThan(0);

    const beforeCadence = await readEntityStorageLayout(walDb, entityId, keyLiveEntity(entityId));
    expect(beforeCadence?.doc.certifiedBoardState?.boardRegistryRoot).toBe(rootA);
    await hydrateCertifiedBoardRootNodesFromStorage(createEmptyEnv(`${seed}:a`), walDb, rootA);
    await expect(
      hydrateCertifiedBoardRootNodesFromStorage(createEmptyEnv(`${seed}:b-missing`), walDb, rootB),
    ).rejects.toThrow(`CERTIFIED_BOARD_PATH_NODE_MISSING:${rootB}`);

    env.state.height += 1;
    env.state.timestamp += 1;
    expect((await save()).materialized).toBe(true);
    const atCadence = await readEntityStorageLayout(walDb, entityId, keyLiveEntity(entityId));
    expect(atCadence?.doc.certifiedBoardState?.boardRegistryRoot).toBe(rootB);
    await hydrateCertifiedBoardRootNodesFromStorage(createEmptyEnv(`${seed}:b`), walDb, rootB);
    expect(env.infrastructure?.pendingCertifiedBoardNodes?.size ?? 0).toBe(0);
  } finally {
    try {
      await currentDb.close();
    } finally {
      await walDb.close();
      rmSync(dbRoot, { recursive: true, force: true });
    }
  }
});
