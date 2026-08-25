/**
 * Physical projection of the Rust Account authority's exact checkpoint.
 * These rows share the authoritative Runtime WAL batch; the current DB is only
 * a rebuildable mirror. Header/consensus rows are retained because TS cannot
 * reconstruct historical Hanko or held outputs from AccountState alone.
 */
import {
  decodeRscoreCheckpointToken,
  rscoreCheckpointBytes,
  rscoreCheckpointList,
  rscoreCheckpointTuple,
  type RscoreCheckpointChanges,
  type RscoreExactCheckpoint,
  type RscoreCheckpointToken,
} from '../../../rscore/checkpoint/checkpoint-wire';
import type { RscoreWireValue } from '../../../rscore/client';
import { buffersEqual } from '../../../protocol/serialization';
import { decodeBuffer, encodeBuffer } from '../../codec/codec';
import {
  MAX_PHYSICAL_STORAGE_VALUE_BYTES,
  prepareBoundedStorageValueMutation,
  readBoundedEncodedValue,
} from '../../codec/bounded-value';
import { iterateKeys, readRawOrNull } from '../../database/level';
import {
  keyRscoreAccount,
  keyRscoreAccountNode,
  keyRscoreAccountNodePrefix,
  keyRscoreAccountPrefix,
  keyRscoreCheckpoint,
} from '../../keys';
import type { RuntimeDbLike, StorageRscoreCheckpointRef } from '../../types';

const TREE_TAGS = [1, 2, 3, 4, 5] as const;
const OWNER_PATTERN = /^0x[0-9a-f]{64}$/;

export type RscoreCheckpointStorageInput = Readonly<{
  ownerEntityId: string;
  protocolFingerprint: string;
  checkpoint: RscoreCheckpointChanges;
}>;

export type PreparedRscoreCheckpointStorage = Readonly<{
  refs: readonly StorageRscoreCheckpointRef[];
  puts: readonly Readonly<{ key: Buffer; value: Buffer }>[];
  dels: readonly Buffer[];
  /** Full post-mutation rows, reconstructed through the physical overlay. */
  exactCheckpoints: readonly RscoreExactCheckpoint[];
}>;

export type LoadedRscoreCheckpoint = RscoreExactCheckpoint;

const ownerId = (value: string): string => {
  const normalized = String(value).trim().toLowerCase();
  if (!OWNER_PATTERN.test(normalized)) throw new Error(`STORAGE_RSCORE_OWNER_INVALID:${value}`);
  return normalized;
};

const hex32 = (value: Uint8Array): string => `0x${Buffer.from(value).toString('hex')}`;

const storageRef = (
  ownerEntityId: string,
  protocolFingerprint: string,
  token: RscoreCheckpointToken,
): StorageRscoreCheckpointRef => ({
  ownerEntityId,
  protocolFingerprint,
  baseRevision: String(token[0]),
  revision: String(token[1]),
  accountsRoot: hex32(token[2]),
  signerDigest: hex32(token[3]),
  accountCount: token[4],
});

const wireRevision = (value: string): number | bigint => {
  const integer = BigInt(value);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
};

const wireToken = (value: StorageRscoreCheckpointRef): RscoreCheckpointToken =>
  decodeRscoreCheckpointToken([
    wireRevision(value.baseRevision),
    wireRevision(value.revision),
    Buffer.from(value.accountsRoot.slice(2), 'hex'),
    Buffer.from(value.signerDigest.slice(2), 'hex'),
    value.accountCount,
  ], 'STORED');

const storedDecimal = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`STORAGE_RSCORE_CHECKPOINT_${field}_INVALID`);
  }
  const integer = BigInt(value);
  if (integer > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`STORAGE_RSCORE_CHECKPOINT_${field}_MAX`);
  }
  return value;
};

const storedHash = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`STORAGE_RSCORE_CHECKPOINT_${field}_INVALID`);
  }
  return value;
};

const exactRecord = (value: unknown, keys: readonly string[], code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
  return record;
};

const variableBytes = (value: unknown, field: string): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new Error(`STORAGE_RSCORE_${field}_BYTES`);
  return value;
};

