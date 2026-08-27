import type { BookState } from '../../orderbook';
import type { EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { decodeBuffer, decodeValidatedBuffer } from '../codec/codec';
import { readBoundedValidatedValue } from '../codec/bounded-value';
import {
  KEY_LIVE_ACCOUNT,
  KEY_HEAD,
  KEY_LIVE_ENTITY,
  decodeEntityId,
  hexBytes,
  keyCertifiedBoardNodePrefix,
  keyCertifiedBoardPathNode,
  keyAccountJClaimNodePrefix,
  keyAccountJClaimPathNode,
  keySnapshotGraphPrefix,
  parseSnapshotGraphKey,
  keyFrame,
  keyLiveAccount,
  keyLiveAccountPrefix,
  keyLiveBook,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyLiveReplicaMeta,
  keyLiveReplicaMetaPrefix,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntityPrefix,
  keySnapshotReplicaMeta,
  keySnapshotReplicaMetaPrefix,
  normalizeEntityId,
  parseLiveAccountKey,
  parseLiveBookKey,
  parseSnapshotAccountKey,
  parseSnapshotEntityKey,
  prefixUpperBound,
  textBytes,
} from '../keys';
import { readAccountStorageLayout } from '../schema/account-layout';
import { readEntityStorageLayout } from '../schema/entity/layout';
import {
  createSnapshotAccountGraphView,
  createSnapshotEntityGraphView,
} from '../database/snapshot-graph-view';
import { iterateKeys, readValidatedOrNull } from '../database/level';
import { listSnapshotHeights } from '../database/lifecycle';
import { compareAscii } from '../../support/collections/sorted-map-index';
import { hydrateEntityStateFromStorage } from './projections';
import { requireStorageDbOpen } from '../commit/availability';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  getCertifiedBoardNodeStore,
  hashCertifiedBoardNode,
} from '../../jurisdiction/machine/board-registry';
import {
  EMPTY_ACCOUNT_J_CLAIM_ROOT,
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
  type AccountJClaimAccumulatorState,
  type AccountJClaimNode,
} from '../../account/j-claims/j-claim-accumulator';
import { getAccountJClaimNodeStore } from '../../entity/account/account-j-claim-node-store';
import { validateStorageReplicaMeta } from '../replica/replica-meta-validation';
import {
  assertStorageAccountDocBinding,
  assertStorageEntityDocBinding,
  validatePersistedAccountJClaimPathNode,
  validatePersistedCertifiedBoardPathNode,
  validateStorageAccountDocValue,
  validateStorageFrameRecordValue,
  validateStorageHeadValue,
} from '../schema/authoritative-schema';
import { readSnapshotBookGraph, readStorageBookGraph } from './book-graph';
import { readRuntimeOutputRows } from '../wal/outbox-payload';
import { readEntityContextPayloads } from '../wal/entity-context-payload';
import { readRuntimeMachineGraph } from '../wal/runtime-machine-graph';
import type {
  RuntimeDbLike,
  RuntimeFrame,
  RuntimeFramePayloads,
  StorageAccountDoc,
  StorageDoc,
  StorageEntityCoreDoc,
  StorageHead,
  StorageReplicaMeta,
} from '../types';

type StorageAccountDocPage = {
  items: StorageAccountDoc[];
  nextCursor: string | null;
};

