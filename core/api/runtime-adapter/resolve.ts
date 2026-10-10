import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { readRuntimeEntityMetricStats } from '../../runtime/observability/entity-metrics';
import { normalizeEntityId } from '../../storage/keys';
import {
  projectEntityCoreDoc,
  projectEntityReplicaCoreView,
} from '../../storage/read/projections';
import type { RuntimeFrame } from '../../storage/types';
import { RuntimeAdapterError } from './errors';
import { detachRuntimeAdapterPayload } from './codec';
import { buildRuntimeRecoveryBundle } from '../../storage/recovery/bundle';
import {
  deriveRuntimeRecoveryLookupKey,
  encryptRuntimeRecoveryBundle,
} from '../../storage/recovery/bundle/crypto';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoverySignerV1,
} from '../../storage/recovery/bundle/types';
import type { RuntimeActivityFilters } from '../../storage/views/activity-types';
import type {
  RuntimeAdapterActivityPage,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSolvencySummary,
  RuntimeAdapterTimelineIndexPage,
} from './types';
import {
  assertRequestedHeightAvailable,
  envHeight,
  findReplica,
  listEntitySummaries,
  loadViewPageForHeight,
  readAtHeight,
  readBestHead,
  readBoundedLimit,
  type RuntimeAdapterEntityCoreDoc,
  type RuntimeAdapterResolveContext,
} from './read/context';
import {
  accountPageSummaryForView,
  compactAccountDocForView,
  compactEntityCoreForRemote,
  compactViewPageForRemote,
  singleAccountViewPage,
} from './read/compact-view';
import { projectHistoryFrameBatch, projectViewFrame } from './read/view-frame';
import { projectGraphFrame } from './read/graph-frame';

import { calculateSolvency } from '../../runtime/swap-cmd/solvency';
import { acquireRuntimeCommittedRead } from '../../runtime/frame/lifecycle/writer-lock';

export type RuntimeAdapterFrameSummary = {
  height: number;
  timestamp: number;
  prevFrameHash?: string;
  frameHash?: string;
  postStateHash: string;
  stateHash: string;
  materializedState?: boolean;
  canonicalStateHash?: string;
  canonicalEntityHashes?: RuntimeFrame['canonicalEntityHashes'];
  runtimeInputCounts: {
    runtimeTxs: number;
    jInputs: number;
    entityInputs: number;
    entityTxs: number;
  };
  touchedCounts: {
    entities: number;
    accounts: number;
    bookEntities: number;
  };
};

const normalizePath = (path: string): string[] => {
  const parts = String(path || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (parts.length === 0) throw new RuntimeAdapterError('E_BAD_PATH', 'empty adapter path');
  return parts;
};

const decodeSwapHistoryCursor = (
  raw: unknown,
): Readonly<{ height: number; offerId: string }> | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new RuntimeAdapterError('E_BAD_QUERY', 'swap history cursor must be text');
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'swap history cursor is invalid');
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'swap history cursor is invalid');
  }
  const [height, offerId] = decoded;
  if (!Number.isSafeInteger(height) || height < 1 || typeof offerId !== 'string' || !offerId || offerId.length > 256) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'swap history cursor is invalid');
  }
  return { height, offerId };
};

const encodeSwapHistoryCursor = (cursor: Readonly<{ height: number; offerId: string }> | null): string | null =>
  cursor ? encodeURIComponent(JSON.stringify([cursor.height, cursor.offerId])) : null;

