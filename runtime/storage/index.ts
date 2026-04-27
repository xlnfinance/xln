import { rebuildOrderbookPairIndex, type OrderbookExtState, type HubProfile, type EntityReferral, type BookState } from '../orderbook';
import { ethers } from 'ethers';
import { Packr } from 'msgpackr';
import { deserializeTaggedJson, safeStringify, serializeTaggedJson } from '../serialization-utils';
import { cloneEntityReplica } from '../state-helpers';
import { buildHexKeyedMerkle, type RadixMerkleRadix } from './merkle';
import {
  computeCanonicalEntityHash,
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalRuntimeStateHash,
  computeCanonicalStateHashFromEnv,
  type CanonicalFrameEntityHash,
} from './canonical-hash';
import type {
  AccountInput,
  AccountMachine,
  AccountStatus,
  ConsensusConfig,
  Delta,
  DebtEntry,
  EntityReplica,
  EntityInput,
  EntityState,
  EntitySwapPair,
  Env,
  FrameLogEntry,
  HtlcLock,
  HtlcNoteKey,
  HtlcRoute,
  HubRebalanceConfig,
  JurisdictionEvent,
  LockBookEntry,
  Proposal,
  RebalancePolicy,
  RebalanceQuote,
  RebalanceRequestFeeState,
  RuntimeInput,
  RuntimeFrameDbRecord,
  SwapOffer,
} from '../types';
import type { CrontabState } from '../crontab-types';
import type { JBatchState } from '../j-batch';
import type { SwapKey } from '../swap-keys';

type RuntimeDbLike = {
  get: (key: Buffer) => Promise<Buffer>;
  put?: (key: Buffer, value: Buffer, options?: { sync?: boolean }) => Promise<void>;
  batch: () => {
    put: (key: Buffer, value: Buffer) => unknown;
    del?: (key: Buffer) => unknown;
    write: (options?: { sync?: boolean }) => Promise<void>;
  };
  keys?: (options?: { gte?: Buffer; lt?: Buffer }) => AsyncIterable<Buffer | Uint8Array | string>;
};

type PerfDeps = {
  getPerfMs: () => number;
  formatPerfMs: (value: number) => string;
};

export type StorageRuntimeConfig = {
  enabled?: boolean;
  packPeriodFrames?: number;
  snapshotPeriodFrames?: number;
  retainSnapshots?: number;
  epochMaxBytes?: number;
  frameDbMaxBytes?: number;
  frameDbRetainFrames?: number;
  accountMerkleRadix?: RadixMerkleRadix;
};

export type StorageHead = {
  schemaVersion: number;
  latestHeight: number;
  latestSnapshotHeight: number;
  latestPackHeight: number;
  packPeriodFrames: number;
  snapshotPeriodFrames: number;
  retainSnapshots: number;
  epochMaxBytes: number;
  accountMerkleRadix: RadixMerkleRadix;
  retainedHistoryBytes: number;
};

export type StorageEntityCoreDoc = {
  entityId: string;
  signerId?: string;
  isProposer?: boolean;
  height: number;
  timestamp: number;
  messages: EntityState['messages'];
  nonces: Map<string, number>;
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string;
  reserves: Map<number, bigint>;
  deferredAccountProposals?: Map<string, true>;
  lastFinalizedJHeight: number;
  jBlockObservations: EntityState['jBlockObservations'];
  jBlockChain: EntityState['jBlockChain'];
  batchHistory?: EntityState['batchHistory'];
  accountInputQueue?: AccountInput[];
  crontabState?: CrontabState;
  jBatchState?: JBatchState;
  entityEncPubKey: string;
  entityEncPrivKey: string;
  profile: EntityState['profile'];
  htlcRoutes: Map<string, HtlcRoute>;
  htlcFeesEarned: bigint;
  htlcNotes?: Map<HtlcNoteKey, string>;
  outDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  inDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  lockBook: Map<string, LockBookEntry>;
  swapTradingPairs?: EntitySwapPair[];
  pendingSwapFillRatios?: Map<SwapKey, number>;
  hubRebalanceConfig?: HubRebalanceConfig;
  orderbookHubProfile?: HubProfile;
  orderbookReferrals?: Map<string, EntityReferral>;
};

export type StorageAccountDoc = {
  leftEntity: string;
  rightEntity: string;
  status: AccountStatus;
  mempool: AccountMachine['mempool'];
  currentFrame: AccountMachine['currentFrame'];
  deltas: Map<number, Delta>;
  locks: Map<string, HtlcLock>;
  swapOffers: Map<string, SwapOffer>;
  globalCreditLimits: AccountMachine['globalCreditLimits'];
  currentHeight: number;
  pendingFrame?: AccountMachine['pendingFrame'];
  pendingSignatures: string[];
  pendingAccountInput?: AccountMachine['pendingAccountInput'];
  rollbackCount: number;
  lastRollbackFrameHash?: string;
  leftJObservations?: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[]; observedAt: number }>;
  rightJObservations?: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[]; observedAt: number }>;
  jEventChain?: AccountMachine['jEventChain'];
  lastFinalizedJHeight: number;
  proofHeader: AccountMachine['proofHeader'];
  proofBody: AccountMachine['proofBody'];
  abiProofBody?: AccountMachine['abiProofBody'];
  disputeConfig: AccountMachine['disputeConfig'];
  currentFrameHanko?: AccountMachine['currentFrameHanko'];
  counterpartyFrameHanko?: AccountMachine['counterpartyFrameHanko'];
  currentDisputeProofHanko?: AccountMachine['currentDisputeProofHanko'];
  currentDisputeProofNonce?: number;
  currentDisputeProofBodyHash?: string;
  currentDisputeHash?: string;
  counterpartyDisputeProofHanko?: AccountMachine['counterpartyDisputeProofHanko'];
  counterpartyDisputeProofNonce?: number;
  counterpartyDisputeProofBodyHash?: string;
  counterpartyDisputeHash?: string;
  counterpartySettlementHanko?: AccountMachine['counterpartySettlementHanko'];
  disputeProofNoncesByHash?: AccountMachine['disputeProofNoncesByHash'];
  disputeProofBodiesByHash?: AccountMachine['disputeProofBodiesByHash'];
  onChainSettlementNonce: number;
  settlementWorkspace?: AccountMachine['settlementWorkspace'];
  activeDispute?: AccountMachine['activeDispute'];
  swapOrderHistory?: AccountMachine['swapOrderHistory'];
  swapClosedOrders?: AccountMachine['swapClosedOrders'];
  pendingWithdrawals: Map<string, {
    requestId: string;
    tokenId: number;
    amount: bigint;
    requestedAt: number;
    direction: 'outgoing' | 'incoming';
    status: 'pending' | 'approved' | 'rejected' | 'timed_out';
    signature?: string;
  }>;
  requestedRebalance: Map<number, bigint>;
  requestedRebalanceFeeState: Map<number, RebalanceRequestFeeState>;
  counterpartyRebalanceFeePolicy?: AccountMachine['counterpartyRebalanceFeePolicy'];
  rebalancePolicy: Map<number, RebalancePolicy>;
  activeRebalanceQuote?: RebalanceQuote;
  pendingRebalanceRequest?: { tokenId: number; targetAmount: bigint };
};

