import { rebuildOrderbookPairIndex, type OrderbookExtState, type BookState } from '../orderbook';
import { ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
import { buildHexKeyedMerkle, type RadixMerkleRadix } from './merkle';
import { mergeStorageOverlayRecords, storageOverlayRecordKey } from './overlay';
import { decodeBuffer, encodeBuffer, notFound, writeBatch } from './codec';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_FRAME_DB_MAX_BYTES,
  DEFAULT_FRAME_DB_RETAIN_FRAMES,
  DEFAULT_MATERIALIZE_PERIOD_FRAMES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  EPOCH_SEED_FRAME_TAIL,
  FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME,
  FRAME_DB_ENTITY_ACTIVITY,
  FRAME_DB_RUNTIME_ACTIVITY,
  KEY_DIFF,
  KEY_FRAME,
  KEY_FRAME_DB_HEAD,
  KEY_HEAD,
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_BOOK,
  KEY_LIVE_DOC_HASH,
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_HASH,
  KEY_LIVE_REPLICA_META,
  KEY_PACK,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_BOOK,
  KEY_SNAPSHOT_ENTITY,
  KEY_SNAPSHOT_MANIFEST,
  STORAGE_SCHEMA_VERSION,
  STORAGE_VERIFY_TAIL_FRAMES,
  ZERO_FRAME_HASH,
  decodeEntityId,
  decodeHeight,
  encodeHeight,
  hexBytes,
  keyDiff,
  keyFrame,
  keyFrameDbAccountFrame,
  keyFrameDbAccountFrameByRuntime,
  keyFrameDbAccountFrameByRuntimePrefix,
  keyFrameDbAccountFramePrefix,
  keyFrameDbEntityActivity,
  keyFrameDbOrderbookCommit,
  keyFrameDbOrderbookCommitPrefix,
  keyFrameDbRuntimeActivity,
  keyLiveAccount,
  keyLiveAccountPrefix,
  keyLiveBook,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyLiveEntityHash,
  keyLiveEntityHashPrefix,
  keyLiveReplicaMeta,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotEntityPrefix,
  keySnapshotManifest,
  normalizeEntityId,
  parseFrameDbAccountFrameRuntimeIndexKey,
  parseLiveAccountKey,
  parseLiveBookKey,
  parseSnapshotManifestHeight,
  prefixUpperBound,
} from './keys';
import {
  computeCanonicalEntityHash,
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalRuntimeStateHash,
  type CanonicalFrameEntityHash,
} from './canonical-hash';
import type {
  AccountMachine,
  EntityReplica,
  EntityInput,
  EntityState,
  Env,
  FrameLogEntry,
  RuntimeInput,
  RuntimeFrameDbRecord,
  RuntimeOverlayRecord,
} from '../types';
import type {
  FrameDbPut,
  NamespaceBytes,
  PerfDeps,
  RuntimeDbLike,
  RuntimeFrameDbLike,
  StorageAccountRef,
  StorageAccountDoc,
  StorageBookRef,
  StorageDebugStats,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageEntityCoreDoc,
  StorageEntityHashDoc,
  StorageEpochSeedStats,
  StorageFrameDbHead,
  StorageFrameEntityHash,
  StorageFrameRecord,
  StorageHashCell,
  StorageHead,
  StorageOverlayRefs,
  StorageReplicaLookup,
  StorageReplicaMeta,
  StorageRuntimeConfig,
  StorageSnapshotManifest,
} from './types';

export type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDebugStats,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageEntityCoreDoc,
  StorageEntityHashDoc,
  StorageEpochSeedStats,
  StorageFrameEntityHash,
  StorageFrameRecord,
  StorageHashCell,
  StorageHead,
  StorageReplicaMeta,
  StorageRuntimeConfig,
  StorageSnapshotManifest,
} from './types';

type StorageDocEncodedValue = { buffer: Buffer; hash: string; hashBytes: Buffer };
type StorageDocWithComputedHash = StorageDoc & {
  hash?: string;
  encodedValue?: Buffer;
  hashBytes?: Buffer;
};