const normalizeRuntimeIdForRecovery = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const inferRecoverySignersForAdapter = (env: RuntimeReplica): RuntimeRecoverySignerV1[] => {
  const runtimeId = normalizeRuntimeIdForRecovery(env.runtimeId);
  if (!runtimeId) return [];
  let entityId = '';
  let jurisdiction = '';
  let name = 'Runtime signer';
  for (const [key, replica] of env.state.eReplicas?.entries?.() || []) {
    const signerId = normalizeRuntimeIdForRecovery(replica?.signerId);
    const validators = [
      ...Object.keys(replica?.state?.config?.shares || {}),
      ...(replica?.state?.config?.validators || []),
    ].map(normalizeRuntimeIdForRecovery);
    if (signerId !== runtimeId && !validators.includes(runtimeId)) continue;
    entityId = normalizeEntityId(replica?.state?.entityId || replica?.entityId || String(key).split(':')[0] || '');
    jurisdiction = String(replica?.state?.config?.jurisdiction?.name || '').trim();
    name = String(replica?.state?.profile?.name || replica?.entityId || 'Runtime signer').trim();
    break;
  }
  return [{
    index: 0,
    derivationIndex: 0,
    address: runtimeId,
    name,
    ...(entityId ? { entityId } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
  }];
};

const buildPeerRecoveryBundleRead = async (
  ctx: RuntimeAdapterResolveContext,
  lookupKey: string,
): Promise<{
  ok: true;
  runtimeId: string;
  lookupKey: string;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  bundles: EncryptedRuntimeRecoveryBundleV1[];
}> => {
  const runtimeId = normalizeRuntimeIdForRecovery(ctx.env.runtimeId);
  if (!runtimeId) throw new RuntimeAdapterError('E_BAD_QUERY', 'recovery bundle reads require runtimeId');
  const runtimeSeed = String(ctx.env.runtimeSeed || '').trim();
  if (!runtimeSeed) throw new RuntimeAdapterError('E_BAD_QUERY', 'recovery bundle reads require runtimeSeed');
  const requestedLookupKey = String(lookupKey || '').trim().toLowerCase();
  const expectedLookupKey = deriveRuntimeRecoveryLookupKey(runtimeId, runtimeSeed).toLowerCase();
  if (!requestedLookupKey || requestedLookupKey !== expectedLookupKey) {
    throw new RuntimeAdapterError('E_NOT_FOUND', 'recovery bundle not found');
  }
  const { readPersistedFrameJournal } = await import('../../runtime/composition');
  const tip = ctx.env.state.height > 0
    ? await readPersistedFrameJournal(ctx.env, ctx.env.state.height)
    : null;
  if (ctx.env.state.height > 0 && !tip) throw new Error('RECOVERY_BUNDLE_CHECKPOINT_FRAME_MISSING');
  const bundle = buildRuntimeRecoveryBundle(ctx.env, {
    frames: tip ? [tip] : [],
    signers: inferRecoverySignersForAdapter(ctx.env),
    createdAt: Math.max(0, Math.floor(Number(ctx.env.state.timestamp || ctx.env.state.height || 0))),
    meta: { activeSignerIndex: 0 },
  });
  const encrypted = await encryptRuntimeRecoveryBundle(bundle, runtimeSeed);
  if (String(encrypted.lookupKey || '').toLowerCase() !== expectedLookupKey) {
    throw new RuntimeAdapterError('E_INTERNAL', 'recovery bundle lookup key mismatch');
  }
  return {
    ok: true,
    runtimeId,
    lookupKey: expectedLookupKey,
    bundle: encrypted,
    bundles: [encrypted],
  };
};

const parseStringList = (raw: unknown): string[] => {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  return values
    .map((item) => String(item || '').trim())
    .filter(Boolean);
};

const readOptionalFiniteNumber = (raw: unknown, field: string): number | undefined => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new RuntimeAdapterError('E_BAD_QUERY', `${field} must be finite`);
  return Math.floor(value);
};

const readActivityQuery = (
  query?: RuntimeAdapterReadQuery,
): RuntimeActivityFilters & {
  beforeHeight?: number | undefined;
  limit?: number | undefined;
  scanLimit?: number | undefined;
} => {
  const kind = query?.kind ?? 'all';
  if (kind !== 'all' && kind !== 'onchain' && kind !== 'offchain') {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'activity kind must be all, onchain, or offchain');
  }
  const entityId = query?.entityId ? normalizeEntityId(String(query.entityId)) : '';
  if (entityId && !/^0x[0-9a-f]{64}$/.test(entityId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'activity entityId must be 0x + 64 hex chars');
  }
  return {
    ...(entityId ? { entityId } : {}),
    kind,
    types: parseStringList(query?.types),
    query: String(query?.query ?? query?.q ?? '').trim(),
    fromTimestamp: readOptionalFiniteNumber(query?.fromTimestamp, 'fromTimestamp'),
    toTimestamp: readOptionalFiniteNumber(query?.toTimestamp, 'toTimestamp'),
    beforeHeight: readOptionalFiniteNumber(query?.beforeHeight, 'beforeHeight'),
    limit: readOptionalFiniteNumber(query?.limit, 'limit'),
    scanLimit: readOptionalFiniteNumber(query?.scanLimit, 'scanLimit'),
  };
};