const nodeStorageKey = (
  owner: string,
  account: string,
  namespace: number,
  value: RscoreWireValue,
  deletion: boolean,
): Buffer => {
  const tag = Array.isArray(value) ? value[0] : null;
  const record = rscoreCheckpointTuple(
    value,
    tag === 0 ? (deletion ? 2 : 3) : (deletion ? 3 : 4),
    'NODE',
  );
  if (record[0] !== 0 && record[0] !== 1) throw new Error('STORAGE_RSCORE_NODE_TAG');
  const kind = record[0] as 0 | 1;
  const payload = variableBytes(record[kind === 0 ? 1 : 2], 'NODE_KEY');
  return keyRscoreAccountNode(owner, account, namespace, kind, payload);
};

const addEncodedPut = (
  puts: Map<string, { key: Buffer; value: Buffer }>,
  dels: Map<string, Buffer>,
  key: Buffer,
  encoded: Buffer,
): void => {
  if (encoded.byteLength >= MAX_PHYSICAL_STORAGE_VALUE_BYTES) {
    throw new Error(
      `STORAGE_RSCORE_PHYSICAL_VALUE_TOO_LARGE:${key.toString('hex')}:` +
      `${encoded.byteLength}:${MAX_PHYSICAL_STORAGE_VALUE_BYTES}`,
    );
  }
  const id = key.toString('hex');
  const existing = puts.get(id);
  if (existing && !buffersEqual(existing.value, encoded)) throw new Error(`STORAGE_RSCORE_PUT_CONFLICT:${id}`);
  puts.set(id, { key, value: encoded });
  dels.delete(id);
};

const addPut = (
  puts: Map<string, { key: Buffer; value: Buffer }>,
  dels: Map<string, Buffer>,
  key: Buffer,
  value: unknown,
): void => addEncodedPut(puts, dels, key, encodeBuffer(value));

const addDel = (puts: Map<string, { key: Buffer; value: Buffer }>, dels: Map<string, Buffer>, key: Buffer): void => {
  const id = key.toString('hex');
  if (!puts.has(id)) dels.set(id, key);
};

const accountIdsIn = async (db: RuntimeDbLike, owner: string): Promise<Set<string>> => {
  const prefix = keyRscoreAccountPrefix(owner);
  const ids = new Set<string>();
  for await (const key of iterateKeys(db, { prefix })) {
    if (key.byteLength !== prefix.byteLength + 32) throw new Error('STORAGE_RSCORE_ACCOUNT_KEY_INVALID');
    ids.add(hex32(key.subarray(prefix.byteLength)));
  }
  return ids;
};

const compareKeyBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
};

const keyInRange = (
  key: Buffer,
  options: { gte?: Buffer; lt?: Buffer },
): boolean =>
  (options.gte === undefined || compareKeyBytes(key, options.gte) >= 0) &&
  (options.lt === undefined || compareKeyBytes(key, options.lt) < 0);

/** Read the exact DB state that the planned atomic batch would publish. */
const preparedCheckpointView = (
  db: RuntimeDbLike,
  puts: ReadonlyMap<string, Readonly<{ key: Buffer; value: Buffer }>>,
  dels: ReadonlySet<string>,
): RuntimeDbLike => ({
  get: async key => {
    const id = key.toString('hex');
    if (dels.has(id)) {
      const error = new Error(`STORAGE_RSCORE_OVERLAY_NOT_FOUND:${id}`);
      error.name = 'NotFoundError';
      throw error;
    }
    const put = puts.get(id);
    return put ? Buffer.from(put.value) : db.get(key);
  },
  batch: () => {
    throw new Error('STORAGE_RSCORE_OVERLAY_READ_ONLY');
  },
  keys: async function* (options = {}) {
    if (typeof db.keys !== 'function') {
      throw new Error('STORAGE_RSCORE_OVERLAY_KEYS_UNAVAILABLE');
    }
    const keys = new Map<string, Buffer>();
    for await (const rawKey of db.keys(options)) {
      const key = Buffer.isBuffer(rawKey)
        ? rawKey
        : rawKey instanceof Uint8Array
          ? Buffer.from(rawKey)
          : Buffer.from(String(rawKey));
      const id = key.toString('hex');
      if (!dels.has(id)) keys.set(id, key);
    }
    for (const put of puts.values()) {
      if (keyInRange(put.key, options)) {
        keys.set(put.key.toString('hex'), put.key);
      }
    }
    const ordered = [...keys.values()]
      .sort(compareKeyBytes);
    if (options.reverse === true) ordered.reverse();
    yield* ordered;
  },
});

