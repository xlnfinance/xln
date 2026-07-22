import type { RadixMerkleRadix } from './merkle';
import { INTEGRITY_DIGEST_ALGORITHM_ID } from '../infra/integrity-checksum';

/**
 * Schema 7 is the only supported fresh-reset format. It binds the current
 * SHA-256 frame chain to its domain and Merkle mode; schema 6 used different
 * frame-hash bytes and must never be interpreted as this format.
 */
export const STORAGE_SCHEMA_VERSION = 7;

export const STORAGE_FRAME_FORMAT = Object.freeze({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  domain: 'xln.storage.frame',
  algorithmId: INTEGRITY_DIGEST_ALGORITHM_ID,
  hashMode: 'storage-merkle-v1',
} as const);

export class StorageSchemaMismatchError extends Error {
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
export const DEFAULT_RETAIN_SNAPSHOTS = 2;
export const DEFAULT_EPOCH_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_FRAME_DB_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_FRAME_DB_RETAIN_FRAMES = 100_000;
export const DEFAULT_MATERIALIZE_PERIOD_FRAMES = 100;
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
export const KEY_CERTIFIED_BOARD_NODE = 0x2a;
export const KEY_CONSUMPTION_NODE = 0x2b;
export const KEY_ACCOUNT_J_CLAIM_NODE = 0x2c;
export const KEY_SNAPSHOT_ENTITY = 0x31;
export const KEY_SNAPSHOT_ACCOUNT = 0x32;
export const KEY_SNAPSHOT_BOOK = 0x33;
export const KEY_SNAPSHOT_REPLICA_META = 0x34;
/** Physical content-addressed chunks; hidden by the logical DB adapter. */
export const KEY_CHUNK_VALUE = 0x7e;

export const STORAGE_VERIFY_TAIL_FRAMES = 128;
export const EPOCH_SEED_FRAME_TAIL = STORAGE_VERIFY_TAIL_FRAMES + 1;

export const KEY_FRAME_DB_HEAD = Buffer.from([0x00]);
export const FRAME_DB_ACCOUNT_FRAME = 0x01;
export const FRAME_DB_RUNTIME_ACTIVITY = 0x02;
export const FRAME_DB_ENTITY_FRAME = 0x03;
export const FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME = 0x04;
export const FRAME_DB_ENTITY_FRAME_BY_RUNTIME = 0x05;
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

export const decodeEntityId = (bytes: Uint8Array): string => {
  if (bytes.byteLength !== 32) throw new Error(`STORAGE_ENTITY_ID_BYTES_INVALID:${bytes.byteLength}`);
  return `0x${Buffer.from(bytes).toString('hex')}`;
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

export const decodeTaggedStorageHeight = (key: Buffer, tag: number, code: string): number => {
  if (key.length !== 9 || key[0] !== tag) throw new Error(`${code}:${key.toString('hex')}`);
  return decodeHeight(key);
};

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

export const keyFrameDbEntityFrame = (entityId: string, entityHeight: number): Buffer =>
  Buffer.concat([Buffer.from([FRAME_DB_ENTITY_FRAME]), hexBytes(entityId), encodeHeight(entityHeight)]);

export const keyFrameDbEntityFramePrefix = (entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([FRAME_DB_ENTITY_FRAME]), hexBytes(entityId)])
    : Buffer.from([FRAME_DB_ENTITY_FRAME]);

export const parseFrameDbEntityFrameKey = (key: Buffer): { entityId: string; entityHeight: number } => {
  if (key.length !== 41 || key[0] !== FRAME_DB_ENTITY_FRAME) {
    throw new Error(`STORAGE_FRAME_DB_ENTITY_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    entityHeight: decodeHeight(key, 33),
  };
};

export const keyFrameDbEntityFrameByRuntime = (
  runtimeHeight: number,
  entityId: string,
  entityHeight: number,
): Buffer => Buffer.concat([
  Buffer.from([FRAME_DB_ENTITY_FRAME_BY_RUNTIME]),
  encodeHeight(runtimeHeight),
  hexBytes(entityId),
  encodeHeight(entityHeight),
]);

export const keyFrameDbEntityFrameByRuntimePrefix = (): Buffer =>
  Buffer.from([FRAME_DB_ENTITY_FRAME_BY_RUNTIME]);

export const parseFrameDbEntityFrameRuntimeIndexKey = (key: Buffer): {
  runtimeHeight: number;
  entityId: string;
  entityHeight: number;
} => {
  if (key.length !== 49 || key[0] !== FRAME_DB_ENTITY_FRAME_BY_RUNTIME) {
    throw new Error(`STORAGE_FRAME_DB_ENTITY_RUNTIME_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    runtimeHeight: decodeHeight(key, 1),
    entityId: decodeEntityId(key.subarray(9, 41)),
    entityHeight: decodeHeight(key, 41),
  };
};

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
} => {
  if (key.length !== 81 || key[0] !== FRAME_DB_ACCOUNT_FRAME_BY_RUNTIME) {
    throw new Error(`STORAGE_FRAME_DB_ACCOUNT_RUNTIME_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    runtimeHeight: decodeHeight(key, 1),
    entityId: decodeEntityId(key.subarray(9, 41)),
    counterpartyId: decodeEntityId(key.subarray(41, 73)),
    accountHeight: decodeHeight(key, 73),
  };
};

export const parseFrameDbAccountFrameKey = (key: Buffer): {
  entityId: string;
  counterpartyId: string;
  accountHeight: number;
} => {
  if (key.length !== 73 || key[0] !== FRAME_DB_ACCOUNT_FRAME) {
    throw new Error(`STORAGE_FRAME_DB_ACCOUNT_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    entityId: decodeEntityId(key.subarray(1, 33)),
    counterpartyId: decodeEntityId(key.subarray(33, 65)),
    accountHeight: decodeHeight(key, 65),
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

export const keySnapshotBookPrefix = (height: number, entityId?: string): Buffer =>
  entityId
    ? Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height), hexBytes(entityId)])
    : Buffer.concat([Buffer.from([KEY_SNAPSHOT_BOOK]), encodeHeight(height)]);

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

export const parseSnapshotEntityKey = (key: Buffer): { height: number; entityId: string } => {
  if (key.length !== 41 || key[0] !== KEY_SNAPSHOT_ENTITY) {
    throw new Error(`STORAGE_SNAPSHOT_ENTITY_KEY_INVALID:${key.toString('hex')}`);
  }
  return { height: decodeHeight(key), entityId: decodeEntityId(key.subarray(9, 41)) };
};

export const parseSnapshotAccountKey = (key: Buffer): {
  height: number;
  entityId: string;
  counterpartyId: string;
} => {
  if (key.length !== 73 || key[0] !== KEY_SNAPSHOT_ACCOUNT) {
    throw new Error(`STORAGE_SNAPSHOT_ACCOUNT_KEY_INVALID:${key.toString('hex')}`);
  }
  return {
    height: decodeHeight(key),
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

export const parseLiveAccountKey = (key: Buffer): { entityId: string; counterpartyId: string } => {
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

export const parseSnapshotManifestHeight = (key: Buffer): number => {
  if (key.length !== 9 || key[0] !== KEY_SNAPSHOT_MANIFEST) {
    throw new Error(`STORAGE_SNAPSHOT_MANIFEST_KEY_INVALID:${key.toString('hex')}`);
  }
  return decodeHeight(key);
};
