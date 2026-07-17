import type { BookState } from '../orderbook';
import type { EntityState, Env } from '../types';
import { ethers } from 'ethers';
import { decodeBuffer, decodeValidatedBuffer } from './codec';
import { docRefCellKey, docRefKey, docValueKey } from './doc-refs';
import { storageMerkleCellHexKey } from './hashes';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  KEY_HEAD,
  KEY_LIVE_ENTITY,
  decodeEntityId,
  hexBytes,
  keyDiff,
  keyCertifiedBoardNode,
  keyConsumptionNode,
  keyAccountJClaimNode,
  keyFrame,
  keyMerkleLeaf,
  keyLiveAccount,
  keyLiveAccountPrefix,
  keyLiveBook,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyMerkleBranchPrefix,
  keyMerkleLeafPrefix,
  keyMerkleRoot,
  keyLiveReplicaMeta,
  keyLiveReplicaMetaPrefix,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotEntityPrefix,
  keySnapshotReplicaMeta,
  keySnapshotReplicaMetaPrefix,
  normalizeEntityId,
  parseLiveAccountKey,
  parseLiveBookKey,
  prefixUpperBound,
  textBytes,
} from './keys';
import { iterateKeys, readRawOrNull, readValidatedOrNull } from './level';
import { listSnapshotHeights } from './lifecycle';
import { compareAscii } from './sorted-index';
import {
  buildHexKeyedMerkle,
  computeRadixMerkleBranchHash,
  computeRadixMerkleLeafHash,
  packRadixMerklePath,
  radixMerklePathSlots,
} from './merkle';
import { hydrateEntityStateFromStorage } from './projections';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  getCertifiedBoardNodeStore,
  hashCertifiedBoardNode,
} from '../jurisdiction/board-registry';
import {
  EMPTY_CONSUMPTION_ROOT,
  hashConsumptionNode,
} from '../entity/consumption-accumulator';
import {
  collectReachableConsumptionNodes,
  getConsumptionNodeStore,
} from '../entity/consumption-store';
import { assertEntityAccountInsertionCapacity } from '../entity/account-capacity';
import {
  EMPTY_ACCOUNT_J_CLAIM_ROOT,
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
  type AccountJClaimAccumulatorState,
} from '../account/j-claim-accumulator';
import { getAccountJClaimNodeStore } from '../account/j-claim-store';
import { validateEntityReplica } from '../validation-utils';
import {
  assertStorageAccountDocBinding,
  assertStorageEntityDocBinding,
  validateAccountJClaimNodeValue,
  validateCertifiedBoardNodeValue,
  validateConsumptionNodeValue,
  validateStorageAccountDocValue,
  validateStorageBookDocValue,
  validateStorageDiffRecordValue,
  validateStorageEntityCoreDocValue,
  validateStorageFrameRecordValue,
  validateStorageHeadValue,
  validateStorageMerkleBranchDocValue,
  validateStorageMerkleLeafDocValue,
  validateStorageMerkleRootDocValue,
} from './authoritative-schema';
import type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageEntityCoreDoc,
  StorageFrameRecord,
  StorageHead,
  StorageReplicaMeta,
} from './types';

export type StorageAccountDocPage = {
  items: StorageAccountDoc[];
  nextCursor: string | null;
};

export type StorageBookDocPage = {
  items: Array<{ pairId: string; book: BookState }>;
  nextCursor: string | null;
};

export type StorageEntityViewPage = {
  core: StorageEntityCoreDoc;
  accounts: StorageAccountDocPage;
  books: StorageBookDocPage;
};

const assertEntityDocKeyBinding = (
  doc: StorageEntityCoreDoc | null,
  expectedEntityId: string,
  scope: string,
): StorageEntityCoreDoc | null => {
  return doc ? assertStorageEntityDocBinding(doc, expectedEntityId, scope) : null;
};

export const hydrateCertifiedBoardRootNodesFromStorage = async (
  env: Env,
  db: RuntimeDbLike,
  root: string | undefined,
): Promise<void> => {
  if (!root || root === EMPTY_CERTIFIED_BOARD_ROOT) return;
  const store = getCertifiedBoardNodeStore(env);
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (visited.has(hash)) continue;
    if (visited.size > 1_000_000) throw new Error('CERTIFIED_BOARD_DAG_OVERSIZED');
    visited.add(hash);
    let node = store.get(hash);
    if (!node) {
      const raw = await readRawOrNull(db, keyCertifiedBoardNode(hash));
      if (!raw) throw new Error(`CERTIFIED_BOARD_NODE_MISSING:${hash}`);
      node = decodeValidatedBuffer(raw, validateCertifiedBoardNodeValue);
      store.set(hash, node);
    }
    const actual = hashCertifiedBoardNode(node);
    if (actual !== hash) throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${hash}:${actual}`);
    if (node.type === 'branch') pending.push(node.left, node.right);
  }
};

export const hydrateConsumptionRootNodesFromStorage = async (
  env: Env,
  db: RuntimeDbLike,
  state: NonNullable<EntityState['consumptionAccumulator']> | undefined,
): Promise<void> => {
  if (!state || state.root === EMPTY_CONSUMPTION_ROOT) return;
  const store = getConsumptionNodeStore(env);
  const pending = [state.root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (visited.has(hash)) continue;
    visited.add(hash);
    let node = store.get(hash);
    if (!node) {
      const raw = await readRawOrNull(db, keyConsumptionNode(hash));
      if (!raw) throw new Error(`CONSUMPTION_NODE_MISSING:${hash}`);
      node = decodeValidatedBuffer(raw, validateConsumptionNodeValue);
      store.set(hash, node);
    }
    const actual = hashConsumptionNode(node);
    if (actual !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}:${actual}`);
    if (node.type === 'branch') pending.push(node.left, node.right);
  }
  collectReachableConsumptionNodes(store, [state]);
};