const readCheckpointRef = async (
  db: RuntimeDbLike,
  owner: string,
): Promise<StorageRscoreCheckpointRef | null> => {
  const tokenRaw = await readRawOrNull(db, keyRscoreCheckpoint(owner));
  if (!tokenRaw) return null;
  const meta = exactRecord(decodeBuffer(tokenRaw), [
    'version', 'ownerEntityId', 'protocolFingerprint', 'baseRevision', 'revision',
    'accountsRoot', 'signerDigest', 'accountCount',
  ], 'STORAGE_RSCORE_CHECKPOINT_META');
  if (meta['version'] !== 1 || meta['ownerEntityId'] !== owner) {
    throw new Error('STORAGE_RSCORE_CHECKPOINT_META_INVALID');
  }
  const accountCount = meta['accountCount'];
  if (!Number.isSafeInteger(accountCount) || Number(accountCount) < 0 || Number(accountCount) > 65_536) {
    throw new Error('STORAGE_RSCORE_CHECKPOINT_ACCOUNT_COUNT_INVALID');
  }
  const ref: StorageRscoreCheckpointRef = {
    ownerEntityId: owner,
    protocolFingerprint: storedHash(meta['protocolFingerprint'], 'FINGERPRINT'),
    baseRevision: storedDecimal(meta['baseRevision'], 'BASE_REVISION'),
    revision: storedDecimal(meta['revision'], 'REVISION'),
    accountsRoot: storedHash(meta['accountsRoot'], 'ACCOUNTS_ROOT'),
    signerDigest: storedHash(meta['signerDigest'], 'SIGNER_DIGEST'),
    accountCount: Number(accountCount),
  };
  const token = wireToken(ref);
  if (BigInt(token[0]) !== BigInt(token[1])) {
    throw new Error('STORAGE_RSCORE_STORED_TOKEN_BASE');
  }
  return ref;
};

