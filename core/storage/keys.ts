import { packRadixMerklePath, unpackRadixMerklePath, type RadixMerkleRadix } from '../protocol/state/radix-merkle';
import { toEntityId, type EntityId } from '../protocol/identity';
import { toRuntimeHeight, type RuntimeHeight } from '../protocol/units';
import { INTEGRITY_DIGEST_ALGORITHM_ID } from '../support/bytes/integrity-checksum';

/**
 * xln testnet has one canonical storage format. We deliberately do not carry
 * migration readers: an incompatible database is rejected and the operator
 * starts a new network instead of replaying ambiguous historical bytes.
 */
export const STORAGE_SCHEMA_VERSION = 6;

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
export const DEFAULT_MATERIALIZE_PERIOD_FRAMES = 1_000;
export const DEFAULT_ACCOUNT_MERKLE_RADIX: RadixMerkleRadix = 16;

export const KEY_HEAD = Buffer.from([0x20]);
export const KEY_FRAME = 0x10;
/** Static continuation rows for any oversized WAL or checkpoint value. */
export const KEY_BOUNDED_VALUE_CHUNK = 0x11;
export const KEY_SNAPSHOT_MANIFEST = 0x12;
/** Flat Runtime outbox row keyed by permanent `(height, outputIndex)`. */
export const KEY_RUNTIME_OUTPUT_ROW = 0x13;
/** Entity replay-context row at a permanent `(height, replica, kind, index)` path. */
export const KEY_ENTITY_CONTEXT_PAYLOAD = 0x14;
/** Latest Runtime checkpoint Patricia branch at its permanent packed path. */
export const KEY_RUNTIME_MACHINE_BRANCH = 0x15;
/** Latest Runtime checkpoint Patricia leaf at its permanent protocol-key path. */
export const KEY_RUNTIME_MACHINE_LEAF = 0x16;
/** Exact Rust Account-authority checkpoint token, one per owning Entity. */
const KEY_RSCORE_CHECKPOINT = 0x17;
/** Exact Rust Account header/consensus sidecar, one per bilateral Account. */
const KEY_RSCORE_ACCOUNT = 0x18;
/** Rust-owned Account Patricia records, scoped by owner, peer and namespace. */
const KEY_RSCORE_ACCOUNT_NODE = 0x19;
export const KEY_LIVE_ENTITY = 0x21;
export const KEY_LIVE_ACCOUNT = 0x22;
export const KEY_LIVE_BOOK = 0x23;
/** One bounded Account envelope field at its permanent owner + field-tag key. */
export const KEY_LIVE_ACCOUNT_FIELD = 0x24;
export const KEY_LIVE_REPLICA_META = 0x26;
/** Board Patricia rows keyed by `(owning Entity, logical binary path)`. */
export const KEY_CERTIFIED_BOARD_NODE = 0x2a;
/** Account J-claim rows keyed by `(owner, counterparty, side, logical binary path)`. */
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
/** Bounded Entity envelope field at its permanent entity + field-tag key. */
export const KEY_LIVE_ENTITY_FIELD = 0x36;
/** Exact branch nodes of Entity-owned persistent collections. */
export const KEY_LIVE_ENTITY_BRANCH = 0x37;
/** Exact leaf nodes of Entity-owned persistent collections. */
export const KEY_LIVE_ENTITY_LEAF = 0x38;
export const STORAGE_VERIFY_TAIL_FRAMES = 128;

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

/**
 * A continuation is addressed only by its permanent owner key and page index.
 * Content digests verify bytes in the owner manifest; they never address rows.
 * The explicit owner-key length makes prefixes unambiguous for variable keys.
 */
const keyBoundedValueChunkPrefix = (ownerKey: Buffer): Buffer => {
  if (ownerKey.byteLength < 1 || ownerKey.byteLength > 0xffff) {
    throw new Error(`STORAGE_BOUNDED_OWNER_KEY_BYTES_INVALID:${ownerKey.byteLength}`);
  }
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16BE(ownerKey.byteLength);
  return Buffer.concat([Buffer.from([KEY_BOUNDED_VALUE_CHUNK]), length, ownerKey]);
};

