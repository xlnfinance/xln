import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Level } from 'level';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import {
  cacheCertifiedBoardNodes,
  createEmptyCertifiedBoardRegistryState,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  lookupCertifiedBoardRecord,
  putCertifiedBoardRecord,
} from '../jurisdiction/board-registry';
import { generateLazyEntityId } from '../entity/factory';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import { applyRuntimeStorageChanges } from '../machine/env-events';
import { createEmptyEnv, enqueueRuntimeInput, process as processRuntime } from '../runtime';
import { inspectStorage, saveRuntimeFrameToStorage } from '../storage';
import {
  KEY_CERTIFIED_BOARD_NODE,
  KEY_DIFF,
  KEY_FRAME,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_MANIFEST,
  KEY_SNAPSHOT_REPLICA_META,
  keyCertifiedBoardNode,
} from '../storage/keys';
import { measurePrefixBytes } from '../storage/level';
import { hydrateCertifiedBoardRootNodesFromStorage, readStorageHead } from '../storage/read';
import type { RuntimeDbLike } from '../storage/types';
import type { CertifiedBoardRecord, EntityReplica, JReplica, JurisdictionConfig } from '../types';
import { getPerfMs } from '../utils';

const isMissing = async (db: RuntimeDbLike, key: Buffer): Promise<boolean> => {
  try {
    await db.get(key);
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') return true;
    throw error;
  }
};

const refreshGenesisAnchor = (replica: EntityReplica): void => {
  if (replica.certifiedFrameAnchor?.height !== 0) return;
  const { runtimeCheckpoint: _priorRuntimeCheckpoint, ...genesis } = replica.certifiedFrameAnchor;
  replica.certifiedFrameAnchor = {
    ...genesis,
    stateRoot: computeCanonicalEntityConsensusStateHash(replica.state),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replica.state)),
  };
};

test('retained checkpoint roots preserve board witnesses until snapshot pruning makes them unreachable', async () => {
  const seed = 'certified board history gc alpha beta gamma';
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(seed, signerId, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const jurisdiction: JurisdictionConfig = {
    name: 'certified-board-history-gc',
    address: 'browservm://certified-board-history-gc',
    chainId: 31_337,
    depositoryAddress: `0x${'11'.repeat(20)}`,
    entityProviderAddress: `0x${'12'.repeat(20)}`,
  };
  const env = createEmptyEnv(seed);
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { storage: { enabled: false } };
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
          mode: 'proposer-based', threshold: 1n, validators: [signerId],
          shares: { [signerId]: 1n }, jurisdiction,
        },
      },
    }],
    entityInputs: [],
  });
  await processRuntime(env, []);
  const replica = Array.from(env.eReplicas.values())[0]!;
  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  const dbRoot = mkdtempSync(join(tmpdir(), 'xln-certified-board-gc-'));
  const currentDb = new Level<Buffer, Buffer>(join(dbRoot, 'current'), {
    keyEncoding: 'buffer', valueEncoding: 'buffer',
  });
  const historyDb = new Level<Buffer, Buffer>(join(dbRoot, 'history'), {
    keyEncoding: 'buffer', valueEncoding: 'buffer',
  });
  await Promise.all([currentDb.open(), historyDb.open()]);
  env.runtimeConfig = {
    storage: {
      enabled: true,
      materializePeriodFrames: 1,
      snapshotPeriodFrames: 1,
      retainSnapshots: 2,
      canonicalHashPeriodFrames: 1,
    },
  };
  try {
    const save = () => saveRuntimeFrameToStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => currentDb,
      tryOpenFrameDb: async () => true,
      getFrameDb: () => historyDb,
      getPerfMs,
      formatPerfMs: (value) => value.toFixed(2),
    });
    const roots: string[] = [];
    const records: CertifiedBoardRecord[] = [];
    const trackedPrefixes = [
      KEY_FRAME,
      KEY_DIFF,
      KEY_SNAPSHOT_MANIFEST,
      KEY_SNAPSHOT_ENTITY,
      KEY_SNAPSHOT_ACCOUNT,
      KEY_SNAPSHOT_BOOK,
      KEY_SNAPSHOT_REPLICA_META,
      KEY_CERTIFIED_BOARD_NODE,
    ];
    const measureRetainedBytes = async (): Promise<number> => {
      let total = 0;
      for (const prefix of trackedPrefixes) {
        total += (await measurePrefixBytes(historyDb, Buffer.from([prefix]))).bytes;
      }
      return total;
    };

    for (let epoch = 1; epoch <= 3; epoch += 1) {
      const previous = replica.state.certifiedBoardState ?? createEmptyCertifiedBoardRegistryState(jurisdiction);
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
      const updated = putCertifiedBoardRecord(getCertifiedBoardNodeStore(env), previous.boardRegistryRoot, record);
      cacheCertifiedBoardNodes(env, updated.newNodes);
      replica.state = {
        ...replica.state,
        certifiedBoardState: { ...previous, boardRegistryRoot: updated.root },
      };
      refreshGenesisAnchor(replica);
      if (epoch > 1) {
        env.height += 1;
        env.timestamp += 1;
      }
      applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
      await save();
      roots.push(updated.root);
      records.push(record);

      if (epoch === 1) {
        expect((await readStorageHead(historyDb))?.retainedHistoryBytes).toBe(await measureRetainedBytes());
        const stats = await inspectStorage({
          env,
          tryOpenDb: async () => true,
          getRuntimeDb: () => historyDb,
        });
        expect(stats?.certifiedBoardNodeCount).toBe(1);
        expect(stats?.certifiedBoardNodeBytes).toBe(
          (await measurePrefixBytes(historyDb, Buffer.from([KEY_CERTIFIED_BOARD_NODE]))).bytes,
        );
      }
      if (epoch === 2) {
        expect(await isMissing(historyDb, keyCertifiedBoardNode(roots[0]!))).toBe(false);
      }
    }

    expect(await isMissing(historyDb, keyCertifiedBoardNode(roots[0]!))).toBe(true);
    expect((await readStorageHead(historyDb))?.retainedHistoryBytes).toBe(await measureRetainedBytes());
    for (const index of [1, 2]) {
      const restored = createEmptyEnv(`certified board gc restore ${index} alpha beta gamma`);
      await hydrateCertifiedBoardRootNodesFromStorage(restored, historyDb, roots[index]);
      expect(lookupCertifiedBoardRecord(
        getCertifiedBoardNodeStore(restored), roots[index]!, stackKey, entityId,
      )).toEqual(records[index]);
    }
  } finally {
    try {
      await currentDb.close();
    } finally {
      try {
        await historyDb.close();
      } finally {
        rmSync(dbRoot, { recursive: true, force: true });
      }
    }
  }
});