export const prepareRscoreCheckpointStorage = async (
  db: RuntimeDbLike,
  inputs: readonly RscoreCheckpointStorageInput[],
): Promise<PreparedRscoreCheckpointStorage> => {
  const puts = new Map<string, { key: Buffer; value: Buffer }>();
  const dels = new Map<string, Buffer>();
  const refs: StorageRscoreCheckpointRef[] = [];
  const owners = new Set<string>();
  for (const input of [...inputs].sort((left, right) => left.ownerEntityId.localeCompare(right.ownerEntityId))) {
    const owner = ownerId(input.ownerEntityId);
    if (!/^0x[0-9a-f]{64}$/.test(input.protocolFingerprint)) throw new Error('STORAGE_RSCORE_FINGERPRINT_INVALID');
    if (owners.has(owner)) throw new Error(`STORAGE_RSCORE_OWNER_DUPLICATE:${owner}`);
    owners.add(owner);
    const storedRef = await readCheckpointRef(db, owner);
    const commitBase = BigInt(input.checkpoint.commitToken[0]);
    if (storedRef === null) {
      if (commitBase !== 0n) {
        throw new Error(`STORAGE_RSCORE_BASE_MISSING:${owner}:${commitBase}`);
      }
    } else {
      if (storedRef.protocolFingerprint !== input.protocolFingerprint) {
        throw new Error(`STORAGE_RSCORE_FINGERPRINT_MISMATCH:${owner}`);
      }
      if (BigInt(storedRef.revision) !== commitBase) {
        throw new Error(
          `STORAGE_RSCORE_BASE_REVISION:${owner}:${storedRef.revision}:${commitBase}`,
        );
      }
    }
    const currentIds = await accountIdsIn(db, owner);
    if (storedRef && currentIds.size !== storedRef.accountCount) {
      throw new Error(
        `STORAGE_RSCORE_STORED_ACCOUNT_COUNT:${owner}:${currentIds.size}:${storedRef.accountCount}`,
      );
    }
    const changedIds = new Set<string>();
    for (const raw of input.checkpoint.accounts) {
      const row = rscoreCheckpointTuple(raw, 10, 'ACCOUNT');
      const account = hex32(rscoreCheckpointBytes(row[0], 32, 'ACCOUNT_ID'));
      if (changedIds.has(account)) throw new Error(`STORAGE_RSCORE_ACCOUNT_DUPLICATE:${account}`);
      changedIds.add(account);
      const header = rscoreCheckpointTuple(row[2], 9, 'HEADER');
      if (hex32(rscoreCheckpointBytes(header[0], 32, 'HEADER_OWNER')) !== owner) {
        throw new Error(`STORAGE_RSCORE_ACCOUNT_OWNER:${account}`);
      }
      rscoreCheckpointTuple(row[3], 5, 'SECTIONS');
      rscoreCheckpointTuple(row[9], 11, 'CONSENSUS');
      const accountKey = keyRscoreAccount(owner, account);
      const accountMutation = await prepareBoundedStorageValueMutation(
        db,
        accountKey,
        encodeBuffer([row[1], row[2], row[9]]),
      );
      for (const key of accountMutation.dels) addDel(puts, dels, key);
      for (const put of accountMutation.puts) addEncodedPut(puts, dels, put.key, put.value);
      for (const [offset, namespace] of TREE_TAGS.entries()) {
        const changes = rscoreCheckpointTuple(row[4 + offset], 2, `TREE_${namespace}`);
        for (const rawDel of rscoreCheckpointList(changes[1], `TREE_${namespace}_DELS`)) {
          const nodeMutation = await prepareBoundedStorageValueMutation(
            db,
            nodeStorageKey(owner, account, namespace, rawDel, true),
            null,
          );
          for (const key of nodeMutation.dels) addDel(puts, dels, key);
        }
        for (const rawPut of rscoreCheckpointList(changes[0], `TREE_${namespace}_PUTS`)) {
          const nodeMutation = await prepareBoundedStorageValueMutation(
            db,
            nodeStorageKey(owner, account, namespace, rawPut, false),
            encodeBuffer(rawPut),
          );
          for (const key of nodeMutation.dels) addDel(puts, dels, key);
          for (const put of nodeMutation.puts) addEncodedPut(puts, dels, put.key, put.value);
        }
      }
      currentIds.add(account);
    }
    const removed = input.checkpoint.removed.map(hex32);
    for (const account of removed) {
      if (changedIds.has(account)) throw new Error(`STORAGE_RSCORE_ACCOUNT_CHANGED_AND_REMOVED:${account}`);
      const accountMutation = await prepareBoundedStorageValueMutation(
        db,
        keyRscoreAccount(owner, account),
        null,
      );
      for (const key of accountMutation.dels) addDel(puts, dels, key);
      for await (const key of iterateKeys(db, { prefix: keyRscoreAccountNodePrefix(owner, account) })) {
        const nodeMutation = await prepareBoundedStorageValueMutation(db, key, null);
        for (const nodeKey of nodeMutation.dels) addDel(puts, dels, nodeKey);
      }
      currentIds.delete(account);
    }
    if (currentIds.size !== input.checkpoint.restoreToken[4]) {
      throw new Error(`STORAGE_RSCORE_ACCOUNT_COUNT:${currentIds.size}:${input.checkpoint.restoreToken[4]}`);
    }
    const ref = storageRef(owner, input.protocolFingerprint, input.checkpoint.restoreToken);
    refs.push(ref);
    addPut(puts, dels, keyRscoreCheckpoint(owner), { version: 1, ...ref });
  }
  const view = preparedCheckpointView(db, puts, new Set(dels.keys()));
  const exactCheckpoints: RscoreExactCheckpoint[] = [];
  for (const ref of refs) {
    const checkpoint = await loadRscoreCheckpoint(view, ref.ownerEntityId);
    if (!checkpoint) {
      throw new Error(`STORAGE_RSCORE_PREPARED_CHECKPOINT_MISSING:${ref.ownerEntityId}`);
    }
    exactCheckpoints.push(checkpoint);
  }
  return {
    refs,
    puts: [...puts.values()],
    dels: [...dels.values()],
    exactCheckpoints,
  };
};

