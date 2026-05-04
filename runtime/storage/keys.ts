import type { RadixMerkleRadix } from './merkle';

export const STORAGE_SCHEMA_VERSION = 1;
export const DEFAULT_SNAPSHOT_PERIOD_FRAMES = 256;
export const DEFAULT_RETAIN_SNAPSHOTS = 3;
export const DEFAULT_EPOCH_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_FRAME_DB_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_FRAME_DB_RETAIN_FRAMES = 100_000;
export const DEFAULT_MATERIALIZE_PERIOD_FRAMES = 64;
export const DEFAULT_ACCOUNT_MERKLE_RADIX: RadixMerkleRadix = 16;

export const KEY_HEAD = Buffer.from([0x20]);
export const KEY_FRAME = 0x10;
export const KEY_DIFF = 0x11;
export const KEY_SNAPSHOT_MANIFEST = 0x12;
export const KEY_LIVE_ENTITY = 0x21;
export const KEY_LIVE_ACCOUNT = 0x22;
export const KEY_LIVE_BOOK = 0x23;
export const KEY_LIVE_REPLICA_META = 0x26;
export const KEY_MERKLE_ROOT = 0x27;
export const KEY_MERKLE_BRANCH = 0x28;
export const KEY_MERKLE_LEAF = 0x29;
export const KEY_SNAPSHOT_ENTITY = 0x31;
export const KEY_SNAPSHOT_ACCOUNT = 0x32;
export const KEY_SNAPSHOT_BOOK = 0x33;

export const STORAGE_VERIFY_TAIL_FRAMES = 128;
export const EPOCH_SEED_FRAME_TAIL = STORAGE_VERIFY_TAIL_FRAMES + 1;

export const KEY_FRAME_DB_HEAD = Buffer.from([0x00]);
export const FRAME_DB_ACCOUNT_FRAME = 0x01;
export const FRAME_DB_RUNTIME_ACTIVITY = 0x02;
export const FRAME_DB_ENTITY_ACTIVITY = 0x03;
export const FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME = 0x04;
export const FRAME_DB_ORDERBOOK_COMMIT = 0x05;
export const ZERO_FRAME_HASH = `0x${'00'.repeat(32)}`;

export const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();

export const hexBytes = (value: string): Buffer => {
  const hex = normalizeEntityId(value).replace(/^0x/, '');
  return Buffer.from(hex.padStart(64, '0'), 'hex');
};

export const decodeEntityId = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

export const encodeHeight = (height: number): Buffer => {
  const out = Buffer.allocUnsafe(8);
  out.writeBigUInt64BE(BigInt(height));
  return out;
};

export const decodeHeight = (buffer: Buffer, offset = 1): number => Number(buffer.readBigUInt64BE(offset));

export const textBytes = (value: string): Buffer => {
  const raw = Buffer.from(value, 'utf8');
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(raw.length);
  return Buffer.concat([len, raw]);
};

export const readText = (buffer: Buffer, offset: number): { value: string; nextOffset: number } => {
  const len = buffer.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buffer.subarray(start, start + len).toString('utf8'), nextOffset: start + len };
};

export const keyFrame = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_FRAME]), encodeHeight(height)]);
export const keyDiff = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_DIFF]), encodeHeight(height)]);
export const keySnapshotManifest = (height: number): Buffer => Buffer.concat([Buffer.from([KEY_SNAPSHOT_MANIFEST]), encodeHeight(height)]);

export const keyLiveEntity = (entityId: string): Buffer => Buffer.concat([Buffer.from([KEY_LIVE_ENTITY]), hexBytes(entityId)]);

export const keyLiveAccount = (entityId: string, counterpartyId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_ACCOUNT]), hexBytes(entityId), hexBytes(counterpartyId)]);
export const keyLiveAccountPrefix = (entityId?: string): Buffer =>
  entityId ? Buffer.concat([Buffer.from([KEY_LIVE_ACCOUNT]), hexBytes(entityId)]) : Buffer.from([KEY_LIVE_ACCOUNT]);

export const keyLiveBook = (entityId: string, pairId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_BOOK]), hexBytes(entityId), textBytes(pairId)]);
export const keyLiveBookPrefix = (entityId?: string): Buffer =>
  entityId ? Buffer.concat([Buffer.from([KEY_LIVE_BOOK]), hexBytes(entityId)]) : Buffer.from([KEY_LIVE_BOOK]);

export const keyLiveReplicaMeta = (entityId: string): Buffer =>
  Buffer.concat([Buffer.from([KEY_LIVE_REPLICA_META]), hexBytes(entityId)]);

export type StorageMerkleNamespace =
  | 'runtime-roots'
  | 'entity-core'
  | 'accounts'
  | 'books'
  | 'lock-book'
  | 'account-deltas'
  | 'account-locks'
  | 'account-swap-offers'
  | 'htlc-routes';

const merkleNamespaceBytes = (namespace: StorageMerkleNamespace): Buffer => textBytes(namespace);

const merklePathBytes = (path: Uint8Array | Buffer): Buffer => {
  const raw = Buffer.from(path);
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(raw.length);
  return Buffer.concat([len, raw]);
};

export const keyMerkleRoot = (entityId: string, namespace: StorageMerkleNamespace): Buffer =>
  Buffer.concat([Buffer.from([KEY_MERKLE_ROOT]), hexBytes(entityId), merkleNamespaceBytes(namespace)]);