export const hydrateAccountJClaimRootNodesFromStorage = async (
  env: Env,
  db: RuntimeDbLike,
  states: readonly AccountJClaimAccumulatorState[],
): Promise<void> => {
  const store = getAccountJClaimNodeStore(env);
  const pending = states.filter((state) => state.root !== EMPTY_ACCOUNT_J_CLAIM_ROOT).map((state) => state.root);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (visited.has(hash)) continue;
    visited.add(hash);
    let node = store.get(hash);
    if (!node) {
      const raw = await readRawOrNull(db, keyAccountJClaimNode(hash));
      if (!raw) throw new Error(`ACCOUNT_J_CLAIM_NODE_MISSING:${hash}`);
      node = decodeValidatedBuffer(raw, validateAccountJClaimNodeValue);
      store.set(hash, node);
    }
    const actual = hashAccountJClaimNode(node);
    if (actual !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}:${actual}`);
    if (node.type === 'branch') pending.push(node.left, node.right);
  }
  collectReachableAccountJClaimNodes(store, states);
};

const hydrateEntityWithCertifiedBoardNodes = async (
  env: Env,
  db: RuntimeDbLike,
  core: StorageEntityCoreDoc,
  accounts: Map<string, StorageAccountDoc>,
  books: Map<string, BookState>,
): Promise<EntityState> => {
  const state = hydrateEntityStateFromStorage({ core, accounts, books });
  const root = state.certifiedBoardState?.boardRegistryRoot;
  await hydrateCertifiedBoardRootNodesFromStorage(env, db, root);
  await hydrateConsumptionRootNodesFromStorage(env, db, state.consumptionAccumulator);
  await hydrateAccountJClaimRootNodesFromStorage(
    env,
    db,
    Array.from(state.accounts.values()).flatMap((account) => [
      account.leftPendingJClaims,
      account.rightPendingJClaims,
    ]),
  );
  return state;
};

export type StoragePageQuery = {
  cursor?: string;
  limit?: number;
  sortDir?: 'asc' | 'desc';
};

export const readStorageHead = async (
  db: RuntimeDbLike,
): Promise<StorageHead | null> => {
  return readValidatedOrNull(db, KEY_HEAD, validateStorageHeadValue);
};

export const readStorageFrameRecord = async (
  db: RuntimeDbLike,
  height: number,
): Promise<StorageFrameRecord | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  const frame = await readValidatedOrNull(db, keyFrame(targetHeight), validateStorageFrameRecordValue);
  if (frame && frame.height !== targetHeight) {
    throw new Error(`STORAGE_FRAME_KEY_HEIGHT_MISMATCH:key=${targetHeight}:value=${frame.height}`);
  }
  return frame;
};

export const readStorageReplicaMeta = async (
  db: RuntimeDbLike,
  entityId: string,
  signerId: string,
): Promise<StorageReplicaMeta | null> => {
  const raw = await readRawOrNull(db, keyLiveReplicaMeta(entityId, signerId));
  if (!raw) return null;
  return validateEntityReplica(
    decodeBuffer<unknown>(raw),
    `StorageReplicaMeta[${entityId}:${signerId}]`,
  ) as StorageReplicaMeta;
};

const listReplicaMetas = async (
  db: RuntimeDbLike,
  entityId: string,
  prefix: Buffer,
  expectedKey: (entityId: string, signerId: string) => Buffer,
): Promise<StorageReplicaMeta[]> => {
  const metas: StorageReplicaMeta[] = [];
  const seenSigners = new Set<string>();
  const expectedEntityId = normalizeEntityId(entityId);
  for await (const key of iterateKeys(db, { prefix })) {
    const meta = validateEntityReplica(
      decodeBuffer<unknown>(await db.get(key)),
      `StorageReplicaMeta[0x${key.toString('hex')}]`,
    ) as StorageReplicaMeta;
    const metaEntityId = normalizeEntityId(String(meta.entityId || ''));
    const signerId = normalizeEntityId(String(meta.signerId || ''));
    if (!metaEntityId || metaEntityId !== expectedEntityId) {
      throw new Error(
        `STORAGE_REPLICA_META_ENTITY_KEY_MISMATCH:expected=${expectedEntityId}:actual=${metaEntityId || 'missing'}`,
      );
    }
    if (!signerId || !key.equals(expectedKey(metaEntityId, signerId))) {
      throw new Error(`STORAGE_REPLICA_META_KEY_BINDING_MISMATCH:entity=${metaEntityId}:signer=${signerId || 'missing'}`);
    }
    if (normalizeEntityId(String(meta.state?.entityId || '')) !== metaEntityId) {
      throw new Error(
        `STORAGE_REPLICA_META_STATE_ENTITY_MISMATCH:meta=${metaEntityId}:` +
        `state=${normalizeEntityId(String(meta.state?.entityId || '')) || 'missing'}`,
      );
    }
    if (seenSigners.has(signerId)) {
      throw new Error(`STORAGE_REPLICA_META_DUPLICATE_SIGNER:entity=${metaEntityId}:signer=${signerId}`);
    }
    seenSigners.add(signerId);
    const validators = meta.state?.config?.validators;
    if (!Array.isArray(validators) || !validators.some(validator => normalizeEntityId(validator) === signerId)) {
      throw new Error(`STORAGE_REPLICA_META_SIGNER_NOT_IN_BOARD:entity=${metaEntityId}:signer=${signerId}`);
    }
    metas.push(meta);
  }
  return metas.sort((left, right) => compareAscii(String(left.signerId || ''), String(right.signerId || '')));
};

export const listStorageReplicaMetas = async (
  db: RuntimeDbLike,
  entityId: string,
): Promise<StorageReplicaMeta[]> => listReplicaMetas(
  db,
  entityId,
  keyLiveReplicaMetaPrefix(entityId),
  keyLiveReplicaMeta,
);

export const listStorageSnapshotReplicaMetas = async (
  db: RuntimeDbLike,
  height: number,
  entityId: string,
): Promise<StorageReplicaMeta[]> => listReplicaMetas(
  db,
  entityId,
  keySnapshotReplicaMetaPrefix(height, entityId),
  (metaEntityId, signerId) => keySnapshotReplicaMeta(height, metaEntityId, signerId),
);

export const listStorageSnapshotHeights = async (db: RuntimeDbLike): Promise<number[]> => {
  return listSnapshotHeights(db);
};

const findLatestSnapshotAtOrBelow = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const head = await readStorageHead(db);
  const publishedHeight = Math.max(0, Math.floor(Number(head?.latestSnapshotHeight ?? 0)));
  const upperBound = Math.min(height, publishedHeight);
  const heights = await listSnapshotHeights(db);
  let best = 0;
  for (const value of heights) {
    if (value <= upperBound && value > best) best = value;
  }
  return best;
};

const storageVerifyDocHashesEnabled = (): boolean => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] ?? '' : '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
};

const storageVerifyMerkleMode = (): 'none' | 'deep' => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_VERIFY_MERKLE'] ?? '' : '')
    .trim()
    .toLowerCase();
  if (raw === 'deep' || raw === '1' || raw === 'true' || raw === 'yes') return 'deep';
  return 'none';
};

const hashRawDocValue = (value: Buffer | Uint8Array): string =>
  ethers.keccak256(value instanceof Uint8Array ? value : Uint8Array.from(value));

const assertLiveDocHash = async (options: {
  db: RuntimeDbLike;
  ref: StorageDocRef;
  raw: Buffer | Uint8Array;
  enabled: boolean;
}): Promise<void> => {
  if (!options.enabled) return;
  const key = docRefKey(options.ref);
  const entityId = normalizeEntityId(options.ref.entityId);
  const leafKeyHex = storageMerkleCellHexKey(docRefCellKey(options.ref));
  const leafKeyBytes = Buffer.from(leafKeyHex.slice(2), 'hex');
  const leafPath = radixMerklePathSlots(leafKeyBytes, DEFAULT_ACCOUNT_MERKLE_RADIX);
  const leaf = await readValidatedOrNull(
    options.db,
    keyMerkleLeaf(entityId, 'runtime-roots', packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, leafPath)),
    validateStorageMerkleLeafDocValue,
  );
  if (!leaf) throw new Error(`STORAGE_DOC_HASH_MISSING: ${key}`);
  const expected = String(leaf.valueHash || '');
  const actual = hashRawDocValue(options.raw);
  if (actual !== expected) {
    throw new Error(`STORAGE_DOC_HASH_MISMATCH: ${key} actual=${actual} expected=${expected}`);
  }
  const valueBytes = Buffer.from(expected.replace(/^0x/, ''), 'hex');
  const actualLeafHash = computeRadixMerkleLeafHash(leafKeyBytes, valueBytes);
  if (actualLeafHash !== leaf.hash) {
    throw new Error(`STORAGE_MERKLE_LEAF_HASH_MISMATCH: entity=${entityId} path=${leaf.path.join('.')}`);
  }
};

const assertLiveMerkleIntegrity = async (
  db: RuntimeDbLike,
  entityId: string,
  mode: 'none' | 'deep',
): Promise<void> => {
  if (mode === 'none') return;
  const normalized = normalizeEntityId(entityId);
  const root = await readValidatedOrNull(
    db,
    keyMerkleRoot(normalized, 'runtime-roots'),
    validateStorageMerkleRootDocValue,
  );
  if (!root) throw new Error(`STORAGE_MERKLE_ROOT_MISSING: entity=${normalized}`);

  let branchCount = 0;
  for await (const key of iterateKeys(db, { prefix: keyMerkleBranchPrefix(normalized, 'runtime-roots') })) {
    const branch = decodeValidatedBuffer(await db.get(key), validateStorageMerkleBranchDocValue);
    const actual = computeRadixMerkleBranchHash(
      branch.radix,
      branch.children.map((child) => [child.slot, child.hash]),
    );
    if (actual !== branch.hash) {
      throw new Error(`STORAGE_MERKLE_BRANCH_HASH_MISMATCH: entity=${normalized} path=${branch.path.join('.')}`);
    }
    branchCount += 1;
  }

  const leaves: Array<{ hexKey: string; value: Uint8Array }> = [];
  for await (const key of iterateKeys(db, { prefix: keyMerkleLeafPrefix(normalized, 'runtime-roots') })) {
    const leaf = decodeValidatedBuffer(await db.get(key), validateStorageMerkleLeafDocValue);
    const keyBytes = Buffer.from(String(leaf.key || '').replace(/^0x/, ''), 'hex');
    const valueBytes = Buffer.from(String(leaf.valueHash || '').replace(/^0x/, ''), 'hex');
    const actual = computeRadixMerkleLeafHash(keyBytes, valueBytes);
    if (actual !== leaf.hash) {
      throw new Error(`STORAGE_MERKLE_LEAF_HASH_MISMATCH: entity=${normalized} path=${leaf.path.join('.')}`);
    }
    leaves.push({ hexKey: leaf.key, value: valueBytes });
  }
  if (leaves.length !== root.leafCount) {
    throw new Error(`STORAGE_MERKLE_DEEP_LEAF_COUNT_MISMATCH: entity=${normalized} actual=${leaves.length} expected=${root.leafCount}`);
  }
  const rebuilt = buildHexKeyedMerkle(leaves, { radix: root.radix });
  if (rebuilt.root !== root.rootHash) {
    throw new Error(`STORAGE_MERKLE_DEEP_ROOT_MISMATCH: entity=${normalized} actual=${rebuilt.root} expected=${root.rootHash} branches=${branchCount}`);
  }
};

const readPageLimit = (query?: StoragePageQuery): number => {
  const raw = Number(query?.limit ?? 10);
  return Number.isFinite(raw) ? Math.max(1, Math.min(500, Math.floor(raw))) : 10;
};

const readAccountCursor = (query?: StoragePageQuery): string =>
  query?.cursor ? normalizeEntityId(query.cursor) : '';

const isAfterAccountCursor = (
  counterpartyId: string,
  cursor: string,
  direction: 'asc' | 'desc',
): boolean => !cursor || (direction === 'desc' ? counterpartyId < cursor : counterpartyId > cursor);

const pushAccountCandidate = (
  candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }>,
  seen: Set<string>,
  counterpartyId: string,
  doc: StorageAccountDoc,
  limit: number,
  direction: 'asc' | 'desc',
): void => {
  const normalized = normalizeEntityId(counterpartyId);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  const compare = (left: string, right: string): number =>
    direction === 'desc' ? compareAscii(right, left) : compareAscii(left, right);
  let insertAt = candidates.length;
  while (insertAt > 0 && compare(normalized, candidates[insertAt - 1]!.counterpartyId) < 0) {
    insertAt -= 1;
  }
  candidates.splice(insertAt, 0, { counterpartyId: normalized, doc });
  if (candidates.length > limit + 1) {
    const dropped = candidates.pop();
    if (dropped) seen.delete(dropped.counterpartyId);
  }
};

const accountPageFromCandidates = (
  candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }>,
  limit: number,
): StorageAccountDocPage => {
  const visible = candidates.slice(0, limit);
  return {
    items: visible.map((entry) => entry.doc),
    nextCursor: candidates.length > limit ? visible[visible.length - 1]?.counterpartyId ?? null : null,
  };
};

const parseSnapshotAccountKey = (key: Buffer): { entityId: string; counterpartyId: string } => ({
  entityId: decodeEntityId(key.subarray(9, 41)),
  counterpartyId: decodeEntityId(key.subarray(41, 73)),
});

const keySnapshotAccountCursor = (height: number, entityId: string, counterpartyId: string): Buffer =>
  Buffer.concat([keySnapshotAccountPrefix(height, entityId), hexBytes(counterpartyId)]);

const keySnapshotBookCursor = (height: number, entityId: string, pairId: string): Buffer =>
  Buffer.concat([keySnapshotBookPrefix(height, entityId), textBytes(pairId)]);

const listAccountPageFromKeyspace = async (options: {
  db: RuntimeDbLike;
  entityId: string;
  prefix: Buffer;
  cursorKey?: Buffer | undefined;
  parseKey: (key: Buffer) => { counterpartyId: string };
  cursor: string;
  limit: number;
  direction: 'asc' | 'desc';
  overlay?: Map<string, StorageAccountDoc | null>;
}): Promise<StorageAccountDocPage | null> => {
  const { db, prefix, parseKey, cursor, limit, direction, overlay } = options;
  if (typeof db.keys !== 'function') return null;
  const candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }> = [];
  const seen = new Set<string>();

  for (const [counterpartyId, doc] of overlay?.entries?.() ?? []) {
    if (!doc || !isAfterAccountCursor(counterpartyId, cursor, direction)) continue;
    pushAccountCandidate(candidates, seen, counterpartyId, doc, limit, direction);
  }

  const upperBound = prefixUpperBound(prefix);
  const range = direction === 'asc'
    ? (upperBound ? { gte: options.cursorKey ?? prefix, lt: upperBound } : { gte: options.cursorKey ?? prefix })
    : (upperBound
        ? { gte: prefix, lt: options.cursorKey ?? upperBound, reverse: true }
        : { prefix, reverse: true });
  for await (const key of iterateKeys(db, range)) {
    const { counterpartyId } = parseKey(key);
    const normalized = normalizeEntityId(counterpartyId);
    if (!isAfterAccountCursor(normalized, cursor, direction)) continue;
    if (overlay?.has(normalized)) continue;
    const doc = assertStorageAccountDocBinding(
      decodeValidatedBuffer(await db.get(key), validateStorageAccountDocValue),
      options.entityId,
      counterpartyId,
      'page',
    );
    pushAccountCandidate(candidates, seen, normalized, doc, limit, direction);
    const worst = candidates[candidates.length - 1]?.counterpartyId;
    if (direction === 'asc' && candidates.length > limit && worst && compareAscii(normalized, worst) >= 0) break;
    if (direction === 'desc' && candidates.length > limit && worst && compareAscii(normalized, worst) <= 0) break;
  }

  return accountPageFromCandidates(candidates, limit);
};

export const findStorageLatestSnapshotAtOrBelow = async (
  db: RuntimeDbLike,
  height: number,
): Promise<number> => {
  return findLatestSnapshotAtOrBelow(db, height);
};

export const listStorageLiveEntityIds = async (db: RuntimeDbLike): Promise<string[]> => {
  const ids: string[] = [];
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    ids.push(decodeEntityId(key.subarray(1, 33)));
  }
  return ids;
};

export const listStorageSnapshotEntityIds = async (
  db: RuntimeDbLike,
  height: number,
): Promise<string[]> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return [];
  const ids: string[] = [];
  for await (const key of iterateKeys(db, { prefix: keySnapshotEntityPrefix(targetHeight) })) {
    ids.push(decodeEntityId(key.subarray(9, 41)));
  }
  return ids;
};

const applyDocs = (
  target: Map<string, StorageDoc>,
  puts: StorageDoc[],
  dels: StorageDocRef[],
  entityId?: string,
): void => {
  const filterEntity = entityId ? normalizeEntityId(entityId) : null;
  for (const ref of dels) {
    if (filterEntity && normalizeEntityId(ref.entityId) !== filterEntity) continue;
    target.delete(docRefKey(ref));
  }
  for (const doc of puts) {
    if (filterEntity && normalizeEntityId(doc.entityId) !== filterEntity) continue;
    target.set(docValueKey(doc), doc);
  }
};

const readRequiredDiff = async (
  db: RuntimeDbLike,
  height: number,
  scope: string,
): Promise<StorageDiffRecord> => {
  const diff = await readValidatedOrNull(db, keyDiff(height), validateStorageDiffRecordValue);
  if (!diff) {
    throw new Error(`STORAGE_DIFF_MISSING: height=${height} scope=${scope}`);
  }
  if (diff.height !== height) {
    throw new Error(`STORAGE_DIFF_KEY_HEIGHT_MISMATCH:key=${height}:value=${diff.height}:scope=${scope}`);
  }
  return diff;
};

const resolveTargetStorageHeight = (
  head: StorageHead,
  requestedHeight: number | undefined,
  scope: string,
): number => {
  const latestHeight = Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));
  if (requestedHeight === undefined) return latestHeight;
  const raw = Number(requestedHeight);
  if (!Number.isFinite(raw)) {
    throw new Error(`STORAGE_HEIGHT_INVALID: scope=${scope} requested=${String(requestedHeight)}`);
  }
  const targetHeight = Math.floor(raw);
  if (targetHeight <= 0) return 0;
  if (targetHeight > latestHeight) {
    throw new Error(`STORAGE_HEIGHT_UNAVAILABLE: scope=${scope} requested=${targetHeight} latest=${latestHeight}`);
  }
  return targetHeight;
};

const loadSnapshotDocsForEntity = async (db: RuntimeDbLike, snapshotHeight: number, entityId: string): Promise<Map<string, StorageDoc>> => {
  const docs = new Map<string, StorageDoc>();

  const entityBuffer = assertEntityDocKeyBinding(await readValidatedOrNull(
    db,
    keySnapshotEntity(snapshotHeight, entityId),
    validateStorageEntityCoreDocValue,
  ), entityId, `snapshot:${snapshotHeight}`);
  if (entityBuffer) {
    docs.set(`e:${normalizeEntityId(entityId)}`, { family: 'entity', entityId: normalizeEntityId(entityId), value: entityBuffer });
  }

  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(snapshotHeight, entityId) })) {
    const entity = decodeEntityId(key.subarray(9, 41));
    const counterparty = decodeEntityId(key.subarray(41, 73));
    const value = assertStorageAccountDocBinding(
      decodeValidatedBuffer(await db.get(key), validateStorageAccountDocValue),
      entity,
      counterparty,
      `snapshot:${snapshotHeight}`,
    );
    docs.set(`a:${normalizeEntityId(entity)}:${normalizeEntityId(counterparty)}`, {
      family: 'account',
      entityId: normalizeEntityId(entity),
      counterpartyId: normalizeEntityId(counterparty),
      value,
    });
  }

  for await (const key of iterateKeys(db, { prefix: keySnapshotBookPrefix(snapshotHeight, entityId) })) {
    const parsed = parseLiveBookKey(key, 9);
    const value = decodeValidatedBuffer(await db.get(key), validateStorageBookDocValue);
    docs.set(`b:${normalizeEntityId(parsed.entityId)}:${parsed.pairId}`, {
      family: 'book',
      entityId: normalizeEntityId(parsed.entityId),
      pairId: parsed.pairId,
      value,
    });
  }

  return docs;
};

const loadSnapshotDocsAtHeight = async (
  db: RuntimeDbLike,
  snapshotHeight: number,
): Promise<Map<string, StorageDoc>> => {
  const docs = new Map<string, StorageDoc>();
  if (snapshotHeight <= 0) return docs;

  for await (const key of iterateKeys(db, { prefix: keySnapshotEntityPrefix(snapshotHeight) })) {
    const entityId = decodeEntityId(key.subarray(9, 41));
    const value = assertStorageEntityDocBinding(
      decodeValidatedBuffer(await db.get(key), validateStorageEntityCoreDocValue),
      entityId,
      `snapshot:${snapshotHeight}`,
    );
    if (value) docs.set(`e:${normalizeEntityId(entityId)}`, { family: 'entity', entityId, value });
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(snapshotHeight) })) {
    const { entityId, counterpartyId } = parseSnapshotAccountKey(key);
    const value = assertStorageAccountDocBinding(
      decodeValidatedBuffer(await db.get(key), validateStorageAccountDocValue),
      entityId,
      counterpartyId,
      `snapshot:${snapshotHeight}`,
    );
    docs.set(`a:${normalizeEntityId(entityId)}:${normalizeEntityId(counterpartyId)}`, {
      family: 'account', entityId, counterpartyId, value,
    });
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotBookPrefix(snapshotHeight) })) {
    const { entityId, pairId } = parseLiveBookKey(key, 9);
    docs.set(`b:${normalizeEntityId(entityId)}:${pairId}`, {
      family: 'book',
      entityId,
      pairId,
      value: decodeValidatedBuffer(await db.get(key), validateStorageBookDocValue),
    });
  }
  return docs;
};

const hydrateEntityStatesFromDocs = async (
  env: Env,
  db: RuntimeDbLike,
  docs: Map<string, StorageDoc>,
): Promise<Map<string, EntityState>> => {
  const cores = new Map<string, StorageEntityCoreDoc>();
  const accounts = new Map<string, Map<string, StorageAccountDoc>>();
  const books = new Map<string, Map<string, BookState>>();
  for (const doc of docs.values()) {
    const entityId = normalizeEntityId(doc.entityId);
    if (doc.family === 'entity') {
      cores.set(entityId, doc.value);
    } else if (doc.family === 'account') {
      const entityAccounts = accounts.get(entityId) ?? new Map<string, StorageAccountDoc>();
      assertEntityAccountInsertionCapacity(entityAccounts, doc.counterpartyId, `storage.bulk:${entityId}`);
      entityAccounts.set(normalizeEntityId(doc.counterpartyId), doc.value);
      accounts.set(entityId, entityAccounts);
    } else {
      const entityBooks = books.get(entityId) ?? new Map<string, BookState>();
      entityBooks.set(doc.pairId, doc.value);
      books.set(entityId, entityBooks);
    }
  }

  const states = new Map<string, EntityState>();
  for (const [entityId, core] of Array.from(cores.entries()).sort(([left], [right]) => compareAscii(left, right))) {
    states.set(entityId, await hydrateEntityWithCertifiedBoardNodes(
      env,
      db,
      core,
      accounts.get(entityId) ?? new Map(),
      books.get(entityId) ?? new Map(),
    ));
  }
  return states;
};

const loadEntityCoreDocAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  liveStateReadable = true,
): Promise<StorageEntityCoreDoc | null> => {
  const normalized = normalizeEntityId(entityId);
  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    return assertEntityDocKeyBinding(
      await readValidatedOrNull(db, keyLiveEntity(normalized), validateStorageEntityCoreDocValue),
      normalized,
      'live',
    );
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  let core = baseSnapshotHeight > 0
    ? await readValidatedOrNull(
        db,
        keySnapshotEntity(baseSnapshotHeight, normalized),
        validateStorageEntityCoreDocValue,
      )
    : null;
  core = assertEntityDocKeyBinding(core, normalized, `snapshot:${baseSnapshotHeight}`);
  for (let cursor = baseSnapshotHeight + 1; cursor <= targetHeight; cursor += 1) {
    const diff = await readRequiredDiff(db, cursor, `entity:${normalized}`);
    for (const ref of diff.dels) {
      if (ref.family === 'entity' && normalizeEntityId(ref.entityId) === normalized) core = null;
    }
    for (const doc of diff.puts) {
      if (doc.family === 'entity' && normalizeEntityId(doc.entityId) === normalized) core = doc.value;
    }
  }
  return core;
};

const collectHistoricalAccountOverlay = async (
  db: RuntimeDbLike,
  entityId: string,
  fromHeightExclusive: number,
  toHeight: number,
): Promise<Map<string, StorageAccountDoc | null>> => {
  const normalized = normalizeEntityId(entityId);
  const overlay = new Map<string, StorageAccountDoc | null>();
  for (let height = fromHeightExclusive + 1; height <= toHeight; height += 1) {
    const diff = await readRequiredDiff(db, height, `accounts:${normalized}`);
    for (const ref of diff.dels) {
      if (ref.family === 'account' && normalizeEntityId(ref.entityId) === normalized) {
        overlay.set(normalizeEntityId(ref.counterpartyId), null);
      }
    }
    for (const doc of diff.puts) {
      if (doc.family === 'account' && normalizeEntityId(doc.entityId) === normalized) {
        overlay.set(normalizeEntityId(doc.counterpartyId), doc.value);
      }
    }
  }
  return overlay;
};

const loadAccountDocPageAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  query?: StoragePageQuery,
  liveStateReadable = true,
): Promise<StorageAccountDocPage | null> => {
  const normalized = normalizeEntityId(entityId);
  const limit = readPageLimit(query);
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';
  const cursor = readAccountCursor(query);

  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    const prefix = keyLiveAccountPrefix(normalized);
    return listAccountPageFromKeyspace({
      db,
      entityId: normalized,
      prefix,
      cursorKey: cursor ? keyLiveAccount(normalized, cursor) : undefined,
      parseKey: parseLiveAccountKey,
      cursor,
      limit,
      direction,
    });
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const overlay = await collectHistoricalAccountOverlay(db, normalized, baseSnapshotHeight, targetHeight);
  if (baseSnapshotHeight <= 0) {
    const candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }> = [];
    const seen = new Set<string>();
    for (const [counterpartyId, doc] of overlay.entries()) {
      if (!doc || !isAfterAccountCursor(counterpartyId, cursor, direction)) continue;
      pushAccountCandidate(candidates, seen, counterpartyId, doc, limit, direction);
    }
    return accountPageFromCandidates(candidates, limit);
  }
  const prefix = keySnapshotAccountPrefix(baseSnapshotHeight, normalized);
  return listAccountPageFromKeyspace({
    db,
    entityId: normalized,
    prefix,
    cursorKey: cursor ? keySnapshotAccountCursor(baseSnapshotHeight, normalized, cursor) : undefined,
    parseKey: parseSnapshotAccountKey,
    cursor,
    limit,
    direction,
    overlay,
  });
};

const loadAccountDocAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  liveStateReadable = true,
): Promise<StorageAccountDoc | null> => {
  const normalized = normalizeEntityId(entityId);
  const counterparty = normalizeEntityId(counterpartyId);

  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    const raw = await readRawOrNull(db, keyLiveAccount(normalized, counterparty));
    if (!raw) return null;
    await assertLiveDocHash({
      db,
      ref: { family: 'account', entityId: normalized, counterpartyId: counterparty },
      raw,
      enabled: storageVerifyDocHashesEnabled(),
    });
    return assertStorageAccountDocBinding(
      decodeValidatedBuffer(raw, validateStorageAccountDocValue),
      normalized,
      counterparty,
      'live',
    );
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  let doc = baseSnapshotHeight > 0
    ? await readValidatedOrNull(
        db,
        keySnapshotAccountCursor(baseSnapshotHeight, normalized, counterparty),
        validateStorageAccountDocValue,
      )
    : null;
  if (doc) {
    doc = assertStorageAccountDocBinding(doc, normalized, counterparty, `snapshot:${baseSnapshotHeight}`);
  }
  for (let height = baseSnapshotHeight + 1; height <= targetHeight; height += 1) {
    const diff = await readRequiredDiff(db, height, `account:${normalized}:${counterparty}`);
    for (const ref of diff.dels) {
      if (
        ref.family === 'account' &&
        normalizeEntityId(ref.entityId) === normalized &&
        normalizeEntityId(ref.counterpartyId) === counterparty
      ) {
        doc = null;
      }
    }
    for (const item of diff.puts) {
      if (
        item.family === 'account' &&
        normalizeEntityId(item.entityId) === normalized &&
        normalizeEntityId(item.counterpartyId) === counterparty
      ) {
        doc = item.value;
      }
    }
  }
  return doc;
};

const readBookCursor = (query?: StoragePageQuery): string =>
  String(query?.cursor || '').trim();

const compareBookPairKeyOrder = (left: string, right: string): number => {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return leftBytes.length < rightBytes.length ? -1 : 1;
  return Buffer.compare(leftBytes, rightBytes);
};

const isAfterBookCursor = (
  pairId: string,
  cursor: string,
  direction: 'asc' | 'desc',
): boolean => {
  if (!cursor) return true;
  const order = compareBookPairKeyOrder(pairId, cursor);
  return direction === 'desc' ? order < 0 : order > 0;
};

const pushBookCandidate = (
  candidates: Array<{ pairId: string; book: BookState }>,
  seen: Set<string>,
  pairId: string,
  book: BookState,
  limit: number,
  direction: 'asc' | 'desc',
): void => {
  if (seen.has(pairId)) return;
  seen.add(pairId);
  const compare = (left: string, right: string): number =>
    direction === 'desc' ? compareBookPairKeyOrder(right, left) : compareBookPairKeyOrder(left, right);
  let insertAt = candidates.length;
  while (insertAt > 0 && compare(pairId, candidates[insertAt - 1]!.pairId) < 0) {
    insertAt -= 1;
  }
  candidates.splice(insertAt, 0, { pairId, book });
  if (candidates.length > limit + 1) {
    const dropped = candidates.pop();
    if (dropped) seen.delete(dropped.pairId);
  }
};

const bookPageFromCandidates = (
  candidates: Array<{ pairId: string; book: BookState }>,
  limit: number,
): StorageBookDocPage => {
  const visible = candidates.slice(0, limit);
  return {
    items: visible.map((entry) => ({ pairId: entry.pairId, book: entry.book })),
    nextCursor: candidates.length > limit ? visible[visible.length - 1]?.pairId ?? null : null,
  };
};

const listBookPageFromKeyspace = async (options: {
  db: RuntimeDbLike;
  prefix: Buffer;
  cursorKey?: Buffer | undefined;
  parseKey: (key: Buffer) => { pairId: string };
  cursor: string;
  limit: number;
  direction: 'asc' | 'desc';
  overlay?: Map<string, BookState | null>;
}): Promise<StorageBookDocPage | null> => {
  const { db, prefix, parseKey, cursor, limit, direction, overlay } = options;
  if (typeof db.keys !== 'function') return null;
  const candidates: Array<{ pairId: string; book: BookState }> = [];
  const seen = new Set<string>();

  for (const [pairId, book] of overlay?.entries?.() ?? []) {
    if (!book || !isAfterBookCursor(pairId, cursor, direction)) continue;
    pushBookCandidate(candidates, seen, pairId, book, limit, direction);
  }

  const upperBound = prefixUpperBound(prefix);
  const range = direction === 'asc'
    ? (upperBound ? { gte: options.cursorKey ?? prefix, lt: upperBound } : { gte: options.cursorKey ?? prefix })
    : (upperBound
        ? { gte: prefix, lt: options.cursorKey ?? upperBound, reverse: true }
        : { prefix, reverse: true });
  for await (const key of iterateKeys(db, range)) {
    const { pairId } = parseKey(key);
    if (!isAfterBookCursor(pairId, cursor, direction)) continue;
    if (overlay?.has(pairId)) continue;
    const book = decodeValidatedBuffer(await db.get(key), validateStorageBookDocValue);
    pushBookCandidate(candidates, seen, pairId, book, limit, direction);
    const worst = candidates[candidates.length - 1]?.pairId;
    if (!worst || candidates.length <= limit) continue;
    const order = compareBookPairKeyOrder(pairId, worst);
    if (direction === 'asc' && order >= 0) break;
    if (direction === 'desc' && order <= 0) break;
  }

  return bookPageFromCandidates(candidates, limit);
};

const loadBookDocPageAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  query?: StoragePageQuery,
  liveStateReadable = true,
): Promise<StorageBookDocPage> => {
  const normalized = normalizeEntityId(entityId);
  const limit = readPageLimit(query);
  const cursor = readBookCursor(query);
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';

  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    const page = await listBookPageFromKeyspace({
      db,
      prefix: keyLiveBookPrefix(normalized),
      cursorKey: cursor ? keyLiveBook(normalized, cursor) : undefined,
      parseKey: (key) => parseLiveBookKey(key),
      cursor,
      limit,
      direction,
    });
    if (page) return page;
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const overlay = new Map<string, BookState | null>();
  for (let height = baseSnapshotHeight + 1; height <= targetHeight; height += 1) {
    const diff = await readRequiredDiff(db, height, `books:${normalized}`);
    for (const ref of diff.dels) {
      if (ref.family === 'book' && normalizeEntityId(ref.entityId) === normalized) overlay.set(ref.pairId, null);
    }
    for (const doc of diff.puts) {
      if (doc.family === 'book' && normalizeEntityId(doc.entityId) === normalized) overlay.set(doc.pairId, doc.value);
    }
  }

  if (baseSnapshotHeight > 0) {
    const page = await listBookPageFromKeyspace({
      db,
      prefix: keySnapshotBookPrefix(baseSnapshotHeight, normalized),
      cursorKey: cursor ? keySnapshotBookCursor(baseSnapshotHeight, normalized, cursor) : undefined,
      parseKey: (key) => parseLiveBookKey(key, 9),
      cursor,
      limit,
      direction,
      overlay,
    });
    if (page) return page;
  }

  const candidates: Array<{ pairId: string; book: BookState }> = [];
  const seen = new Set<string>();
  for (const [pairId, book] of overlay.entries()) {
    if (!book || !isAfterBookCursor(pairId, cursor, direction)) continue;
    pushBookCandidate(candidates, seen, pairId, book, limit, direction);
  }
  return bookPageFromCandidates(candidates, limit);
};

export const loadEntityViewPageFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
  accountQuery?: StoragePageQuery;
  bookQuery?: StoragePageQuery;
  liveStateReadable?: boolean;
}): Promise<StorageEntityViewPage | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readStorageHead(db);
  if (!head) return null;
  const targetHeight = resolveTargetStorageHeight(head, options.height, `entity-view:${normalizeEntityId(options.entityId)}`);
  const entityId = normalizeEntityId(options.entityId);
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );

  const liveStateReadable = options.liveStateReadable !== false;
  const core = await loadEntityCoreDocAtHeight(db, entityId, targetHeight, latestMaterializedHeight, liveStateReadable);
  if (!core) return null;
  const accounts = await loadAccountDocPageAtHeight(
    db,
    entityId,
    targetHeight,
    latestMaterializedHeight,
    options.accountQuery,
    liveStateReadable,
  );
  if (!accounts) return null;
  const books = await loadBookDocPageAtHeight(
    db,
    entityId,
    targetHeight,
    latestMaterializedHeight,
    options.bookQuery,
    liveStateReadable,
  );
  return { core, accounts, books };
};

export const loadEntityAccountDocFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  counterpartyId: string;
  height?: number;
  liveStateReadable?: boolean;
}): Promise<StorageAccountDoc | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readStorageHead(db);
  if (!head) return null;
  const targetHeight = resolveTargetStorageHeight(
    head,
    options.height,
    `account:${normalizeEntityId(options.entityId)}:${normalizeEntityId(options.counterpartyId)}`,
  );
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );
  return loadAccountDocAtHeight(
    db,
    options.entityId,
    options.counterpartyId,
    targetHeight,
    latestMaterializedHeight,
    options.liveStateReadable !== false,
  );
};

export const loadEntityStateFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
  liveStateReadable?: boolean;
}): Promise<EntityState | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readStorageHead(db);
  if (!head) return null;
  const targetHeight = resolveTargetStorageHeight(head, options.height, `entity-state:${normalizeEntityId(options.entityId)}`);
  const entityId = normalizeEntityId(options.entityId);
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );

  if (options.liveStateReadable !== false && targetHeight === latestMaterializedHeight) {
    const verifyDocHashes = storageVerifyDocHashesEnabled();
    const verifyMerkleMode = storageVerifyMerkleMode();
    const entityRaw = await readRawOrNull(db, keyLiveEntity(entityId));
    if (!entityRaw) return null;
    await assertLiveDocHash({
      db,
      ref: { family: 'entity', entityId },
      raw: entityRaw,
      enabled: verifyDocHashes,
    });
    const entityCore = assertStorageEntityDocBinding(
      decodeValidatedBuffer(entityRaw, validateStorageEntityCoreDocValue),
      entityId,
      'live-state',
    );
    if (!entityCore) return null;
    const accounts = new Map<string, StorageAccountDoc>();
    for await (const key of iterateKeys(db, { prefix: keyLiveAccountPrefix(entityId) })) {
      const parsed = parseLiveAccountKey(key);
      const raw = await db.get(key);
      await assertLiveDocHash({
        db,
        ref: { family: 'account', entityId: parsed.entityId, counterpartyId: parsed.counterpartyId },
        raw,
        enabled: verifyDocHashes,
      });
      const doc = assertStorageAccountDocBinding(
        decodeValidatedBuffer(raw, validateStorageAccountDocValue),
        parsed.entityId,
        parsed.counterpartyId,
        'live-state',
      );
      assertEntityAccountInsertionCapacity(
        accounts,
        parsed.counterpartyId,
        `storage.live:${entityId}`,
      );
      accounts.set(parsed.counterpartyId, doc);
    }
    const books = new Map<string, BookState>();
    for await (const key of iterateKeys(db, { prefix: keyLiveBookPrefix(entityId) })) {
      const parsed = parseLiveBookKey(key);
      const raw = await db.get(key);
      await assertLiveDocHash({
        db,
        ref: { family: 'book', entityId: parsed.entityId, pairId: parsed.pairId },
        raw,
        enabled: verifyDocHashes,
      });
      books.set(parsed.pairId, decodeValidatedBuffer(raw, validateStorageBookDocValue));
    }
    await assertLiveMerkleIntegrity(db, entityId, verifyMerkleMode);
    return hydrateEntityWithCertifiedBoardNodes(options.env, db, entityCore, accounts, books);
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const docs = baseSnapshotHeight > 0
    ? await loadSnapshotDocsForEntity(db, baseSnapshotHeight, entityId)
    : new Map<string, StorageDoc>();

  let cursor = baseSnapshotHeight + 1;
  while (cursor <= targetHeight) {
    const diff = await readRequiredDiff(db, cursor, `entity-state:${entityId}`);
    applyDocs(docs, diff.puts, diff.dels, entityId);
    cursor += 1;
  }

  const core = docs.get(`e:${entityId}`) as Extract<StorageDoc, { family: 'entity' }> | undefined;
  if (!core) return null;
  const accounts = new Map<string, StorageAccountDoc>();
  const books = new Map<string, BookState>();
  for (const doc of docs.values()) {
    if (doc.family === 'account' && normalizeEntityId(doc.entityId) === entityId) {
      assertEntityAccountInsertionCapacity(
        accounts,
        doc.counterpartyId,
        `storage.snapshot:${entityId}`,
      );
      accounts.set(doc.counterpartyId, doc.value);
    } else if (doc.family === 'book' && normalizeEntityId(doc.entityId) === entityId) {
      books.set(doc.pairId, doc.value);
    }
  }

  return hydrateEntityWithCertifiedBoardNodes(options.env, db, core.value, accounts, books);
};

export const loadEntityStatesAtHeightFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  height?: number;
}): Promise<Map<string, EntityState>> => {
  if (!(await options.tryOpenDb(options.env))) return new Map();
  const db = options.getRuntimeDb(options.env);
  const head = await readStorageHead(db);
  if (!head) return new Map();
  const targetHeight = resolveTargetStorageHeight(head, options.height, 'entity-states');
  if (targetHeight <= 0) return new Map();

  const snapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const docs = await loadSnapshotDocsAtHeight(db, snapshotHeight);
  for (let height = snapshotHeight + 1; height <= targetHeight; height += 1) {
    const diff = await readRequiredDiff(db, height, 'entity-states');
    applyDocs(docs, diff.puts, diff.dels);
  }
  return hydrateEntityStatesFromDocs(options.env, db, docs);
};