const resolveEntityState = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  query?: RuntimeAdapterReadQuery,
): Promise<{ state: EntityState; replica?: EntityReplica }> => {
  const normalized = normalizeEntityId(entityId);
  const height = readAtHeight(query);
  if (height !== null && height !== envHeight(ctx.env)) {
    if (!ctx.loadEntityState) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'historical reads are unavailable for this adapter');
    }
    const loaded = await ctx.loadEntityState(normalized, height);
    if (!loaded) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found at height ${height}: ${normalized}`);
    return { state: loaded };
  }

  const replica = findReplica(ctx.env, normalized);
  if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalized}`);
  return { state: replica.state, replica };
};

const compactFrameRecordForRemote = (frame: RuntimeFrame): RuntimeAdapterFrameSummary => {
  const runtimeInput = frame.runtimeInput ?? { runtimeTxs: [], jInputs: [], entityInputs: [] };
  const entityInputs = runtimeInput.entityInputs ?? [];
  return {
    height: frame.height,
    timestamp: frame.timestamp,
    ...(frame.prevFrameHash ? { prevFrameHash: frame.prevFrameHash } : {}),
    ...(frame.frameHash ? { frameHash: frame.frameHash } : {}),
    postStateHash: frame.postStateHash,
    stateHash: frame.canonicalStateHash ?? '',
    ...(frame.materializedState !== undefined ? { materializedState: frame.materializedState } : {}),
    ...(frame.canonicalStateHash ? { canonicalStateHash: frame.canonicalStateHash } : {}),
    ...(frame.canonicalEntityHashes ? { canonicalEntityHashes: frame.canonicalEntityHashes } : {}),
    runtimeInputCounts: {
      runtimeTxs: runtimeInput.runtimeTxs?.length ?? 0,
      jInputs: runtimeInput.jInputs?.length ?? 0,
      entityInputs: entityInputs.length,
      entityTxs: entityInputs.reduce((sum, input) => sum + (input.entityTxs?.length ?? 0), 0),
    },
    touchedCounts: {
      entities: frame.touchedEntities?.length ?? 0,
      accounts: frame.touchedAccounts?.length ?? 0,
      bookEntities: frame.touchedBookEntities?.length ?? 0,
    },
  };
};

const projectTimelineIndex = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterTimelineIndexPage> => {
  if (!ctx.readFrame) throw new RuntimeAdapterError('E_BAD_QUERY', 'timeline-index requires persisted frame storage');
  const head = await readBestHead(ctx);
  const latestHeight = Math.max(0, Math.min(envHeight(ctx.env), Math.floor(Number(head.latestHeight || 0))));
  const runtimeIdForPage = normalizeEntityId(String(ctx.env.runtimeId || '')) || 'embedded';
  // A runtime that has not persisted a frame yet is an empty timeline, not a bad request.
  // Erroring here made every fresh browser runtime report a broken time machine.
  if (latestHeight < 1 && query?.beforeHeight === undefined) {
    return { runtimeId: runtimeIdForPage, latestHeight, entries: [], scannedHeights: 0, nextBeforeHeight: null };
  }
  const beforeHeight = query?.beforeHeight === undefined
    ? latestHeight + 1
    : Math.floor(Number(query.beforeHeight));
  if (!Number.isFinite(beforeHeight) || beforeHeight < 2) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'beforeHeight must be an integer greater than 1');
  }
  const limit = readBoundedLimit(query?.limit, 250);
  const rawScanLimit = Math.floor(Number(query?.scanLimit ?? limit * 4));
  if (!Number.isFinite(rawScanLimit) || rawScanLimit < 1) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'scanLimit must be a positive integer');
  }
  const scanLimit = Math.min(2_000, rawScanLimit);
  const fromTimestamp = query?.fromTimestamp === undefined ? null : Math.floor(Number(query.fromTimestamp));
  const toTimestamp = query?.toTimestamp === undefined ? null : Math.floor(Number(query.toTimestamp));
  if (fromTimestamp !== null && (!Number.isFinite(fromTimestamp) || fromTimestamp < 0)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'fromTimestamp must be a non-negative integer');
  }
  if (toTimestamp !== null && (!Number.isFinite(toTimestamp) || toTimestamp < 0)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'toTimestamp must be a non-negative integer');
  }
  const runtimeId = runtimeIdForPage;
  const entries: RuntimeAdapterTimelineIndexPage['entries'] = [];
  let cursor = Math.min(latestHeight, beforeHeight - 1);
  let scannedHeights = 0;
  while (cursor >= 1 && scannedHeights < scanLimit && entries.length < limit) {
    const frame = await ctx.readFrame(cursor);
    cursor -= 1;
    scannedHeights += 1;
    if (!frame) continue;
    const timestamp = Math.max(0, Math.floor(Number(frame.timestamp || 0)));
    if (fromTimestamp !== null && timestamp < fromTimestamp) continue;
    if (toTimestamp !== null && timestamp > toTimestamp) continue;
    entries.push({
      runtimeId,
      height: Math.max(1, Math.floor(Number(frame.height || 0))),
      timestamp,
      stateHash: String(frame.canonicalStateHash || ''),
      materialized: frame.materializedState === true,
      graphChanged: (frame.touchedEntities?.length ?? 0) > 0
        || (frame.touchedAccounts?.length ?? 0) > 0
        || (frame.touchedBookEntities?.length ?? 0) > 0,
    });
  }
  entries.sort((left, right) => left.timestamp - right.timestamp || left.height - right.height);
  return {
    runtimeId,
    latestHeight,
    entries,
    scannedHeights,
    nextBeforeHeight: cursor >= 1 ? cursor + 1 : null,
  };
};

