import { packRadixMerklePath, unpackRadixMerklePath, type RadixMerkleRadix } from '../protocol/state/radix-merkle';
import { toEntityId, type EntityId } from '../protocol/identity';
import {
  toAccountHeight,
  toEntityHeight,
  toRuntimeHeight,
  type AccountHeight,
  type EntityHeight,
  type RuntimeHeight,
} from '../protocol/units';
import { INTEGRITY_DIGEST_ALGORITHM_ID } from '../support/integrity-checksum';

/**
 * xln testnet has one canonical storage format. We deliberately do not carry
 * migration readers: an incompatible database is rejected and the operator
 * starts a new network instead of replaying ambiguous historical bytes.
 */
export const STORAGE_SCHEMA_VERSION = 5;

export const STORAGE_FRAME_FORMAT = Object.freeze({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  domain: 'xln.storage.frame',
  postStateDomain: 'xln.storage.postState',
  algorithmId: INTEGRITY_DIGEST_ALGORITHM_ID,
} as const);

class StorageSchemaMismatchError extends Error {
  readonly code = 'STORAGE_SCHEMA_MISMATCH' as const;

  constructor(
    readonly storedSchemaVersion: number,
    readonly currentSchemaVersion: number,
    readonly boundary: string,
  ) {
    super(
      `STORAGE_SCHEMA_MISMATCH:stored=${storedSchemaVersion}:current=${currentSchemaVersion}:boundary=${boundary}`,
    );
    this.name = 'StorageSchemaMismatchError';
  }
}

export const assertStorageSchemaVersion = (
  value: unknown,
  boundary: string,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(
      `STORAGE_SCHEMA_INVALID:stored=${value === undefined ? 'missing' : String(value)}:` +
        `current=${STORAGE_SCHEMA_VERSION}:boundary=${boundary}`,
    );
  }
  const stored = Number(value);
  if (stored !== STORAGE_SCHEMA_VERSION) {
    throw new StorageSchemaMismatchError(stored, STORAGE_SCHEMA_VERSION, boundary);
  }
  return stored;
};
export const DEFAULT_SNAPSHOT_PERIOD_FRAMES = 10_000;
// Archival storage is unlimited unless the local operator explicitly chooses
// a quota. Snapshot count follows the same rule: silently deleting historical
// checkpoints by default would make "blank means unlimited" false. Runtime
// state never changes because of this local policy.
export const DEFAULT_RETAIN_SNAPSHOTS = Number.MAX_SAFE_INTEGER;
export const DEFAULT_EPOCH_MAX_BYTES = Number.MAX_SAFE_INTEGER;
export const DEFAULT_HISTORY_VIEW_MAX_BYTES = Number.MAX_SAFE_INTEGER;
export const DEFAULT_HISTORY_VIEW_RETAIN_FRAMES = Number.MAX_SAFE_INTEGER;
export const DEFAULT_MATERIALIZE_PERIOD_FRAMES = 100;
export const DEFAULT_ACCOUNT_MERKLE_RADIX: RadixMerkleRadix = 16;