type StorageBookDocPage = {
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

type StoredBinaryPatriciaNode =
  | Readonly<{ type: 'leaf'; key: string }>
  | Readonly<{ type: 'branch'; bit: number; left: string; right: string }>;

type PathNodeGroup<TNode extends StoredBinaryPatriciaNode> = Readonly<{
  scope: Buffer;
  nodes: Map<string, TNode>;
  keys: Map<string, Buffer>;
}>;

const readPathNodeGroups = async <TNode extends StoredBinaryPatriciaNode>(options: {
  db: RuntimeDbLike;
  livePrefix: Buffer;
  scopeBytes: number;
  snapshotHeight?: number;
  validate: (value: unknown) => Readonly<{ hash: string; node: TNode }>;
  hashNode: (node: TNode) => string;
  code: string;
}): Promise<PathNodeGroup<TNode>[]> => {
  const physicalPrefix = options.snapshotHeight === undefined
    ? options.livePrefix
    : keySnapshotGraphPrefix(options.snapshotHeight, options.livePrefix);
  const groups = new Map<string, { scope: Buffer; nodes: Map<string, TNode>; keys: Map<string, Buffer> }>();
  for await (const physicalKey of iterateKeys(options.db, { prefix: physicalPrefix })) {
    const liveKey = options.snapshotHeight === undefined
      ? physicalKey
      : parseSnapshotGraphKey(physicalKey).liveKey;
    if (liveKey.byteLength <= options.scopeBytes || liveKey[0] !== options.livePrefix[0]) {
      throw new Error(`${options.code}_KEY_INVALID:${liveKey.toString('hex')}`);
    }
    const scope = liveKey.subarray(0, options.scopeBytes);
    const scopeHex = scope.toString('hex');
    const group = groups.get(scopeHex) ?? {
      scope,
      nodes: new Map<string, TNode>(),
      keys: new Map<string, Buffer>(),
    };
    const row = decodeValidatedBuffer(await options.db.get(physicalKey), options.validate);
    const actual = options.hashNode(row.node);
    if (actual !== row.hash) throw new Error(`${options.code}_CORRUPT:${row.hash}:${actual}`);
    const previous = group.nodes.get(row.hash);
    if (previous) throw new Error(`${options.code}_DUPLICATE_HASH:${row.hash}`);
    group.nodes.set(row.hash, row.node);
    group.keys.set(row.hash, liveKey);
    groups.set(scopeHex, group);
  }
  return [...groups.values()].sort((left, right) => Buffer.compare(left.scope, right.scope));
};

const hydratePathNodeRoot = <TNode extends StoredBinaryPatriciaNode>(options: {
  groups: readonly PathNodeGroup<TNode>[];
  root: string;
  target: Map<string, TNode>;
  keyForPath: (scope: Buffer, path: Readonly<
    { kind: 'leaf'; key: string } | { kind: 'branch'; bit: number; representativeKey: string }
  >) => Buffer;
  hashNode: (node: TNode) => string;
  code: string;
}): void => {
  const group = options.groups.find(candidate => candidate.nodes.has(options.root));
  if (!group) throw new Error(`${options.code}_MISSING:${options.root}`);
  const stack = new Set<string>();
  const reached = new Set<string>();
  const visit = (hash: string, previousBit: number): string => {
    if (stack.has(hash)) throw new Error(`${options.code}_CYCLE:${hash}`);
    const node = group.nodes.get(hash);
    if (!node) throw new Error(`${options.code}_MISSING:${hash}`);
    const actual = options.hashNode(node);
    if (actual !== hash) throw new Error(`${options.code}_CORRUPT:${hash}:${actual}`);
    reached.add(hash);
    stack.add(hash);
    try {
      let representativeKey: string;
      const path = node.type === 'leaf'
        ? { kind: 'leaf' as const, key: node.key }
        : (() => {
            if (!Number.isSafeInteger(node.bit) || node.bit <= previousBit || node.bit > 255) {
              throw new Error(`${options.code}_BRANCH_ORDER_INVALID:${previousBit}:${String(node.bit)}`);
            }
            representativeKey = visit(node.left, node.bit);
            const rightKey = visit(node.right, node.bit);
            const bitAt = (key: string): number => {
              const offset = 2 + Math.floor(node.bit / 8) * 2;
              const byte = Number.parseInt(key.slice(offset, offset + 2), 16);
              return (byte >> (7 - (node.bit % 8))) & 1;
            };
            if (bitAt(representativeKey) !== 0 || bitAt(rightKey) !== 1) {
              throw new Error(`${options.code}_BRANCH_DIRECTION_INVALID:${node.bit}`);
            }
            return { kind: 'branch' as const, bit: node.bit, representativeKey };
          })();
      const storedKey = group.keys.get(hash);
      const expectedKey = options.keyForPath(group.scope, path);
      if (!storedKey?.equals(expectedKey)) {
        throw new Error(
          `${options.code}_PATH_MISMATCH:${hash}:` +
          `stored=${storedKey?.toString('hex') ?? 'missing'}:expected=${expectedKey.toString('hex')}`,
        );
      }
      options.target.set(hash, node);
      return node.type === 'leaf' ? node.key : representativeKey!;
    } finally {
      stack.delete(hash);
    }
  };
  visit(options.root, -1);
  if (reached.size !== group.nodes.size) {
    throw new Error(`${options.code}_UNREACHABLE:${group.nodes.size - reached.size}`);
  }
};

export const hydrateCertifiedBoardRootNodesFromStorage = async (
  env: RuntimeReplica,
  db: RuntimeDbLike,
  root: string | undefined,
  snapshotHeight?: number,
): Promise<void> => {
  if (!root || root === EMPTY_CERTIFIED_BOARD_ROOT) return;
  const groups = await readPathNodeGroups({
    db,
    livePrefix: keyCertifiedBoardNodePrefix(),
    scopeBytes: 33,
    ...(snapshotHeight === undefined ? {} : { snapshotHeight }),
    validate: validatePersistedCertifiedBoardPathNode,
    hashNode: hashCertifiedBoardNode,
    code: 'CERTIFIED_BOARD_PATH_NODE',
  });
  hydratePathNodeRoot({
    groups,
    root,
    target: getCertifiedBoardNodeStore(env),
    keyForPath: (scope, path) => keyCertifiedBoardPathNode(decodeEntityId(scope.subarray(1)), path),
    hashNode: hashCertifiedBoardNode,
    code: 'CERTIFIED_BOARD_PATH_NODE',
  });
};

export const hydrateAccountJClaimRootNodesFromStorage = async (
  env: RuntimeReplica,
  db: RuntimeDbLike,
  states: readonly AccountJClaimAccumulatorState[],
  snapshotHeight?: number,
): Promise<void> => {
  const groups = await readPathNodeGroups({
    db,
    livePrefix: keyAccountJClaimNodePrefix(),
    scopeBytes: 66,
    ...(snapshotHeight === undefined ? {} : { snapshotHeight }),
    validate: validatePersistedAccountJClaimPathNode,
    hashNode: hashAccountJClaimNode,
    code: 'ACCOUNT_J_CLAIM_PATH_NODE',
  });
  const store = getAccountJClaimNodeStore(env) as Map<string, AccountJClaimNode>;
  for (const state of states) {
    if (state.root === EMPTY_ACCOUNT_J_CLAIM_ROOT) continue;
    hydratePathNodeRoot({
      groups,
      root: state.root,
      target: store,
      keyForPath: (scope, path) => {
        const side = scope[65];
        if (side !== 0 && side !== 1) throw new Error('ACCOUNT_J_CLAIM_PATH_NODE_SIDE_INVALID');
        return keyAccountJClaimPathNode(
          decodeEntityId(scope.subarray(1, 33)),
          decodeEntityId(scope.subarray(33, 65)),
          side,
          path,
        );
      },
      hashNode: hashAccountJClaimNode,
      code: 'ACCOUNT_J_CLAIM_PATH_NODE',
    });
  }
  collectReachableAccountJClaimNodes(store, states);
};

const hydrateEntityWithCertifiedBoardNodes = async (
  env: RuntimeReplica,
  db: RuntimeDbLike,
  core: StorageEntityCoreDoc,
  accounts: Map<string, StorageAccountDoc>,
  books: Map<string, BookState>,
  snapshotHeight?: number,
): Promise<EntityState> => {
  const state = hydrateEntityStateFromStorage({ core, accounts, books });
  const root = state.certifiedBoardState?.boardRegistryRoot;
  await hydrateCertifiedBoardRootNodesFromStorage(env, db, root, snapshotHeight);
  await hydrateAccountJClaimRootNodesFromStorage(
    env,
    db,
    Array.from(state.accounts.values()).flatMap((account) => [
      account.state.leftPendingJClaims,
      account.state.rightPendingJClaims,
    ]),
    snapshotHeight,
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
): Promise<RuntimeFrame | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  const frame = await readBoundedValidatedValue(
    db,
    keyFrame(targetHeight),
    validateStorageFrameRecordValue,
  );
  if (frame && frame.height !== targetHeight) {
    throw new Error(`STORAGE_FRAME_KEY_HEIGHT_MISMATCH:key=${targetHeight}:value=${frame.height}`);
  }
  return frame;
};

export const readStorageFramePayloads = async (
  db: RuntimeDbLike,
  frame: RuntimeFrame,
  options?: { includeRuntimeMachine?: boolean },
): Promise<RuntimeFramePayloads> => {
  const targetHeight = frame.height;
  const runtimeOutputs = await readRuntimeOutputRows(db, targetHeight, {
    count: frame.runtimeOutputCount,
    digest: frame.runtimeOutputsDigest,
  });
  const entityContexts = frame.entityContextRefs?.size
    ? await readEntityContextPayloads(
      db,
      targetHeight,
      frame.entityContextRefs,
    )
    : new Map();
  const runtimeMachine = options?.includeRuntimeMachine !== false && frame.runtimeMachineRoot
    ? await readRuntimeMachineGraph(
      db,
      targetHeight,
      frame.runtimeMachineRoot,
    )
    : undefined;
  const payloads: RuntimeFramePayloads = {
    entityContexts,
    ...(runtimeOutputs.length > 0 ? { runtimeOutputs } : {}),
    ...(runtimeMachine ? { runtimeMachine } : {}),
  };
  return payloads;
};

const listReplicaMetas = async (
  db: RuntimeDbLike,
  entityId: string,
  prefix: Buffer,
  expectedKey: (entityId: string, signerId: string) => Buffer,
  sharedState?: EntityState,
): Promise<StorageReplicaMeta[]> => {
  const metas: StorageReplicaMeta[] = [];
  const seenSigners = new Set<string>();
  const expectedEntityId = normalizeEntityId(entityId);
  for await (const key of iterateKeys(db, { prefix })) {
    const decoded = decodeBuffer(await db.get(key));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error(`STORAGE_REPLICA_META_RECORD_REQUIRED:0x${key.toString('hex')}`);
    }
    if (Object.hasOwn(decoded, 'state')) {
      throw new Error(`STORAGE_REPLICA_META_STATE_BLOB_FORBIDDEN:0x${key.toString('hex')}`);
    }
    if (!sharedState) {
      throw new Error(`STORAGE_REPLICA_META_SHARED_STATE_REQUIRED:0x${key.toString('hex')}`);
    }
    const meta = validateStorageReplicaMeta(
      decoded,
      `StorageReplicaMeta[0x${key.toString('hex')}]`,
    );
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
    if (normalizeEntityId(String(sharedState.entityId || '')) !== metaEntityId) {
      throw new Error(
        `STORAGE_REPLICA_META_STATE_ENTITY_MISMATCH:meta=${metaEntityId}:` +
        `state=${normalizeEntityId(String(sharedState.entityId || '')) || 'missing'}`,
      );
    }
    if (seenSigners.has(signerId)) {
      throw new Error(`STORAGE_REPLICA_META_DUPLICATE_SIGNER:entity=${metaEntityId}:signer=${signerId}`);
    }
    seenSigners.add(signerId);
    const validators = sharedState.config.validators;
    if (!Array.isArray(validators) || !validators.some(validator => normalizeEntityId(validator) === signerId)) {
      throw new Error(`STORAGE_REPLICA_META_SIGNER_NOT_IN_BOARD:entity=${metaEntityId}:signer=${signerId}`);
    }
    metas.push(meta satisfies StorageReplicaMeta);
  }
  return metas.sort((left, right) => compareAscii(String(left.signerId || ''), String(right.signerId || '')));
};

