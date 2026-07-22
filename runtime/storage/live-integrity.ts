import { computeIntegrityDigest } from '../infra/integrity-checksum';
import { decodeValidatedBuffer, encodeBuffer } from './codec';
import { docRefCellKey } from './doc-refs';
import { storageMerkleCellHexKey } from './hashes';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  KEY_LIVE_ENTITY,
  decodeEntityId,
  hexBytes,
  keyLiveAccount,
  keyLiveAccountPrefix,
  keyLiveBook,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyMerkleBranch,
  keyMerkleBranchPrefix,
  keyMerkleLeaf,
  keyMerkleLeafPrefix,
  keyMerkleRoot,
  keyMerkleRootPrefix,
  normalizeEntityId,
  parseLiveAccountKey,
  parseLiveBookKey,
} from './keys';
import { iterateKeys } from './level';
import { buildHexKeyedMerkleMaterialized, packRadixMerklePath } from './merkle';
import {
  assertStorageAccountDocBinding,
  assertStorageEntityDocBinding,
  validateStorageAccountDocValue,
  validateStorageBookDocValue,
  validateStorageEntityCoreDocValue,
  validateStorageMerkleBranchDocValue,
  validateStorageMerkleLeafDocValue,
  validateStorageMerkleRootDocValue,
} from './authoritative-schema';
import { readAccountStorageLayout } from './account-layout';
import type {
  RuntimeDbLike,
  StorageMerkleBranchDoc,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
} from './types';

const RUNTIME_ROOTS = 'runtime-roots' as const;

type LiveCell = { hexKey: string; value: Buffer };

const appendCell = (
  cellsByEntity: Map<string, LiveCell[]>,
  entityId: string,
  cellKey: string,
  raw: Buffer,
): void => {
  const normalized = normalizeEntityId(entityId);
  const cells = cellsByEntity.get(normalized) ?? [];
  cells.push({
    hexKey: storageMerkleCellHexKey(cellKey),
    value: hexBytes(computeIntegrityDigest(raw)),
  });
  cellsByEntity.set(normalized, cells);
};

const assertExactKey = (actual: Buffer, expected: Buffer, code: string): void => {
  if (!actual.equals(expected)) {
    throw new Error(`${code}:actual=${actual.toString('hex')}:expected=${expected.toString('hex')}`);
  }
};

const assertExactDoc = (actual: unknown, expected: unknown, code: string): void => {
  if (!encodeBuffer(actual).equals(encodeBuffer(expected))) throw new Error(code);
};

const merklePathKey = (path: number[]): string => JSON.stringify(path);

/**
 * Verifies the complete live materialization before a persisted HEAD is used.
 * The frame/state hashes alone are insufficient: a corrupt key can otherwise
 * move a valid value to another namespace while preserving valid-looking rows.
 */