const projectActivityPage = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterActivityPage> => {
  if (!ctx.readActivityPage) throw new RuntimeAdapterError('E_BAD_QUERY', 'activity reads are unavailable for this adapter');
  return ctx.readActivityPage(readActivityQuery(query));
};

const projectSolvencySummary = (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterSolvencySummary => {
  const requestedHeight = readAtHeight(query);
  const currentHeight = envHeight(ctx.env);
  if (requestedHeight !== null && requestedHeight !== currentHeight) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'historical solvency-summary reads are not available yet');
  }

  const solvency = calculateSolvency(ctx.env);
  const assets = Array.from(solvency.byAsset.values())
    .sort((left, right) => left.stackId.localeCompare(right.stackId) || left.tokenId - right.tokenId);

  return {
    ok: true,
    height: currentHeight,
    entityCount: solvency.entityCount,
    accountViews: solvency.accountViews,
    assets,
    isValid: solvency.isValid,
  };
};

const resolveScopedRuntimeAdapterRead = async <T>(
  ctx: RuntimeAdapterResolveContext,
  parts: string[],
  query?: RuntimeAdapterReadQuery,
): Promise<T> => {
  if (parts[0] === 'entity' && parts.length >= 2) {
    const entityId = parts[1];
    if (!entityId) throw new RuntimeAdapterError('E_BAD_PATH', 'entity id is required');

    if (parts.length === 3 && parts[2] === 'settlement-counters') {
      if (readAtHeight(query) !== null) {
        throw new RuntimeAdapterError('E_BAD_QUERY', 'historical settlement counters are unavailable');
      }
      const replica = findReplica(ctx.env, entityId);
      if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
      return {
        height: replica.state.height,
        paybookOpen: replica.state.paybook.entries.size,
        paybookFeesEarned: replica.state.paybook.feesEarned,
        metrics: readRuntimeEntityMetricStats(ctx.env, entityId),
      } as T;
    }

    if (parts.length === 3 && (parts[2] === 'accounts' || parts[2] === 'books' || parts[2] === 'book-docs')) {
      const height = readAtHeight(query);
      const targetHeight = height ?? envHeight(ctx.env);
      if (targetHeight < 1) throw new RuntimeAdapterError('E_BAD_QUERY', 'paged entity reads require a persisted runtime height');
      const accountId = normalizeEntityId(String(query?.accountId || ''));
      if (parts[2] === 'accounts' && accountId) {
        const limit = readBoundedLimit(query?.accountsLimit ?? query?.limit, 10);
        const isCurrentHeight = height === null || targetHeight === envHeight(ctx.env);
        if (isCurrentHeight) {
          const replica = findReplica(ctx.env, entityId);
          if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
          const account = replica.state.accounts.get(accountId);
          const page = singleAccountViewPage(accountId, account ? compactAccountDocForView(account) : null, limit);
          return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
        }
        if (!ctx.loadEntityAccountDoc) {
          throw new RuntimeAdapterError('E_BAD_QUERY', 'historical account reads are unavailable for this adapter');
        }
        const account = await ctx.loadEntityAccountDoc(entityId, accountId, targetHeight);
        const page = singleAccountViewPage(accountId, account ? compactAccountDocForView(account) : null, limit);
        return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
      }
      const isCurrentHeight = height === null || targetHeight === envHeight(ctx.env);
      const stored = await loadViewPageForHeight(ctx, entityId, targetHeight, isCurrentHeight, query);
      const compactStored = compactViewPageForRemote(entityId, stored);
      return (parts[2] === 'accounts' ? compactStored.accounts : compactStored.books) as T;
    }

    if (parts.length === 5 && parts[2] === 'account' && parts[4] === 'frames') {
      // A dispute is argued from the frames both parties signed. The aggregate
      // Entity view carries only the current one, so this is a point read.
      const counterpartyId = normalizeEntityId(parts[3] ?? '');
      if (!counterpartyId) throw new RuntimeAdapterError('E_BAD_PATH', 'account id is required');
      if (readAtHeight(query) !== null) {
        throw new RuntimeAdapterError('E_BAD_QUERY', 'historical frame reads are not available through a live adapter');
      }
      if (!ctx.readAccountFrameHistory) {
        throw new RuntimeAdapterError('E_BAD_QUERY', 'account frame reads are unavailable for this adapter');
      }
      return (await ctx.readAccountFrameHistory(
        entityId,
        counterpartyId,
        readBoundedLimit(query?.limit, 25),
      )) as T;
    }

    if (parts.length === 5 && parts[2] === 'account' && parts[4] === 'swap-history') {
      const counterpartyId = normalizeEntityId(parts[3] ?? '');
      if (!counterpartyId) throw new RuntimeAdapterError('E_BAD_PATH', 'account id is required');
      if (readAtHeight(query) !== null) {
        throw new RuntimeAdapterError('E_BAD_QUERY', 'historical swap-history reads are not available through a live adapter');
      }
      if (!ctx.readAccountSwapHistoryPage) {
        throw new RuntimeAdapterError('E_BAD_QUERY', 'account swap-history reads are unavailable for this adapter');
      }
      const cursor = decodeSwapHistoryCursor(query?.cursor);
      const page = await ctx.readAccountSwapHistoryPage(entityId, counterpartyId, {
        limit: readBoundedLimit(query?.limit, 25),
        ...(cursor ? { cursor } : {}),
      });
      return {
        ...page,
        nextCursor: encodeSwapHistoryCursor(page.nextCursor),
      } as T;
    }

    if (parts.length === 4 && parts[2] === 'account') {
      const counterpartyId = normalizeEntityId(parts[3] ?? '');
      const height = readAtHeight(query);
      if (height !== null && height !== envHeight(ctx.env)) {
        if (!ctx.loadEntityAccountDoc) {
          throw new RuntimeAdapterError('E_BAD_QUERY', 'historical account reads are unavailable for this adapter');
        }
        const loaded = await ctx.loadEntityAccountDoc(entityId, counterpartyId, height);
        if (!loaded) throw new RuntimeAdapterError('E_NOT_FOUND', `account not found at height ${height}: ${normalizeEntityId(entityId)}/${counterpartyId}`);
        return compactAccountDocForView(loaded) as T;
      }
      const { state } = await resolveEntityState(ctx, entityId, query);
      const account = state.accounts.get(counterpartyId);
      if (!account) throw new RuntimeAdapterError('E_NOT_FOUND', `account not found: ${normalizeEntityId(entityId)}/${counterpartyId}`);
      return compactAccountDocForView(account) as T;
    }

    // An unknown sub-path falls through to E_BAD_PATH; resolving the entity
    // first loaded full historical state from storage before rejecting it.
    if (parts.length === 2) {
      const { state, replica } = await resolveEntityState(ctx, entityId, query);
      const projected = replica
        ? projectEntityReplicaCoreView(state, replica)
        : projectEntityCoreDoc(state);
      const core: RuntimeAdapterEntityCoreDoc = replica
        ? { ...projected, metrics: readRuntimeEntityMetricStats(ctx.env, entityId) }
        : projected;
      return compactEntityCoreForRemote(core) as RuntimeAdapterEntityCoreDoc as T;
    }
  }

  if (parts[0] === 'frame' && parts.length === 2) {
    if (!ctx.readFrame) throw new RuntimeAdapterError('E_BAD_QUERY', 'frame reads are unavailable for this adapter');
    const height = parts[1] === 'latest' ? envHeight(ctx.env) : Number(parts[1]);
    if (!Number.isFinite(height) || height < 1) throw new RuntimeAdapterError('E_BAD_PATH', 'frame height must be a positive integer or latest');
    const frame = await ctx.readFrame(Math.floor(height));
    if (!frame) throw new RuntimeAdapterError('E_NOT_FOUND', `frame not found: ${Math.floor(height)}`);
    return compactFrameRecordForRemote(frame) as T;
  }

  if (parts.length === 1 && parts[0] === 'checkpoints') {
    const heights = ctx.listCheckpoints ? await ctx.listCheckpoints() : [];
    return heights.map((height) => ({ height, timestamp: null })) as T;
  }

  throw new RuntimeAdapterError('E_BAD_PATH', `unsupported adapter path: ${parts.join('/')}`);
};

