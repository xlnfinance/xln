import { Level } from 'level';
import { collectReachableAccountJClaimNodes } from '../../account/j-claims/j-claim-accumulator';
import { getAccountJClaimNodeStore, getLiveAccountJClaimAccumulatorStates } from '../../entity/account/account-j-claim-node-store';
import {
  collectReachableConsumptionNodes,
  getConsumptionNodeStore,
  getLiveConsumptionAccumulatorStates,
} from '../../entity/consumption/consumption-store';
import { collectReachableCertifiedBoardNodes, getCertifiedBoardNodeStore } from '../../jurisdiction/machine/board-registry';
import {
  assertCertifiedJHistoryIntegrity,
  assertValidatorJHistoryMatchesCertifiedAnchor,
} from '../../jurisdiction/machine/local-history';
import { ensureRuntimeInfrastructure } from '../../runtime/infrastructure/runtime-infrastructure';
import type { RuntimeReplica } from '../../runtime/types';
import { buildDurableOutputRetryState } from '../../runtime/delivery/durable-output-retry';
import { clearDatabase } from '../database/clear-database';
import { computeCanonicalEntityHash, computeCanonicalRuntimeStateHash } from '../canonical-hash';
import { buildCertifiedEntityLineagePlan } from '../replica/entity-lineage';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  STORAGE_SCHEMA_VERSION,
} from '../keys';
import { hydrateEntityStateFromStorage, projectAccountDoc, projectEntityCoreDoc } from '../read/projections';
import { buildStorageReplicaMetaCommitment } from '../replica/replicas';
import { replaceRestoredStorageBase } from '../index';
import { type StorageDbRole, withStorageWriterLock } from '../runtime-dbs';
import type { StorageDoc, StoragePersistenceBoundaryHook } from '../types';
import { buildStorageRuntimeMachineSnapshot } from '../wal/snapshot';

export interface PersistRestoredRuntimeDeps {
  getStorageDb(env: RuntimeReplica, role?: StorageDbRole): Level<Buffer, Buffer>;
  getRuntimeWalDb(env: RuntimeReplica): Level<Buffer, Buffer>;
  tryOpenStorageDb(env: RuntimeReplica, role?: StorageDbRole): Promise<boolean>;
  tryOpenRuntimeWalDb(env: RuntimeReplica): Promise<boolean>;
}

export interface PersistRestoredRuntimeOptions {
  onPersistenceBoundary?: StoragePersistenceBoundaryHook;
}

const collectCertifiedStorageDocs = (
  lineagePlan: ReturnType<typeof buildCertifiedEntityLineagePlan>,
): { docs: StorageDoc[]; canonicalEntityHashes: ReturnType<typeof computeCanonicalEntityHash>[] } => {
  const docs: StorageDoc[] = [];
  const canonicalEntityHashes: ReturnType<typeof computeCanonicalEntityHash>[] = [];

  for (const [entityId, selected] of lineagePlan.lookup.entries()) {
    const core = projectEntityCoreDoc(selected.state);
    // This is a cold recovery projection, not a machine clone: each decoded
    // value is projected once into the exact storage boundary representation.
    const accounts = new Map<string, ReturnType<typeof projectAccountDoc>>();
    for (const [counterpartyId, account] of selected.state.accounts) {
      accounts.set(String(counterpartyId || '').toLowerCase(), projectAccountDoc(account));
    }
    const books = new Map<string, NonNullable<typeof selected.state.orderbookExt>['books'] extends ReadonlyMap<string, infer B> ? B : never>();
    for (const [pairId, book] of selected.state.orderbookExt?.books ?? []) {
      books.set(String(pairId || '').trim(), book);
    }
    const projectedState = hydrateEntityStateFromStorage({ core, accounts, books });
    const expectedHash = computeCanonicalEntityHash(selected.replica);
    const projectedHash = computeCanonicalEntityHash({ ...selected.replica, state: projectedState });
    if (projectedHash.hash !== expectedHash.hash) {
      throw new Error(
        `RECOVERY_IMPORT_PROJECTED_ENTITY_HASH_MISMATCH:entity=${entityId}:` +
          `expected=${expectedHash.hash}:projected=${projectedHash.hash}`,
      );
    }
    canonicalEntityHashes.push(expectedHash);
    docs.push({ family: 'entity', entityId, value: core });

    for (const [counterpartyId, account] of accounts) {
      if (!counterpartyId || !account) continue;
      docs.push({ family: 'account', entityId, counterpartyId, value: account });
    }
    for (const [pairId, book] of books) {
      if (!pairId || !book) continue;
      docs.push({ family: 'book', entityId, pairId, value: book });
    }
  }
  return { docs, canonicalEntityHashes };
};