export const verifyLiveStorageIntegrity = async (db: RuntimeDbLike): Promise<void> => {
  const cellsByEntity = new Map<string, LiveCell[]>();

  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    if (key.length !== 33) throw new Error(`STORAGE_LIVE_ENTITY_KEY_INVALID:${key.toString('hex')}`);
    const entityId = decodeEntityId(key.subarray(1));
    assertExactKey(key, keyLiveEntity(entityId), 'STORAGE_LIVE_ENTITY_KEY_MISMATCH');
    const raw = await db.get(key);
    const doc = assertStorageEntityDocBinding(
      decodeValidatedBuffer(raw, validateStorageEntityCoreDocValue),
      entityId,
      'startup-integrity',
    );
    appendCell(cellsByEntity, entityId, docRefCellKey({ family: 'entity', entityId: doc.entityId }), raw);
  }

  for await (const key of iterateKeys(db, { prefix: keyLiveAccountPrefix() })) {
    const parsed = parseLiveAccountKey(key);
    assertExactKey(key, keyLiveAccount(parsed.entityId, parsed.counterpartyId), 'STORAGE_LIVE_ACCOUNT_KEY_MISMATCH');
    const stored = await readAccountStorageLayout(db, parsed.entityId, parsed.counterpartyId, key);
    if (!stored) throw new Error(`STORAGE_LIVE_ACCOUNT_MISSING:${key.toString('hex')}`);
    assertStorageAccountDocBinding(
      validateStorageAccountDocValue(stored.doc),
      parsed.entityId,
      parsed.counterpartyId,
      'startup-integrity',
    );
    appendCell(cellsByEntity, parsed.entityId, docRefCellKey({
      family: 'account',
      entityId: parsed.entityId,
      counterpartyId: parsed.counterpartyId,
    }), stored.logicalValue);
  }

  for await (const key of iterateKeys(db, { prefix: keyLiveBookPrefix() })) {
    const parsed = parseLiveBookKey(key);
    assertExactKey(key, keyLiveBook(parsed.entityId, parsed.pairId), 'STORAGE_LIVE_BOOK_KEY_MISMATCH');
    const raw = await db.get(key);
    decodeValidatedBuffer(raw, validateStorageBookDocValue);
    appendCell(cellsByEntity, parsed.entityId, docRefCellKey({
      family: 'book',
      entityId: parsed.entityId,
      pairId: parsed.pairId,
    }), raw);
  }

  const roots = new Map<string, StorageMerkleRootDoc>();
  const branches = new Map<string, Map<string, StorageMerkleBranchDoc>>();
  const leaves = new Map<string, Map<string, StorageMerkleLeafDoc>>();

  for await (const key of iterateKeys(db, { prefix: keyMerkleRootPrefix() })) {
    const doc = decodeValidatedBuffer(await db.get(key), validateStorageMerkleRootDocValue);
    assertExactKey(key, keyMerkleRoot(doc.entityId, doc.namespace), 'STORAGE_MERKLE_ROOT_KEY_MISMATCH');
    if (doc.namespace === RUNTIME_ROOTS) roots.set(normalizeEntityId(doc.entityId), doc);
  }
  for await (const key of iterateKeys(db, { prefix: keyMerkleBranchPrefix() })) {
    const doc = decodeValidatedBuffer(await db.get(key), validateStorageMerkleBranchDocValue);
    assertExactKey(
      key,
      keyMerkleBranch(doc.entityId, doc.namespace, packRadixMerklePath(doc.radix, doc.path)),
      'STORAGE_MERKLE_BRANCH_KEY_MISMATCH',
    );
    if (doc.namespace !== RUNTIME_ROOTS) continue;
    const entityId = normalizeEntityId(doc.entityId);
    const rows = branches.get(entityId) ?? new Map<string, StorageMerkleBranchDoc>();
    rows.set(merklePathKey(doc.path), doc);
    branches.set(entityId, rows);
  }
  for await (const key of iterateKeys(db, { prefix: keyMerkleLeafPrefix() })) {
    const doc = decodeValidatedBuffer(await db.get(key), validateStorageMerkleLeafDocValue);
    assertExactKey(
      key,
      keyMerkleLeaf(doc.entityId, doc.namespace, packRadixMerklePath(doc.radix, doc.path)),
      'STORAGE_MERKLE_LEAF_KEY_MISMATCH',
    );
    if (doc.namespace !== RUNTIME_ROOTS) continue;
    const entityId = normalizeEntityId(doc.entityId);
    const rows = leaves.get(entityId) ?? new Map<string, StorageMerkleLeafDoc>();
    rows.set(merklePathKey(doc.path), doc);
    leaves.set(entityId, rows);
  }

  const allEntities = new Set([...cellsByEntity.keys(), ...roots.keys(), ...branches.keys(), ...leaves.keys()]);
  for (const entityId of allEntities) {
    const cells = cellsByEntity.get(entityId) ?? [];
    const root = roots.get(entityId);
    if (!root) throw new Error(`STORAGE_MERKLE_ROOT_MISSING:entity=${entityId}`);
    const rebuilt = buildHexKeyedMerkleMaterialized(cells, { radix: DEFAULT_ACCOUNT_MERKLE_RADIX });
    assertExactDoc(root, {
      entityId,
      namespace: RUNTIME_ROOTS,
      radix: rebuilt.radix,
      rootHash: rebuilt.root,
      rootKind: rebuilt.rootKind,
      rootPath: rebuilt.rootPath,
      leafCount: rebuilt.leafCount,
    } satisfies StorageMerkleRootDoc, `STORAGE_MERKLE_ROOT_MISMATCH:entity=${entityId}`);

    const actualBranches = branches.get(entityId) ?? new Map<string, StorageMerkleBranchDoc>();
    if (actualBranches.size !== rebuilt.branches.length) {
      throw new Error(`STORAGE_MERKLE_BRANCH_COUNT_MISMATCH:entity=${entityId}`);
    }
    for (const expected of rebuilt.branches) {
      const path = merklePathKey(expected.path);
      const actual = actualBranches.get(path);
      if (!actual) throw new Error(`STORAGE_MERKLE_BRANCH_MISSING:entity=${entityId}:path=${path}`);
      assertExactDoc(actual, {
        entityId,
        namespace: RUNTIME_ROOTS,
        radix: rebuilt.radix,
        ...expected,
      } satisfies StorageMerkleBranchDoc, `STORAGE_MERKLE_BRANCH_MISMATCH:entity=${entityId}:path=${path}`);
    }

    const actualLeaves = leaves.get(entityId) ?? new Map<string, StorageMerkleLeafDoc>();
    if (actualLeaves.size !== rebuilt.leaves.length) {
      throw new Error(`STORAGE_MERKLE_LEAF_COUNT_MISMATCH:entity=${entityId}`);
    }
    for (const expected of rebuilt.leaves) {
      const path = merklePathKey(expected.path);
      const actual = actualLeaves.get(path);
      if (!actual) throw new Error(`STORAGE_MERKLE_LEAF_MISSING:entity=${entityId}:path=${path}`);
      assertExactDoc(actual, {
        entityId,
        namespace: RUNTIME_ROOTS,
        radix: rebuilt.radix,
        ...expected,
      } satisfies StorageMerkleLeafDoc, `STORAGE_MERKLE_LEAF_MISMATCH:entity=${entityId}:path=${path}`);
    }
  }
};