const setHiddenDocComputedValue = <K extends keyof StorageDocWithComputedHash>(
  doc: StorageDocWithComputedHash,
  key: K,
  value: StorageDocWithComputedHash[K],
): void => {
  Object.defineProperty(doc, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

const encodeStorageDocValue = (doc: StorageDoc): StorageDocEncodedValue => {
  const cached = doc as StorageDocWithComputedHash;
  if (
    typeof cached.hash === 'string' &&
    Buffer.isBuffer(cached.encodedValue) &&
    Buffer.isBuffer(cached.hashBytes)
  ) {
    return { buffer: cached.encodedValue, hash: cached.hash, hashBytes: cached.hashBytes };
  }
  const buffer = encodeBuffer(doc.value);
  const hash = hashBuffer(buffer);
  const hashBytes = Buffer.from(hash.slice(2), 'hex');
  // Per-frame StorageDoc objects are the overlay. Keep computed values on that
  // object, hidden from diff encoding. Durable truth remains KEY_LIVE_DOC_HASH
  // and KEY_LIVE_ENTITY_HASH in LevelDB.
  setHiddenDocComputedValue(cached, 'encodedValue', buffer);
  setHiddenDocComputedValue(cached, 'hash', hash);
  setHiddenDocComputedValue(cached, 'hashBytes', hashBytes);
  return { buffer, hash, hashBytes };
};

const withProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const readJsonOrNull = async <T>(db: RuntimeDbLike, key: Buffer): Promise<T | null> => {
  try {
    return decodeBuffer<T>(await db.get(key));
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
};

const readRawOrNull = async (db: RuntimeDbLike, key: Buffer): Promise<Buffer | null> => {
  try {
    return await db.get(key);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
};

const listKeys = async (db: RuntimeDbLike, prefix: Buffer): Promise<Buffer[]> => {
  if (typeof db.keys !== 'function') return [];
  const out: Buffer[] = [];
  const upperBound = prefixUpperBound(prefix);
  for await (const rawKey of db.keys(upperBound ? { gte: prefix, lt: upperBound } : { gte: prefix })) {
    if (Buffer.isBuffer(rawKey)) out.push(rawKey);
    else if (rawKey instanceof Uint8Array) out.push(Buffer.from(rawKey));
    else out.push(Buffer.from(String(rawKey)));
  }
  return out;
};

const listKeysRange = async (db: RuntimeDbLike, gte: Buffer, lt: Buffer): Promise<Buffer[]> => {
  if (typeof db.keys !== 'function') return [];
  const out: Buffer[] = [];
  for await (const rawKey of db.keys({ gte, lt })) {
    if (Buffer.isBuffer(rawKey)) out.push(rawKey);
    else if (rawKey instanceof Uint8Array) out.push(Buffer.from(rawKey));
    else out.push(Buffer.from(String(rawKey)));
  }
  return out;
};

const hashBuffer = (value: Buffer | Uint8Array): string =>
  ethers.keccak256(value instanceof Uint8Array ? value : Uint8Array.from(value));

const hashStable = (value: unknown): string => ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(value)));

const hashToBytes = (hash: string): Buffer =>
  Buffer.from(String(hash || '').replace(/^0x/, '').padStart(64, '0'), 'hex');

const encodeMerkleUint64 = (value: string, label: string): Buffer => {
  if (!/^\d+$/.test(value)) throw new Error(`STORAGE_INVALID_MERKLE_PATH_${label}: ${value}`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`STORAGE_INVALID_MERKLE_PATH_${label}: ${value}`);
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(parsed);
  return out;
};

const bookPairMerklePayload = (pairId: string): Buffer => {
  const [baseTokenId, quoteTokenId, extra] = String(pairId || '').split('/');
  if (baseTokenId === undefined || quoteTokenId === undefined || extra !== undefined) {
    throw new Error(`STORAGE_INVALID_BOOK_MERKLE_PATH: ${pairId}`);
  }
  return Buffer.concat([
    encodeMerkleUint64(baseTokenId, 'BOOK_BASE'),
    encodeMerkleUint64(quoteTokenId, 'BOOK_QUOTE'),
    Buffer.alloc(16),
  ]);
};

const storageMerklePath = (key: string): string => {
  const normalized = String(key || '');
  if (normalized === 'entity') {
    return `0x${Buffer.concat([Buffer.from([0x01]), Buffer.alloc(32)]).toString('hex')}`;
  }

  if (normalized.startsWith('accounts/')) {
    const counterpartyId = normalized.slice('accounts/'.length);
    return `0x${Buffer.concat([Buffer.from([0x02]), hexBytes(counterpartyId)]).toString('hex')}`;
  }

  if (normalized.startsWith('books/')) {
    const pairId = normalized.slice('books/'.length);
    return `0x${Buffer.concat([Buffer.from([0x03]), bookPairMerklePayload(pairId)]).toString('hex')}`;
  }

  throw new Error(`STORAGE_UNKNOWN_MERKLE_PATH: ${normalized}`);
};

const normalizeHashCells = (cells: Iterable<StorageHashCell>): StorageHashCell[] =>
  Array.from(cells)
    .map((cell) => ({ key: String(cell.key), hash: String(cell.hash) }))
    .filter((cell) => cell.key.length > 0 && /^0x[0-9a-f]{64}$/i.test(cell.hash))
    .sort((left, right) => left.key.localeCompare(right.key));

const buildEntityHashDoc = (entityId: string, cells: Iterable<StorageHashCell>): StorageEntityHashDoc => {
  const normalizedCells = normalizeHashCells(cells);
  const merkle = buildHexKeyedMerkle(
    normalizedCells.map((cell) => ({
      hexKey: storageMerklePath(cell.key),
      value: hashToBytes(cell.hash),
    })),
    { radix: DEFAULT_ACCOUNT_MERKLE_RADIX },
  );
  return {
    entityId: normalizeEntityId(entityId),
    cells: normalizedCells,
    hash: merkle.root,
  };
};

export const computeStorageStateRoot = (entityHashes: StorageFrameEntityHash[]): string => {
  return buildHexKeyedMerkle(
    entityHashes
      .map((entry) => ({
        hexKey: normalizeEntityId(entry.entityId),
        value: hashToBytes(entry.hash),
      })),
    { radix: DEFAULT_ACCOUNT_MERKLE_RADIX },
  ).root;
};

const prepareStorageCanonicalStateHashes = (
  env: Env,
  touchedEntities: string[],
  previousFrame: StorageFrameRecord | null,
  replicaLookup = buildReplicaLookup(env),
): { canonicalStateHash: string; canonicalEntityHashes: StorageFrameEntityHash[] } => {
  const liveEntityIds = new Set(Array.from(env.eReplicas.values()).map((replica) => normalizeEntityId(replica.entityId)));
  const previousHashes = Array.isArray(previousFrame?.canonicalEntityHashes)
    ? normalizeFrameEntityHashes(previousFrame.canonicalEntityHashes)
    : [];
  const canonicalHashByEntity = new Map<string, CanonicalFrameEntityHash>();

  if (previousHashes.length > 0) {
    for (const entry of previousHashes) {
      if (liveEntityIds.has(entry.entityId)) canonicalHashByEntity.set(entry.entityId, entry);
    }
  } else {
    for (const entry of computeCanonicalEntityHashesFromEnv(env)) {
      canonicalHashByEntity.set(entry.entityId, entry);
    }
  }

  for (const entityId of touchedEntities) {
    const normalized = normalizeEntityId(entityId);
    const replica = findReplicaForEntity(env, normalized, replicaLookup)?.replica;
    if (replica) {
      canonicalHashByEntity.set(normalized, computeCanonicalEntityHash(replica));
    } else {
      canonicalHashByEntity.delete(normalized);
    }
  }

  const canonicalEntityHashes = Array.from(canonicalHashByEntity.values())
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  return {
    canonicalEntityHashes,
    canonicalStateHash: computeCanonicalRuntimeStateHash(env.height, env.timestamp, canonicalEntityHashes),
  };
};

export const computeStorageFrameHash = (record: StorageFrameRecord): string => {
  const { frameHash: _frameHash, ...stableRecord } = record;
  void _frameHash;
  return hashStable({
    kind: 'xln.storage.frame.v1',
    ...stableRecord,
    entityHashes: (stableRecord.entityHashes ?? [])
      .map((entry) => ({
        entityId: normalizeEntityId(entry.entityId),
        hash: entry.hash,
        cellCount: entry.cellCount,
      }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId)),
  });
};

export const projectEntityCoreDoc = (
  state: EntityState,
  replica?: Pick<EntityReplica, 'signerId' | 'isProposer'>,
): StorageEntityCoreDoc => ({
  entityId: state.entityId,
  ...withProp('signerId', replica?.signerId ? normalizeEntityId(replica.signerId) : undefined),
  ...withProp('isProposer', typeof replica?.isProposer === 'boolean' ? replica.isProposer : undefined),
  height: state.height,
  timestamp: state.timestamp,
  messages: state.messages,
  nonces: state.nonces,
  proposals: state.proposals,
  config: state.config,
  reserves: state.reserves,
  lastFinalizedJHeight: state.lastFinalizedJHeight,
  jBlockObservations: state.jBlockObservations,
  jBlockChain: state.jBlockChain,
  entityEncPubKey: state.entityEncPubKey,
  entityEncPrivKey: state.entityEncPrivKey,
  profile: state.profile,
  htlcRoutes: state.htlcRoutes,
  htlcFeesEarned: state.htlcFeesEarned,
  lockBook: state.lockBook,
  ...withProp('prevFrameHash', state.prevFrameHash),
  ...withProp('deferredAccountProposals', state.deferredAccountProposals),
  ...withProp('accountInputQueue', state.accountInputQueue),
  ...withProp('crontabState', state.crontabState),
  ...withProp('batchHistory', state.batchHistory),
  ...withProp('jBatchState', state.jBatchState),
  ...withProp('htlcNotes', state.htlcNotes),
  ...withProp('outDebtsByToken', state.outDebtsByToken),
  ...withProp('inDebtsByToken', state.inDebtsByToken),
  ...withProp('swapTradingPairs', state.swapTradingPairs),
  ...withProp('pendingSwapFillRatios', state.pendingSwapFillRatios),
  ...withProp('hubRebalanceConfig', state.hubRebalanceConfig),
  ...withProp('orderbookHubProfile', state.orderbookExt?.hubProfile),
  ...withProp('orderbookReferrals', state.orderbookExt?.referrals),
});

const cloneHankoWitness = (hankoWitness?: EntityReplica['hankoWitness']): EntityReplica['hankoWitness'] | undefined => {
  if (!(hankoWitness instanceof Map) || hankoWitness.size === 0) return undefined;
  return new Map(
    Array.from(hankoWitness.entries()).map(([hash, entry]) => [
      String(hash),
      {
        hanko: entry.hanko,
        type: entry.type,
        entityHeight: entry.entityHeight,
        createdAt: entry.createdAt,
      },
    ]),
  );
};

const projectReplicaMeta = (replica: EntityReplica): StorageReplicaMeta => ({
  entityId: normalizeEntityId(replica.entityId),
  signerId: normalizeEntityId(replica.signerId),
  isProposer: replica.isProposer,
  ...withProp('proposal', replica.proposal),
  ...withProp('lockedFrame', replica.lockedFrame),
  ...withProp('validatorComputedState', replica.validatorComputedState),
  ...withProp('hankoWitness', cloneHankoWitness(replica.hankoWitness)),
});

const projectAccountDocFull = (account: AccountMachine): StorageAccountDoc => ({
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
  status: account.status,
  mempool: account.mempool,
  currentFrame: account.currentFrame,
  deltas: account.deltas,
  locks: account.locks,
  swapOffers: account.swapOffers,
  globalCreditLimits: account.globalCreditLimits,
  currentHeight: account.currentHeight,
  pendingSignatures: account.pendingSignatures,
  rollbackCount: account.rollbackCount,
  leftJObservations: account.leftJObservations,
  rightJObservations: account.rightJObservations,
  jEventChain: account.jEventChain,
  lastFinalizedJHeight: account.lastFinalizedJHeight,
  proofHeader: account.proofHeader,
  proofBody: account.proofBody,
  disputeConfig: account.disputeConfig,
  onChainSettlementNonce: account.onChainSettlementNonce,
  pendingWithdrawals: account.pendingWithdrawals,
  requestedRebalance: account.requestedRebalance,
  requestedRebalanceFeeState: account.requestedRebalanceFeeState,
  rebalancePolicy: account.rebalancePolicy,
  ...withProp('pendingFrame', account.pendingFrame),
  ...withProp('pendingAccountInput', account.pendingAccountInput),
  ...withProp('lastRollbackFrameHash', account.lastRollbackFrameHash),
  ...withProp('abiProofBody', account.abiProofBody),
  ...withProp('currentFrameHanko', account.currentFrameHanko),
  ...withProp('counterpartyFrameHanko', account.counterpartyFrameHanko),
  ...withProp('currentDisputeProofHanko', account.currentDisputeProofHanko),
  ...withProp('currentDisputeProofNonce', account.currentDisputeProofNonce),
  ...withProp('currentDisputeProofBodyHash', account.currentDisputeProofBodyHash),
  ...withProp('currentDisputeHash', account.currentDisputeHash),
  ...withProp('counterpartyDisputeProofHanko', account.counterpartyDisputeProofHanko),
  ...withProp('counterpartyDisputeProofNonce', account.counterpartyDisputeProofNonce),
  ...withProp('counterpartyDisputeProofBodyHash', account.counterpartyDisputeProofBodyHash),
  ...withProp('counterpartyDisputeHash', account.counterpartyDisputeHash),
  ...withProp('counterpartySettlementHanko', account.counterpartySettlementHanko),
  ...withProp('disputeProofNoncesByHash', account.disputeProofNoncesByHash),
  ...withProp('disputeProofBodiesByHash', account.disputeProofBodiesByHash),
  ...withProp('settlementWorkspace', account.settlementWorkspace),
  ...withProp('activeDispute', account.activeDispute),
  ...withProp('swapOrderHistory', account.swapOrderHistory),
  ...withProp('swapClosedOrders', account.swapClosedOrders),
  ...withProp('counterpartyRebalanceFeePolicy', account.counterpartyRebalanceFeePolicy),
  ...withProp('activeRebalanceQuote', account.activeRebalanceQuote),
  ...withProp('pendingRebalanceRequest', account.pendingRebalanceRequest),
});

export const projectAccountDoc = (account: AccountMachine): StorageAccountDoc => {
  // Historical account frames are not future-consensus state. They are written
  // to the frame DB by deterministic keys and intentionally omitted here.
  return projectAccountDocFull(account);
};

export const buildAccountMerkleFromDocs = (
  accounts: ReadonlyMap<string, StorageAccountDoc>,
  radix: RadixMerkleRadix = DEFAULT_ACCOUNT_MERKLE_RADIX,
) => {
  return buildHexKeyedMerkle(
    Array.from(accounts.entries()).map(([counterpartyId, doc]) => ({
      hexKey: counterpartyId,
      value: encodeBuffer(doc),
    })),
    { radix },
  );
};

export const buildAccountMerkleFromState = (
  accounts: ReadonlyMap<string, AccountMachine>,
  radix: RadixMerkleRadix = DEFAULT_ACCOUNT_MERKLE_RADIX,
) => {
  return buildHexKeyedMerkle(
    Array.from(accounts.entries()).map(([counterpartyId, account]) => ({
      hexKey: counterpartyId,
      value: encodeBuffer(projectAccountDoc(account)),
    })),
    { radix },
  );
};

const hydrateAccountDoc = (doc: StorageAccountDoc): AccountMachine => ({
  leftEntity: doc.leftEntity,
  rightEntity: doc.rightEntity,
  status: doc.status,
  mempool: doc.mempool,
  currentFrame: doc.currentFrame,
  deltas: doc.deltas,
  locks: doc.locks,
  swapOffers: doc.swapOffers,
  globalCreditLimits: doc.globalCreditLimits,
  currentHeight: doc.currentHeight,
  pendingSignatures: doc.pendingSignatures,
  rollbackCount: doc.rollbackCount,
  leftJObservations: doc.leftJObservations ?? [],
  rightJObservations: doc.rightJObservations ?? [],
  jEventChain: doc.jEventChain ?? [],
  lastFinalizedJHeight: doc.lastFinalizedJHeight,
  proofHeader: doc.proofHeader,
  proofBody: doc.proofBody,
  disputeConfig: doc.disputeConfig,
  onChainSettlementNonce: doc.onChainSettlementNonce,
  pendingWithdrawals: doc.pendingWithdrawals ?? new Map(),
  requestedRebalance: doc.requestedRebalance ?? new Map(),
  requestedRebalanceFeeState: doc.requestedRebalanceFeeState ?? new Map(),
  rebalancePolicy: doc.rebalancePolicy ?? new Map(),
  swapOrderHistory: doc.swapOrderHistory ?? new Map(),
  swapClosedOrders: doc.swapClosedOrders ?? new Map(),
  ...withProp('pendingFrame', doc.pendingFrame),
  ...withProp('pendingAccountInput', doc.pendingAccountInput),
  ...withProp('lastRollbackFrameHash', doc.lastRollbackFrameHash),
  ...withProp('abiProofBody', doc.abiProofBody),
  ...withProp('currentFrameHanko', doc.currentFrameHanko),
  ...withProp('counterpartyFrameHanko', doc.counterpartyFrameHanko),
  ...withProp('currentDisputeProofHanko', doc.currentDisputeProofHanko),
  ...withProp('currentDisputeProofNonce', doc.currentDisputeProofNonce),
  ...withProp('currentDisputeProofBodyHash', doc.currentDisputeProofBodyHash),
  ...withProp('currentDisputeHash', doc.currentDisputeHash),
  ...withProp('counterpartyDisputeProofHanko', doc.counterpartyDisputeProofHanko),
  ...withProp('counterpartyDisputeProofNonce', doc.counterpartyDisputeProofNonce),
  ...withProp('counterpartyDisputeProofBodyHash', doc.counterpartyDisputeProofBodyHash),
  ...withProp('counterpartyDisputeHash', doc.counterpartyDisputeHash),
  ...withProp('counterpartySettlementHanko', doc.counterpartySettlementHanko),
  ...withProp('disputeProofNoncesByHash', doc.disputeProofNoncesByHash),
  ...withProp('disputeProofBodiesByHash', doc.disputeProofBodiesByHash),
  ...withProp('settlementWorkspace', doc.settlementWorkspace),
  ...withProp('activeDispute', doc.activeDispute),
  ...withProp('counterpartyRebalanceFeePolicy', doc.counterpartyRebalanceFeePolicy),
  ...withProp('activeRebalanceQuote', doc.activeRebalanceQuote),
  ...withProp('pendingRebalanceRequest', doc.pendingRebalanceRequest),
});

export const hydrateEntityStateFromStorage = (options: {
  core: StorageEntityCoreDoc;
  accounts: Map<string, StorageAccountDoc>;
  books: Map<string, BookState>;
}): EntityState => {
  const { core, accounts, books } = options;
  let orderbookExt: OrderbookExtState | undefined;
  if (books.size > 0 || core.orderbookHubProfile || core.orderbookReferrals) {
    orderbookExt = {
      books,
      orderPairs: new Map(),
      referrals: core.orderbookReferrals ?? new Map(),
      hubProfile: core.orderbookHubProfile ?? {
        entityId: core.entityId,
        name: core.profile.name || core.entityId.slice(-8),
        spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [],
      },
    };
    rebuildOrderbookPairIndex(orderbookExt);
  }

  return {
    entityId: core.entityId,
    height: core.height,
    timestamp: core.timestamp,
    nonces: core.nonces ?? new Map(),
    messages: core.messages ?? [],
    proposals: core.proposals ?? new Map(),
    config: core.config,
    reserves: core.reserves ?? new Map(),
    accounts: new Map(Array.from(accounts.entries()).map(([key, value]) => [key, hydrateAccountDoc(value)])),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    jBlockObservations: core.jBlockObservations ?? [],
    jBlockChain: core.jBlockChain ?? [],
    entityEncPubKey: core.entityEncPubKey,
    entityEncPrivKey: core.entityEncPrivKey,
    profile: core.profile,
    htlcRoutes: core.htlcRoutes ?? new Map(),
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: core.lockBook ?? new Map(),
    ...withProp('prevFrameHash', core.prevFrameHash),
    ...withProp('deferredAccountProposals', core.deferredAccountProposals),
    ...withProp('accountInputQueue', core.accountInputQueue),
    ...withProp('crontabState', core.crontabState),
    ...withProp('batchHistory', core.batchHistory),
    ...withProp('jBatchState', core.jBatchState),
    ...withProp('htlcNotes', core.htlcNotes),
    ...withProp('outDebtsByToken', core.outDebtsByToken),
    ...withProp('inDebtsByToken', core.inDebtsByToken),
    ...withProp('orderbookExt', orderbookExt),
    ...withProp('swapTradingPairs', core.swapTradingPairs),
    ...withProp('pendingSwapFillRatios', core.pendingSwapFillRatios),
    ...withProp('hubRebalanceConfig', core.hubRebalanceConfig),
  };
};

const docRefKey = (ref: StorageDocRef): string => {
  if (ref.family === 'entity') return `e:${normalizeEntityId(ref.entityId)}`;
  if (ref.family === 'account') return `a:${normalizeEntityId(ref.entityId)}:${normalizeEntityId(ref.counterpartyId)}`;
  return `b:${normalizeEntityId(ref.entityId)}:${ref.pairId}`;
};

const docValueKey = (doc: StorageDoc): string => {
  if (doc.family === 'entity') return `e:${normalizeEntityId(doc.entityId)}`;
  if (doc.family === 'account') return `a:${normalizeEntityId(doc.entityId)}:${normalizeEntityId(doc.counterpartyId)}`;
  return `b:${normalizeEntityId(doc.entityId)}:${doc.pairId}`;
};

const runtimeConfigFromEnv = (env: Env): Required<StorageRuntimeConfig> => ({
  enabled: env.runtimeConfig?.storage?.enabled ?? true,
  snapshotPeriodFrames: Math.max(
    1,
    Number(
      env.runtimeConfig?.storage?.snapshotPeriodFrames ??
        env.runtimeConfig?.snapshotIntervalFrames ??
        DEFAULT_SNAPSHOT_PERIOD_FRAMES,
    ),
  ),
  retainSnapshots: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS),
  ),
  epochMaxBytes: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES),
  ),
  frameDbMaxBytes: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.frameDbMaxBytes ?? DEFAULT_FRAME_DB_MAX_BYTES),
  ),
  frameDbRetainFrames: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.frameDbRetainFrames ?? DEFAULT_FRAME_DB_RETAIN_FRAMES),
  ),
  materializePeriodFrames: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.materializePeriodFrames ?? DEFAULT_MATERIALIZE_PERIOD_FRAMES),
  ),
  accountMerkleRadix: env.runtimeConfig?.storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
});