export type StorageDoc =
  | { family: 'entity'; entityId: string; value: StorageEntityCoreDoc }
  | { family: 'account'; entityId: string; counterpartyId: string; value: StorageAccountDoc }
  | { family: 'book'; entityId: string; pairId: string; value: BookState };

export type StorageDocRef =
  | { family: 'entity'; entityId: string }
  | { family: 'account'; entityId: string; counterpartyId: string }
  | { family: 'book'; entityId: string; pairId: string };

type StorageAccountRef = Extract<StorageDocRef, { family: 'account' }>;

export type StorageFrameRecord = {
  height: number;
  timestamp: number;
  prevFrameHash?: string;
  frameHash?: string;
  stateHash: string;
  hashMode?: 'storage-debug-v1' | 'legacy-env-v1';
  entityHashes?: StorageFrameEntityHash[];
  /**
   * Independent audit root computed from canonical EntityReplica snapshots,
   * not from storage projection docs. This catches bugs where project*Doc()
   * accidentally omits state that restore/replay would otherwise miss too.
   */
  auditStateHash?: string;
  auditEntityHashes?: StorageFrameEntityHash[];
  /**
   * Independent canonical root computed directly from live EntityReplica data.
   * This intentionally avoids cloneEntityReplica(), project*Doc(), msgpack, and
   * coarse-doc storage cells so replay verification can catch bugs in those
   * pipelines instead of repeating them.
   */
  canonicalStateHash?: string;
  canonicalEntityHashes?: StorageFrameEntityHash[];
  /**
   * Runtime replay journal. Activity/log/account-frame history is indexed in
   * the separate frame DB so live state compaction is not coupled to UI history.
   */
  runtimeInput: RuntimeInput;
  frameOutputs: EntityInput[];
  logs: FrameLogEntry[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
};

export type StorageHashCell = {
  key: string;
  hash: string;
};

export type StorageEntityHashDoc = {
  entityId: string;
  hash: string;
  cells: StorageHashCell[];
};

export type StorageFrameEntityHash = {
  entityId: string;
  hash: string;
  cellCount: number;
};

export type StorageReplicaMeta = {
  entityId: string;
  signerId?: string;
  isProposer?: boolean;
  proposal?: EntityReplica['proposal'];
  lockedFrame?: EntityReplica['lockedFrame'];
  validatorComputedState?: EntityReplica['validatorComputedState'];
  hankoWitness?: EntityReplica['hankoWitness'];
};

export type StorageDiffRecord = {
  height: number;
  puts: StorageDoc[];
  dels: StorageDocRef[];
};

export type StoragePackRecord = {
  startHeight: number;
  endHeight: number;
  puts: StorageDoc[];
  dels: StorageDocRef[];
};

export type StorageSnapshotManifest = {
  height: number;
  createdAt: number;
  docCount: number;
};

export type StorageDebugStats = {
  head: StorageHead | null;
  frameCount: number;
  diffCount: number;
  packCount: number;
  snapshotHeights: number[];
  liveEntityCount: number;
  liveAccountCount: number;
  liveBookCount: number;
  frameBytes: number;
  diffBytes: number;
  packBytes: number;
  snapshotBytes: number;
  liveBytes: number;
  historyBytes: number;
  totalBytes: number;
  maxFrameBytes: number;
  maxDiffBytes: number;
  maxPackBytes: number;
  maxSnapshotBytes: number;
  epochDbs?: Array<{
    role: 'current' | 'previous';
    path: string;
    latestHeight: number;
    latestSnapshotHeight: number;
    frameCount: number;
    diffCount: number;
    packCount: number;
    snapshotCount: number;
    liveBytes: number;
    historyBytes: number;
    totalBytes: number;
  }>;
};

const STORAGE_SCHEMA_VERSION = 1;
const DEFAULT_PACK_PERIOD_FRAMES = 64;
const DEFAULT_SNAPSHOT_PERIOD_FRAMES = 256;
const DEFAULT_RETAIN_SNAPSHOTS = 3;
const DEFAULT_EPOCH_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_FRAME_DB_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_FRAME_DB_RETAIN_FRAMES = 100_000;
const DEFAULT_ACCOUNT_MERKLE_RADIX: RadixMerkleRadix = 16;
const KEY_HEAD = Buffer.from([0x01]);
const KEY_FRAME = 0x02;
const KEY_DIFF = 0x03;
const KEY_PACK = 0x04;
const KEY_SNAPSHOT_MANIFEST = 0x05;
const KEY_LIVE_ENTITY = 0x21;
const KEY_LIVE_ACCOUNT = 0x22;
const KEY_LIVE_BOOK = 0x23;
const KEY_LIVE_DOC_HASH = 0x24;
const KEY_LIVE_ENTITY_HASH = 0x25;
const KEY_LIVE_REPLICA_META = 0x26;
const KEY_SNAPSHOT_ENTITY = 0x31;
const KEY_SNAPSHOT_ACCOUNT = 0x32;
const KEY_SNAPSHOT_BOOK = 0x33;
const EPOCH_SEED_FRAME_TAIL = 129;

const KEY_FRAME_DB_HEAD = Buffer.from([0x00]);
const FRAME_DB_ACCOUNT_FRAME = 0x01;
const FRAME_DB_RUNTIME_ACTIVITY = 0x02;
const FRAME_DB_ENTITY_ACTIVITY = 0x03;
const ZERO_FRAME_HASH = `0x${'00'.repeat(32)}`;

type StorageCodecName = 'json' | 'msgpack';

const STORAGE_CODEC_MAGIC: Record<StorageCodecName, number> = {
  msgpack: 0x01,
  json: 0x02,
};
const STORAGE_CODEC_BY_MAGIC = new Map<number, StorageCodecName>(
  Object.entries(STORAGE_CODEC_MAGIC).map(([codec, magic]) => [magic, codec as StorageCodecName]),
);

const notFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '');
  const name = String((error as { name?: unknown }).name ?? '');
  return code === 'LEVEL_NOT_FOUND' || name === 'NotFoundError';
};