const readRestoredFrameCoordinates = (env: RuntimeReplica): { height: number; timestamp: number } => {
  const height = Number(env.state.height);
  const timestamp = Number(env.state.timestamp);
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error('RECOVERY_PERSIST_HEIGHT_REQUIRED');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('RECOVERY_PERSIST_TIMESTAMP_INVALID');
  }
  return { height, timestamp };
};

const persistRestoredRuntimeStateUnlocked = async (
  deps: PersistRestoredRuntimeDeps,
  env: RuntimeReplica,
  coordinates: { height: number; timestamp: number },
  options: PersistRestoredRuntimeOptions,
): Promise<void> => {
  for (const replica of env.state.eReplicas.values()) {
    assertCertifiedJHistoryIntegrity(replica.state);
    assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
  }
  const lineagePlan = buildCertifiedEntityLineagePlan(env);
  const materialized = collectCertifiedStorageDocs(lineagePlan);
  const boardNodes = collectReachableCertifiedBoardNodes(
    getCertifiedBoardNodeStore(env),
    Array.from(env.state.eReplicas.values(), ({ state }) => state.certifiedBoardState?.boardRegistryRoot).filter(
      (root): root is string => Boolean(root),
    ),
  );
  const consumptionNodes = collectReachableConsumptionNodes(
    getConsumptionNodeStore(env),
    getLiveConsumptionAccumulatorStates(env),
  );
  const accountJClaimNodes = collectReachableAccountJClaimNodes(
    getAccountJClaimNodeStore(env),
    getLiveAccountJClaimAccumulatorStates(env),
  );
  const runtimeOutputs = env.pendingNetworkOutputs ?? [];
  const runtimeOutputRetryState = buildDurableOutputRetryState(env, runtimeOutputs);
  const runtimeMachine = buildStorageRuntimeMachineSnapshot(env);
  const canonicalStateHash = computeCanonicalRuntimeStateHash(
    coordinates.height,
    coordinates.timestamp,
    materialized.canonicalEntityHashes,
    runtimeMachine,
  );

  if (!(await deps.tryOpenStorageDb(env, 'current'))) {
    throw new Error('RECOVERY_PERSIST_STORAGE_OPEN_FAILED');
  }
  if (!(await deps.tryOpenRuntimeWalDb(env))) throw new Error('RECOVERY_PERSIST_RUNTIME_WAL_OPEN_FAILED');

  await replaceRestoredStorageBase({
    currentDb: deps.getStorageDb(env, 'current'),
    walDb: deps.getRuntimeWalDb(env),
    ...coordinates,
    docs: materialized.docs,
    replicaMetas: buildStorageReplicaMetaCommitment(env, lineagePlan).entries,
    headConfig: {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      snapshotPeriodFrames: Math.max(
        1,
        Number(env.runtimeConfig?.storage?.snapshotPeriodFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES),
      ),
      retainSnapshots: Math.max(1, Number(env.runtimeConfig?.storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS)),
      epochMaxBytes: Math.max(1, Number(env.runtimeConfig?.storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES)),
      accountMerkleRadix: env.runtimeConfig?.storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
    },
    canonicalEntityHashes: materialized.canonicalEntityHashes,
    canonicalStateHash,
    runtimeMachine,
    runtimeOutputs,
    runtimeOutputRetryState,
    certifiedBoardNodes: Array.from(boardNodes, ([hash, node]) => ({ hash, node })),
    consumptionNodes: Array.from(consumptionNodes, ([hash, node]) => ({ hash, node })),
    accountJClaimNodes: Array.from(accountJClaimNodes, ([hash, node]) => ({ hash, node })),
    ...(options.onPersistenceBoundary ? { onPersistenceBoundary: options.onPersistenceBoundary } : {}),
  });
  if (await deps.tryOpenStorageDb(env, 'previous')) {
    await clearDatabase(deps.getStorageDb(env, 'previous'));
  }
  const state = ensureRuntimeInfrastructure(env);
  state.currentStorageOverlayMarks = new Map();
};

// Import replaces the entire local persistence base. It is never appended to the
// previous WAL: the recovered checkpoint becomes the first authoritative local frame.
export const persistRestoredRuntimeState = async (
  deps: PersistRestoredRuntimeDeps,
  env: RuntimeReplica,
  options: PersistRestoredRuntimeOptions = {},
): Promise<void> => {
  const coordinates = readRestoredFrameCoordinates(env);
  await withStorageWriterLock(env, () => persistRestoredRuntimeStateUnlocked(deps, env, coordinates, options));
};