const readHead = async (db: RuntimeDbLike, config: Required<StorageRuntimeConfig>): Promise<StorageHead> => {
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (head) {
    return {
      ...head,
      latestMaterializedHeight: Math.max(
        0,
        Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? head.latestHeight ?? 0)),
      ),
    };
  }
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 0,
    latestMaterializedHeight: 0,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: config.snapshotPeriodFrames,
    retainSnapshots: config.retainSnapshots,
    epochMaxBytes: config.epochMaxBytes,
    accountMerkleRadix: config.accountMerkleRadix,
    retainedHistoryBytes: 0,
  };
};

const findReplicaForEntity = (
  env: Env,
  entityId: string,
  lookup?: StorageReplicaLookup,
): { replicaKey: string; replica: EntityReplica; state: EntityState } | null => {
  const normalized = normalizeEntityId(entityId);
  if (lookup) return lookup.get(normalized) ?? null;
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const candidate = String(replica?.entityId || String(replicaKey).split(':')[0] || '').toLowerCase();
    if (candidate === normalized) return { replicaKey: String(replicaKey), replica, state: replica.state };
  }
  return null;
};

const buildReplicaLookup = (env: Env): StorageReplicaLookup => {
  const lookup: StorageReplicaLookup = new Map();
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || String(replicaKey).split(':')[0] || '');
    if (!entityId) continue;
    lookup.set(entityId, { replicaKey: String(replicaKey), replica, state: replica.state });
  }
  return lookup;
};

const addAccountRef = (target: Map<string, StorageDocRef>, entityId: string, counterpartyId: string): void => {
  if (!entityId || !counterpartyId) return;
  const ref: StorageDocRef = { family: 'account', entityId: normalizeEntityId(entityId), counterpartyId: normalizeEntityId(counterpartyId) };
  target.set(docRefKey(ref), ref);
};

const addBookRef = (target: Map<string, StorageBookRef>, entityId: string, pairId: string): void => {
  const normalizedEntityId = normalizeEntityId(entityId);
  const normalizedPairId = String(pairId || '').trim();
  if (!normalizedEntityId || !normalizedPairId) return;
  const ref: StorageBookRef = {
    family: 'book',
    entityId: normalizedEntityId,
    pairId: normalizedPairId,
  };
  target.set(docRefKey(ref), ref);
};

const mergeOverlayRecordsIntoEnv = (
  env: Env,
  records: readonly RuntimeOverlayRecord[],
): RuntimeOverlayRecord[] => {
  env.overlay = mergeStorageOverlayRecords(env.overlay, records);
  return env.overlay.map((record) => ({ ...record }));
};

const overlayRecordsFromDocs = (
  puts: readonly StorageDoc[] | undefined,
  dels: readonly StorageDocRef[] | undefined,
): RuntimeOverlayRecord[] => {
  const records = new Map<string, RuntimeOverlayRecord>();
  for (const doc of puts ?? []) {
    const entityId = normalizeEntityId(doc.entityId);
    if (!entityId) continue;
    const record: RuntimeOverlayRecord = doc.family === 'account'
      ? { family: 'account', entityId, counterpartyId: normalizeEntityId(doc.counterpartyId) }
      : doc.family === 'book'
        ? { family: 'book', entityId, pairId: String(doc.pairId || '').trim() }
        : { family: 'entity', entityId };
    records.set(storageOverlayRecordKey(record), record);
  }
  for (const ref of dels ?? []) {
    if (ref.family !== 'book') {
      throw new Error(`STORAGE_OVERLAY_DELETE_UNSUPPORTED: family=${ref.family}`);
    }
    const entityId = normalizeEntityId(ref.entityId);
    if (!entityId) continue;
    const record: RuntimeOverlayRecord = { family: 'book', entityId, pairId: String(ref.pairId || '').trim(), deleted: true };
    records.set(storageOverlayRecordKey(record), record);
  }
  return Array.from(records.values());
};

export const readStorageOverlayRecordsFromDiffs = async (
  db: RuntimeDbLike,
  startHeight: number,
  targetHeight: number,
): Promise<RuntimeOverlayRecord[]> => {
  let records: RuntimeOverlayRecord[] = [];
  const start = Math.max(1, Math.floor(startHeight));
  const end = Math.floor(targetHeight);
  for (let height = start; height <= end; height += 1) {
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(height));
    if (!diff) continue;
    records = mergeStorageOverlayRecords(records, overlayRecordsFromDocs(diff.puts, diff.dels));
  }
  return records;
};

const buildBookDeletionsFromOverlay = (
  records: readonly RuntimeOverlayRecord[] | undefined,
): StorageDocRef[] => {
  const dels = new Map<string, StorageBookRef>();
  for (const record of records ?? []) {
    if (record.family !== 'book' || record.deleted !== true) continue;
    const entityId = normalizeEntityId(record.entityId);
    const pairId = String(record.pairId || '').trim();
    if (!entityId || !pairId) continue;
    const ref: StorageBookRef = { family: 'book', entityId, pairId };
    dels.set(docRefKey(ref), ref);
  }
  return Array.from(dels.values());
};

const storageRefsFromOverlay = (
  records: readonly RuntimeOverlayRecord[] | undefined,
): StorageOverlayRefs => {
  const touchedEntities = new Set<string>();
  const touchedAccounts = new Map<string, StorageAccountRef>();
  const touchedBooks = new Map<string, StorageBookRef>();
  const touchedBookEntities = new Set<string>();

  for (const record of records ?? []) {
    if (record.family === 'entity') {
      const entityId = normalizeEntityId(record.entityId);
      if (entityId) touchedEntities.add(entityId);
      continue;
    }

    if (record.family === 'account') {
      const entityId = normalizeEntityId(record.entityId);
      const counterpartyId = normalizeEntityId(record.counterpartyId);
      if (!entityId || !counterpartyId) continue;
      touchedEntities.add(entityId);
      addAccountRef(touchedAccounts, entityId, counterpartyId);
      continue;
    }

    if (record.family === 'book') {
      const entityId = normalizeEntityId(record.entityId);
      const pairId = String(record.pairId || '').trim();
      if (!entityId || !pairId) continue;
      touchedEntities.add(entityId);
      touchedBookEntities.add(entityId);
      addBookRef(touchedBooks, entityId, pairId);
    }
  }

  return { touchedEntities, touchedAccounts, touchedBooks, touchedBookEntities };
};

const buildDocPuts = (
  env: Env,
  touched: StorageOverlayRefs,
  replicaLookup = buildReplicaLookup(env),
): StorageDoc[] => {
  const puts: StorageDoc[] = [];

  for (const entityId of touched.touchedEntities) {
    const replica = findReplicaForEntity(env, entityId, replicaLookup);
    if (!replica) continue;
    puts.push({
      family: 'entity',
      entityId,
      value: projectEntityCoreDoc(replica.state, replica.replica),
    });
  }

  for (const ref of touched.touchedAccounts.values()) {
    const replica = findReplicaForEntity(env, ref.entityId, replicaLookup);
    const account = replica?.state.accounts.get(ref.counterpartyId);
    if (!replica || !account) continue;
    puts.push({
      family: 'account',
      entityId: ref.entityId,
      counterpartyId: ref.counterpartyId,
      value: projectAccountDoc(account),
    });
  }

  for (const ref of touched.touchedBooks.values()) {
    const replica = findReplicaForEntity(env, ref.entityId, replicaLookup);
    const book = replica?.state.orderbookExt?.books?.get(ref.pairId);
    if (!book) continue;
    puts.push({ family: 'book', entityId: ref.entityId, pairId: ref.pairId, value: book });
  }

  return puts;
};