const resolveRuntimeAdapterReadFromCommittedState = async <T = unknown>(
  ctx: RuntimeAdapterResolveContext,
  path: string,
  query?: RuntimeAdapterReadQuery,
): Promise<T> => {
  const parts = normalizePath(path);

  if (parts.length === 1 && parts[0] === 'head') {
    const requestedHeight = readAtHeight(query);
    const currentEnvHeight = envHeight(ctx.env);
    if (requestedHeight !== null && requestedHeight !== currentEnvHeight) {
      if (!ctx.readHead) {
        throw new RuntimeAdapterError('E_INTERNAL', 'storage head reader is required for historical reads');
      }
      const head = await ctx.readHead();
      if (!head) throw new RuntimeAdapterError('E_NOT_FOUND', `storage head not found at height ${requestedHeight}`);
      assertRequestedHeightAvailable(requestedHeight, head, 'head');
      return head as T;
    }
    return await readBestHead(ctx) as T;
  }

  if (parts.length === 1 && parts[0] === 'entities') {
    return await listEntitySummaries(ctx, query) as T;
  }

  if (parts.length === 1 && parts[0] === 'view-frame') {
    return await projectViewFrame(ctx, query) as T;
  }

  if (parts.length === 1 && parts[0] === 'graph-frame') {
    return await projectGraphFrame(ctx, query) as T;
  }

  if (parts.length === 1 && parts[0] === 'history-frame-batch') {
    return await projectHistoryFrameBatch(ctx, query) as T;
  }

  if (parts.length === 1 && parts[0] === 'timeline-index') {
    return await projectTimelineIndex(ctx, query) as T;
  }

  if (parts.length === 1 && parts[0] === 'activity') {
    return await projectActivityPage(ctx, query) as T;
  }

  if (parts.length === 1 && parts[0] === 'frame-receipts') {
    if (!ctx.readFrameReceipts) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'frame receipt reads are unavailable for this adapter');
    }
    return await ctx.readFrameReceipts(query) as T;
  }

  if (parts.length === 1 && parts[0] === 'solvency-summary') {
    return projectSolvencySummary(ctx, query) as T;
  }

  if (parts[0] === 'recovery' && parts[1] === 'bundles' && parts.length === 3) {
    const lookupKey = decodeURIComponent(parts[2] || '').trim();
    if (!lookupKey) throw new RuntimeAdapterError('E_BAD_PATH', 'recovery lookup key is required');
    return await buildPeerRecoveryBundleRead(ctx, lookupKey) as T;
  }

  return resolveScopedRuntimeAdapterRead<T>(ctx, parts, query);
};