export const listStorageReplicaMetas = async (
  db: RuntimeDbLike,
  entityId: string,
  sharedState?: EntityState,
): Promise<StorageReplicaMeta[]> => listReplicaMetas(
  db,
  entityId,
  keyLiveReplicaMetaPrefix(entityId),
  keyLiveReplicaMeta,
  sharedState,
);

export const listStorageSnapshotReplicaMetas = async (
  db: RuntimeDbLike,
  height: number,
  entityId: string,
  sharedState: EntityState,
): Promise<StorageReplicaMeta[]> => listReplicaMetas(
  db,
  entityId,
  keySnapshotReplicaMetaPrefix(height, entityId),
  (metaEntityId, signerId) => keySnapshotReplicaMeta(height, metaEntityId, signerId),
  sharedState,
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
  snapshotHeight?: number;
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
    const stored = key[0] === KEY_LIVE_ACCOUNT
      ? await readAccountStorageLayout(db, options.entityId, counterpartyId, key)
      : options.snapshotHeight !== undefined
        ? await readAccountStorageLayout(
            createSnapshotAccountGraphView(db, options.snapshotHeight),
            options.entityId,
            counterpartyId,
            keyLiveAccount(options.entityId, counterpartyId),
          )
        : null;
    if (!stored) {
      throw new Error(`STORAGE_ACCOUNT_GRAPH_MISSING:${options.entityId}:${counterpartyId}`);
    }
    const doc = assertStorageAccountDocBinding(
      validateStorageAccountDocValue(stored.doc),
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
    if (key.length !== 33) throw new Error(`STORAGE_LIVE_ENTITY_KEY_INVALID:${key.toString('hex')}`);
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
    const parsed = parseSnapshotEntityKey(key);
    if (parsed.height !== targetHeight) throw new Error(`STORAGE_SNAPSHOT_ENTITY_HEIGHT_MISMATCH:${parsed.height}:${targetHeight}`);
    ids.push(parsed.entityId);
  }
  return ids;
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

/**
 * A graph keyspace contains exactly two authoritative shapes: the current
 * materialized graph and immutable checkpoint graphs. Arbitrary historical
 * heights are reconstructed only by deterministic Runtime WAL replay. Keeping
 * a second document-diff reducer here previously duplicated consensus logic
 * and depended on a retired record family that was no longer written.
 */
const requireDirectGraphSource = async (
  db: RuntimeDbLike,
  targetHeight: number,
  latestMaterializedHeight: number,
  liveStateReadable: boolean,
  scope: string,
): Promise<'live' | 'snapshot'> => {
  if (liveStateReadable && targetHeight === latestMaterializedHeight) return 'live';
  const snapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  if (snapshotHeight === targetHeight) return 'snapshot';
  throw new Error(
    `STORAGE_DIRECT_HISTORICAL_READ_FORBIDDEN:scope=${scope}:` +
    `requested=${targetHeight}:materialized=${latestMaterializedHeight}:` +
    `checkpoint=${snapshotHeight};use=runtime-wal-replay`,
  );
};

const loadSnapshotDocsForEntity = async (db: RuntimeDbLike, snapshotHeight: number, entityId: string): Promise<Map<string, StorageDoc>> => {
  const docs = new Map<string, StorageDoc>();

  const entityStored = await readEntityStorageLayout(
    createSnapshotEntityGraphView(db, snapshotHeight),
    entityId,
    keyLiveEntity(entityId),
  );
  const entityBuffer = assertEntityDocKeyBinding(
    entityStored?.doc ?? null,
    entityId,
    `snapshot:${snapshotHeight}`,
  );
  if (entityBuffer) {
    docs.set(`e:${normalizeEntityId(entityId)}`, { family: 'entity', entityId: normalizeEntityId(entityId), value: entityBuffer });
  }

  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(snapshotHeight, entityId) })) {
    const { height: keyHeight, entityId: entity, counterpartyId: counterparty } = parseSnapshotAccountKey(key);
    if (keyHeight !== snapshotHeight) throw new Error(`STORAGE_SNAPSHOT_ACCOUNT_HEIGHT_MISMATCH:${keyHeight}:${snapshotHeight}`);
    const stored = await readAccountStorageLayout(
      createSnapshotAccountGraphView(db, snapshotHeight),
      entity,
      counterparty,
      keyLiveAccount(entity, counterparty),
    );
    if (!stored) throw new Error(`STORAGE_SNAPSHOT_ACCOUNT_GRAPH_MISSING:${snapshotHeight}:${entity}:${counterparty}`);
    const value = assertStorageAccountDocBinding(
      stored.doc,
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
    const value = await readSnapshotBookGraph(db, snapshotHeight, parsed.entityId, parsed.pairId);
    if (!value) throw new Error(`STORAGE_SNAPSHOT_BOOK_GRAPH_MISSING:${snapshotHeight}:${parsed.entityId}:${parsed.pairId}`);
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
    const { height: keyHeight, entityId } = parseSnapshotEntityKey(key);
    if (keyHeight !== snapshotHeight) throw new Error(`STORAGE_SNAPSHOT_ENTITY_HEIGHT_MISMATCH:${keyHeight}:${snapshotHeight}`);
    const stored = await readEntityStorageLayout(
      createSnapshotEntityGraphView(db, snapshotHeight),
      entityId,
      keyLiveEntity(entityId),
    );
    if (!stored) throw new Error(`STORAGE_SNAPSHOT_ENTITY_GRAPH_MISSING:${snapshotHeight}:${entityId}`);
    const value = assertStorageEntityDocBinding(
      stored.doc,
      entityId,
      `snapshot:${snapshotHeight}`,
    );
    if (value) docs.set(`e:${normalizeEntityId(entityId)}`, { family: 'entity', entityId, value });
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(snapshotHeight) })) {
    const { entityId, counterpartyId } = parseSnapshotAccountKey(key);
    const stored = await readAccountStorageLayout(
      createSnapshotAccountGraphView(db, snapshotHeight),
      entityId,
      counterpartyId,
      keyLiveAccount(entityId, counterpartyId),
    );
    if (!stored) throw new Error(`STORAGE_SNAPSHOT_ACCOUNT_GRAPH_MISSING:${snapshotHeight}:${entityId}:${counterpartyId}`);
    const value = assertStorageAccountDocBinding(
      stored.doc,
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
    const value = await readSnapshotBookGraph(db, snapshotHeight, entityId, pairId);
    if (!value) throw new Error(`STORAGE_SNAPSHOT_BOOK_GRAPH_MISSING:${snapshotHeight}:${entityId}:${pairId}`);
    docs.set(`b:${normalizeEntityId(entityId)}:${pairId}`, {
      family: 'book',
      entityId,
      pairId,
      value,
    });
  }
  return docs;
};