const msgpackCodec = new Packr({
  mapsAsObjects: false,
  structuredClone: true,
});

const storageCodecName = (): StorageCodecName => {
  const raw = String(
    typeof process !== 'undefined'
      ? process.env['XLN_STORAGE_CODEC'] ?? ''
      : '',
  ).trim().toLowerCase();
  return raw === 'json' ? 'json' : 'msgpack';
};

const encodeWithCodec = (codec: StorageCodecName, value: unknown): Buffer => {
  if (codec === 'json') return Buffer.from(serializeTaggedJson(value));
  return Buffer.from(msgpackCodec.pack(value));
};

const decodeWithCodec = <T>(codec: StorageCodecName, buffer: Buffer): T => {
  if (codec === 'json') return deserializeTaggedJson<T>(buffer.toString());
  return msgpackCodec.unpack(buffer) as T;
};

const encodeBuffer = (value: unknown): Buffer => {
  const codec = storageCodecName();
  return Buffer.concat([Buffer.from([STORAGE_CODEC_MAGIC[codec]]), encodeWithCodec(codec, value)]);
};
const decodeBuffer = <T>(buffer: Buffer): T => {
  const magic = buffer[0];
  const codec = magic === undefined ? undefined : STORAGE_CODEC_BY_MAGIC.get(magic);
  if (!codec) {
    throw new Error(`STORAGE_CODEC_MAGIC_MISSING: firstByte=${magic ?? 'none'}`);
  }
  return decodeWithCodec<T>(codec, buffer.subarray(1));
};
const withProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const storageSyncWritesEnabled = (): boolean => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_SYNC_WRITES'] ?? '' : '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
};

const writeBatch = async (
  batch: { write: (options?: { sync?: boolean }) => Promise<void> },
  options: { sync?: boolean } = {},
): Promise<void> => {
  const sync = options.sync ?? storageSyncWritesEnabled();
  await batch.write(sync ? { sync: true } : undefined);
};

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();

const hexBytes = (value: string): Buffer => {
  const hex = normalizeEntityId(value).replace(/^0x/, '');
  return Buffer.from(hex.padStart(64, '0'), 'hex');
};

const decodeEntityId = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

const encodeHeight = (height: number): Buffer => {
  const out = Buffer.allocUnsafe(8);
  out.writeBigUInt64BE(BigInt(height));
  return out;
};

const decodeHeight = (buffer: Buffer, offset = 1): number => Number(buffer.readBigUInt64BE(offset));

const textBytes = (value: string): Buffer => {
  const raw = Buffer.from(value, 'utf8');
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(raw.length);
  return Buffer.concat([len, raw]);
};

const readText = (buffer: Buffer, offset: number): { value: string; nextOffset: number } => {
  const len = buffer.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buffer.subarray(start, start + len).toString('utf8'), nextOffset: start + len };
};

const keyFrame = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_FRAME]), encodeHeight(height)]);
const keyDiff = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_DIFF]), encodeHeight(height)]);
const keyPack = (endHeight: number): Buffer => Buffer.concat([Buffer.from([KEY_PACK]), encodeHeight(endHeight)]);
const keySnapshotManifest = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_SNAPSHOT_MANIFEST]), encodeHeight(height)]);

const keyLiveEntity = (entityId: string): Buffer => Buffer.concat([Buffer.from([KEY_LIVE_ENTITY]), hexBytes(entityId)]);

const keyLiveAccount = (entityId: string, counterpartyId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_ACCOUNT]), hexBytes(entityId), hexBytes(counterpartyId)]);
const keyLiveAccountPrefix = (entityId?: string): Buffer =>
  entityId ? Buffer.concat([Buffer.from([KEY_LIVE_ACCOUNT]), hexBytes(entityId)]) : Buffer.from([KEY_LIVE_ACCOUNT]);

const keyLiveBook = (entityId: string, pairId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_BOOK]), hexBytes(entityId), textBytes(pairId)]);
const keyLiveBookPrefix = (entityId?: string): Buffer =>
  entityId ? Buffer.concat([Buffer.from([KEY_LIVE_BOOK]), hexBytes(entityId)]) : Buffer.from([KEY_LIVE_BOOK]);

const keyLiveEntityHash = (entityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_ENTITY_HASH]), hexBytes(entityId)]);
const keyLiveEntityHashPrefix = (): Buffer => Buffer.from([KEY_LIVE_ENTITY_HASH]);

const keyLiveReplicaMeta = (entityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_REPLICA_META]), hexBytes(entityId)]);

const keyFrameDbAccountFrame = (
  entityId: string,
  counterpartyId: string,
  accountHeight: number,
): Buffer => Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME]), hexBytes(entityId), hexBytes(counterpartyId), encodeHeight(accountHeight)]);
const keyFrameDbRuntimeActivity = (height: number): Buffer =>
  Buffer.concat([Buffer.from([FRAME_DB_RUNTIME_ACTIVITY]), encodeHeight(height)]);