/**
 * Resolve one externally visible read against a stable committed Runtime view.
 *
 * Runtime mutates its owned State in place before the asynchronous WAL append.
 * The lease prevents that writer from starting while a read is in progress and
 * prevents a read from observing RAM between mutation and durable commit.
 */
export const resolveRuntimeAdapterRead = async <T = unknown>(
  ctx: RuntimeAdapterResolveContext,
  path: string,
  query?: RuntimeAdapterReadQuery,
): Promise<T> => {
  const parts = normalizePath(path);
  if (parts.length === 1 && parts[0] === 'payment-routes') {
    // Route search refreshes gossip over the network (up to about 1 s) and
    // takes the committed-read lease itself, only around the graph search.
    // Holding the lease across that wait let any inspect token stall frames.
    if (!ctx.findPaymentRoutes) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route reads are unavailable for this adapter');
    }
    return detachRuntimeAdapterPayload(await ctx.findPaymentRoutes(query)) as T;
  }
  const release = await acquireRuntimeCommittedRead(ctx.env);
  try {
    const projection = await resolveRuntimeAdapterReadFromCommittedState<T>(ctx, path, query);
    /**
     * The committed-read lease protects only this function. Returning references
     * into the live Runtime would let an embedded caller observe the next
     * in-place frame after the lease is released. Adapter payloads are bounded
     * transport DTOs, so taking ownership here is cheap and never clones the
     * Runtime's unbounded Entity/Account maps.
     */
    return detachRuntimeAdapterPayload(projection);
  } finally {
    release();
  }
};