export const KEY_HEAD = Buffer.from([0x20]);
export const KEY_FRAME = 0x10;
export const KEY_DIFF = 0x11;
export const KEY_SNAPSHOT_MANIFEST = 0x12;
/** Immutable routed-output bytes addressed by their full SHA-256 digest. */
export const KEY_RUNTIME_OUTPUT_PAYLOAD = 0x13;
/** Immutable Entity infrastructure context addressed by full SHA-256 digest. */
export const KEY_ENTITY_CONTEXT_PAYLOAD = 0x14;
/** Runtime checkpoint Patricia branch, scoped by the materialized frame height. */
export const KEY_RUNTIME_MACHINE_BRANCH = 0x15;
/** Runtime checkpoint Patricia leaf, scoped by the materialized frame height. */
export const KEY_RUNTIME_MACHINE_LEAF = 0x16;
export const KEY_LIVE_ENTITY = 0x21;
export const KEY_LIVE_ACCOUNT = 0x22;
export const KEY_LIVE_BOOK = 0x23;
/** One bounded Account envelope field at its permanent owner + field-tag key. */
export const KEY_LIVE_ACCOUNT_FIELD = 0x24;
export const KEY_LIVE_REPLICA_META = 0x26;
export const KEY_CERTIFIED_BOARD_NODE = 0x2a;
export const KEY_CONSUMPTION_NODE = 0x2b;
export const KEY_ACCOUNT_J_CLAIM_NODE = 0x2c;
export const KEY_LIVE_BOOK_BRANCH = 0x2d;
export const KEY_LIVE_BOOK_LEAF = 0x2e;
export const KEY_LIVE_ACCOUNT_BRANCH = 0x2f;
export const KEY_LIVE_ACCOUNT_LEAF = 0x30;
export const KEY_SNAPSHOT_ENTITY = 0x31;
export const KEY_SNAPSHOT_ACCOUNT = 0x32;
export const KEY_SNAPSHOT_BOOK = 0x33;
export const KEY_SNAPSHOT_REPLICA_META = 0x34;
/** Snapshot namespace wrapping one unchanged live enum-keyed graph record. */
export const KEY_SNAPSHOT_GRAPH = 0x35;

export const STORAGE_VERIFY_TAIL_FRAMES = 128;

export const KEY_HISTORY_VIEW_HEAD = Buffer.from([0x00]);
export const HISTORY_VIEW_ACCOUNT_FRAME = 0x01;
export const HISTORY_VIEW_RUNTIME_ACTIVITY = 0x02;
export const HISTORY_VIEW_ENTITY_FRAME = 0x03;
/** Rebuildable Account swap events, indexed by `(account, offer, accountHeight)`. */
export const HISTORY_VIEW_ACCOUNT_SWAP_EVENT = 0x04;
/** Rebuildable Account swap events, indexed by `(account, accountHeight, offer)` for newest-first pages. */
export const HISTORY_VIEW_ACCOUNT_SWAP_RECENCY = 0x05;
export const ZERO_FRAME_HASH = `0x${'00'.repeat(32)}`;

export const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();