const hydrateEntityStatesFromDocs = async (
  env: RuntimeReplica,
  db: RuntimeDbLike,
  docs: Map<string, StorageDoc>,
  snapshotHeight?: number,
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
      snapshotHeight,
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
  const source = await requireDirectGraphSource(
    db,
    targetHeight,
    latestMaterializedHeight,
    liveStateReadable,
    `entity:${normalized}`,
  );
  if (source === 'live') {
    const stored = await readEntityStorageLayout(db, normalized, keyLiveEntity(normalized));
    return assertEntityDocKeyBinding(
      stored?.doc ?? null,
      normalized,
      'live',
    );
  }
  const snapshotStored = await readEntityStorageLayout(
    createSnapshotEntityGraphView(db, targetHeight),
    normalized,
    keyLiveEntity(normalized),
  );
  return assertEntityDocKeyBinding(
    snapshotStored?.doc ?? null,
    normalized,
    `snapshot:${targetHeight}`,
  );
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

  const source = await requireDirectGraphSource(
    db,
    targetHeight,
    latestMaterializedHeight,
    liveStateReadable,
    `accounts:${normalized}`,
  );
  if (source === 'live') {
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
  const prefix = keySnapshotAccountPrefix(targetHeight, normalized);
  return listAccountPageFromKeyspace({
    db,
    entityId: normalized,
    prefix,
    cursorKey: cursor ? keySnapshotAccountCursor(targetHeight, normalized, cursor) : undefined,
    parseKey: parseSnapshotAccountKey,
    cursor,
    limit,
    direction,
    snapshotHeight: targetHeight,
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

  const source = await requireDirectGraphSource(
    db,
    targetHeight,
    latestMaterializedHeight,
    liveStateReadable,
    `account:${normalized}:${counterparty}`,
  );
  if (source === 'live') {
    const stored = await readAccountStorageLayout(
      db,
      normalized,
      counterparty,
      keyLiveAccount(normalized, counterparty),
    );
    if (!stored) return null;
    return assertStorageAccountDocBinding(
      validateStorageAccountDocValue(stored.doc),
      normalized,
      counterparty,
      'live',
    );
  }
  const stored = await readAccountStorageLayout(
    createSnapshotAccountGraphView(db, targetHeight),
    normalized,
    counterparty,
    keyLiveAccount(normalized, counterparty),
  );
  return stored
    ? assertStorageAccountDocBinding(
        validateStorageAccountDocValue(stored.doc),
        normalized,
        counterparty,
        `snapshot:${targetHeight}`,
      )
    : null;
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
  readBook: (pairId: string) => Promise<BookState | null>;
}): Promise<StorageBookDocPage | null> => {
  const { db, prefix, parseKey, cursor, limit, direction, overlay, readBook } = options;
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
    const book = await readBook(pairId);
    if (!book) throw new Error(`STORAGE_BOOK_GRAPH_MISSING:${pairId}`);
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

  const source = await requireDirectGraphSource(
    db,
    targetHeight,
    latestMaterializedHeight,
    liveStateReadable,
    `books:${normalized}`,
  );
  if (source === 'live') {
    const page = await listBookPageFromKeyspace({
      db,
      prefix: keyLiveBookPrefix(normalized),
      cursorKey: cursor ? keyLiveBook(normalized, cursor) : undefined,
      parseKey: (key) => parseLiveBookKey(key),
      cursor,
      limit,
      direction,
      readBook: pairId => readStorageBookGraph(db, normalized, pairId),
    });
    if (page) return page;
  }

  const page = await listBookPageFromKeyspace({
    db,
    prefix: keySnapshotBookPrefix(targetHeight, normalized),
    cursorKey: cursor ? keySnapshotBookCursor(targetHeight, normalized, cursor) : undefined,
    parseKey: (key) => parseLiveBookKey(key, 9),
    cursor,
    limit,
    direction,
    readBook: pairId => readSnapshotBookGraph(db, targetHeight, normalized, pairId),
  });
  return page ?? { items: [], nextCursor: null };
};

export const loadEntityViewPageFromStorage = async (options: {
  env: RuntimeReplica;
  tryOpenDb: (env: RuntimeReplica) => Promise<boolean>;
  getRuntimeDb: (env: RuntimeReplica) => RuntimeDbLike;
  entityId: string;
  height?: number;
  accountQuery?: StoragePageQuery;
  bookQuery?: StoragePageQuery;
  liveStateReadable?: boolean;
}): Promise<StorageEntityViewPage | null> => {
  await requireStorageDbOpen(
    () => options.tryOpenDb(options.env),
    'entity-view',
  );
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
  env: RuntimeReplica;
  tryOpenDb: (env: RuntimeReplica) => Promise<boolean>;
  getRuntimeDb: (env: RuntimeReplica) => RuntimeDbLike;
  entityId: string;
  counterpartyId: string;
  height?: number;
  liveStateReadable?: boolean;
}): Promise<StorageAccountDoc | null> => {
  await requireStorageDbOpen(
    () => options.tryOpenDb(options.env),
    'account-document',
  );
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
  env: RuntimeReplica;
  tryOpenDb: (env: RuntimeReplica) => Promise<boolean>;
  getRuntimeDb: (env: RuntimeReplica) => RuntimeDbLike;
  entityId: string;
  height?: number;
  liveStateReadable?: boolean;
}): Promise<EntityState | null> => {
  await requireStorageDbOpen(
    () => options.tryOpenDb(options.env),
    'entity-state',
  );
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
    const entityStored = await readEntityStorageLayout(db, entityId, keyLiveEntity(entityId));
    if (!entityStored) return null;
    const entityCore = assertStorageEntityDocBinding(
      entityStored.doc,
      entityId,
      'live-state',
    );
    if (!entityCore) return null;
    const accounts = new Map<string, StorageAccountDoc>();
    for await (const key of iterateKeys(db, { prefix: keyLiveAccountPrefix(entityId) })) {
      const parsed = parseLiveAccountKey(key);
      const stored = await readAccountStorageLayout(
        db,
        parsed.entityId,
        parsed.counterpartyId,
        key,
      );
      if (!stored) throw new Error(`STORAGE_LIVE_ACCOUNT_LAYOUT_MISSING:${key.toString('hex')}`);
      const doc = assertStorageAccountDocBinding(
        validateStorageAccountDocValue(stored.doc),
        parsed.entityId,
        parsed.counterpartyId,
        'live-state',
      );
      accounts.set(parsed.counterpartyId, doc);
    }
    const books = new Map<string, BookState>();
    for await (const key of iterateKeys(db, { prefix: keyLiveBookPrefix(entityId) })) {
      const parsed = parseLiveBookKey(key);
      const book = await readStorageBookGraph(db, parsed.entityId, parsed.pairId);
      if (!book) throw new Error(`STORAGE_BOOK_GRAPH_MISSING:${parsed.entityId}:${parsed.pairId}`);
      books.set(parsed.pairId, book);
    }
    return hydrateEntityWithCertifiedBoardNodes(options.env, db, entityCore, accounts, books);
  }

  await requireDirectGraphSource(
    db,
    targetHeight,
    latestMaterializedHeight,
    options.liveStateReadable !== false,
    `entity-state:${entityId}`,
  );
  const docs = await loadSnapshotDocsForEntity(db, targetHeight, entityId);

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

  return hydrateEntityWithCertifiedBoardNodes(options.env, db, core.value, accounts, books, targetHeight);
};