const liveKeyForDoc = (doc: StorageDoc): Buffer => {
  if (doc.family === 'entity') return keyLiveEntity(doc.entityId);
  if (doc.family === 'account') return keyLiveAccount(doc.entityId, doc.counterpartyId);
  return keyLiveBook(doc.entityId, doc.pairId);
};

const liveKeyForRef = (ref: StorageDocRef): Buffer => {
  if (ref.family === 'entity') return keyLiveEntity(ref.entityId);
  if (ref.family === 'account') return keyLiveAccount(ref.entityId, ref.counterpartyId);
  return keyLiveBook(ref.entityId, ref.pairId);
};

const docRefForDoc = (doc: StorageDoc): StorageDocRef => {
  if (doc.family === 'entity') return { family: 'entity', entityId: doc.entityId };
  if (doc.family === 'account') {
    return { family: 'account', entityId: doc.entityId, counterpartyId: doc.counterpartyId };
  }
  return { family: 'book', entityId: doc.entityId, pairId: doc.pairId };
};

const docRefCellKey = (ref: StorageDocRef): string => {
  if (ref.family === 'entity') return 'entity';
  if (ref.family === 'account') return `accounts/${normalizeEntityId(ref.counterpartyId)}`;
  return `books/${ref.pairId}`;
};

const keyLiveDocHash = (ref: StorageDocRef): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_DOC_HASH]), liveKeyForRef(ref)]);

const readEntityHashDoc = async (db: RuntimeDbLike, entityId: string): Promise<StorageEntityHashDoc | null> =>
  readJsonOrNull<StorageEntityHashDoc>(db, keyLiveEntityHash(entityId));

const buildEntityHashDocFromLive = async (db: RuntimeDbLike, entityId: string): Promise<StorageEntityHashDoc> => {
  const normalizedEntityId = normalizeEntityId(entityId);
  const cells: StorageHashCell[] = [];
  const entityRaw = await readRawOrNull(db, keyLiveEntity(normalizedEntityId));
  if (entityRaw) cells.push({ key: 'entity', hash: hashBuffer(entityRaw) });

  for (const key of await listKeys(db, keyLiveAccountPrefix(normalizedEntityId))) {
    const raw = await readRawOrNull(db, key);
    if (!raw) continue;
    const parsed = parseLiveAccountKey(key);
    cells.push({ key: docRefCellKey({ family: 'account', entityId: normalizedEntityId, counterpartyId: parsed.counterpartyId }), hash: hashBuffer(raw) });
  }

  for (const key of await listKeys(db, keyLiveBookPrefix(normalizedEntityId))) {
    const raw = await readRawOrNull(db, key);
    if (!raw) continue;
    const parsed = parseLiveBookKey(key);
    cells.push({ key: docRefCellKey({ family: 'book', entityId: normalizedEntityId, pairId: parsed.pairId }), hash: hashBuffer(raw) });
  }

  return buildEntityHashDoc(normalizedEntityId, cells);
};

const readAllEntityHashDocs = async (db: RuntimeDbLike): Promise<Map<string, StorageEntityHashDoc>> => {
  const docs = new Map<string, StorageEntityHashDoc>();
  const hashKeys = await listKeys(db, keyLiveEntityHashPrefix());
  for (const key of hashKeys) {
    const entityId = decodeEntityId(key.subarray(1, 33));
    const doc = await readEntityHashDoc(db, entityId);
    if (doc) docs.set(normalizeEntityId(entityId), buildEntityHashDoc(entityId, doc.cells));
  }

  if (docs.size > 0) return docs;

  // Backward-compatibility bootstrap for DBs created before storage-debug-v1
  // hash docs. This is intentionally one-time O(live state); subsequent frames
  // update only touched cell hashes.
  for (const entityId of (await listKeys(db, Buffer.from([KEY_LIVE_ENTITY]))).map((key) => decodeEntityId(key.subarray(1, 33)))) {
    docs.set(normalizeEntityId(entityId), await buildEntityHashDocFromLive(db, entityId));
  }
  return docs;
};

const toFrameEntityHashes = (docs: Iterable<StorageEntityHashDoc>): StorageFrameEntityHash[] =>
  Array.from(docs)
    .map((doc) => ({ entityId: normalizeEntityId(doc.entityId), hash: doc.hash, cellCount: doc.cells.length }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

const prepareStorageStateHashes = async (options: {
  db: RuntimeDbLike;
  height: number;
  timestamp: number;
  puts: StorageDoc[];
  dels: StorageDocRef[];
  entityHashDocs?: Map<string, StorageEntityHashDoc>;
}): Promise<{
  stateHash: string;
  entityHashes: StorageFrameEntityHash[];
  entityHashDocs: Map<string, StorageEntityHashDoc>;
  docValueBuffers: Map<string, Buffer>;
  docHashPuts: Array<{ key: Buffer; value: Buffer }>;
  docHashDels: Buffer[];
  entityHashPuts: Array<{ key: Buffer; value: Buffer }>;
}> => {
  const entityHashDocs = options.entityHashDocs
    ? new Map(Array.from(options.entityHashDocs.entries()).map(([key, value]) => [key, buildEntityHashDoc(value.entityId, value.cells)]))
    : await readAllEntityHashDocs(options.db);
  const docValueBuffers = new Map<string, Buffer>();
  const docHashPuts: Array<{ key: Buffer; value: Buffer }> = [];
  const docHashDels: Buffer[] = [];
  const touchedEntityIds = new Set<string>();

  const ensureEntityDoc = async (entityId: string): Promise<StorageEntityHashDoc> => {
    const normalized = normalizeEntityId(entityId);
    let doc = entityHashDocs.get(normalized);
    if (!doc) {
      doc = await buildEntityHashDocFromLive(options.db, normalized);
      entityHashDocs.set(normalized, doc);
    }
    return doc;
  };

  const updateEntityCells = async (entityId: string, update: (cells: Map<string, string>) => void): Promise<void> => {
    const normalized = normalizeEntityId(entityId);
    const current = await ensureEntityDoc(normalized);
    const cells = new Map(current.cells.map((cell) => [cell.key, cell.hash]));
    update(cells);
    entityHashDocs.set(normalized, buildEntityHashDoc(normalized, Array.from(cells, ([key, hash]) => ({ key, hash }))));
    touchedEntityIds.add(normalized);
  };

  for (const doc of options.puts) {
    const ref = docRefForDoc(doc);
    const encoded = encodeStorageDocValue(doc);
    docValueBuffers.set(docValueKey(doc), encoded.buffer);
    docHashPuts.push({ key: keyLiveDocHash(ref), value: encoded.hashBytes });
    await updateEntityCells(ref.entityId, (cells) => {
      cells.set(docRefCellKey(ref), encoded.hash);
    });
  }

  for (const ref of options.dels) {
    docHashDels.push(keyLiveDocHash(ref));
    await updateEntityCells(ref.entityId, (cells) => {
      cells.delete(docRefCellKey(ref));
    });
  }

  const entityHashPuts = Array.from(touchedEntityIds).map((entityId) => ({
    key: keyLiveEntityHash(entityId),
    value: encodeBuffer(entityHashDocs.get(entityId) ?? buildEntityHashDoc(entityId, [])),
  }));
  const entityHashes = toFrameEntityHashes(entityHashDocs.values());
  return {
    stateHash: computeStorageStateRoot(entityHashes),
    entityHashes,
    entityHashDocs,
    docValueBuffers,
    docHashPuts,
    docHashDels,
    entityHashPuts,
  };
};

type StoredAccountFrameRecord = Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }> & {
  runtimeHeight: number;
  timestamp: number;
};

type StoredOrderbookCommitRecord = Extract<RuntimeFrameDbRecord, { kind: 'bookUpdate' }> & {
  runtimeHeight: number;
  timestamp: number;
};

type StoredRuntimeActivityRecord = {
  kind: 'runtimeActivity';
  height: number;
  timestamp: number;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
  touchedBooks?: Array<{ entityId: string; pairId: string }>;
};

type StoredEntityActivityRecord = {
  kind: 'entityActivity';
  height: number;
  timestamp: number;
  entityId: string;
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  accountFrameCount: number;
  logCount: number;
};

const buildFrameDbPuts = (options: {
  height: number;
  timestamp: number;
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
  frameDbRecords?: RuntimeFrameDbRecord[];
}): FrameDbPut[] => {
  const puts: FrameDbPut[] = [];
  const runtimeActivity: StoredRuntimeActivityRecord = {
    kind: 'runtimeActivity',
    height: options.height,
    timestamp: options.timestamp,
    logs: options.logs,
    touchedEntities: options.touchedEntities,
    touchedAccounts: options.touchedAccounts,
    touchedBookEntities: options.touchedBookEntities,
  };
  puts.push({ key: keyFrameDbRuntimeActivity(options.height), value: encodeBuffer(runtimeActivity) });

  const logCountsByEntity = new Map<string, number>();
  for (const log of options.logs) {
    const entityId = normalizeEntityId(String(log.entityId || log.data?.['entityId'] || ''));
    if (!entityId) continue;
    logCountsByEntity.set(entityId, (logCountsByEntity.get(entityId) ?? 0) + 1);
  }

  const frameCountsByEntity = new Map<string, number>();
  const orderbookCountsByEntity = new Map<string, number>();
  const touchedBooksByKey = new Map<string, { entityId: string; pairId: string }>();
  for (const record of options.frameDbRecords ?? []) {
    if (record.kind === 'accountFrame') {
      const entityId = normalizeEntityId(record.entityId);
      const counterpartyId = normalizeEntityId(record.counterpartyId);
      const accountHeight = Number(record.accountHeight || record.frame?.height || 0);
      if (!entityId || !counterpartyId || !Number.isFinite(accountHeight) || accountHeight <= 0) continue;
      const stored: StoredAccountFrameRecord = {
        ...record,
        entityId,
        counterpartyId,
        accountHeight: Math.floor(accountHeight),
        runtimeHeight: options.height,
        timestamp: options.timestamp,
      };
      puts.push({
        key: keyFrameDbAccountFrame(entityId, counterpartyId, stored.accountHeight),
        value: encodeBuffer(stored),
      });
      puts.push({
        key: keyFrameDbAccountFrameByRuntime(options.height, entityId, counterpartyId, stored.accountHeight),
        value: Buffer.alloc(0),
      });
      frameCountsByEntity.set(entityId, (frameCountsByEntity.get(entityId) ?? 0) + 1);
      continue;
    }

    if (record.kind === 'bookUpdate') {
      const entityId = normalizeEntityId(record.entityId);
      const pairId = String(record.pairId || '').trim();
      if (!entityId || !pairId) continue;
      const stored: StoredOrderbookCommitRecord = {
        kind: 'bookUpdate',
        entityId,
        pairId,
        book: record.book ? structuredClone(record.book) : null,
        runtimeHeight: options.height,
        timestamp: options.timestamp,
      };
      puts.push({
        key: keyFrameDbOrderbookCommit(options.height, entityId, pairId),
        value: encodeBuffer(stored),
      });
      orderbookCountsByEntity.set(entityId, (orderbookCountsByEntity.get(entityId) ?? 0) + 1);
      touchedBooksByKey.set(`${entityId}:${pairId}`, { entityId, pairId });
    }
  }

  if (touchedBooksByKey.size > 0) {
    runtimeActivity.touchedBooks = Array.from(touchedBooksByKey.values())
      .sort((left, right) => left.entityId.localeCompare(right.entityId) || left.pairId.localeCompare(right.pairId));
  }

  for (const entityId of options.touchedEntities) {
    const normalized = normalizeEntityId(entityId);
    if (!normalized) continue;
    const entityActivity: StoredEntityActivityRecord = {
      kind: 'entityActivity',
      height: options.height,
      timestamp: options.timestamp,
      entityId: normalized,
      touchedAccounts: options.touchedAccounts.filter((account) => normalizeEntityId(account.entityId) === normalized),
      accountFrameCount: frameCountsByEntity.get(normalized) ?? 0,
      logCount: (logCountsByEntity.get(normalized) ?? 0) + (orderbookCountsByEntity.get(normalized) ?? 0),
    };
    puts.push({ key: keyFrameDbEntityActivity(normalized, options.height), value: encodeBuffer(entityActivity) });
  }

  return puts;
};

const readFrameDbHead = async (
  db: RuntimeFrameDbLike,
  config: Required<StorageRuntimeConfig>,
): Promise<StorageFrameDbHead> => {
  const raw = await readJsonOrNull<StorageFrameDbHead>(db, KEY_FRAME_DB_HEAD);
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: Math.max(0, Math.floor(Number(raw?.latestHeight ?? 0))),
    latestPrunedRuntimeHeight: Math.max(0, Math.floor(Number(raw?.latestPrunedRuntimeHeight ?? 0))),
    retainedBytes: Math.max(0, Math.floor(Number(raw?.retainedBytes ?? 0))),
    maxBytes: config.frameDbMaxBytes,
    retainFrames: config.frameDbRetainFrames,
  };
};