export const keyMerkleRootPrefix = (entityId?: string): Buffer =>
  entityId ? Buffer.concat([Buffer.from([KEY_MERKLE_ROOT]), hexBytes(entityId)]) : Buffer.from([KEY_MERKLE_ROOT]);

export const keyMerkleBranch = (entityId: string, namespace: StorageMerkleNamespace, packedPath: Uint8Array | Buffer): Buffer =>
  Buffer.concat([Buffer.from([KEY_MERKLE_BRANCH]), hexBytes(entityId), merkleNamespaceBytes(namespace), merklePathBytes(packedPath)]);
export const keyMerkleBranchPrefix = (entityId?: string, namespace?: StorageMerkleNamespace): Buffer => {
  if (entityId && namespace) return Buffer.concat([Buffer.from([KEY_MERKLE_BRANCH]), hexBytes(entityId), merkleNamespaceBytes(namespace)]);
  if (entityId) return Buffer.concat([Buffer.from([KEY_MERKLE_BRANCH]), hexBytes(entityId)]);
  return Buffer.from([KEY_MERKLE_BRANCH]);
};

export const keyMerkleLeaf = (entityId: string, namespace: StorageMerkleNamespace, packedPath: Uint8Array | Buffer): Buffer =>
  Buffer.concat([Buffer.from([KEY_MERKLE_LEAF]), hexBytes(entityId), merkleNamespaceBytes(namespace), merklePathBytes(packedPath)]);
export const keyMerkleLeafPrefix = (entityId?: string, namespace?: StorageMerkleNamespace): Buffer => {
  if (entityId && namespace) return Buffer.concat([Buffer.from([KEY_MERKLE_LEAF]), hexBytes(entityId), merkleNamespaceBytes(namespace)]);
  if (entityId) return Buffer.concat([Buffer.from([KEY_MERKLE_LEAF]), hexBytes(entityId)]);
  return Buffer.from([KEY_MERKLE_LEAF]);
};

export const keyFrameDbAccountFrame = (
  entityId: string,
  counterpartyId: string,
  accountHeight: number,
): Buffer => Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME]), hexBytes(entityId), hexBytes(counterpartyId), encodeHeight(accountHeight)]);

export const keyFrameDbAccountFrameByRuntime = (
  runtimeHeight: number,
  entityId: string,
  counterpartyId: string,
  accountHeight: number,
): Buffer => Buffer.concat([
  Buffer.from([FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME]),
  encodeHeight(runtimeHeight),
  hexBytes(entityId),
  hexBytes(counterpartyId),
  encodeHeight(accountHeight),
]);

export const keyFrameDbRuntimeActivity = (height: number): Buffer =>
  Buffer.concat([Buffer.from([FRAME_DB_RUNTIME_ACTIVITY]), encodeHeight(height)]);
export const keyFrameDbEntityActivity = (entityId: string, height: number): Buffer =>
  Buffer.concat([Buffer.from([FRAME_DB_ENTITY_ACTIVITY]), hexBytes(entityId), encodeHeight(height)]);
export const keyFrameDbOrderbookCommit = (runtimeHeight: number, entityId: string, pairId: string): Buffer =>
  Buffer.concat([Buffer.from([FRAME_DB_ORDERBOOK_COMMIT]), encodeHeight(runtimeHeight), hexBytes(entityId), textBytes(pairId)]);
export const keyFrameDbOrderbookCommitPrefix = (): Buffer => Buffer.from([FRAME_DB_ORDERBOOK_COMMIT]);

export const keyFrameDbAccountFramePrefix = (entityId?: string, counterpartyId?: string): Buffer => {
  if (entityId && counterpartyId) return Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME]), hexBytes(entityId), hexBytes(counterpartyId)]);
  if (entityId) return Buffer.concat([Buffer.from([FRAME_DB_ACCOUNT_FRAME]), hexBytes(entityId)]);
  return Buffer.from([FRAME_DB_ACCOUNT_FRAME]);
};

export const keyFrameDbAccountFrameByRuntimePrefix = (): Buffer => Buffer.from([FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME]);

export const parseFrameDbAccountFrameRuntimeIndexKey = (key: Buffer): {
  runtimeHeight: number;
  entityId: string;
  counterpartyId: string;
  accountHeight: number;
} => ({
  runtimeHeight: decodeHeight(key, 1),
  entityId: decodeEntityId(key.subarray(9, 41)),
  counterpartyId: decodeEntityId(key.subarray(41, 73)),
  accountHeight: decodeHeight(key, 73),
});

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

export const keySnapshotBookPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height)]);

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

export const parseLiveAccountKey = (key: Buffer): { entityId: string; counterpartyId: string } => ({
  entityId: decodeEntityId(key.subarray(1, 33)),
  counterpartyId: decodeEntityId(key.subarray(33, 65)),
});

export const parseLiveBookKey = (key: Buffer, offset = 1): { entityId: string; pairId: string } => {
  const entityId = decodeEntityId(key.subarray(offset, offset + 32));
  const { value } = readText(key, offset + 32);
  return { entityId, pairId: value };
};

export const parseSnapshotManifestHeight = (key: Buffer): number => decodeHeight(key);
