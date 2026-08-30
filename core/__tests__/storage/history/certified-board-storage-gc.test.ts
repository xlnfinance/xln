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
  lookupCertifiedBoardRecord,
  putCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';
import { applyRuntimeStorageChanges } from '../../../runtime/observability/env-events';
import { createEmptyEnv, enqueueRuntimeInput, processRuntime } from '../../../runtime';
import { inspectStorage, saveRuntimeFrameToStorage } from '../../../storage';
import {
  KEY_CERTIFIED_BOARD_NODE,
  KEY_HEAD,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_BOOK,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
  KEY_LIVE_REPLICA_META,
  keyCertifiedBoardNodePrefix,
  keySnapshotGraphPrefix,
} from '../../../storage/keys';
import { measurePrefixBytes } from '../../../storage/database/level';
import { hydrateCertifiedBoardRootNodesFromStorage, readStorageHead } from '../../../storage/read/read';
import { decodeBuffer } from '../../../storage/codec/codec';
import { validatePersistedCertifiedBoardPathNode } from '../../../storage/schema/authoritative-schema';
import type { RuntimeDbLike } from '../../../storage/types';
import type { CertifiedBoardRecord } from '../../../types/entity-board-registry';
import type { EntityReplica, JurisdictionConfig } from '../../../entity/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { getPerfMs } from '../../../support/time';

const snapshotHasBoardHash = async (
  db: RuntimeDbLike,
  height: number,
  hash: string,
): Promise<boolean> => {
  const prefix = keySnapshotGraphPrefix(height, keyCertifiedBoardNodePrefix());
  for await (const rawKey of db.keys?.({ prefix }) ?? []) {
    const key = Buffer.from(rawKey);
    if (!key.subarray(0, prefix.byteLength).equals(prefix)) continue;
    const row = validatePersistedCertifiedBoardPathNode(decodeBuffer(await db.get(key)));
    if (row.hash === hash) return true;
  }
  return false;
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
          mode: 'proposer-based', threshold: 1n, validators: [signerId],
          shares: { [signerId]: 1n }, jurisdiction,
        },
      },
    })],
    entityInputs: [],
  });
  await processRuntime(env, []);
  const replica = Array.from(env.state.eReplicas.values())[0]!;
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
      entityContexts: new Map(),
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => currentDb,
      tryOpenRuntimeWalDb: async () => true,
      getRuntimeWalDb: () => historyDb,
      getPerfMs,
      formatPerfMs: (value) => value.toFixed(2),
    });
    const roots: string[] = [];
    const records: CertifiedBoardRecord[] = [];
    const livePrefixes = new Set([
      KEY_LIVE_ENTITY,
      KEY_LIVE_ENTITY_FIELD,
      KEY_LIVE_ENTITY_BRANCH,
      KEY_LIVE_ENTITY_LEAF,
      KEY_LIVE_ACCOUNT,
      KEY_LIVE_ACCOUNT_FIELD,
      KEY_LIVE_ACCOUNT_BRANCH,
      KEY_LIVE_ACCOUNT_LEAF,
      KEY_LIVE_BOOK,
      KEY_LIVE_BOOK_BRANCH,
      KEY_LIVE_BOOK_LEAF,
      KEY_LIVE_REPLICA_META,
      KEY_CERTIFIED_BOARD_NODE,
    ]);
    const measureRetainedBytes = async (): Promise<number> => {
      let total = 0;
      for await (const [key, value] of historyDb.iterator()) {
        if (Buffer.compare(key, KEY_HEAD) === 0) continue;
        // Rebuildable history-view indexes use the 0x01..0x05 namespace and
        // are deliberately outside the authoritative retained-byte budget.
        if (key[0] !== undefined && key[0] <= 0x05) continue;
        if (livePrefixes.has(key[0]!)) continue;
        total += key.byteLength + value.byteLength;
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
        env.state.height += 1;
        env.state.timestamp += 1;
      }
      applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
      await save();
      roots.push(updated.root);
      records.push(record);

      if (epoch === 1) {
        expect((await readStorageHead(historyDb))?.retainedWalBytes).toBe(await measureRetainedBytes());
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
        expect(await snapshotHasBoardHash(historyDb, 1, roots[0]!)).toBe(true);
      }
    }

    expect(await snapshotHasBoardHash(historyDb, 1, roots[0]!)).toBe(false);
    expect((await readStorageHead(historyDb))?.retainedWalBytes).toBe(await measureRetainedBytes());
    for (const index of [1, 2]) {
      const restored = createEmptyEnv(`certified board gc restore ${index} alpha beta gamma`);
      await hydrateCertifiedBoardRootNodesFromStorage(restored, historyDb, roots[index], index + 1);
      expect(lookupCertifiedBoardRecord(
        getCertifiedBoardNodeStore(restored), roots[index]!, stackKey, entityId,
      )).toEqual(records[index]);
    }
  } finally {
    try {
      await currentDb.close();
    } finally {
      await historyDb.close();
      rmSync(dbRoot, { recursive: true, force: true });
    }
  }
});