const writeFrameDbHead = async (db: RuntimeFrameDbLike, head: StorageFrameDbHead): Promise<void> => {
  const batch = db.batch();
  batch.put(KEY_FRAME_DB_HEAD, encodeBuffer(head));
  await writeBatch(batch);
};

const pruneFrameDbBeforeRuntimeHeight = async (
  db: RuntimeFrameDbLike,
  heightInclusive: number,
): Promise<{ removedBytes: number; removedKeys: number }> => {
  const cutoff = Math.max(0, Math.floor(Number(heightInclusive)));
  if (cutoff <= 0) return { removedBytes: 0, removedKeys: 0 };

  let removedBytes = 0;
  let removedKeys = 0;
  const runtimeActivityKeys = (await listKeys(db, Buffer.from([FRAME_DB_RUNTIME_ACTIVITY])))
    .filter((key) => decodeHeight(key, 1) <= cutoff);
  removedBytes += await deleteKeys(db, runtimeActivityKeys);
  removedKeys += runtimeActivityKeys.length;

  const entityActivityKeys = (await listKeys(db, Buffer.from([FRAME_DB_ENTITY_ACTIVITY])))
    .filter((key) => decodeHeight(key, 33) <= cutoff);
  removedBytes += await deleteKeys(db, entityActivityKeys);
  removedKeys += entityActivityKeys.length;

  const orderbookCommitKeys = (await listKeys(db, keyFrameDbOrderbookCommitPrefix()))
    .filter((key) => decodeHeight(key, 1) <= cutoff);
  removedBytes += await deleteKeys(db, orderbookCommitKeys);
  removedKeys += orderbookCommitKeys.length;

  const accountFrameKeysByHex = new Map<string, Buffer>();
  const accountFrameIndexKeys = await listKeysRange(
    db,
    keyFrameDbAccountFrameByRuntimePrefix(),
    Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME]), encodeHeight(cutoff + 1)]),
  );
  for (const key of accountFrameIndexKeys) {
    accountFrameKeysByHex.set(key.toString('hex'), key);
    const parsed = parseFrameDbAccountFrameRuntimeIndexKey(key);
    const primaryKey = keyFrameDbAccountFrame(parsed.entityId, parsed.counterpartyId, parsed.accountHeight);
    accountFrameKeysByHex.set(primaryKey.toString('hex'), primaryKey);
  }

  if (accountFrameIndexKeys.length === 0) {
    // Legacy frame DBs written before the runtime-height index still need one
    // value scan to age out old account frames. Newly written rows prune by key.
    for (const key of await listKeys(db, keyFrameDbAccountFramePrefix())) {
      const raw = await readRawOrNull(db, key);
      if (!raw) continue;
      const record = decodeBuffer<StoredAccountFrameRecord>(raw);
      if (Math.max(0, Math.floor(Number(record.runtimeHeight ?? 0))) <= cutoff) {
        accountFrameKeysByHex.set(key.toString('hex'), key);
      }
    }
  }
  const accountFrameKeysToDelete = Array.from(accountFrameKeysByHex.values());
  removedBytes += await deleteKeys(db, accountFrameKeysToDelete);
  removedKeys += accountFrameKeysToDelete.length;

  return { removedBytes, removedKeys };
};

const writeFrameDbPutsWithRetention = async (options: {
  db: RuntimeFrameDbLike;
  height: number;
  puts: FrameDbPut[];
  config: Required<StorageRuntimeConfig>;
}): Promise<{
  writtenBytes: number;
  prunedBytes: number;
  retainedBytes: number;
  prunedKeys: number;
  latestPrunedRuntimeHeight: number;
}> => {
  if (options.puts.length === 0) {
    const head = await readFrameDbHead(options.db, options.config);
    return {
      writtenBytes: 0,
      prunedBytes: 0,
      retainedBytes: head.retainedBytes,
      prunedKeys: 0,
      latestPrunedRuntimeHeight: head.latestPrunedRuntimeHeight,
    };
  }

  const height = Math.max(1, Math.floor(Number(options.height)));
  const head = await readFrameDbHead(options.db, options.config);
  const writtenBytes = options.puts.reduce((sum, item) => sum + item.key.byteLength + item.value.byteLength, 0);
  const appendBytes = head.latestHeight >= height ? 0 : writtenBytes;
  const nextHead: StorageFrameDbHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: Math.max(head.latestHeight, height),
    latestPrunedRuntimeHeight: head.latestPrunedRuntimeHeight,
    retainedBytes: head.retainedBytes + appendBytes,
    maxBytes: options.config.frameDbMaxBytes,
    retainFrames: options.config.frameDbRetainFrames,
  };

  const batch = options.db.batch();
  for (const item of options.puts) batch.put(item.key, item.value);
  batch.put(KEY_FRAME_DB_HEAD, encodeBuffer(nextHead));
  await writeBatch(batch);

  if (nextHead.retainedBytes <= options.config.frameDbMaxBytes || height <= options.config.frameDbRetainFrames) {
    return {
      writtenBytes,
      prunedBytes: 0,
      retainedBytes: nextHead.retainedBytes,
      prunedKeys: 0,
      latestPrunedRuntimeHeight: nextHead.latestPrunedRuntimeHeight,
    };
  }

  const cutoff = height - options.config.frameDbRetainFrames;
  const pruned = await pruneFrameDbBeforeRuntimeHeight(options.db, cutoff);
  const finalHead: StorageFrameDbHead = {
    ...nextHead,
    latestPrunedRuntimeHeight: Math.max(nextHead.latestPrunedRuntimeHeight, cutoff),
    retainedBytes: Math.max(0, nextHead.retainedBytes - pruned.removedBytes),
  };
  await writeFrameDbHead(options.db, finalHead);
  return {
    writtenBytes,
    prunedBytes: pruned.removedBytes,
    retainedBytes: finalHead.retainedBytes,
    prunedKeys: pruned.removedKeys,
    latestPrunedRuntimeHeight: finalHead.latestPrunedRuntimeHeight,
  };
};

export const readFrameDbRuntimeActivity = async (
  db: RuntimeFrameDbLike,
  height: number,
): Promise<StoredRuntimeActivityRecord | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  return readJsonOrNull<StoredRuntimeActivityRecord>(db, keyFrameDbRuntimeActivity(targetHeight));
};

export const readFrameDbAccountFrames = async (
  db: RuntimeFrameDbLike,
  entityId: string,
  counterpartyId: string,
): Promise<StoredAccountFrameRecord[]> => {
  const prefix = keyFrameDbAccountFramePrefix(entityId, counterpartyId);
  const records: StoredAccountFrameRecord[] = [];
  for (const key of await listKeys(db, prefix)) {
    const accountHeight = decodeHeight(key, 65);
    const record = decodeBuffer<StoredAccountFrameRecord>(await db.get(key));
    records.push({ ...record, accountHeight });
  }
  return records.sort((left, right) => left.accountHeight - right.accountHeight);
};

export const computeStorageDebugStateHashFromEnv = (env: Env): string => {
  const entityHashDocs: StorageEntityHashDoc[] = [];
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const entityId = normalizeEntityId(String(replica?.entityId || String(replicaKey).split(':')[0] || ''));
    if (!entityId || !replica?.state) continue;
    const cells: StorageHashCell[] = [];
    cells.push({
      key: 'entity',
      hash: hashBuffer(encodeBuffer(projectEntityCoreDoc(replica.state, replica))),
    });
    for (const [counterpartyId, account] of replica.state.accounts ?? new Map<string, AccountMachine>()) {
      cells.push({
        key: docRefCellKey({ family: 'account', entityId, counterpartyId: normalizeEntityId(counterpartyId) }),
        hash: hashBuffer(encodeBuffer(projectAccountDoc(account))),
      });
    }
    for (const [pairId, book] of replica.state.orderbookExt?.books ?? new Map<string, BookState>()) {
      cells.push({
        key: docRefCellKey({ family: 'book', entityId, pairId: String(pairId) }),
        hash: hashBuffer(encodeBuffer(book)),
      });
    }
    entityHashDocs.push(buildEntityHashDoc(entityId, cells));
  }
  return computeStorageStateRoot(toFrameEntityHashes(entityHashDocs));
};

const buildDiffRecord = (height: number, puts: StorageDoc[], dels: StorageDocRef[]): StorageDiffRecord => ({
  height,
  puts,
  dels,
});

const measurePrefixBytes = async (db: RuntimeDbLike, prefix: Buffer): Promise<NamespaceBytes> => {
  const keys = await listKeys(db, prefix);
  let bytes = 0;
  let maxValueBytes = 0;
  for (const key of keys) {
    const value = await db.get(key);
    bytes += key.byteLength + value.byteLength;
    if (value.byteLength > maxValueBytes) maxValueBytes = value.byteLength;
  }
  return { count: keys.length, bytes, maxValueBytes };
};

const copyKeys = async (
  sourceDb: RuntimeDbLike,
  targetDb: RuntimeDbLike,
  keys: Buffer[],
): Promise<{ bytes: number; count: number }> => {
  let bytes = 0;
  let count = 0;
  for (let offset = 0; offset < keys.length; offset += 256) {
    const batch = targetDb.batch();
    for (const key of keys.slice(offset, offset + 256)) {
      const value = await sourceDb.get(key);
      batch.put(key, value);
      bytes += key.byteLength + value.byteLength;
      count += 1;
    }
    await writeBatch(batch);
  }
  return { bytes, count };
};