const exactHexBytes = (value: string, byteLength: number, code: string): Buffer => {
  const raw = String(value);
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`);
  if (!pattern.test(raw)) throw new Error(`${code}:${raw}`);
  return Buffer.from(raw.slice(2), 'hex');
};

export const hexBytes = (value: string): Buffer => {
  return exactHexBytes(value, 32, 'STORAGE_HEX_32_INVALID');
};

const signerKeyBytes = (value: string): Buffer =>
  Buffer.concat([Buffer.alloc(12), exactHexBytes(value, 20, 'STORAGE_SIGNER_HEX_20_INVALID')]);

export const decodeEntityId = (bytes: Uint8Array): EntityId => {
  if (bytes.byteLength !== 32) throw new Error(`STORAGE_ENTITY_ID_BYTES_INVALID:${bytes.byteLength}`);
  return toEntityId(`0x${Buffer.from(bytes).toString('hex')}`);
};

export const decodeTaggedStorageHash = (key: Buffer, tag: number, code: string): string => {
  if (key.length !== 33 || key[0] !== tag) throw new Error(`${code}:${key.toString('hex')}`);
  return decodeEntityId(key.subarray(1));
};

export const encodeHeight = (height: number): Buffer => {
  const out = Buffer.allocUnsafe(8);
  out.writeBigUInt64BE(BigInt(height));
  return out;
};

export const decodeHeight = (buffer: Buffer, offset = 1): number => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > buffer.length) {
    throw new Error(`STORAGE_HEIGHT_KEY_TRUNCATED:offset=${offset}:length=${buffer.length}`);
  }
  const raw = buffer.readBigUInt64BE(offset);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`STORAGE_HEIGHT_KEY_UNSAFE:${raw.toString()}`);
  return Number(raw);
};

export const decodeTaggedStorageHeight = (key: Buffer, tag: number, code: string): RuntimeHeight => {
  if (key.length !== 9 || key[0] !== tag) throw new Error(`${code}:${key.toString('hex')}`);
  return toRuntimeHeight(decodeHeight(key));
};

export const textBytes = (value: string): Buffer => {
  const raw = Buffer.from(value, 'utf8');
  if (raw.byteLength === 0 || raw.byteLength > 0xffff) {
    throw new Error(`STORAGE_TEXT_BYTES_INVALID:${raw.byteLength}`);
  }
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(raw.length);
  return Buffer.concat([len, raw]);
};

const readText = (buffer: Buffer, offset: number): { value: string; nextOffset: number } => {
  const len = buffer.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buffer.subarray(start, start + len).toString('utf8'), nextOffset: start + len };
};

export const keyFrame = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_FRAME]), encodeHeight(height)]);
export const keyDiff = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_DIFF]), encodeHeight(height)]);
export const keySnapshotManifest = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_SNAPSHOT_MANIFEST]), encodeHeight(height)]);

export const keyRuntimeOutputPayload = (hash: string): Buffer =>
  Buffer.concat([
    Buffer.from([KEY_RUNTIME_OUTPUT_PAYLOAD]),
    exactHexBytes(hash, 32, 'STORAGE_RUNTIME_OUTPUT_HASH_INVALID'),
  ]);

export const keyEntityContextPayload = (hash: string): Buffer =>
  Buffer.concat([
    Buffer.from([KEY_ENTITY_CONTEXT_PAYLOAD]),
    exactHexBytes(hash, 32, 'STORAGE_ENTITY_CONTEXT_HASH_INVALID'),
  ]);

const runtimeMachineTreeOwnerKey = (
  tag: typeof KEY_RUNTIME_MACHINE_BRANCH | typeof KEY_RUNTIME_MACHINE_LEAF,
  height: number,
): Buffer => Buffer.concat([Buffer.from([tag]), encodeHeight(height)]);

export const keyRuntimeMachineBranch = (
  height: number,
  path: readonly number[],
): Buffer => Buffer.concat([
  runtimeMachineTreeOwnerKey(KEY_RUNTIME_MACHINE_BRANCH, height),
  Buffer.from(packRadixMerklePath(16, [...path])),
]);

export const keyRuntimeMachineLeaf = (
  height: number,
  keyBytes: Uint8Array,
): Buffer => Buffer.concat([
  runtimeMachineTreeOwnerKey(KEY_RUNTIME_MACHINE_LEAF, height),
  Buffer.from(keyBytes),
]);

export const keyRuntimeMachineTreePrefix = (
  tag: typeof KEY_RUNTIME_MACHINE_BRANCH | typeof KEY_RUNTIME_MACHINE_LEAF,
  height: number,
): Buffer => runtimeMachineTreeOwnerKey(tag, height);

const parseRuntimeMachineTreeKey = (
  key: Buffer,
  tag: number,
  code: string,
): Readonly<{ height: RuntimeHeight; payload: Buffer }> => {
  if (key.byteLength <= 9 || key[0] !== tag) throw new Error(`${code}_KEY_INVALID`);
  return {
    height: toRuntimeHeight(decodeHeight(key)),
    payload: key.subarray(9),
  };
};

export const parseRuntimeMachineBranchKey = (key: Buffer) => {
  const parsed = parseRuntimeMachineTreeKey(
    key,
    KEY_RUNTIME_MACHINE_BRANCH,
    'STORAGE_RUNTIME_MACHINE_BRANCH',
  );
  return { ...parsed, path: unpackRadixMerklePath(16, parsed.payload) };
};

export const parseRuntimeMachineLeafKey = (key: Buffer) =>
  parseRuntimeMachineTreeKey(
    key,
    KEY_RUNTIME_MACHINE_LEAF,
    'STORAGE_RUNTIME_MACHINE_LEAF',
  );

export const keySnapshotGraph = (height: number, liveKey: Buffer): Buffer =>
  Buffer.concat([Buffer.from([KEY_SNAPSHOT_GRAPH]), encodeHeight(height), liveKey]);

export const keySnapshotGraphPrefix = (height: number, livePrefix?: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([KEY_SNAPSHOT_GRAPH]),
    encodeHeight(height),
    ...(livePrefix ? [livePrefix] : []),
  ]);

export const parseSnapshotGraphKey = (key: Buffer): Readonly<{ height: RuntimeHeight; liveKey: Buffer }> => {
  if (key.byteLength <= 10 || key[0] !== KEY_SNAPSHOT_GRAPH) {
    throw new Error(`STORAGE_SNAPSHOT_GRAPH_KEY_INVALID:${key.toString('hex')}`);
  }
  return { height: toRuntimeHeight(decodeHeight(key)), liveKey: key.subarray(9) };
};

export const keyLiveEntity = (entityId: string): Buffer => Buffer.concat([Buffer.from([KEY_LIVE_ENTITY]), hexBytes(entityId)]);

export const keyLiveAccount = (entityId: string, counterpartyId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_ACCOUNT]), hexBytes(entityId), hexBytes(counterpartyId)]);
export const keyLiveAccountPrefix = (entityId?: string): Buffer =>
  entityId ? Buffer.concat([Buffer.from([KEY_LIVE_ACCOUNT]), hexBytes(entityId)]) : Buffer.from([KEY_LIVE_ACCOUNT]);

const liveAccountFieldOwnerKey = (entityId: string, counterpartyId: string): Buffer =>
  Buffer.concat([
    Buffer.from([KEY_LIVE_ACCOUNT_FIELD]),
    hexBytes(entityId),
    hexBytes(counterpartyId),
  ]);

export const keyLiveAccountField = (
  entityId: string,
  counterpartyId: string,
  fieldTag: number,
): Buffer => {
  if (!Number.isSafeInteger(fieldTag) || fieldTag < 1 || fieldTag > 0xff) {
    throw new Error(`STORAGE_ACCOUNT_FIELD_TAG_INVALID:${String(fieldTag)}`);
  }
  return Buffer.concat([
    liveAccountFieldOwnerKey(entityId, counterpartyId),
    Buffer.from([fieldTag]),
  ]);
};

/**
 * Static continuation row for a large Account envelope field.
 *
 * The key is owner + permanent field tag + deterministic chunk index. Content
 * hashes are verification data in the Account manifest, never addresses. This
 * keeps overwrites bounded without creating a second content-addressed graph.
 */
export const keyLiveAccountFieldChunk = (
  entityId: string,
  counterpartyId: string,
  fieldTag: number,
  chunkIndex: number,
): Buffer => {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff_ffff) {
    throw new Error(`STORAGE_ACCOUNT_FIELD_CHUNK_INDEX_INVALID:${String(chunkIndex)}`);
  }
  const index = Buffer.allocUnsafe(4);
  index.writeUInt32BE(chunkIndex);
  return Buffer.concat([
    keyLiveAccountField(entityId, counterpartyId, fieldTag),
    index,
  ]);
};

export const keyLiveAccountFieldPrefix = (
  entityId: string,
  counterpartyId: string,
): Buffer => liveAccountFieldOwnerKey(entityId, counterpartyId);

export const parseLiveAccountFieldKey = (key: Buffer) => {
  if ((key.byteLength !== 66 && key.byteLength !== 70) || key[0] !== KEY_LIVE_ACCOUNT_FIELD) {
    throw new Error(`STORAGE_ACCOUNT_FIELD_KEY_INVALID:${key.toString('hex')}`);
  }
  const fieldTag = key[65];
  if (fieldTag === undefined || fieldTag === 0) throw new Error('STORAGE_ACCOUNT_FIELD_TAG_INVALID');
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    counterpartyId: decodeEntityId(key.subarray(33, 65)),
    fieldTag,
    ...(key.byteLength === 70 ? { chunkIndex: key.readUInt32BE(66) } : {}),
  };
};

const accountTreeOwnerKey = (
  tag: number,
  entityId: string,
  counterpartyId: string,
  namespaceTag: number,
): Buffer => {
  if (!Number.isSafeInteger(namespaceTag) || namespaceTag < 1 || namespaceTag > 0xff) {
    throw new Error(`STORAGE_ACCOUNT_TREE_NAMESPACE_INVALID:${String(namespaceTag)}`);
  }
  return Buffer.concat([
    Buffer.from([tag]),
    hexBytes(entityId),
    hexBytes(counterpartyId),
    Buffer.from([namespaceTag]),
  ]);
};

export const keyLiveAccountBranch = (
  entityId: string,
  counterpartyId: string,
  namespaceTag: number,
  path: readonly number[],
): Buffer => Buffer.concat([
  accountTreeOwnerKey(KEY_LIVE_ACCOUNT_BRANCH, entityId, counterpartyId, namespaceTag),
  Buffer.from(packRadixMerklePath(16, [...path])),
]);

export const keyLiveAccountLeaf = (
  entityId: string,
  counterpartyId: string,
  namespaceTag: number,
  keyBytes: Uint8Array,
): Buffer => Buffer.concat([
  accountTreeOwnerKey(KEY_LIVE_ACCOUNT_LEAF, entityId, counterpartyId, namespaceTag),
  Buffer.from(keyBytes),
]);

export const keyLiveAccountTreePrefix = (
  tag: typeof KEY_LIVE_ACCOUNT_BRANCH | typeof KEY_LIVE_ACCOUNT_LEAF,
  entityId: string,
  counterpartyId: string,
  namespaceTag?: number,
): Buffer => namespaceTag === undefined
  ? Buffer.concat([Buffer.from([tag]), hexBytes(entityId), hexBytes(counterpartyId)])
  : accountTreeOwnerKey(tag, entityId, counterpartyId, namespaceTag);

const parseAccountTreeOwner = (
  key: Buffer,
  tag: number,
  code: string,
) => {
  if (key.byteLength < 68 || key[0] !== tag) throw new Error(`${code}_KEY_INVALID`);
  const namespaceTag = key[65];
  if (namespaceTag === undefined || namespaceTag === 0) throw new Error(`${code}_NAMESPACE_INVALID`);
  const payload = key.subarray(66);
  if (payload.byteLength === 0) throw new Error(`${code}_PAYLOAD_EMPTY`);
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    counterpartyId: decodeEntityId(key.subarray(33, 65)),
    namespaceTag,
    payload,
  };
};

export const parseLiveAccountBranchKey = (key: Buffer) => {
  const parsed = parseAccountTreeOwner(key, KEY_LIVE_ACCOUNT_BRANCH, 'STORAGE_ACCOUNT_BRANCH');
  return { ...parsed, path: unpackRadixMerklePath(16, parsed.payload) };
};

export const parseLiveAccountLeafKey = (key: Buffer) =>
  parseAccountTreeOwner(key, KEY_LIVE_ACCOUNT_LEAF, 'STORAGE_ACCOUNT_LEAF');

export const keyLiveBook = (entityId: string, pairId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_BOOK]), hexBytes(entityId), textBytes(pairId)]);
export const keyLiveBookPrefix = (entityId?: string): Buffer =>
  entityId ? Buffer.concat([Buffer.from([KEY_LIVE_BOOK]), hexBytes(entityId)]) : Buffer.from([KEY_LIVE_BOOK]);

const bookTreeOwnerKey = (
  tag: number,
  entityId: string,
  pairId: string,
  side: 0 | 1,
): Buffer => Buffer.concat([
  Buffer.from([tag]),
  hexBytes(entityId),
  textBytes(pairId),
  Buffer.from([side]),
]);

export const keyLiveBookBranch = (
  entityId: string,
  pairId: string,
  side: 0 | 1,
  path: readonly number[],
): Buffer => Buffer.concat([
  bookTreeOwnerKey(KEY_LIVE_BOOK_BRANCH, entityId, pairId, side),
  Buffer.from(packRadixMerklePath(16, [...path])),
]);

export const keyLiveBookLeaf = (
  entityId: string,
  pairId: string,
  side: 0 | 1,
  pageKeyBytes: Uint8Array,
): Buffer => Buffer.concat([
  bookTreeOwnerKey(KEY_LIVE_BOOK_LEAF, entityId, pairId, side),
  Buffer.from(pageKeyBytes),
]);

export const keyLiveBookTreePrefix = (
  tag: typeof KEY_LIVE_BOOK_BRANCH | typeof KEY_LIVE_BOOK_LEAF,
  entityId: string,
  pairId: string,
  side?: 0 | 1,
): Buffer => side === undefined
  ? Buffer.concat([Buffer.from([tag]), hexBytes(entityId), textBytes(pairId)])
  : bookTreeOwnerKey(tag, entityId, pairId, side);

const parseBookTreeOwner = (
  key: Buffer,
  tag: number,
  code: string,
): Readonly<{ entityId: EntityId; pairId: string; side: 0 | 1; payload: Buffer }> => {
  if (key.byteLength < 37 || key[0] !== tag) throw new Error(`${code}_KEY_INVALID`);
  const entityId = decodeEntityId(key.subarray(1, 33));
  const pair = readText(key, 33);
  if (pair.nextOffset >= key.byteLength) throw new Error(`${code}_KEY_TRUNCATED`);
  const side = key[pair.nextOffset];
  if (side !== 0 && side !== 1) throw new Error(`${code}_SIDE_INVALID`);
  const payload = key.subarray(pair.nextOffset + 1);
  if (payload.byteLength === 0) throw new Error(`${code}_PAYLOAD_EMPTY`);
  return { entityId, pairId: pair.value, side, payload };
};

export const parseLiveBookBranchKey = (key: Buffer) => {
  const parsed = parseBookTreeOwner(key, KEY_LIVE_BOOK_BRANCH, 'STORAGE_BOOK_BRANCH');
  return { ...parsed, path: unpackRadixMerklePath(16, parsed.payload) };
};

export const parseLiveBookLeafKey = (key: Buffer) =>
  parseBookTreeOwner(key, KEY_LIVE_BOOK_LEAF, 'STORAGE_BOOK_LEAF');

export const keyLiveReplicaMetaPrefix = (entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_LIVE_REPLICA_META]), hexBytes(entityId)])
    : Buffer.from([KEY_LIVE_REPLICA_META]);

export const keyLiveReplicaMeta = (entityId: string, signerId: string): Buffer =>
  Buffer.concat([keyLiveReplicaMetaPrefix(entityId), signerKeyBytes(signerId)]);

export const keyCertifiedBoardNode = (hash: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_CERTIFIED_BOARD_NODE]), hexBytes(hash)]);
export const keyCertifiedBoardNodePrefix = (): Buffer => Buffer.from([KEY_CERTIFIED_BOARD_NODE]);

export const keyConsumptionNode = (hash: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_CONSUMPTION_NODE]), hexBytes(hash)]);
export const keyConsumptionNodePrefix = (): Buffer => Buffer.from([KEY_CONSUMPTION_NODE]);

export const keyAccountJClaimNode = (hash: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_ACCOUNT_J_CLAIM_NODE]), hexBytes(hash)]);
export const keyAccountJClaimNodePrefix = (): Buffer => Buffer.from([KEY_ACCOUNT_J_CLAIM_NODE]);

export const keyHistoryViewAccountFrame = (
  entityId: string,
  counterpartyId: string,
  accountHeight: number,
): Buffer => Buffer.concat([Buffer.from([HISTORY_VIEW_ACCOUNT_FRAME]), hexBytes(entityId), hexBytes(counterpartyId), encodeHeight(accountHeight)]);

export const keyHistoryViewRuntimeActivity = (height: number): Buffer =>
  Buffer.concat([Buffer.from([HISTORY_VIEW_RUNTIME_ACTIVITY]), encodeHeight(height)]);

export const keyHistoryViewEntityFrame = (entityId: string, entityHeight: number): Buffer =>
  Buffer.concat([Buffer.from([HISTORY_VIEW_ENTITY_FRAME]), hexBytes(entityId), encodeHeight(entityHeight)]);

export const keyHistoryViewEntityFramePrefix = (entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([HISTORY_VIEW_ENTITY_FRAME]), hexBytes(entityId)])
    : Buffer.from([HISTORY_VIEW_ENTITY_FRAME]);

export const parseHistoryViewEntityFrameKey = (key: Buffer): { entityId: EntityId; entityHeight: EntityHeight } => {
  if (key.length !== 41 || key[0] !== HISTORY_VIEW_ENTITY_FRAME) {
    throw new Error(`STORAGE_HISTORY_VIEW_ENTITY_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    entityHeight: toEntityHeight(decodeHeight(key, 33)),
  };
};