const keyFrameDbEntityActivity = (entityId: string, height: number): Buffer =>
  Buffer.concat([Buffer.from([FRAME_DB_ENTITY_ACTIVITY]), hexBytes(entityId), encodeHeight(height)]);
const keyFrameDbAccountFramePrefix = (entityId?: string, counterpartyId?: string): Buffer => {
  if (entityId && counterpartyId) return Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME]), hexBytes(entityId), hexBytes(counterpartyId)]);
  if (entityId) return Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME]), hexBytes(entityId)]);
  return Buffer.from([FRAME_DB_ACCOUNT_FRAME]);
};

const keySnapshotEntity = (height: number, entityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height), hexBytes(entityId)]);
const keySnapshotEntityPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height)]);

const keySnapshotAccountPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_ACCOUNT]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_ACCOUNT]), encodeHeight(height)]);

const keySnapshotBookPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height)]);

const prefixUpperBound = (prefix: Buffer): Buffer | undefined => {
  const out = Buffer.from(prefix);
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const current = out[index];
    if (current === undefined || current === 0xff) continue;
    out[index] = current + 1;
    return out.subarray(0, index + 1);
  }
  return undefined;
};

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

const parseLiveAccountKey = (key: Buffer): { entityId: string; counterpartyId: string } => ({
  entityId: decodeEntityId(key.subarray(1, 33)),
  counterpartyId: decodeEntityId(key.subarray(33, 65)),
});

const parseLiveBookKey = (key: Buffer, offset = 1): { entityId: string; pairId: string } => {
  const entityId = decodeEntityId(key.subarray(offset, offset + 32));
  const { value } = readText(key, offset + 32);
  return { entityId, pairId: value };
};

const parseSnapshotManifestHeight = (key: Buffer): number => decodeHeight(key);

const hashBuffer = (value: Buffer | Uint8Array): string =>
  ethers.keccak256(value instanceof Uint8Array ? value : Uint8Array.from(value));

const hashStable = (value: unknown): string => ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(value)));

const normalizeHashCells = (cells: Iterable<StorageHashCell>): StorageHashCell[] =>
  Array.from(cells)
    .map((cell) => ({ key: String(cell.key), hash: String(cell.hash) }))
    .filter((cell) => cell.key.length > 0 && /^0x[0-9a-f]{64}$/i.test(cell.hash))
    .sort((left, right) => left.key.localeCompare(right.key));

const buildEntityHashDoc = (entityId: string, cells: Iterable<StorageHashCell>): StorageEntityHashDoc => {
  const normalizedCells = normalizeHashCells(cells);
  return {
    entityId: normalizeEntityId(entityId),
    cells: normalizedCells,
    hash: hashStable({
      kind: 'xln.storage.entityHash.v1',
      entityId: normalizeEntityId(entityId),
      cells: normalizedCells,
    }),
  };
};