export const seedFreshStorageEpoch = async (options: {
  sourceDb: RuntimeDbLike;
  targetDb: RuntimeDbLike;
  snapshotHeight: number;
}): Promise<StorageEpochSeedStats> => {
  const head = await readJsonOrNull<StorageHead>(options.sourceDb, KEY_HEAD);
  if (!head) return { liveBytes: 0, snapshotBytes: 0, frameBytes: 0, docCount: 0 };
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));
  if (latestHeight > 0 && options.snapshotHeight !== latestHeight) {
    throw new Error(
      `STORAGE_EPOCH_SEED_REQUIRES_LATEST_SNAPSHOT: snapshot=${options.snapshotHeight} latest=${latestHeight}`,
    );
  }

  // Epoch seeding intentionally skips diff/pack history. Rotation is only
  // allowed at the current head, after that frame has produced a snapshot and
  // materialized live state, so no unmaterialized overlay window crosses the
  // epoch boundary.
  // Rotation must rebuild the fresh epoch through LevelDB writes, not copy the
  // old LSM directory. That gives the new DB clean compaction/fragments while
  // the old epoch remains immutable audit/history data.
  const livePrefixes = [
    Buffer.from([KEY_LIVE_ENTITY]),
    Buffer.from([KEY_LIVE_ACCOUNT]),
    Buffer.from([KEY_LIVE_BOOK]),
    Buffer.from([KEY_LIVE_DOC_HASH]),
    Buffer.from([KEY_LIVE_ENTITY_HASH]),
    Buffer.from([KEY_LIVE_REPLICA_META]),
  ];
  const snapshotPrefixes = [
    keySnapshotManifest(options.snapshotHeight),
    keySnapshotEntityPrefix(options.snapshotHeight),
    keySnapshotAccountPrefix(options.snapshotHeight),
    keySnapshotBookPrefix(options.snapshotHeight),
  ];

  let liveBytes = 0;
  let snapshotBytes = 0;
  let frameBytes = 0;
  let docCount = 0;

  for (const prefix of livePrefixes) {
    const copied = await copyKeys(options.sourceDb, options.targetDb, await listKeys(options.sourceDb, prefix));
    liveBytes += copied.bytes;
    docCount += copied.count;
  }

  const manifestRaw = await readRawOrNull(options.sourceDb, keySnapshotManifest(options.snapshotHeight));
  if (manifestRaw) {
    const batch = options.targetDb.batch();
    const manifestKey = keySnapshotManifest(options.snapshotHeight);
    batch.put(manifestKey, manifestRaw);
    await writeBatch(batch);
    snapshotBytes += manifestKey.byteLength + manifestRaw.byteLength;
    docCount += 1;
  }

  for (const prefix of snapshotPrefixes.slice(1)) {
    const copied = await copyKeys(options.sourceDb, options.targetDb, await listKeys(options.sourceDb, prefix));
    snapshotBytes += copied.bytes;
    docCount += copied.count;
  }

  if (latestHeight > 0) {
    // The fresh epoch must keep enough frame chain to verify its own tail and
    // to compute prevFrameHash for the first append after rotation. Diffs
    // stay in the immutable previous epoch; live docs + latest snapshot are the
    // recovery truth for the new current epoch.
    const firstTailHeight = Math.max(1, latestHeight - EPOCH_SEED_FRAME_TAIL + 1);
    const frameKeys: Buffer[] = [];
    for (let height = firstTailHeight; height <= latestHeight; height += 1) {
      frameKeys.push(keyFrame(height));
    }
    const copied = await copyKeys(options.sourceDb, options.targetDb, frameKeys);
    frameBytes += copied.bytes;
    docCount += copied.count;
  }

  const batch = options.targetDb.batch();
  batch.put(
    KEY_HEAD,
    encodeBuffer({
      ...head,
      latestMaterializedHeight: options.snapshotHeight,
      latestSnapshotHeight: options.snapshotHeight,
      retainedHistoryBytes: snapshotBytes + frameBytes,
    } satisfies StorageHead),
  );
  await writeBatch(batch);

  return { liveBytes, snapshotBytes, frameBytes, docCount };
};

const deleteKeys = async (db: RuntimeDbLike, keys: Buffer[]): Promise<number> => {
  let removedBytes = 0;
  for (let offset = 0; offset < keys.length; offset += 256) {
    const batch = db.batch();
    for (const key of keys.slice(offset, offset + 256)) {
      const value = await readRawOrNull(db, key);
      if (value) removedBytes += key.byteLength + value.byteLength;
      if (typeof batch.del === 'function') batch.del(key);
    }
    await writeBatch(batch);
  }
  return removedBytes;
};

const listSnapshotHeights = async (db: RuntimeDbLike): Promise<number[]> => {
  const keys = await listKeys(db, Buffer.from([KEY_SNAPSHOT_MANIFEST]));
  return keys.map(parseSnapshotManifestHeight).sort((left, right) => left - right);
};

const createSnapshot = async (db: RuntimeDbLike, height: number): Promise<{ docCount: number; bytes: number }> => {
  const livePrefixes = [
    Buffer.from([KEY_LIVE_ENTITY]),
    Buffer.from([KEY_LIVE_ACCOUNT]),
    Buffer.from([KEY_LIVE_BOOK]),
  ];

  let written = 0;
  let bytes = 0;
  for (const prefix of livePrefixes) {
    const keys = await listKeys(db, prefix);
    for (let offset = 0; offset < keys.length; offset += 256) {
      const batch = db.batch();
      const slice = keys.slice(offset, offset + 256);
      for (const key of slice) {
        const value = await db.get(key);
        let snapshotKey: Buffer;
        if (key[0] === KEY_LIVE_ENTITY) {
          snapshotKey = Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height), key.subarray(1)]);
        } else if (key[0] === KEY_LIVE_ACCOUNT) {
          snapshotKey = Buffer.concat([Buffer.from([KEY_SNAPSHOT_ACCOUNT]), encodeHeight(height), key.subarray(1)]);
        } else if (key[0] === KEY_LIVE_BOOK) {
          snapshotKey = Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height), key.subarray(1)]);
        } else {
          continue;
        }
        batch.put(snapshotKey, value);
        written += 1;
        bytes += snapshotKey.byteLength + value.byteLength;
      }
      await writeBatch(batch);
    }
  }
  const batch = db.batch();
  const manifestKey = keySnapshotManifest(height);
  const manifestValue = encodeBuffer({ height, createdAt: Date.now(), docCount: written } satisfies StorageSnapshotManifest);
  batch.put(manifestKey, manifestValue);
  await writeBatch(batch);
  bytes += manifestKey.byteLength + manifestValue.byteLength;
  return { docCount: written, bytes };
};

const pruneSnapshot = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const prefixes = [
    keySnapshotEntityPrefix(height),
    keySnapshotAccountPrefix(height),
    keySnapshotBookPrefix(height),
  ];
  let removedBytes = 0;
  // Delete the manifest first. If a crash happens mid-prune, leftover docs are
  // harmless orphans; the opposite order can leave a manifest pointing at
  // missing snapshot docs.
  removedBytes += await deleteKeys(db, [keySnapshotManifest(height)]);
  for (const prefix of prefixes) {
    removedBytes += await deleteKeys(db, await listKeys(db, prefix));
  }
  return removedBytes;
};

const maybeRotateSnapshots = async (db: RuntimeDbLike, retainSnapshots: number): Promise<number> => {
  const heights = await listSnapshotHeights(db);
  if (heights.length <= retainSnapshots) return 0;
  let removedBytes = 0;
  for (const height of heights.slice(0, Math.max(0, heights.length - retainSnapshots))) {
    removedBytes += await pruneSnapshot(db, height);
  }
  return removedBytes;
};

const pruneHistoryBeforeHeight = async (db: RuntimeDbLike, heightInclusive: number): Promise<number> => {
  if (heightInclusive <= 0) return 0;
  let removedBytes = 0;
  // Keep frame journals available for receipts/audit even after a snapshot exists.
  // Only replay-specific layers can be dropped once the snapshot covers them.
  for (const prefix of [Buffer.from([KEY_DIFF]), Buffer.from([KEY_PACK])]) {
    const keys = await listKeys(db, prefix);
    removedBytes += await deleteKeys(
      db,
      keys.filter((key) => decodeHeight(key) <= heightInclusive),
    );
  }
  return removedBytes;
};

export type StorageFrameSaveResult = {
  materialized: boolean;
  materializedOverlayRecords: number;
};