export const keyHistoryViewAccountFramePrefix = (entityId?: string, counterpartyId?: string): Buffer => {
  if (entityId && counterpartyId) return Buffer.concat([Buffer.from([HISTORY_VIEW_ACCOUNT_FRAME]), hexBytes(entityId), hexBytes(counterpartyId)]);
  if (entityId) return Buffer.concat([Buffer.from([HISTORY_VIEW_ACCOUNT_FRAME]), hexBytes(entityId)]);
  return Buffer.from([HISTORY_VIEW_ACCOUNT_FRAME]);
};

export const keyHistoryViewAccountSwapEvent = (
  entityId: string,
  counterpartyId: string,
  offerId: string,
  accountHeight: number,
  txType: string,
): Buffer => Buffer.concat([
  Buffer.from([HISTORY_VIEW_ACCOUNT_SWAP_EVENT]),
  hexBytes(entityId),
  hexBytes(counterpartyId),
  Buffer.from(offerId, 'utf8'),
  Buffer.from([0]),
  Buffer.from(txType, 'utf8'),
  Buffer.from([0]),
  encodeHeight(accountHeight),
]);

export const keyHistoryViewAccountSwapEventPrefix = (
  entityId: string,
  counterpartyId: string,
  offerId?: string,
): Buffer => Buffer.concat([
  Buffer.from([HISTORY_VIEW_ACCOUNT_SWAP_EVENT]),
  hexBytes(entityId),
  hexBytes(counterpartyId),
  ...(offerId === undefined ? [] : [Buffer.from(offerId, 'utf8'), Buffer.from([0])]),
]);