export const computeStorageRuntimeStateHash = (
  height: number,
  timestamp: number,
  entityHashes: StorageFrameEntityHash[],
): string => hashStable({
  kind: 'xln.storage.runtimeHash.v1',
  height,
  timestamp,
  entities: entityHashes
    .map((entry) => ({
      entityId: normalizeEntityId(entry.entityId),
      hash: entry.hash,
      cellCount: entry.cellCount,
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId)),
});

const hashCanonicalJson = (value: unknown): string =>
  ethers.keccak256(ethers.toUtf8Bytes(safeStringify(value)));

const computeStorageAuditRuntimeStateHash = (
  height: number,
  timestamp: number,
  entityHashes: StorageFrameEntityHash[],
): string => hashCanonicalJson({
  kind: 'xln.storage.auditRuntimeHash.v1',
  height,
  timestamp,
  entities: entityHashes
    .map((entry) => ({
      entityId: normalizeEntityId(entry.entityId),
      hash: entry.hash,
      cellCount: entry.cellCount,
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId)),
});

const computeStorageAuditEntityHash = (replica: EntityReplica): StorageFrameEntityHash => {
  const entityId = normalizeEntityId(replica.entityId || replica.state?.entityId || '');
  const snapshot = cloneEntityReplica(replica, true);
  if (Array.isArray(snapshot.state.accountInputQueue) && snapshot.state.accountInputQueue.length === 0) {
    delete (snapshot.state as EntityState & { accountInputQueue?: unknown }).accountInputQueue;
  }
  return {
    entityId,
    cellCount: 1,
    hash: hashCanonicalJson({
      kind: 'xln.storage.auditEntityHash.v1',
      entityId,
      // Historical replay only restores EntityState for arbitrary heights.
      // Proposal/witness/validator metadata is latest-height crash-recovery
      // state, so including it here makes verifyRuntimeChain fail for older
      // heights even when replayed consensus state is correct.
      state: snapshot.state,
    }),
  };
};

export const computeStorageAuditEntityHashesFromEnv = (env: Env): StorageFrameEntityHash[] =>
  Array.from(env.eReplicas.values())
    .filter((replica): replica is EntityReplica => Boolean(replica?.state))
    .map((replica) => computeStorageAuditEntityHash(replica))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

export const computeStorageAuditStateHashFromEnv = (env: Env): string =>
  computeStorageAuditRuntimeStateHash(env.height, env.timestamp, computeStorageAuditEntityHashesFromEnv(env));

export const computeStorageCanonicalStateHashFromEnv = computeCanonicalStateHashFromEnv;

const prepareStorageAuditStateHashes = (
  env: Env,
  touchedEntities: string[],
  previousFrame: StorageFrameRecord | null,
): { auditStateHash: string; auditEntityHashes: StorageFrameEntityHash[] } => {
  const liveEntityIds = new Set(Array.from(env.eReplicas.values()).map((replica) => normalizeEntityId(replica.entityId)));
  const previousHashes = Array.isArray(previousFrame?.auditEntityHashes)
    ? normalizeFrameEntityHashes(previousFrame.auditEntityHashes)
    : [];
  const auditHashByEntity = new Map<string, StorageFrameEntityHash>();

  if (previousHashes.length > 0) {
    for (const entry of previousHashes) {
      if (liveEntityIds.has(entry.entityId)) auditHashByEntity.set(entry.entityId, entry);
    }
  } else {
    for (const entry of computeStorageAuditEntityHashesFromEnv(env)) {
      auditHashByEntity.set(entry.entityId, entry);
    }
  }

  for (const entityId of touchedEntities) {
    const normalized = normalizeEntityId(entityId);
    const replica = findReplicaForEntity(env, normalized)?.replica;
    if (replica) auditHashByEntity.set(normalized, computeStorageAuditEntityHash(replica));
    else auditHashByEntity.delete(normalized);
  }

  const auditEntityHashes = Array.from(auditHashByEntity.values())
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  return {
    auditEntityHashes,
    auditStateHash: computeStorageAuditRuntimeStateHash(env.height, env.timestamp, auditEntityHashes),
  };
};

const prepareStorageCanonicalStateHashes = (
  env: Env,
  touchedEntities: string[],
  previousFrame: StorageFrameRecord | null,
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
    const replica = findReplicaForEntity(env, normalized)?.replica;
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
  packPeriodFrames: Math.max(
    1,
    Number(env.runtimeConfig?.storage?.packPeriodFrames ?? DEFAULT_PACK_PERIOD_FRAMES),
  ),
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
  accountMerkleRadix: env.runtimeConfig?.storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
});

const readHead = async (db: RuntimeDbLike, config: Required<StorageRuntimeConfig>): Promise<StorageHead> => {
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  return head ?? {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 0,
    latestSnapshotHeight: 0,
    latestPackHeight: 0,
    packPeriodFrames: config.packPeriodFrames,
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
): { replicaKey: string; replica: EntityReplica; state: EntityState } | null => {
  const normalized = normalizeEntityId(entityId);
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const candidate = String(replica?.entityId || String(replicaKey).split(':')[0] || '').toLowerCase();
    if (candidate === normalized) return { replicaKey: String(replicaKey), replica, state: replica.state };
  }
  return null;
};

const nextRouteHop = (entityId: string, route: string[] | undefined, fallback: string): string => {
  const normalized = normalizeEntityId(entityId);
  const normalizedRoute = Array.isArray(route) ? route.map(normalizeEntityId) : [];
  const index = normalizedRoute.indexOf(normalized);
  if (index >= 0 && index + 1 < normalizedRoute.length) return normalizedRoute[index + 1]!;
  return normalizeEntityId(fallback);
};

const addAccountRef = (target: Map<string, StorageDocRef>, entityId: string, counterpartyId: string): void => {
  if (!entityId || !counterpartyId) return;
  const ref: StorageDocRef = { family: 'account', entityId: normalizeEntityId(entityId), counterpartyId: normalizeEntityId(counterpartyId) };
  target.set(docRefKey(ref), ref);
};

const addAccountPairRefs = (target: Map<string, StorageDocRef>, entityId: string, counterpartyId: string): void => {
  addAccountRef(target, entityId, counterpartyId);
  addAccountRef(target, counterpartyId, entityId);
};

const touchesBooks = (input: EntityInput): boolean =>
  (input.entityTxs ?? []).some((tx) =>
    tx.type === 'placeSwapOffer' ||
    tx.type === 'resolveSwap' ||
    tx.type === 'cancelSwap' ||
    tx.type === 'proposeCancelSwap' ||
    tx.type === 'initOrderbookExt' ||
    tx.type === 'accountInput',
  );

const collectJEventAccountRefs = (
  entityId: string,
  data: unknown,
  touchedAccounts: Map<string, StorageAccountRef>,
): void => {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const rawEvents = Array.isArray(record['events'])
    ? record['events']
    : record['event'] && typeof record['event'] === 'object'
      ? [record['event']]
      : [];
  for (const rawEvent of rawEvents) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const event = rawEvent as { type?: unknown; data?: unknown };
    const eventData = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {};
    if (event.type === 'AccountSettled') {
      const leftEntity = String(eventData['leftEntity'] || '').toLowerCase();
      const rightEntity = String(eventData['rightEntity'] || '').toLowerCase();
      if (leftEntity === entityId && rightEntity) addAccountPairRefs(touchedAccounts, entityId, rightEntity);
      else if (rightEntity === entityId && leftEntity) addAccountPairRefs(touchedAccounts, entityId, leftEntity);
    } else if (event.type === 'DisputeStarted' || event.type === 'DisputeFinalized') {
      const sender = String(eventData['sender'] || '').toLowerCase();
      const counterentity = String(eventData['counterentity'] || '').toLowerCase();
      if (sender === entityId && counterentity) addAccountPairRefs(touchedAccounts, entityId, counterentity);
      else if (counterentity === entityId && sender) addAccountPairRefs(touchedAccounts, entityId, sender);
    }
  }
};