const leafValues = async (
  db: RuntimeDbLike,
  owner: string,
  account: string,
  namespace: number,
): Promise<RscoreWireValue[]> => {
  const values: RscoreWireValue[] = [];
  const prefix = keyRscoreAccountNodePrefix(owner, account, namespace, 1);
  for await (const key of iterateKeys(db, { prefix })) {
    const raw = await readBoundedEncodedValue(db, key);
    if (!raw) throw new Error(`STORAGE_RSCORE_NODE_MISSING:${key.toString('hex')}`);
    const row = rscoreCheckpointTuple(decodeBuffer(raw), 4, 'STORED_LEAF');
    if (row[0] !== 1) throw new Error('STORAGE_RSCORE_STORED_LEAF_TAG');
    variableBytes(row[1], 'STORED_LEAF_PATH');
    const keyBytes = variableBytes(row[2], 'STORED_LEAF_KEY');
    const storedKey = key.subarray(prefix.byteLength);
    if (!buffersEqual(storedKey, Buffer.from(keyBytes))) {
      throw new Error(`STORAGE_RSCORE_STORED_LEAF_KEY_MISMATCH:${key.toString('hex')}`);
    }
    if (namespace === 3) {
      const bytes = Buffer.from(keyBytes);
      if (bytes.byteLength < 2 || bytes.readUInt16BE(0) !== bytes.byteLength - 2) throw new Error('STORAGE_RSCORE_LENDING_KEY');
      values.push([bytes.subarray(2).toString('utf8'), row[3] as RscoreWireValue]);
    } else if (namespace === 5) {
      const bytes = Buffer.from(keyBytes);
      if (bytes.byteLength !== 32 || bytes.subarray(0, 30).some(byte => byte !== 0)) throw new Error('STORAGE_RSCORE_POLICY_KEY');
      values.push([bytes.readUInt16BE(30), row[3] as RscoreWireValue]);
    } else {
      values.push(row[3] as RscoreWireValue);
    }
  }
  return values;
};

export const loadRscoreCheckpoint = async (
  db: RuntimeDbLike,
  rawOwnerEntityId: string,
): Promise<LoadedRscoreCheckpoint | null> => {
  const owner = ownerId(rawOwnerEntityId);
  const ref = await readCheckpointRef(db, owner);
  if (!ref) return null;
  const restoreToken = wireToken(ref);
  const accounts: RscoreWireValue[][] = [];
  const prefix = keyRscoreAccountPrefix(owner);
  for await (const key of iterateKeys(db, { prefix })) {
    const account = hex32(key.subarray(prefix.byteLength));
    const raw = await readBoundedEncodedValue(db, key);
    if (!raw) throw new Error(`STORAGE_RSCORE_ACCOUNT_MISSING:${account}`);
    const accountMeta = rscoreCheckpointTuple(decodeBuffer(raw), 3, 'STORED_ACCOUNT');
    accounts.push([
      Buffer.from(account.slice(2), 'hex'),
      accountMeta[0],
      accountMeta[1],
      await leafValues(db, owner, account, 1),
      await leafValues(db, owner, account, 2),
      await leafValues(db, owner, account, 3),
      await leafValues(db, owner, account, 4),
      await leafValues(db, owner, account, 5),
      accountMeta[2],
    ] as RscoreWireValue[]);
  }
  if (accounts.length !== restoreToken[4]) throw new Error(`STORAGE_RSCORE_RESTORE_COUNT:${accounts.length}:${restoreToken[4]}`);
  return {
    ownerEntityId: owner,
    protocolFingerprint: String(ref.protocolFingerprint),
    restoreToken,
    accounts,
  };
};