export const keyBoundedValueChunk = (ownerKey: Buffer, chunkIndex: number): Buffer => {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff_ffff) {
    throw new Error(`STORAGE_BOUNDED_CHUNK_INDEX_INVALID:${String(chunkIndex)}`);
  }
  const index = Buffer.allocUnsafe(4);
  index.writeUInt32BE(chunkIndex);
  return Buffer.concat([keyBoundedValueChunkPrefix(ownerKey), index]);
};

export const keySnapshotManifest = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_SNAPSHOT_MANIFEST]), encodeHeight(height)]);

export const keyRuntimeOutputRowPrefix = (height?: number): Buffer =>
  height === undefined
    ? Buffer.from([KEY_RUNTIME_OUTPUT_ROW])
    : Buffer.concat([Buffer.from([KEY_RUNTIME_OUTPUT_ROW]), encodeHeight(height)]);

export const keyRuntimeOutputRow = (height: number, outputIndex: number): Buffer => {
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffff_ffff) {
    throw new Error(`STORAGE_RUNTIME_OUTPUT_INDEX_INVALID:${String(outputIndex)}`);
  }
  const index = Buffer.allocUnsafe(4);
  index.writeUInt32BE(outputIndex);
  return Buffer.concat([keyRuntimeOutputRowPrefix(height), index]);
};

export const parseRuntimeOutputRowKey = (
  key: Buffer,
): Readonly<{ height: number; outputIndex: number }> => {
  if (key.byteLength !== 13 || key[0] !== KEY_RUNTIME_OUTPUT_ROW) {
    throw new Error(`STORAGE_RUNTIME_OUTPUT_KEY_INVALID:${key.toString('hex')}`);
  }
  return { height: decodeHeight(key), outputIndex: key.readUInt32BE(9) };
};

export type EntityContextPayloadPathKind =
  | 'manifest'
  | 'gossipProfile'
  | 'htlcEntry'
  | 'htlcOriginated'
  | 'peerAssertions'
  | 'gossipProfileDigests'
  | 'htlcEntryDigests'
  | 'htlcOriginatedDigests'
  | 'peerAssertionDigests';

const ENTITY_CONTEXT_PAYLOAD_PATH_TAG = Object.freeze({
  manifest: 0,
  gossipProfile: 1,
  htlcEntry: 2,
  htlcOriginated: 3,
  peerAssertions: 4,
  gossipProfileDigests: 5,
  htlcEntryDigests: 6,
  htlcOriginatedDigests: 7,
  peerAssertionDigests: 8,
} satisfies Record<EntityContextPayloadPathKind, number>);