export const keyHistoryViewAccountSwapRecency = (
  entityId: string,
  counterpartyId: string,
  accountHeight: number,
  offerId: string,
): Buffer => Buffer.concat([
  Buffer.from([HISTORY_VIEW_ACCOUNT_SWAP_RECENCY]),
  hexBytes(entityId),
  hexBytes(counterpartyId),
  encodeHeight(accountHeight),
  Buffer.from(offerId, 'utf8'),
]);

export const keyHistoryViewAccountSwapRecencyPrefix = (
  entityId: string,
  counterpartyId: string,
): Buffer => Buffer.concat([
  Buffer.from([HISTORY_VIEW_ACCOUNT_SWAP_RECENCY]), hexBytes(entityId), hexBytes(counterpartyId)]);

export const parseHistoryViewAccountSwapRecencyKey = (key: Buffer): {
  accountHeight: AccountHeight;
  offerId: string;
} => {
  if (key.length <= 73 || key[0] !== HISTORY_VIEW_ACCOUNT_SWAP_RECENCY) {
    throw new Error(`STORAGE_HISTORY_VIEW_ACCOUNT_SWAP_RECENCY_KEY_INVALID:${key.toString('hex')}`);
  }
  const offerId = key.subarray(73).toString('utf8');
  if (!offerId || Buffer.from(offerId, 'utf8').compare(key.subarray(73)) !== 0) {
    throw new Error(`STORAGE_HISTORY_VIEW_ACCOUNT_SWAP_RECENCY_OFFER_INVALID:${key.toString('hex')}`);
  }
  return { accountHeight: toAccountHeight(decodeHeight(key, 65)), offerId };
};

