import { expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import {
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
  verifyConsumptionProof,
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
import { generateLazyEntityId } from '../entity/factory';
import { markStorageEntityDirty } from '../machine/env-events';
import { createEmptyEnv, enqueueRuntimeInput, process as processRuntime } from '../runtime';
import { recoverStorageDbFromHistory, saveRuntimeFrameToStorage } from '../storage';
import { keyConsumptionNode } from '../storage/keys';
import { hydrateConsumptionRootNodesFromStorage } from '../storage/read';
import type { RuntimeDbLike } from '../storage/types';
import type { EntityReplica, JReplica, JurisdictionConfig } from '../types';
import { getPerfMs } from '../utils';

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
      const operations: Array<
        { type: 'put'; key: Buffer; value: Buffer } | { type: 'del'; key: Buffer }
      > = [];
      return {
        put: (key, value) => operations.push({
          type: 'put', key: Buffer.from(key), value: Buffer.from(value),
        }),
        del: (key) => operations.push({ type: 'del', key: Buffer.from(key) }),
        write: async () => {
          writes.push(operations.map(({ key }) => key.toString('hex')));
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
  // This storage-only fixture mutates an H0 state directly instead of through
  // Entity consensus. The prior WAL checkpoint must not be silently rewritten;
  // return to the independently validated lazy-H0 anchor before the next save.
  const { runtimeCheckpoint: _priorRuntimeCheckpoint, ...genesis } = replica.certifiedFrameAnchor;
  replica.certifiedFrameAnchor = {
    ...genesis,
    stateRoot: computeCanonicalEntityConsensusStateHash(replica.state),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replica.state)),
  };
};

test('snapshot retention keeps old witnesses until their roots are pruned, then collects them', async () => {
  const seed = 'consumption history gc alpha beta gamma';
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(seed, signerId, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const jurisdiction: JurisdictionConfig = {
    name: 'consumption-history-gc',
    address: 'browservm://consumption-history-gc',
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

  let accumulator = createEmptyConsumptionAccumulator();
  let replacement: ReturnType<typeof applyConsumptionOutput> | undefined;
  let replacementIdentity: Parameters<typeof applyConsumptionOutput>[1] | undefined;
  for (let outputIndex = 0; outputIndex < 256; outputIndex += 1) {
    const suffix = outputIndex.toString(16).padStart(64, '0');
    const identity = {
      targetEntityId: entityId,
      sourceEntityId: `0x${suffix}`,
      lane: 'generic' as const,
      sequence: 1,
      semanticHash: `0x${suffix}`,
      outputHash: `0x${suffix}`,
      outputHanko: `0x${outputIndex.toString(16).padStart(2, '0')}`,
    };
    const proof = createConsumptionProof(
      getConsumptionNodeStore(env), accumulator.root, getConsumptionKey(identity),
    );
    const applied = applyConsumptionOutput(accumulator, identity, proof);
    if (applied.replacedNodeHashes.length > 0) {
      replacement = applied;
      replacementIdentity = identity;
      break;
    }
    cacheCommittedConsumptionNodeChanges(env, applied);
    accumulator = applied.state;
  }
  if (!replacement || !replacementIdentity) throw new Error('CONSUMPTION_GC_REPLACEMENT_NOT_FOUND');

  replica.state = { ...replica.state, consumptionAccumulator: accumulator };
  refreshGenesisAnchor(replica);
  markStorageEntityDirty(env, entityId);
  env.runtimeConfig = {
    storage: {
      enabled: true,
      materializePeriodFrames: 1,
      snapshotPeriodFrames: 1,
      retainSnapshots: 1,
      canonicalHashPeriodFrames: 1,
    },
  };
  const currentDb = makeAtomicMemoryDb();
  const historyDb = makeAtomicMemoryDb();
  const save = () => saveRuntimeFrameToStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => currentDb,
    tryOpenFrameDb: async () => true,
    getFrameDb: () => historyDb,
    getPerfMs,
    formatPerfMs: (value) => value.toFixed(2),
  });

  await save();
  const replacedHash = replacement.replacedNodeHashes[0]!;
  expect(await isMissing(historyDb, keyConsumptionNode(replacedHash))).toBe(false);

  cacheCommittedConsumptionNodeChanges(env, replacement);
  accumulator = replacement.state;
  replica.state = { ...replica.state, consumptionAccumulator: accumulator };
  refreshGenesisAnchor(replica);
  env.height += 1;
  env.timestamp += 1;
  markStorageEntityDirty(env, entityId);
  await save();

  expect(await isMissing(historyDb, keyConsumptionNode(replacedHash))).toBe(true);
  expect(await isMissing(currentDb, keyConsumptionNode(replacedHash))).toBe(true);
  const rebuiltCurrent = makeAtomicMemoryDb();
  await recoverStorageDbFromHistory({
    db: rebuiltCurrent,
    historyDb,
    config: {
      enabled: true,
      snapshotPeriodFrames: 1,
      retainSnapshots: 1,
      epochMaxBytes: 256 * 1024 * 1024,
      frameDbMaxBytes: 1024 * 1024 * 1024,
      frameDbRetainFrames: 100_000,
      materializePeriodFrames: 1,
      canonicalHashPeriodFrames: 1,
      accountMerkleRadix: 16,
    },
  });
  const restoredEnv = createEmptyEnv('consumption history gc restored alpha beta gamma');
  await hydrateConsumptionRootNodesFromStorage(restoredEnv, rebuiltCurrent, accumulator);
  const restoredStore = getConsumptionNodeStore(restoredEnv);
  expect(verifyConsumptionProof(
    accumulator.root,
    getConsumptionKey(replacementIdentity),
    createConsumptionProof(restoredStore, accumulator.root, getConsumptionKey(replacementIdentity)),
  )).toEqual({
    status: 'member',
    value: expect.objectContaining({
      lastContiguousSeq: 1n,
      lastSemanticHash: replacementIdentity.semanticHash,
      lastOutputHash: replacementIdentity.outputHash,
    }),
  });
});