const normalizedReplicaIdBytes = (replicaId: string): Buffer => {
  if (
    replicaId !== replicaId.toLowerCase() ||
    !/^0x[0-9a-f]{64}:0x[0-9a-f]{40}(:[1-9][0-9]*)?$/.test(replicaId)
  ) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_REPLICA_ID_INVALID:${replicaId}`);
  }
  return textBytes(replicaId);
};

/**
 * Physical Entity-context rows are path-keyed. The digest committed by the
 * Runtime frame or parent page verifies the bytes but never chooses this key.
 */
export const keyEntityContextPayload = (
  runtimeHeight: number,
  replicaId: string,
  kind: EntityContextPayloadPathKind,
  index: number,
): Buffer => {
  if (!Number.isSafeInteger(runtimeHeight) || runtimeHeight < 1) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_HEIGHT_INVALID:${String(runtimeHeight)}`);
  }
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_INDEX_INVALID:${String(index)}`);
  }
  const indexBytes = Buffer.allocUnsafe(4);
  indexBytes.writeUInt32BE(index);
  return Buffer.concat([
    Buffer.from([KEY_ENTITY_CONTEXT_PAYLOAD]),
    encodeHeight(runtimeHeight),
    normalizedReplicaIdBytes(replicaId),
    Buffer.from([ENTITY_CONTEXT_PAYLOAD_PATH_TAG[kind]]),
    indexBytes,
  ]);
};

const runtimeMachineTreeNamespace = (
  tag: typeof KEY_RUNTIME_MACHINE_BRANCH | typeof KEY_RUNTIME_MACHINE_LEAF,
): Buffer => Buffer.from([tag]);

export const keyRuntimeMachineBranch = (
  path: readonly number[],
): Buffer => Buffer.concat([
  runtimeMachineTreeNamespace(KEY_RUNTIME_MACHINE_BRANCH),
  Buffer.from(packRadixMerklePath(16, [...path])),
]);

export const keyRuntimeMachineLeaf = (
  keyBytes: Uint8Array,
): Buffer => Buffer.concat([
  runtimeMachineTreeNamespace(KEY_RUNTIME_MACHINE_LEAF),
  Buffer.from(keyBytes),
]);

export const keyRuntimeMachineTreePrefix = (
  tag: typeof KEY_RUNTIME_MACHINE_BRANCH | typeof KEY_RUNTIME_MACHINE_LEAF,
): Buffer => runtimeMachineTreeNamespace(tag);

const parseRuntimeMachineTreeKey = (
  key: Buffer,
  tag: number,
  code: string,
): Readonly<{ payload: Buffer }> => {
  if (key.byteLength <= 1 || key[0] !== tag) throw new Error(`${code}_KEY_INVALID`);
  return { payload: key.subarray(1) };
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

export const keyRscoreCheckpoint = (ownerEntityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_RSCORE_CHECKPOINT]), hexBytes(ownerEntityId)]);

export const keyRscoreAccount = (ownerEntityId: string, accountId: string): Buffer =>
  Buffer.concat([
    Buffer.from([KEY_RSCORE_ACCOUNT]),
    hexBytes(ownerEntityId),
    hexBytes(accountId),
  ]);

export const keyRscoreAccountPrefix = (ownerEntityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_RSCORE_ACCOUNT]), hexBytes(ownerEntityId)]);

const keyRscoreAccountNode = (
  ownerEntityId: string,
  accountId: string,
  namespaceTag: number,
  kind: 0 | 1,
  payload: Uint8Array,
): Buffer => {
  if (!Number.isSafeInteger(namespaceTag) || namespaceTag < 1 || namespaceTag > 9) {
    throw new Error(`STORAGE_RSCORE_NAMESPACE_INVALID:${String(namespaceTag)}`);
  }
  return Buffer.concat([
    Buffer.from([KEY_RSCORE_ACCOUNT_NODE]),
    hexBytes(ownerEntityId),
    hexBytes(accountId),
    Buffer.from([namespaceTag, kind]),
    Buffer.from(payload),
  ]);
};

/** Canonical radix-16 branch key: nibble length plus two nibbles per byte. */
export const keyRscoreAccountRadixBranchNode = (
  ownerEntityId: string,
  accountId: string,
  namespaceTag: number,
  path: readonly number[],
): Buffer => keyRscoreAccountNode(
  ownerEntityId,
  accountId,
  namespaceTag,
  0,
  Buffer.from(packRadixMerklePath(16, [...path])),
);

/** Canonical radix-16 leaf key: the full namespace protocol key. */
export const keyRscoreAccountRadixLeafNode = (
  ownerEntityId: string,
  accountId: string,
  namespaceTag: number,
  protocolKey: Uint8Array,
): Buffer => keyRscoreAccountNode(
  ownerEntityId,
  accountId,
  namespaceTag,
  1,
  protocolKey,
);

export const keyRscoreAccountNodePrefix = (
  ownerEntityId: string,
  accountId: string,
  namespaceTag?: number,
  kind?: 0 | 1,
): Buffer => {
  if (kind !== undefined && namespaceTag === undefined) {
    throw new Error('STORAGE_RSCORE_NODE_KIND_WITHOUT_NAMESPACE');
  }
  return Buffer.concat([
    Buffer.from([KEY_RSCORE_ACCOUNT_NODE]),
    hexBytes(ownerEntityId),
    hexBytes(accountId),
    ...(namespaceTag === undefined ? [] : [Buffer.from([namespaceTag])]),
    ...(kind === undefined ? [] : [Buffer.from([kind])]),
  ]);
};

/**
 * Rust Account J-claim nodes share the Account checkpoint namespace, but the
 * two Patricia roots are independent. The side is therefore part of the
 * permanent logical section, followed by the branch path or full leaf key.
 */
export const keyRscoreAccountJClaimPathNode = (
  ownerEntityId: string,
  accountId: string,
  side: 0 | 1,
  path: BinaryPatriciaStoragePath,
): Buffer => {
  const encodedPath = keyBinaryPatriciaStoragePath(path);
  const kind = encodedPath[0];
  if (kind !== 0 && kind !== 1) throw new Error('STORAGE_RSCORE_J_CLAIM_PATH_KIND');
  return keyRscoreAccountNode(
    ownerEntityId,
    accountId,
    6,
    kind,
    Buffer.concat([Buffer.from([side]), encodedPath.subarray(1)]),
  );
};

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

const liveEntityFieldOwnerKey = (entityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_ENTITY_FIELD]), hexBytes(entityId)]);

export const keyLiveEntityField = (entityId: string, fieldTag: number): Buffer => {
  if (!Number.isSafeInteger(fieldTag) || fieldTag < 1 || fieldTag > 0xff) {
    throw new Error(`STORAGE_ENTITY_FIELD_TAG_INVALID:${String(fieldTag)}`);
  }
  return Buffer.concat([liveEntityFieldOwnerKey(entityId), Buffer.from([fieldTag])]);
};

export const keyLiveEntityFieldChunk = (
  entityId: string,
  fieldTag: number,
  chunkIndex: number,
): Buffer => {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff_ffff) {
    throw new Error(`STORAGE_ENTITY_FIELD_CHUNK_INDEX_INVALID:${String(chunkIndex)}`);
  }
  const index = Buffer.allocUnsafe(4);
  index.writeUInt32BE(chunkIndex);
  return Buffer.concat([keyLiveEntityField(entityId, fieldTag), index]);
};

export const keyLiveEntityFieldPrefix = (entityId: string): Buffer =>
  liveEntityFieldOwnerKey(entityId);

export const parseLiveEntityFieldKey = (key: Buffer) => {
  if ((key.byteLength !== 34 && key.byteLength !== 38) || key[0] !== KEY_LIVE_ENTITY_FIELD) {
    throw new Error(`STORAGE_ENTITY_FIELD_KEY_INVALID:${key.toString('hex')}`);
  }
  const fieldTag = key[33];
  if (fieldTag === undefined || fieldTag === 0) throw new Error('STORAGE_ENTITY_FIELD_TAG_INVALID');
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    fieldTag,
    ...(key.byteLength === 38 ? { chunkIndex: key.readUInt32BE(34) } : {}),
  };
};

const entityTreeOwnerKey = (
  tag: number,
  entityId: string,
  namespaceTag: number,
): Buffer => {
  if (!Number.isSafeInteger(namespaceTag) || namespaceTag < 1 || namespaceTag > 0xff) {
    throw new Error(`STORAGE_ENTITY_TREE_NAMESPACE_INVALID:${String(namespaceTag)}`);
  }
  return Buffer.concat([
    Buffer.from([tag]),
    hexBytes(entityId),
    Buffer.from([namespaceTag]),
  ]);
};

export const keyLiveEntityBranch = (
  entityId: string,
  namespaceTag: number,
  path: readonly number[],
): Buffer => Buffer.concat([
  entityTreeOwnerKey(KEY_LIVE_ENTITY_BRANCH, entityId, namespaceTag),
  Buffer.from(packRadixMerklePath(16, [...path])),
]);

export const keyLiveEntityLeaf = (
  entityId: string,
  namespaceTag: number,
  keyBytes: Uint8Array,
): Buffer => Buffer.concat([
  entityTreeOwnerKey(KEY_LIVE_ENTITY_LEAF, entityId, namespaceTag),
  Buffer.from(keyBytes),
]);

export const keyLiveEntityTreePrefix = (
  tag: typeof KEY_LIVE_ENTITY_BRANCH | typeof KEY_LIVE_ENTITY_LEAF,
  entityId: string,
  namespaceTag?: number,
): Buffer => namespaceTag === undefined
  ? Buffer.concat([Buffer.from([tag]), hexBytes(entityId)])
  : entityTreeOwnerKey(tag, entityId, namespaceTag);

const parseEntityTreeOwner = (key: Buffer, tag: number, code: string) => {
  if (key.byteLength < 36 || key[0] !== tag) throw new Error(`${code}_KEY_INVALID`);
  const namespaceTag = key[33];
  if (namespaceTag === undefined || namespaceTag === 0) throw new Error(`${code}_NAMESPACE_INVALID`);
  const payload = key.subarray(34);
  if (payload.byteLength === 0) throw new Error(`${code}_PAYLOAD_EMPTY`);
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    namespaceTag,
    payload,
  };
};

export const parseLiveEntityBranchKey = (key: Buffer) => {
  const parsed = parseEntityTreeOwner(key, KEY_LIVE_ENTITY_BRANCH, 'STORAGE_ENTITY_BRANCH');
  return { ...parsed, path: unpackRadixMerklePath(16, parsed.payload) };
};

export const parseLiveEntityLeafKey = (key: Buffer) =>
  parseEntityTreeOwner(key, KEY_LIVE_ENTITY_LEAF, 'STORAGE_ENTITY_LEAF');

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
 * The key is owner + permanent field tag + deterministic chunk index. Hashes
 * remain verification data in the Account manifest, never row addresses.
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

/**
 * Binary Patricia nodes use their permanent logical position, never their
 * digest, as the physical database key. A branch is identified by the common
 * key prefix before its discriminating bit; a leaf is identified by its full
 * protocol key. Updating a node therefore overwrites one bounded row.
 */
export type BinaryPatriciaStoragePath =
  | Readonly<{ kind: 'branch'; bit: number; representativeKey: string }>
  | Readonly<{ kind: 'leaf'; key: string }>;

const keyBinaryPatriciaStoragePath = (path: BinaryPatriciaStoragePath): Buffer => {
  if (path.kind === 'leaf') {
    return Buffer.concat([Buffer.from([1]), hexBytes(path.key)]);
  }
  if (!Number.isSafeInteger(path.bit) || path.bit < 0 || path.bit > 255) {
    throw new Error(`STORAGE_BINARY_PATRICIA_BIT_INVALID:${String(path.bit)}`);
  }
  const prefix = Buffer.from(hexBytes(path.representativeKey));
  const wholeBytes = Math.floor(path.bit / 8);
  const remainder = path.bit % 8;
  if (remainder === 0) {
    prefix.fill(0, wholeBytes);
  } else {
    prefix[wholeBytes] = prefix[wholeBytes]! & (0xff << (8 - remainder));
    prefix.fill(0, wholeBytes + 1);
  }
  const bit = Buffer.allocUnsafe(2);
  bit.writeUInt16BE(path.bit);
  return Buffer.concat([Buffer.from([0]), bit, prefix]);
};

const parseBinaryPatriciaStoragePath = (
  payload: Buffer,
  code: string,
): BinaryPatriciaStoragePath => {
  const kind = payload[0];
  if (kind === 1 && payload.byteLength === 33) {
    return { kind: 'leaf', key: `0x${payload.subarray(1).toString('hex')}` };
  }
  if (kind !== 0 || payload.byteLength !== 35) throw new Error(`${code}_PATH_INVALID`);
  const path: BinaryPatriciaStoragePath = {
    kind: 'branch',
    bit: payload.readUInt16BE(1),
    representativeKey: `0x${payload.subarray(3).toString('hex')}`,
  };
  if (!keyBinaryPatriciaStoragePath(path).equals(payload)) {
    throw new Error(`${code}_PATH_NON_CANONICAL`);
  }
  return path;
};

export const parseRscoreAccountJClaimPathNodeKey = (key: Buffer) => {
  if (
    key.byteLength <= 68 ||
    key[0] !== KEY_RSCORE_ACCOUNT_NODE ||
    key[65] !== 6
  ) {
    throw new Error('STORAGE_RSCORE_J_CLAIM_PATH_KEY_INVALID');
  }
  const kind = key[66];
  const side = key[67];
  if ((kind !== 0 && kind !== 1) || (side !== 0 && side !== 1)) {
    throw new Error('STORAGE_RSCORE_J_CLAIM_PATH_HEADER_INVALID');
  }
  return {
    ownerEntityId: decodeEntityId(key.subarray(1, 33)),
    accountId: decodeEntityId(key.subarray(33, 65)),
    side,
    path: parseBinaryPatriciaStoragePath(
      Buffer.concat([Buffer.from([kind]), key.subarray(68)]),
      'STORAGE_RSCORE_J_CLAIM',
    ),
  };
};

export const keyCertifiedBoardNodePrefix = (ownerEntityId?: string): Buffer =>
  ownerEntityId
    ? Buffer.concat([Buffer.from([KEY_CERTIFIED_BOARD_NODE]), hexBytes(ownerEntityId)])
    : Buffer.from([KEY_CERTIFIED_BOARD_NODE]);

export const keyCertifiedBoardPathNode = (
  ownerEntityId: string,
  path: BinaryPatriciaStoragePath,
): Buffer => Buffer.concat([
  keyCertifiedBoardNodePrefix(ownerEntityId),
  keyBinaryPatriciaStoragePath(path),
]);

export const parseCertifiedBoardPathNodeKey = (key: Buffer) => {
  if (key.byteLength <= 33 || key[0] !== KEY_CERTIFIED_BOARD_NODE) {
    throw new Error('STORAGE_CERTIFIED_BOARD_PATH_KEY_INVALID');
  }
  return {
    ownerEntityId: decodeEntityId(key.subarray(1, 33)),
    path: parseBinaryPatriciaStoragePath(key.subarray(33), 'STORAGE_CERTIFIED_BOARD'),
  };
};

export const keyAccountJClaimNodePrefix = (
  ownerEntityId?: string,
  counterpartyId?: string,
  side?: 0 | 1,
): Buffer => {
  if (counterpartyId !== undefined && ownerEntityId === undefined) {
    throw new Error('STORAGE_ACCOUNT_J_CLAIM_COUNTERPARTY_WITHOUT_OWNER');
  }
  if (side !== undefined && counterpartyId === undefined) {
    throw new Error('STORAGE_ACCOUNT_J_CLAIM_SIDE_WITHOUT_ACCOUNT');
  }
  return Buffer.concat([
    Buffer.from([KEY_ACCOUNT_J_CLAIM_NODE]),
    ...(ownerEntityId === undefined ? [] : [hexBytes(ownerEntityId)]),
    ...(counterpartyId === undefined ? [] : [hexBytes(counterpartyId)]),
    ...(side === undefined ? [] : [Buffer.from([side])]),
  ]);
};

export const keyAccountJClaimPathNode = (
  ownerEntityId: string,
  counterpartyId: string,
  side: 0 | 1,
  path: BinaryPatriciaStoragePath,
): Buffer => Buffer.concat([
  keyAccountJClaimNodePrefix(ownerEntityId, counterpartyId, side),
  keyBinaryPatriciaStoragePath(path),
]);

export const parseAccountJClaimPathNodeKey = (key: Buffer) => {
  if (key.byteLength <= 66 || key[0] !== KEY_ACCOUNT_J_CLAIM_NODE) {
    throw new Error('STORAGE_ACCOUNT_J_CLAIM_PATH_KEY_INVALID');
  }
  const side = key[65];
  if (side !== 0 && side !== 1) throw new Error('STORAGE_ACCOUNT_J_CLAIM_PATH_SIDE_INVALID');
  return {
    ownerEntityId: decodeEntityId(key.subarray(1, 33)),
    counterpartyId: decodeEntityId(key.subarray(33, 65)),
    side,
    path: parseBinaryPatriciaStoragePath(key.subarray(66), 'STORAGE_ACCOUNT_J_CLAIM'),
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