const collectTouchedRefs = (appliedRuntimeInput: RuntimeInput): {
  touchedEntities: Set<string>;
  touchedAccounts: Map<string, StorageAccountRef>;
  touchedBookEntities: Set<string>;
} => {
  const touchedEntities = new Set<string>();
  const touchedAccounts = new Map<string, StorageAccountRef>();
  const touchedBookEntities = new Set<string>();

  for (const runtimeTx of appliedRuntimeInput.runtimeTxs ?? []) {
    if (runtimeTx.type === 'importReplica' && runtimeTx.entityId) {
      touchedEntities.add(normalizeEntityId(runtimeTx.entityId));
    }
  }

  for (const input of appliedRuntimeInput.entityInputs ?? []) {
    const entityId = normalizeEntityId(input.entityId);
    touchedEntities.add(entityId);
    if (touchesBooks(input)) touchedBookEntities.add(entityId);

    for (const tx of input.entityTxs ?? []) {
      switch (tx.type) {
        case 'accountInput': {
          const counterpartyId = normalizeEntityId(tx.data.fromEntityId) === entityId
            ? normalizeEntityId(tx.data.toEntityId)
            : normalizeEntityId(tx.data.fromEntityId);
          addAccountPairRefs(touchedAccounts, entityId, counterpartyId);
          break;
        }
        case 'openAccount':
          addAccountPairRefs(touchedAccounts, entityId, tx.data.targetEntityId);
          break;
        case 'j_event_account_claim':
        case 'requestCollateral':
        case 'reopenDisputedAccount':
        case 'settleDiffs':
        case 'disputeStart':
        case 'disputeFinalize':
        case 'extendCredit':
        case 'setRebalancePolicy':
        case 'placeSwapOffer':
        case 'resolveSwap':
        case 'cancelSwap':
        case 'proposeCancelSwap':
        case 'createSettlement':
        case 'settle_propose':
        case 'settle_update':
        case 'settle_approve':
        case 'settle_execute':
        case 'settle_reject':
          addAccountPairRefs(touchedAccounts, entityId, (tx.data as { counterpartyEntityId: string }).counterpartyEntityId);
          break;
        case 'r2c':
          addAccountPairRefs(touchedAccounts, entityId, tx.data.counterpartyId);
          break;
        case 'directPayment':
        case 'htlcPayment':
          addAccountPairRefs(touchedAccounts, entityId, nextRouteHop(entityId, tx.data.route, tx.data.targetEntityId));
          break;
        case 'processHtlcTimeouts':
          for (const expired of tx.data.expiredLocks ?? []) {
            addAccountPairRefs(touchedAccounts, entityId, expired.accountId);
          }
          break;
        case 'rollbackTimedOutFrames':
          for (const timedOut of tx.data.timedOutAccounts ?? []) {
            addAccountPairRefs(touchedAccounts, entityId, timedOut.counterpartyId);
          }
          break;
        case 'manualHtlcLock':
          addAccountPairRefs(touchedAccounts, entityId, tx.data.counterpartyId);
          break;
        case 'j_event':
          collectJEventAccountRefs(entityId, tx.data, touchedAccounts);
          break;
        default:
          break;
      }
    }
  }

  return { touchedEntities, touchedAccounts, touchedBookEntities };
};

const mergeTouchedRefs = (
  base: ReturnType<typeof collectTouchedRefs>,
  extra: ReturnType<typeof collectTouchedRefs>,
): ReturnType<typeof collectTouchedRefs> => {
  for (const entityId of extra.touchedEntities) base.touchedEntities.add(entityId);
  for (const [key, ref] of extra.touchedAccounts) base.touchedAccounts.set(key, ref);
  for (const entityId of extra.touchedBookEntities) base.touchedBookEntities.add(entityId);
  return base;
};

const buildDocPuts = (env: Env, touched: ReturnType<typeof collectTouchedRefs>): StorageDoc[] => {
  const puts: StorageDoc[] = [];

  for (const entityId of touched.touchedEntities) {
    const replica = findReplicaForEntity(env, entityId);
    if (!replica) continue;
    puts.push({
      family: 'entity',
      entityId,
      value: projectEntityCoreDoc(replica.state, replica.replica),
    });
  }

  for (const ref of touched.touchedAccounts.values()) {
    const replica = findReplicaForEntity(env, ref.entityId);
    const account = replica?.state.accounts.get(ref.counterpartyId);
    if (!replica || !account) continue;
    puts.push({
      family: 'account',
      entityId: ref.entityId,
      counterpartyId: ref.counterpartyId,
      value: projectAccountDoc(account),
    });
  }

  for (const entityId of touched.touchedBookEntities) {
    const replica = findReplicaForEntity(env, entityId);
    const books = replica?.state.orderbookExt?.books;
    if (!books) continue;
    for (const [pairId, book] of books.entries()) {
      puts.push({ family: 'book', entityId, pairId, value: book });
    }
  }

  return puts;
};