export const parseHistoryViewAccountFrameKey = (key: Buffer): {
  entityId: EntityId;
  counterpartyId: EntityId;
  accountHeight: AccountHeight;
} => {
  if (key.length !== 73 || key[0] !== HISTORY_VIEW_ACCOUNT_FRAME) {
    throw new Error(`STORAGE_HISTORY_VIEW_ACCOUNT_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    counterpartyId: decodeEntityId(key.subarray(33, 65)),
    accountHeight: toAccountHeight(decodeHeight(key, 65)),
  };
};

export const keySnapshotEntity = (height: number, entityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height), hexBytes(entityId)]);

export const keySnapshotEntityPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_ENTITY]), encodeHeight(height)]);

export const keySnapshotAccountPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_ACCOUNT]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_ACCOUNT]), encodeHeight(height)]);

export const keySnapshotAccount = (
  height: number,
  entityId: string,
  counterpartyId: string,
): Buffer => Buffer.concat([
  keySnapshotAccountPrefix(height, entityId),
  hexBytes(counterpartyId),
]);

export const keySnapshotBookPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height)]);

export const keySnapshotBook = (height: number, entityId: string, pairId: string): Buffer =>
  Buffer.concat([keySnapshotBookPrefix(height, entityId), textBytes(pairId)]);

export const keySnapshotReplicaMeta = (
  height: number,
  entityId: string,
  signerId: string,
): Buffer => Buffer.concat([
  Buffer.from([KEY_SNAPSHOT_REPLICA_META]),
  encodeHeight(height),
  hexBytes(entityId),
  signerKeyBytes(signerId),
]);

export const keySnapshotReplicaMetaPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_REPLICA_META]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_REPLICA_META]), encodeHeight(height)]);

export const parseSnapshotEntityKey = (key: Buffer): { height: RuntimeHeight; entityId: EntityId } => {
  if (key.length !== 41 || key[0] !== KEY_SNAPSHOT_ENTITY) {
    throw new Error(`STORAGE_SNAPSHOT_ENTITY_KEY_INVALID:${key.toString('hex')}`);
  }
  return { height: toRuntimeHeight(decodeHeight(key)), entityId: decodeEntityId(key.subarray(9, 41)) };
};

export const parseSnapshotAccountKey = (key: Buffer): {
  height: RuntimeHeight;
  entityId: EntityId;
  counterpartyId: EntityId;
} => {
  if (key.length !== 73 || key[0] !== KEY_SNAPSHOT_ACCOUNT) {
    throw new Error(`STORAGE_SNAPSHOT_ACCOUNT_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    height: toRuntimeHeight(decodeHeight(key)),
    entityId: decodeEntityId(key.subarray(9, 41)),
    counterpartyId: decodeEntityId(key.subarray(41, 73)),
  };
};

export const prefixUpperBound = (prefix: Buffer): Buffer | undefined => {
  const out = Buffer.from(prefix);
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const current = out[index];
    if (current === undefined || current === 0xff) continue;
    out[index] = current + 1;
    return out.subarray(0, index + 1);
  }
  return undefined;
};

