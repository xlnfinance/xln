import { expect, test } from 'bun:test';

import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
} from '../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import {
  applyConsumptionOutput,
  createEmptyConsumptionAccumulator,
  MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY,
} from '../entity/consumption-accumulator';
import {
  cacheCommittedConsumptionNodeChanges,
  getConsumptionNodeStore,
} from '../entity/consumption-store';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import { applyRuntimeStorageChanges } from '../machine/env-events';
import { recoverStorageDbFromHistory, saveRuntimeFrameToStorage } from '../storage';
import { decodeBuffer } from '../storage/codec';
import { KEY_HEAD, keyConsumptionNode, keyDiff, keyLiveEntity } from '../storage/keys';
import type { RuntimeDbLike, StorageEntityCoreDoc, StorageHead } from '../storage/types';
import type { JReplica, JurisdictionConfig } from '../types';
import { getPerfMs } from '../utils';
import { buildRuntimeCheckpointSnapshot } from '../wal/snapshot';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
import { LIMITS } from '../constants';

type RecordedDb = RuntimeDbLike & { writes: string[][] };

const makeAtomicMemoryDb = (): RecordedDb => {
  const store = new Map<string, { key: Buffer; value: Buffer }>();
  const writes: string[][] = [];
  return {
    writes,
    get: async (key) => {
      const item = store.get(key.toString('hex'));
      if (item) return Buffer.from(item.value);
      const error = new Error('NotFound') as Error & { code?: string };
      error.code = 'LEVEL_NOT_FOUND';
      throw error;
    },
    batch: () => {
      const operations: Array<{ type: 'put'; key: Buffer; value: Buffer } | { type: 'del'; key: Buffer }> = [];
      return {
        put: (key, value) => { operations.push({ type: 'put', key: Buffer.from(key), value: Buffer.from(value) }); },
        del: (key) => { operations.push({ type: 'del', key: Buffer.from(key) }); },
        write: async () => {
          writes.push(operations.map((operation) => operation.key.toString('hex')));
          for (const operation of operations) {
            const hex = operation.key.toString('hex');
            if (operation.type === 'del') store.delete(hex);
            else store.set(hex, { key: operation.key, value: operation.value });
          }
        },
      };
    },
    keys: async function* (options) {
      const keys = Array.from(store.values(), ({ key }) => key).sort(Buffer.compare);
      if (options?.reverse) keys.reverse();
      for (const key of keys) {
        if (options?.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options?.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield Buffer.from(key);
      }
    },
  };
};

test('normal frame atomically publishes accumulator root, witness node, diff, and head', async () => {
  const seed = 'consumption atomic storage alpha beta gamma';
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(seed, signerId, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const jurisdiction: JurisdictionConfig = {
    name: 'consumption-atomic',
    address: 'browservm://consumption-atomic',
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
  const replica = Array.from(env.eReplicas.values())[0]!;
  const identity = {
    targetEntityId: entityId,
    sourceEntityId: `0x${'22'.repeat(32)}`,
    lane: 'generic' as const,
    sequence: 1,
    semanticHash: `0x${'33'.repeat(32)}`,
    outputHash: `0x${'44'.repeat(32)}`,
    outputHanko: '0x01',
  };
  const applied = applyConsumptionOutput(createEmptyConsumptionAccumulator(), identity, {
    version: 2,
    nodes: [],
  });
  replica.state = { ...replica.state, consumptionAccumulator: applied.state };
  if (replica.certifiedFrameAnchor?.height === 0) {
    replica.certifiedFrameAnchor = {
      ...replica.certifiedFrameAnchor,
      stateRoot: computeCanonicalEntityConsensusStateHash(replica.state),
      authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replica.state)),
    };
  }
  cacheCommittedConsumptionNodeChanges(env, {
    newNodes: applied.newNodes,
    replacedNodeHashes: applied.replacedNodeHashes,
  });
  const node = applied.newNodes[0]!;
  const checkpoint = buildRuntimeCheckpointSnapshot(env);
  const checkpointState = checkpoint['runtimeState'] as { consumptionNodes?: Map<string, unknown> };
  expect(checkpointState.consumptionNodes?.size).toBe(1);
  const store = getConsumptionNodeStore(env);
  store.delete(node.hash);
  expect(() => buildRuntimeCheckpointSnapshot(env)).toThrow(`CONSUMPTION_NODE_MISSING:${node.hash}`);
  if (node.node.type !== 'leaf') throw new Error('CONSUMPTION_ATOMIC_EXPECTED_LEAF');
  store.set(node.hash, {
    ...node.node,
    value: { ...node.node.value, lastSemanticHash: `0x${'ff'.repeat(32)}` },
  });
  expect(() => buildRuntimeCheckpointSnapshot(env)).toThrow(`CONSUMPTION_NODE_CORRUPT:${node.hash}`);
  store.set(node.hash, node.node);
  applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
  env.runtimeConfig = {
    storage: {
      enabled: true,
      materializePeriodFrames: 1,
      snapshotPeriodFrames: 256,
      canonicalHashPeriodFrames: 1,
    },
  };

  const currentDb = makeAtomicMemoryDb();
  const historyDb = makeAtomicMemoryDb();
  await saveRuntimeFrameToStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => currentDb,
    tryOpenFrameDb: async () => true,
    getFrameDb: () => historyDb,
    getPerfMs,
    formatPerfMs: (value) => value.toFixed(2),
  });

  const atomicHistoryWrite = historyDb.writes.find((keys) => (
    keys.includes(KEY_HEAD.toString('hex')) &&
    keys.includes(keyDiff(env.height).toString('hex')) &&
    keys.includes(keyConsumptionNode(node.hash).toString('hex'))
  ));
  expect(atomicHistoryWrite).toBeDefined();
  expect(decodeBuffer(await historyDb.get(keyConsumptionNode(node.hash)))).toEqual(node.node);
  // Frame 1 is also the mandatory recovery snapshot anchor, so its diff is
  // pruned only after the complete snapshot is published. The atomic write
  // above proves the root-bearing diff and witness node crossed the durable
  // boundary together; the materialized cache proves the published value.
  const persistedEntity = decodeBuffer<StorageEntityCoreDoc>(await currentDb.get(keyLiveEntity(entityId)));
  expect(persistedEntity.consumptionAccumulator).toEqual(applied.state);

  const rebuiltCurrent = makeAtomicMemoryDb();
  await recoverStorageDbFromHistory({
    db: rebuiltCurrent,
    historyDb,
    config: {
      enabled: true,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 256 * 1024 * 1024,
      frameDbMaxBytes: 1024 * 1024 * 1024,
      frameDbRetainFrames: 100_000,
      materializePeriodFrames: 1,
      canonicalHashPeriodFrames: 1,
      accountMerkleRadix: 16,
    },
  });
  expect(decodeBuffer(await rebuiltCurrent.get(keyConsumptionNode(node.hash)))).toEqual(node.node);
  expect(decodeBuffer<StorageHead>(await rebuiltCurrent.get(KEY_HEAD)).latestHeight).toBe(env.height);

  const projected = projectEntityCoreDoc(replica.state);
  const overflowSequences = new Map(Array.from(
    { length: LIMITS.MAX_ACCOUNTS_PER_ENTITY + 1 },
    (_, index) => [
      `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`,
      { lastSequence: 1n, lastSemanticHash: `0x${'55'.repeat(32)}` },
    ],
  ));
  expect(() => hydrateEntityStateFromStorage({
    core: { ...projected, certifiedOutputSequences: overflowSequences },
    accounts: new Map(),
    books: new Map(),
  })).toThrow('STORAGE_CERTIFIED_OUTPUT_RELATIONSHIP_LIMIT_EXCEEDED');
  expect(() => hydrateEntityStateFromStorage({
    core: {
      ...projected,
      consumptionAccumulator: {
        version: 2,
        root: `0x${'66'.repeat(32)}`,
        count: MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY + 1n,
      },
    },
    accounts: new Map(),
    books: new Map(),
  })).toThrow('CONSUMPTION_RELATIONSHIP_LIMIT_EXCEEDED');
});