const buildBookDeletions = async (db: RuntimeDbLike, env: Env, touchedBookEntities: ReadonlySet<string>): Promise<StorageDocRef[]> => {
  const dels: StorageDocRef[] = [];
  for (const entityId of touchedBookEntities) {
    const liveKeys = await listKeys(db, keyLiveBookPrefix(entityId));
    if (liveKeys.length === 0) continue;
    const replica = findReplicaForEntity(env, entityId);
    const currentPairs = new Set(Array.from(replica?.state.orderbookExt?.books?.keys?.() ?? []).map(String));
    for (const key of liveKeys) {
      const parsed = parseLiveBookKey(key);
      if (!currentPairs.has(parsed.pairId)) {
        dels.push({ family: 'book', entityId, pairId: parsed.pairId });
      }
    }
  }
  return dels;
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

const hashValueBuffer = (value: Buffer): Buffer => Buffer.from(hashBuffer(value).slice(2), 'hex');

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
    const valueBuffer = encodeBuffer(doc.value);
    const valueHash = hashBuffer(valueBuffer);
    docValueBuffers.set(docValueKey(doc), valueBuffer);
    docHashPuts.push({ key: keyLiveDocHash(ref), value: hashValueBuffer(valueBuffer) });
    await updateEntityCells(ref.entityId, (cells) => {
      cells.set(docRefCellKey(ref), valueHash);
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
    stateHash: computeStorageRuntimeStateHash(options.height, options.timestamp, entityHashes),
    entityHashes,
    entityHashDocs,
    docValueBuffers,
    docHashPuts,
    docHashDels,
    entityHashPuts,
  };
};

type RuntimeFrameDbLike = RuntimeDbLike;

type FrameDbPut = { key: Buffer; value: Buffer };

type StorageFrameDbHead = {
  schemaVersion: number;
  latestHeight: number;
  latestPrunedRuntimeHeight: number;
  retainedBytes: number;
  maxBytes: number;
  retainFrames: number;
};

type StoredAccountFrameRecord = Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }> & {
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

  const frameCountsByEntity = new Map<string, number>();
  for (const record of options.frameDbRecords ?? []) {
    if (record.kind !== 'accountFrame') continue;
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
    frameCountsByEntity.set(entityId, (frameCountsByEntity.get(entityId) ?? 0) + 1);
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
      logCount: options.logs.filter((log) => normalizeEntityId(String(log.entityId || log.data?.['entityId'] || '')) === normalized).length,
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

  const accountFrameKeysToDelete: Buffer[] = [];
  for (const key of await listKeys(db, keyFrameDbAccountFramePrefix())) {
    const raw = await readRawOrNull(db, key);
    if (!raw) continue;
    const record = decodeBuffer<StoredAccountFrameRecord>(raw);
    if (Math.max(0, Math.floor(Number(record.runtimeHeight ?? 0))) <= cutoff) {
      accountFrameKeysToDelete.push(key);
    }
  }
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
  return computeStorageRuntimeStateHash(env.height, env.timestamp, toFrameEntityHashes(entityHashDocs));
};

const buildDiffRecord = (height: number, puts: StorageDoc[], dels: StorageDocRef[]): StorageDiffRecord => ({
  height,
  puts,
  dels,
});

type NamespaceBytes = {
  count: number;
  bytes: number;
  maxValueBytes: number;
};

export type StorageEpochSeedStats = {
  liveBytes: number;
  snapshotBytes: number;
  frameBytes: number;
  docCount: number;
};

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
    // to compute prevFrameHash for the first append after rotation. Diffs/packs
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
      latestPackHeight: 0,
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

const maybeCreatePack = async (
  db: RuntimeDbLike,
  height: number,
  packPeriodFrames: number,
): Promise<{ created: boolean; bytes: number }> => {
  if (height <= 0 || height % packPeriodFrames !== 0) return { created: false, bytes: 0 };
  const startHeight = Math.max(1, height - packPeriodFrames + 1);
  const docPuts = new Map<string, StorageDoc>();
  const docDels = new Map<string, StorageDocRef>();

  for (let h = startHeight; h <= height; h += 1) {
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(h));
    if (!diff) return { created: false, bytes: 0 };
    for (const ref of diff.dels) {
      docDels.set(docRefKey(ref), ref);
      docPuts.delete(docRefKey(ref));
    }
    for (const doc of diff.puts) {
      docPuts.set(docValueKey(doc), doc);
      docDels.delete(docValueKey(doc) as string);
    }
  }

  const batch = db.batch();
  const packKey = keyPack(height);
  const packValue = encodeBuffer({
    startHeight,
    endHeight: height,
    puts: Array.from(docPuts.values()),
    dels: Array.from(docDels.values()),
  } satisfies StoragePackRecord);
  batch.put(packKey, packValue);
  await writeBatch(batch);
  return { created: true, bytes: packKey.byteLength + packValue.byteLength };
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
} & PerfDeps): Promise<void> => {
  const config = runtimeConfigFromEnv(options.env);
  if (!config.enabled) return;

  const state = options.env.runtimeState ?? {};
  if (state.persistencePaused) return;

  const openStartedAt = options.getPerfMs();
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return;
  const db = options.getRuntimeDb(options.env);
  const openMs = options.getPerfMs() - openStartedAt;

  const appliedRuntimeInput = options.currentFrameInput ?? { runtimeTxs: [], entityInputs: [] };
  const touched = mergeTouchedRefs(
    collectTouchedRefs(appliedRuntimeInput),
    collectTouchedRefs({
      runtimeTxs: [],
      entityInputs: options.currentFrameOutputs ?? [],
    }),
  );
  const puts = buildDocPuts(options.env, touched);
  const bookDels = await buildBookDeletions(db, options.env, touched.touchedBookEntities);

  const diffBuildStartedAt = options.getPerfMs();
  const diff = buildDiffRecord(options.env.height, puts, bookDels);
  const cachedEntityHashDocs = state.storageEntityHashDocs instanceof Map
    ? state.storageEntityHashDocs as Map<string, StorageEntityHashDoc>
    : undefined;
  const preparedHashes = await prepareStorageStateHashes({
    db,
    height: options.env.height,
    timestamp: options.env.timestamp,
    puts: diff.puts,
    dels: diff.dels,
    ...(cachedEntityHashDocs ? { entityHashDocs: cachedEntityHashDocs } : {}),
  });
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

  const frameLogs = Array.isArray(options.env.frameLogs) ? options.env.frameLogs.map((entry) => ({ ...entry })) : [];
  const touchedEntities = Array.from(touched.touchedEntities.values()).sort();
  const touchedAccounts = Array.from(touched.touchedAccounts.values())
    .filter((ref): ref is Extract<StorageDocRef, { family: 'account' }> => ref.family === 'account')
    .map((ref) => ({ entityId: ref.entityId, counterpartyId: ref.counterpartyId }));
  const touchedBookEntities = Array.from(touched.touchedBookEntities.values()).sort();
  const auditHashes = prepareStorageAuditStateHashes(options.env, touchedEntities, previousFrame);
  const canonicalHashes = prepareStorageCanonicalStateHashes(options.env, touchedEntities, previousFrame);
  const frameRecordBase: StorageFrameRecord = {
    height: options.env.height,
    timestamp: options.env.timestamp,
    prevFrameHash,
    stateHash: preparedHashes.stateHash,
    hashMode: 'storage-debug-v1',
    entityHashes: preparedHashes.entityHashes,
    auditStateHash: auditHashes.auditStateHash,
    auditEntityHashes: auditHashes.auditEntityHashes,
    canonicalStateHash: canonicalHashes.canonicalStateHash,
    canonicalEntityHashes: canonicalHashes.canonicalEntityHashes,
    runtimeInput: appliedRuntimeInput,
    frameOutputs: (options.currentFrameOutputs ?? []).map((output) => ({ ...output })),
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

  const frameKey = keyFrame(options.env.height);
  const diffKey = keyDiff(options.env.height);
  const frameBuffer = encodeBuffer(frameRecord);
  const diffBuffer = encodeBuffer(diff);
  let frameDbBytes = 0;
  let frameDbPrunedBytes = 0;
  let frameDbRetainedBytes = 0;
  let frameDbPrunedKeys = 0;
  let frameDbLatestPrunedHeight = 0;
  const batch = db.batch();
  batch.put(frameKey, frameBuffer);
  batch.put(diffKey, diffBuffer);
  for (const doc of diff.puts) {
    batch.put(liveKeyForDoc(doc), preparedHashes.docValueBuffers.get(docValueKey(doc)) ?? encodeBuffer(doc.value));
  }
  for (const ref of diff.dels) {
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
  for (const replica of options.env.eReplicas.values()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    batch.put(keyLiveReplicaMeta(entityId), encodeBuffer(projectReplicaMeta(replica)));
  }

  const nextHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: options.env.height,
    latestSnapshotHeight: head.latestSnapshotHeight,
    latestPackHeight: head.latestPackHeight,
    packPeriodFrames: config.packPeriodFrames,
    snapshotPeriodFrames: config.snapshotPeriodFrames,
    retainSnapshots: config.retainSnapshots,
    epochMaxBytes: config.epochMaxBytes,
    accountMerkleRadix: config.accountMerkleRadix,
    retainedHistoryBytes:
      head.retainedHistoryBytes +
      frameKey.byteLength +
      frameBuffer.byteLength +
      diffKey.byteLength +
      diffBuffer.byteLength,
  };
  batch.put(KEY_HEAD, encodeBuffer(nextHead));
  await writeBatch(batch);
  state.storageEntityHashDocs = preparedHashes.entityHashDocs;
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

  let packMs = 0;
  let snapshotMs = 0;
  let packed = false;
  let snapDocs = 0;
  let packBytes = 0;
  let snapshotBytes = 0;
  let prunedBytes = 0;
  let epochRotated = false;
  let epochDbRotated = false;
  let retainedHistoryBytes = nextHead.retainedHistoryBytes;
  let latestPackHeight = head.latestPackHeight;
  let latestSnapshotHeight = head.latestSnapshotHeight;

  if (options.env.height % config.packPeriodFrames === 0) {
    const packStartedAt = options.getPerfMs();
    const packResult = await maybeCreatePack(db, options.env.height, config.packPeriodFrames);
    packed = packResult.created;
    packBytes = packResult.bytes;
    if (packed) {
      retainedHistoryBytes += packBytes;
      latestPackHeight = options.env.height;
    }
    packMs = options.getPerfMs() - packStartedAt;
  }

  const snapshotDue = options.env.height % config.snapshotPeriodFrames === 0;
  const snapshotRequiredByBytes = retainedHistoryBytes > config.epochMaxBytes;
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

  if (packed || snapDocs > 0 || prunedBytes > 0) {
    const latest = await readHead(db, config);
    const update = db.batch();
    update.put(
      KEY_HEAD,
      encodeBuffer({
        ...latest,
        latestPackHeight,
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
        `packBytes=${packBytes} snapshotBytes=${snapshotBytes} historyBytes=${retainedHistoryBytes} ` +
        `entities=${touched.touchedEntities.size} accounts=${touched.touchedAccounts.size} books=${touched.touchedBookEntities.size} ` +
        `highSignals=${highSignalEvents.join(',') || 'none'} ` +
        `pack=${packed ? 1 : 0} snapDocs=${snapDocs} epoch=${epochRotated ? 1 : 0} epochDb=${epochDbRotated ? 1 : 0} ` +
        `ms(open=${options.formatPerfMs(openMs)},diff=${options.formatPerfMs(diffBuildMs)},write=${options.formatPerfMs(writeMs)},pack=${options.formatPerfMs(packMs)},snap=${options.formatPerfMs(snapshotMs)})`,
    );
  }
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
  const tailFrames = Math.max(1, Math.floor(Number(options.tailFrames ?? 128)));
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
    const expectedStateHash = computeStorageRuntimeStateHash(record.height, record.timestamp, record.entityHashes);
    if (record.stateHash !== expectedStateHash) {
      throw new Error(`STORAGE_VERIFY_STATE_HASH_MISMATCH: height=${height} expected=${expectedStateHash} actual=${record.stateHash}`);
    }
    if (!Array.isArray(record.auditEntityHashes) || !record.auditStateHash) {
      throw new Error(`STORAGE_VERIFY_AUDIT_HASH_MISSING: height=${height}`);
    }
    const expectedAuditHash = computeStorageAuditRuntimeStateHash(record.height, record.timestamp, record.auditEntityHashes);
    if (record.auditStateHash !== expectedAuditHash) {
      throw new Error(`STORAGE_VERIFY_AUDIT_HASH_MISMATCH: height=${height} expected=${expectedAuditHash} actual=${record.auditStateHash}`);
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

  if (targetHeight === head.latestHeight) {
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
    const packEnd = cursor + head.packPeriodFrames - 1;
    if (
      head.packPeriodFrames > 1 &&
      packEnd <= targetHeight &&
      packEnd % head.packPeriodFrames === 0
    ) {
      const pack = await readJsonOrNull<StoragePackRecord>(db, keyPack(packEnd));
      if (pack && pack.startHeight === cursor) {
        applyDocs(docs, pack.puts, pack.dels, entityId);
        cursor = packEnd + 1;
        continue;
      }
    }
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
    packStats,
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
    measurePrefixBytes(db, Buffer.from([KEY_PACK])),
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
  const historyBytes = frameStats.bytes + diffStats.bytes + packStats.bytes + snapshotBytes;
  const totalBytes = historyBytes + liveBytes;

  return {
    head,
    frameCount: frameStats.count,
    diffCount: diffStats.count,
    packCount: packStats.count,
    snapshotHeights,
    liveEntityCount: liveEntityStats.count,
    liveAccountCount: liveAccountStats.count,
    liveBookCount: liveBookStats.count,
    frameBytes: frameStats.bytes,
    diffBytes: diffStats.bytes,
    packBytes: packStats.bytes,
    snapshotBytes,
    liveBytes,
    historyBytes,
    totalBytes,
    maxFrameBytes: frameStats.maxValueBytes,
    maxDiffBytes: diffStats.maxValueBytes,
    maxPackBytes: packStats.maxValueBytes,
    maxSnapshotBytes: Math.max(
      snapshotManifestStats.maxValueBytes,
      snapshotEntityStats.maxValueBytes,
      snapshotAccountStats.maxValueBytes,
      snapshotBookStats.maxValueBytes,
    ),
  };
};