export const saveRuntimeFrameToStorage = async (options: {
  env: Env;
  stateHash?: string;
  currentFrameInput?: RuntimeInput;
  currentFrameOutputs?: EntityInput[];
  frameDbRecords?: RuntimeFrameDbRecord[];
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  tryOpenFrameDb: (env: Env) => Promise<boolean>;
  getFrameDb: (env: Env) => RuntimeFrameDbLike;
  rotateEpochDb?: (env: Env, snapshotHeight: number) => Promise<void>;
} & PerfDeps): Promise<StorageFrameSaveResult> => {
  const config = runtimeConfigFromEnv(options.env);
  if (!config.enabled) return { materialized: false, materializedOverlayRecords: 0 };

  const state = options.env.runtimeState ?? {};
  if (state.persistencePaused) return { materialized: false, materializedOverlayRecords: 0 };

  const openStartedAt = options.getPerfMs();
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return { materialized: false, materializedOverlayRecords: 0 };
  const db = options.getRuntimeDb(options.env);
  const openMs = options.getPerfMs() - openStartedAt;

  const appliedRuntimeInput = options.currentFrameInput ?? { runtimeTxs: [], entityInputs: [] };
  const frameOverlayRecords = Array.isArray(state.currentStorageOverlayMarks)
    ? state.currentStorageOverlayMarks.map((record) => ({ ...record }))
    : [];
  const overlayRecords = mergeOverlayRecordsIntoEnv(options.env, []);
  const frameTouched = storageRefsFromOverlay(frameOverlayRecords);
  const replicaLookup = buildReplicaLookup(options.env);
  const diffBuildStartedAt = options.getPerfMs();
  const framePuts = buildDocPuts(options.env, frameTouched, replicaLookup);
  const frameBookDels = buildBookDeletionsFromOverlay(frameOverlayRecords);
  const diff = buildDiffRecord(options.env.height, framePuts, frameBookDels);
  const diffBuildMs = options.getPerfMs() - diffBuildStartedAt;

  const writeStartedAt = options.getPerfMs();
  const head = await readHead(db, config);
  if (head.latestHeight !== options.env.height - 1) {
    throw new Error(
      `STORAGE_APPEND_INVARIANT_FAILED: refusing to write frame ${options.env.height} after persisted head ${head.latestHeight}`,
    );
  }
  const previousFrame = head.latestHeight > 0 ? await readStorageFrameRecord(db, head.latestHeight) : null;
  if (head.latestHeight > 0 && !previousFrame) {
    throw new Error(`STORAGE_PREV_FRAME_MISSING: height=${head.latestHeight}`);
  }
  const prevFrameHash = previousFrame ? previousFrame.frameHash ?? computeStorageFrameHash(previousFrame) : ZERO_FRAME_HASH;
  const frameKey = keyFrame(options.env.height);
  const diffKey = keyDiff(options.env.height);
  const diffBuffer = encodeBuffer(diff);
  const projectedHistoryBytesWithoutFrame =
    head.retainedHistoryBytes +
    diffKey.byteLength +
    diffBuffer.byteLength;
  const snapshotDue = options.env.height % config.snapshotPeriodFrames === 0;
  const snapshotRequiredByBytes = projectedHistoryBytesWithoutFrame > config.epochMaxBytes;
  const shouldMaterialize =
    options.env.height === 1 ||
    options.env.height % config.materializePeriodFrames === 0 ||
    snapshotDue ||
    snapshotRequiredByBytes;

  const frameLogs = Array.isArray(options.env.frameLogs) ? options.env.frameLogs.map((entry) => ({ ...entry })) : [];
  const touchedEntities = Array.from(frameTouched.touchedEntities.values()).sort();
  const touchedAccounts = Array.from(frameTouched.touchedAccounts.values())
    .filter((ref): ref is Extract<StorageDocRef, { family: 'account' }> => ref.family === 'account')
    .map((ref) => ({ entityId: ref.entityId, counterpartyId: ref.counterpartyId }));
  const touchedBookEntities = Array.from(frameTouched.touchedBookEntities.values()).sort();

  const materializedTouched = shouldMaterialize
    ? storageRefsFromOverlay(overlayRecords)
    : null;
  const materializedPuts = materializedTouched
    ? buildDocPuts(options.env, materializedTouched, replicaLookup)
    : [];
  const materializedDels = shouldMaterialize
    ? buildBookDeletionsFromOverlay(overlayRecords)
    : [];
  const cachedEntityHashDocs = state.storageEntityHashDocs instanceof Map
    ? state.storageEntityHashDocs as Map<string, StorageEntityHashDoc>
    : undefined;
  const preparedHashes = shouldMaterialize
    ? await prepareStorageStateHashes({
        db,
        height: options.env.height,
        timestamp: options.env.timestamp,
        puts: materializedPuts,
        dels: materializedDels,
        ...(cachedEntityHashDocs ? { entityHashDocs: cachedEntityHashDocs } : {}),
      })
    : null;
  const materializedEntities = materializedTouched
    ? Array.from(materializedTouched.touchedEntities.values()).sort()
    : [];
  const canonicalHashes = shouldMaterialize
    ? prepareStorageCanonicalStateHashes(options.env, materializedEntities, previousFrame, replicaLookup)
    : null;
  const frameRecordBase: StorageFrameRecord = {
    height: options.env.height,
    timestamp: options.env.timestamp,
    prevFrameHash,
    stateHash: preparedHashes?.stateHash ?? '',
    hashMode: 'storage-merkle-v1',
    materializedState: shouldMaterialize,
    entityHashes: preparedHashes?.entityHashes ?? previousFrame?.entityHashes ?? [],
    ...(canonicalHashes ? {
      canonicalStateHash: canonicalHashes.canonicalStateHash,
      canonicalEntityHashes: canonicalHashes.canonicalEntityHashes,
    } : {}),
    runtimeInput: appliedRuntimeInput,
    frameOutputs: (options.currentFrameOutputs ?? []).map((output) => ({ ...output })),
    ...(shouldMaterialize && overlayRecords.length > 0
      ? { overlayRecords: overlayRecords.map((record) => ({ ...record })) }
      : {}),
    // Logs/history are indexed in the frame DB. Keep the runtime state journal
    // focused on replay inputs/outputs and state hashes.
    logs: [],
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
  };
  const frameRecord: StorageFrameRecord = {
    ...frameRecordBase,
    frameHash: computeStorageFrameHash(frameRecordBase),
  };
  const frameDbPuts = buildFrameDbPuts({
    height: options.env.height,
    timestamp: options.env.timestamp,
    logs: frameLogs,
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
    frameDbRecords: options.frameDbRecords ?? [],
  });
  const highSignalEvents = frameLogs
    .map((entry) => (typeof entry?.message === 'string' ? entry.message : ''))
    .filter((message) =>
      message === 'HtlcReceived' ||
      message === 'HtlcFinalized' ||
      message === 'HtlcFailed' ||
      message === 'JEventReceived' ||
      message === 'JBatchQueued',
    );

  const frameBuffer = encodeBuffer(frameRecord);
  const projectedHistoryBytes =
    head.retainedHistoryBytes +
    frameKey.byteLength +
    frameBuffer.byteLength +
    diffKey.byteLength +
    diffBuffer.byteLength;
  let frameDbBytes = 0;
  let frameDbPrunedBytes = 0;
  let frameDbRetainedBytes = 0;
  let frameDbPrunedKeys = 0;
  let frameDbLatestPrunedHeight = 0;
  const batch = db.batch();
  batch.put(frameKey, frameBuffer);
  batch.put(diffKey, diffBuffer);
  if (preparedHashes) {
    for (const doc of materializedPuts) {
      batch.put(liveKeyForDoc(doc), preparedHashes.docValueBuffers.get(docValueKey(doc)) ?? encodeBuffer(doc.value));
    }
    for (const ref of materializedDels) {
      if (typeof batch.del === 'function') batch.del(liveKeyForRef(ref));
    }
    for (const item of preparedHashes.docHashPuts) {
      batch.put(item.key, item.value);
    }
    for (const key of preparedHashes.docHashDels) {
      if (typeof batch.del === 'function') batch.del(key);
    }
    for (const item of preparedHashes.entityHashPuts) {
      batch.put(item.key, item.value);
    }
  }
  for (const replica of options.env.eReplicas.values()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    batch.put(keyLiveReplicaMeta(entityId), encodeBuffer(projectReplicaMeta(replica)));
  }

  const nextHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: options.env.height,
    latestMaterializedHeight: shouldMaterialize
      ? options.env.height
      : Math.max(0, Math.floor(Number(head.latestMaterializedHeight ?? 0))),
    latestSnapshotHeight: head.latestSnapshotHeight,
    snapshotPeriodFrames: config.snapshotPeriodFrames,
    retainSnapshots: config.retainSnapshots,
    epochMaxBytes: config.epochMaxBytes,
    accountMerkleRadix: config.accountMerkleRadix,
    retainedHistoryBytes: projectedHistoryBytes,
  };
  batch.put(KEY_HEAD, encodeBuffer(nextHead));
  await writeBatch(batch);
  if (state) {
    state.currentStorageOverlayMarks = [];
  }
  if (preparedHashes) {
    state.storageEntityHashDocs = preparedHashes.entityHashDocs;
  }
  if (frameDbPuts.length > 0) {
    try {
      const frameDbReady = await options.tryOpenFrameDb(options.env);
      if (!frameDbReady) throw new Error('RUNTIME_FRAME_DB_UNAVAILABLE');
      const frameDb = options.getFrameDb(options.env);
      const frameDbResult = await writeFrameDbPutsWithRetention({
        db: frameDb,
        height: options.env.height,
        puts: frameDbPuts,
        config,
      });
      frameDbBytes = frameDbResult.writtenBytes;
      frameDbPrunedBytes = frameDbResult.prunedBytes;
      frameDbRetainedBytes = frameDbResult.retainedBytes;
      frameDbPrunedKeys = frameDbResult.prunedKeys;
      frameDbLatestPrunedHeight = frameDbResult.latestPrunedRuntimeHeight;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PERSIST] frame DB secondary-index write failed after main commit: ${message}`);
    }
  }
  const writeMs = options.getPerfMs() - writeStartedAt;

  let snapshotMs = 0;
  let snapDocs = 0;
  let snapshotBytes = 0;
  let prunedBytes = 0;
  let epochRotated = false;
  let epochDbRotated = false;
  let retainedHistoryBytes = nextHead.retainedHistoryBytes;
  let latestSnapshotHeight = head.latestSnapshotHeight;

  if (snapshotDue || snapshotRequiredByBytes) {
    const snapshotStartedAt = options.getPerfMs();
    const snapshotResult = await createSnapshot(db, options.env.height);
    snapDocs = snapshotResult.docCount;
    snapshotBytes = snapshotResult.bytes;
    retainedHistoryBytes += snapshotBytes;
    latestSnapshotHeight = options.env.height;
    prunedBytes += await maybeRotateSnapshots(db, config.retainSnapshots);
    snapshotMs = options.getPerfMs() - snapshotStartedAt;
    if (snapshotRequiredByBytes && !snapshotDue) {
      epochRotated = true;
    }
  }

  if (snapDocs > 0) {
    const retainedSnapshotHeights = await listSnapshotHeights(db);
    const oldestRetainedSnapshotHeight = retainedSnapshotHeights[0] ?? 0;
    if (oldestRetainedSnapshotHeight > 0) {
      prunedBytes += await pruneHistoryBeforeHeight(db, oldestRetainedSnapshotHeight);
    }
  }

  retainedHistoryBytes = Math.max(0, retainedHistoryBytes - prunedBytes);

  if (snapDocs > 0 || prunedBytes > 0) {
    const latest = await readHead(db, config);
    const update = db.batch();
    update.put(
      KEY_HEAD,
      encodeBuffer({
        ...latest,
        latestSnapshotHeight,
        retainedHistoryBytes,
      }),
    );
    await writeBatch(update);
  }

  if (snapDocs > 0 && retainedHistoryBytes > config.epochMaxBytes && options.rotateEpochDb) {
    await options.rotateEpochDb(options.env, latestSnapshotHeight);
    epochDbRotated = true;
  }

  const verboseStorageLogs =
    String(process.env['XLN_STORAGE_VERBOSE'] ?? process.env['RUNTIME_VERBOSE_LOGS'] ?? '').toLowerCase() === '1' ||
    String(process.env['XLN_STORAGE_VERBOSE'] ?? process.env['RUNTIME_VERBOSE_LOGS'] ?? '').toLowerCase() === 'true';
  if (verboseStorageLogs && options.env.quietRuntimeLogs !== true) {
    console.log(
      `[PERSIST] runtime=${String(options.env.runtimeId || '').slice(0, 12)} frame=${options.env.height} puts=${diff.puts.length} dels=${diff.dels.length} ` +
        `frameBytes=${frameBuffer.byteLength} diffBytes=${diffBuffer.byteLength} ` +
        `frameDbBytes=${frameDbBytes} frameDbRetained=${frameDbRetainedBytes} frameDbPruned=${frameDbPrunedBytes}/${frameDbPrunedKeys}@${frameDbLatestPrunedHeight} ` +
        `snapshotBytes=${snapshotBytes} historyBytes=${retainedHistoryBytes} ` +
        `entities=${frameTouched.touchedEntities.size} accounts=${frameTouched.touchedAccounts.size} books=${frameTouched.touchedBookEntities.size} materialized=${shouldMaterialize ? 1 : 0} overlay=${overlayRecords.length} ` +
        `highSignals=${highSignalEvents.join(',') || 'none'} ` +
        `snapDocs=${snapDocs} epoch=${epochRotated ? 1 : 0} epochDb=${epochDbRotated ? 1 : 0} ` +
        `ms(open=${options.formatPerfMs(openMs)},diff=${options.formatPerfMs(diffBuildMs)},write=${options.formatPerfMs(writeMs)},snap=${options.formatPerfMs(snapshotMs)})`,
    );
  }
  return {
    materialized: shouldMaterialize,
    materializedOverlayRecords: shouldMaterialize ? overlayRecords.length : 0,
  };
};

export const readStorageHead = async (
  db: RuntimeDbLike,
): Promise<StorageHead | null> => readJsonOrNull<StorageHead>(db, KEY_HEAD);

export const readStorageFrameRecord = async (
  db: RuntimeDbLike,
  height: number,
): Promise<StorageFrameRecord | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  return readJsonOrNull<StorageFrameRecord>(db, keyFrame(targetHeight));
};

export const readStorageReplicaMeta = async (
  db: RuntimeDbLike,
  entityId: string,
): Promise<StorageReplicaMeta | null> => readJsonOrNull<StorageReplicaMeta>(db, keyLiveReplicaMeta(entityId));

const normalizeFrameEntityHashes = (entityHashes: StorageFrameEntityHash[] | undefined): StorageFrameEntityHash[] =>
  (entityHashes ?? [])
    .map((entry) => ({
      entityId: normalizeEntityId(entry.entityId),
      hash: String(entry.hash || ''),
      cellCount: Number(entry.cellCount ?? 0),
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

const assertEntityHashesEqual = (
  actual: StorageFrameEntityHash[] | undefined,
  expected: StorageFrameEntityHash[] | undefined,
  context: string,
): void => {
  const left = normalizeFrameEntityHashes(actual);
  const right = normalizeFrameEntityHashes(expected);
  if (left.length !== right.length) {
    throw new Error(`STORAGE_ENTITY_HASH_COUNT_MISMATCH: ${context} actual=${left.length} expected=${right.length}`);
  }
  for (let index = 0; index < left.length; index += 1) {
    const actualEntry = left[index]!;
    const expectedEntry = right[index]!;
    if (
      actualEntry.entityId !== expectedEntry.entityId ||
      actualEntry.hash !== expectedEntry.hash ||
      actualEntry.cellCount !== expectedEntry.cellCount
    ) {
      throw new Error(
        `STORAGE_ENTITY_HASH_MISMATCH: ${context} entity=${expectedEntry.entityId} ` +
          `actual=${actualEntry.hash}/${actualEntry.cellCount} expected=${expectedEntry.hash}/${expectedEntry.cellCount}`,
      );
    }
  }
};

export const verifyStorageTailIntegrity = async (
  db: RuntimeDbLike,
  options: { tailFrames?: number } = {},
): Promise<{ latestHeight: number; checkedFrames: number }> => {
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head || head.latestHeight <= 0) return { latestHeight: 0, checkedFrames: 0 };
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight)));
  const tailFrames = Math.max(1, Math.floor(Number(options.tailFrames ?? STORAGE_VERIFY_TAIL_FRAMES)));
  const startHeight = Math.max(1, latestHeight - tailFrames + 1);
  let previousHash = ZERO_FRAME_HASH;
  if (startHeight > 1) {
    const previous = await readStorageFrameRecord(db, startHeight - 1);
    if (!previous) throw new Error(`STORAGE_VERIFY_PREV_FRAME_MISSING: height=${startHeight - 1}`);
    previousHash = previous.frameHash ?? computeStorageFrameHash(previous);
  }

  let checkedFrames = 0;
  let latestRecord: StorageFrameRecord | null = null;
  for (let height = startHeight; height <= latestHeight; height += 1) {
    const record = await readStorageFrameRecord(db, height);
    if (!record) throw new Error(`STORAGE_VERIFY_FRAME_MISSING: height=${height}`);
    if (record.height !== height) throw new Error(`STORAGE_VERIFY_FRAME_HEIGHT_MISMATCH: key=${height} record=${record.height}`);
    if (record.prevFrameHash !== previousHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_CHAIN_BROKEN: height=${height} expectedPrev=${previousHash} actualPrev=${record.prevFrameHash ?? 'none'}`);
    }
    if (!Array.isArray(record.entityHashes)) {
      throw new Error(`STORAGE_VERIFY_ENTITY_HASHES_MISSING: height=${height}`);
    }
    if (record.materializedState !== false) {
      const expectedStateHash = computeStorageStateRoot(record.entityHashes);
      if (record.stateHash !== expectedStateHash) {
        throw new Error(`STORAGE_VERIFY_STATE_HASH_MISMATCH: height=${height} expected=${expectedStateHash} actual=${record.stateHash}`);
      }
      if (record.canonicalStateHash || Array.isArray(record.canonicalEntityHashes)) {
        if (!Array.isArray(record.canonicalEntityHashes) || !record.canonicalStateHash) {
          throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISSING: height=${height}`);
        }
        const expectedCanonicalHash = computeCanonicalRuntimeStateHash(record.height, record.timestamp, record.canonicalEntityHashes);
        if (record.canonicalStateHash !== expectedCanonicalHash) {
          throw new Error(`STORAGE_VERIFY_CANONICAL_HASH_MISMATCH: height=${height} expected=${expectedCanonicalHash} actual=${record.canonicalStateHash}`);
        }
      }
    }
    const actualFrameHash = computeStorageFrameHash(record);
    if (record.frameHash !== actualFrameHash) {
      throw new Error(`STORAGE_VERIFY_FRAME_HASH_MISMATCH: height=${height} expected=${actualFrameHash} actual=${record.frameHash ?? 'none'}`);
    }
    previousHash = actualFrameHash;
    latestRecord = record;
    checkedFrames += 1;
  }

  if (latestRecord) {
    assertEntityHashesEqual(
      toFrameEntityHashes((await readAllEntityHashDocs(db)).values()),
      latestRecord.entityHashes,
      `latestHeight=${latestHeight}`,
    );
  }
  return { latestHeight, checkedFrames };
};

export const listStorageSnapshotHeights = async (db: RuntimeDbLike): Promise<number[]> => {
  return listSnapshotHeights(db);
};

export const findStorageLatestSnapshotAtOrBelow = async (
  db: RuntimeDbLike,
  height: number,
): Promise<number> => {
  return findLatestSnapshotAtOrBelow(db, height);
};

export const listStorageLiveEntityIds = async (db: RuntimeDbLike): Promise<string[]> => {
  const keys = await listKeys(db, Buffer.from([KEY_LIVE_ENTITY]));
  return keys.map((key) => decodeEntityId(key.subarray(1, 33)));
};

export const listStorageSnapshotEntityIds = async (
  db: RuntimeDbLike,
  height: number,
): Promise<string[]> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return [];
  const keys = await listKeys(db, keySnapshotEntityPrefix(targetHeight));
  return keys.map((key) => decodeEntityId(key.subarray(9, 41)));
};

const applyDocs = (
  target: Map<string, StorageDoc>,
  puts: StorageDoc[],
  dels: StorageDocRef[],
  entityId?: string,
): void => {
  const filterEntity = entityId ? normalizeEntityId(entityId) : null;
  for (const ref of dels) {
    if (filterEntity) {
      const owner = ref.family === 'entity' ? ref.entityId : ref.entityId;
      if (normalizeEntityId(owner) !== filterEntity) continue;
    }
    target.delete(docRefKey(ref));
  }
  for (const doc of puts) {
    if (filterEntity && normalizeEntityId(doc.entityId) !== filterEntity) continue;
    target.set(docValueKey(doc), doc);
  }
};

const loadSnapshotDocsForEntity = async (db: RuntimeDbLike, snapshotHeight: number, entityId: string): Promise<Map<string, StorageDoc>> => {
  const docs = new Map<string, StorageDoc>();

  const entityBuffer = await readJsonOrNull<StorageEntityCoreDoc>(db, keySnapshotEntity(snapshotHeight, entityId));
  if (entityBuffer) {
    docs.set(`e:${normalizeEntityId(entityId)}`, { family: 'entity', entityId: normalizeEntityId(entityId), value: entityBuffer });
  }

  const accountKeys = await listKeys(db, keySnapshotAccountPrefix(snapshotHeight, entityId));
  for (const key of accountKeys) {
    const entity = decodeEntityId(key.subarray(9, 41));
    const counterparty = decodeEntityId(key.subarray(41, 73));
    const value = decodeBuffer<StorageAccountDoc>(await db.get(key));
    docs.set(`a:${normalizeEntityId(entity)}:${normalizeEntityId(counterparty)}`, {
      family: 'account',
      entityId: normalizeEntityId(entity),
      counterpartyId: normalizeEntityId(counterparty),
      value,
    });
  }

  const bookKeys = await listKeys(db, keySnapshotBookPrefix(snapshotHeight, entityId));
  for (const key of bookKeys) {
    const parsed = parseLiveBookKey(key, 9);
    const value = decodeBuffer<BookState>(await db.get(key));
    docs.set(`b:${normalizeEntityId(parsed.entityId)}:${parsed.pairId}`, {
      family: 'book',
      entityId: normalizeEntityId(parsed.entityId),
      pairId: parsed.pairId,
      value,
    });
  }

  return docs;
};

const findLatestSnapshotAtOrBelow = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const heights = await listSnapshotHeights(db);
  let best = 0;
  for (const value of heights) {
    if (value <= height && value > best) best = value;
  }
  return best;
};

export const loadEntityStateFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
}): Promise<EntityState | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head) return null;
  const targetHeight = Math.min(options.height ?? head.latestHeight, head.latestHeight);
  const entityId = normalizeEntityId(options.entityId);
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? head.latestHeight ?? 0)),
  );

  if (targetHeight === latestMaterializedHeight) {
    const entityCore = await readJsonOrNull<StorageEntityCoreDoc>(db, keyLiveEntity(entityId));
    if (!entityCore) return null;
    const accounts = new Map<string, StorageAccountDoc>();
    for (const key of await listKeys(db, keyLiveAccountPrefix(entityId))) {
      const parsed = parseLiveAccountKey(key);
      const doc = decodeBuffer<StorageAccountDoc>(await db.get(key));
      accounts.set(parsed.counterpartyId, doc);
    }
    const books = new Map<string, BookState>();
    for (const key of await listKeys(db, keyLiveBookPrefix(entityId))) {
      const parsed = parseLiveBookKey(key);
      books.set(parsed.pairId, decodeBuffer<BookState>(await db.get(key)));
    }
    return hydrateEntityStateFromStorage({ core: entityCore, accounts, books });
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const docs = baseSnapshotHeight > 0
    ? await loadSnapshotDocsForEntity(db, baseSnapshotHeight, entityId)
    : new Map<string, StorageDoc>();

  let cursor = baseSnapshotHeight + 1;
  while (cursor <= targetHeight) {
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(cursor));
    if (diff) {
      applyDocs(docs, diff.puts, diff.dels, entityId);
    }
    cursor += 1;
  }

  const core = docs.get(`e:${entityId}`) as Extract<StorageDoc, { family: 'entity' }> | undefined;
  if (!core) return null;
  const accounts = new Map<string, StorageAccountDoc>();
  const books = new Map<string, BookState>();
  for (const doc of docs.values()) {
    if (doc.family === 'account' && normalizeEntityId(doc.entityId) === entityId) {
      accounts.set(doc.counterpartyId, doc.value);
    } else if (doc.family === 'book' && normalizeEntityId(doc.entityId) === entityId) {
      books.set(doc.pairId, doc.value);
    }
  }

  return hydrateEntityStateFromStorage({ core: core.value, accounts, books });
};

export const inspectStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
}): Promise<StorageDebugStats | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const [
    head,
    frameStats,
    diffStats,
    snapshotManifestStats,
    snapshotEntityStats,
    snapshotAccountStats,
    snapshotBookStats,
    snapshotHeights,
    liveEntityStats,
    liveAccountStats,
    liveBookStats,
    liveReplicaMetaStats,
  ] = await Promise.all([
    readJsonOrNull<StorageHead>(db, KEY_HEAD),
    measurePrefixBytes(db, Buffer.from([KEY_FRAME])),
    measurePrefixBytes(db, Buffer.from([KEY_DIFF])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_MANIFEST])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_SNAPSHOT_BOOK])),
    listSnapshotHeights(db),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ENTITY])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_ACCOUNT])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_BOOK])),
    measurePrefixBytes(db, Buffer.from([KEY_LIVE_REPLICA_META])),
  ]);

  const snapshotBytes =
    snapshotManifestStats.bytes +
    snapshotEntityStats.bytes +
    snapshotAccountStats.bytes +
    snapshotBookStats.bytes;
  const liveBytes = liveEntityStats.bytes + liveAccountStats.bytes + liveBookStats.bytes + liveReplicaMetaStats.bytes;
  const historyBytes = frameStats.bytes + diffStats.bytes + snapshotBytes;
  const totalBytes = historyBytes + liveBytes;

  return {
    head,
    frameCount: frameStats.count,
    diffCount: diffStats.count,
    snapshotHeights,
    liveEntityCount: liveEntityStats.count,
    liveAccountCount: liveAccountStats.count,
    liveBookCount: liveBookStats.count,
    frameBytes: frameStats.bytes,
    diffBytes: diffStats.bytes,
    snapshotBytes,
    liveBytes,
    historyBytes,
    totalBytes,
    maxFrameBytes: frameStats.maxValueBytes,
    maxDiffBytes: diffStats.maxValueBytes,
    maxSnapshotBytes: Math.max(
      snapshotManifestStats.maxValueBytes,
      snapshotEntityStats.maxValueBytes,
      snapshotAccountStats.maxValueBytes,
      snapshotBookStats.maxValueBytes,
    ),
  };
};