export const loadEntityStatesAtHeightFromStorage = async (options: {
  env: RuntimeReplica;
  tryOpenDb: (env: RuntimeReplica) => Promise<boolean>;
  getRuntimeDb: (env: RuntimeReplica) => RuntimeDbLike;
  height?: number;
}): Promise<Map<string, EntityState>> => {
  await requireStorageDbOpen(
    () => options.tryOpenDb(options.env),
    'entity-states',
  );
  const db = options.getRuntimeDb(options.env);
  const head = await readStorageHead(db);
  if (!head) return new Map();
  const targetHeight = resolveTargetStorageHeight(head, options.height, 'entity-states');
  if (targetHeight <= 0) return new Map();

  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );
  if (targetHeight === latestMaterializedHeight) {
    const states = new Map<string, EntityState>();
    for (const entityId of await listStorageLiveEntityIds(db)) {
      const state = await loadEntityStateFromStorage({
        ...options,
        entityId,
        height: targetHeight,
        liveStateReadable: true,
      });
      if (!state) {
        throw new Error(`STORAGE_LIVE_ENTITY_STATE_MISSING:${entityId}:${targetHeight}`);
      }
      states.set(entityId, state);
    }
    return states;
  }

  await requireDirectGraphSource(
    db,
    targetHeight,
    latestMaterializedHeight,
    false,
    'entity-states',
  );
  const docs = await loadSnapshotDocsAtHeight(db, targetHeight);
  return hydrateEntityStatesFromDocs(options.env, db, docs, targetHeight);
};
import { Buffer } from '../../support/platform-crypto';