export const parseLiveAccountKey = (key: Buffer): { entityId: EntityId; counterpartyId: EntityId } => {
  if (key.length !== 65 || key[0] !== KEY_LIVE_ACCOUNT) {
    throw new Error(`STORAGE_LIVE_ACCOUNT_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    counterpartyId: decodeEntityId(key.subarray(33, 65)),
  };
};

export const parseLiveBookKey = (key: Buffer, offset = 1): { entityId: string; pairId: string } => {
  if (offset === 1 && key[0] !== KEY_LIVE_BOOK) {
    throw new Error(`STORAGE_LIVE_BOOK_KEY_INVALID:${key.toString('hex')}`);
  }
  if (offset === 9 && key[0] !== KEY_SNAPSHOT_BOOK) {
    throw new Error(`STORAGE_SNAPSHOT_BOOK_KEY_INVALID:${key.toString('hex')}`);
  }
  const entityId = decodeEntityId(key.subarray(offset, offset + 32));
  const { value, nextOffset } = readText(key, offset + 32);
  if (nextOffset !== key.length) {
    throw new Error(`STORAGE_BOOK_KEY_TRAILING_BYTES:${key.toString('hex')}`);
  }
  return { entityId, pairId: value };
};

export const parseSnapshotManifestHeight = (key: Buffer): RuntimeHeight => {
  if (key.length !== 9 || key[0] !== KEY_SNAPSHOT_MANIFEST) {
    throw new Error(`STORAGE_SNAPSHOT_MANIFEST_KEY_INVALID:${key.toString('hex')}`);
  }
  return toRuntimeHeight(decodeHeight(key));
};
import { Buffer } from '../support/platform-crypto';
