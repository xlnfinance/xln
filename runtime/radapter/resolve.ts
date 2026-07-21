import type { BookState, BookOrderState, PriceBucketState, PriceLevelState } from '../orderbook';
import type { AccountTx, EntityReplica, EntityState, Env, ExternalWalletState } from '../types';
import type { JBatch, JBatchState, SentJBatch } from '../jurisdiction/batch';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  STORAGE_SCHEMA_VERSION,
  normalizeEntityId,
} from '../storage/keys';
import {
  projectAccountDoc,
  projectEntityCoreDoc,
  projectEntityReplicaCoreView,
} from '../storage/projections';
import type {
  StorageAccountDoc,
  StorageEntityCoreDoc,
  StorageFrameRecord,
  StorageHead,
} from '../storage/types';
import { compareAscii, sortedStringMapKeys, sortedStringMapStartIndex } from '../storage/sorted-index';
import { RuntimeAdapterError } from './errors';
import { encodeRuntimeAdapterMessage, runtimeAdapterMaxMessageBytes } from './codec';
import { XLN_PROTOCOL_VERSION } from '../protocol/version';
import { buildRuntimeRecoveryBundle } from '../recovery/bundle';
import {
  deriveRuntimeRecoveryLookupKey,
  encryptRuntimeRecoveryBundle,
} from '../recovery/crypto';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoverySignerV1,
} from '../recovery/types';
import type { RuntimeActivityFilters } from '../api/activity-history';
import type {
  RuntimeAdapterActivityPage,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterPaymentRoutesResponse,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSolvencySummary,
  RuntimeAdapterTimelineIndexPage,
} from './types';

type RuntimeAdapterEntityCoreDoc = StorageEntityCoreDoc & {
  signerId?: string;
  isProposer?: boolean;
  entityEncPubKey?: string;
  entityEncPrivKey?: '';
  htlcNotes?: EntityState['htlcNotes'];
};
import type { Profile } from '../networking/gossip';
import {
  projectRuntimeIngressReceiptForWire,
  type RuntimeIngressReceipt,
} from '../server/ingress-receipts';
import { calculateSolvency } from '../account/solvency';

export type RuntimeAdapterResolveContext = {
  env: Env;
  readHead?: () => Promise<StorageHead | null>;
  readFrame?: (height: number) => Promise<StorageFrameRecord | null>;
  listCheckpoints?: () => Promise<number[]>;
  loadEntityState?: (entityId: string, height: number) => Promise<EntityState | null>;
  loadEntityAccountDoc?: (entityId: string, counterpartyId: string, height: number) => Promise<StorageAccountDoc | null>;
  loadEntityViewPage?: (
    entityId: string,
    height: number,
    query?: RuntimeAdapterReadQuery,
  ) => Promise<{
    core: RuntimeAdapterEntityCoreDoc;
    accounts: RuntimeAdapterAccountPage;
    books: RuntimeAdapterBookPage;
  } | null>;
  listEntityIdsAtHeight?: (height: number) => Promise<string[]>;
  readActivityPage?: (
    opts: RuntimeActivityFilters & {
      beforeHeight?: number | undefined;
      limit?: number | undefined;
      scanLimit?: number | undefined;
    },
  ) => Promise<RuntimeAdapterActivityPage>;
  readReceipt?: (id: string) => Promise<RuntimeIngressReceipt | null> | RuntimeIngressReceipt | null;
  readFrameReceipts?: (query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterFrameReceiptResponse>;
  findPaymentRoutes?: (query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterPaymentRoutesResponse>;
};

export type RuntimeAdapterAccountPage = {
  items: StorageAccountDoc[];
  nextCursor: string | null;
  prevCursor?: string | null;
  firstCursor?: string | null;
  lastCursor?: string | null;
  pageIndex?: number;
  pageCount?: number;
  totalItems?: number;
  limit?: number;
  summary?: RuntimeAdapterAccountPageSummary;
};

export type RuntimeAdapterBookPage = {
  items: Array<{ pairId: string; book: BookState }>;
  nextCursor: string | null;
  prevCursor?: string | null;
  firstCursor?: string | null;
  lastCursor?: string | null;
  pageIndex?: number;
  pageCount?: number;
  totalItems?: number;
  limit?: number;
};

export type RuntimeAdapterVisibleDeltaSummary = {
  counterpartyId: string;
  tokenId: number;
  delta: string;
};

export type RuntimeAdapterAccountPageSummary = {
  totalItems: number | null;
  visibleItems: number;
  limit: number;
  pageIndex: number | null;
  pageCount: number | null;
  hasMore: boolean;
  sampleIds: string[];
  pageStateHashes: string[];
  visibleTopDeltas: RuntimeAdapterVisibleDeltaSummary[];
};

export type RuntimeAdapterViewEntityFrame = {
  summary: RuntimeAdapterEntitySummary;
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
};

export type RuntimeAdapterViewFrame = {
  head: StorageHead;
  height: number;
  entities: RuntimeAdapterEntitySummary[];
  activeEntityId: string | null;
  activeEntity: RuntimeAdapterViewEntityFrame | null;
};

export type RuntimeAdapterGraphEntityCore = {
  entityId: string;
  signerId?: string;
  height: number;
  timestamp: number;
  prevFrameHash?: string;
  reserves: StorageEntityCoreDoc['reserves'];
  profile: Pick<StorageEntityCoreDoc['profile'], 'name' | 'isHub'>;
  isHub?: boolean;
};

export type RuntimeAdapterGraphAccountActivity = {
  type: string;
  tokenId?: number;
  amount?: bigint;
  fromEntityId?: string;
  toEntityId?: string;
};

export type RuntimeAdapterGraphAccountFrame = Pick<
  StorageAccountDoc['currentFrame'],
  'height' | 'timestamp' | 'jHeight' | 'prevFrameHash' | 'accountStateRoot' | 'stateHash' | 'byLeft'
> & {
  accountTxs: RuntimeAdapterGraphAccountActivity[];
  accountTxCount: number;
};

export type RuntimeAdapterGraphAccount = {
  leftEntity: string;
  rightEntity: string;
  status: StorageAccountDoc['status'];
  mempool: RuntimeAdapterGraphAccountActivity[];
  mempoolCount: number;
  currentFrame: RuntimeAdapterGraphAccountFrame;
  deltas: StorageAccountDoc['deltas'];
  currentHeight: number;
  pendingFrame?: RuntimeAdapterGraphAccountFrame;
  rollbackCount: number;
  lastRollbackFrameHash?: string;
  activeDispute?: {
    startedByLeft: boolean;
    disputeTimeout: number;
    initialDisputeNonce: number;
  };
};

export type RuntimeAdapterGraphAccountPage = Omit<RuntimeAdapterAccountPage, 'items' | 'summary'> & {
  items: RuntimeAdapterGraphAccount[];
};

export type RuntimeAdapterGraphEntityFrame = {
  summary: RuntimeAdapterEntitySummary;
  core: RuntimeAdapterGraphEntityCore | null;
  accounts: RuntimeAdapterGraphAccountPage;
};

/**
 * Complete, bounded graph projection for one runtime frame.
 *
 * Unlike view-frame this payload is not scoped to the currently inspected
 * entity. Local entities carry every account observation within the global
 * graph bound; discovered gossip/account peers are retained as summary-only
 * nodes. If either bound is exceeded, the consumer gets E_BAD_QUERY instead
 * of a partial topology.
 */
export type RuntimeAdapterGraphFrame = {
  head: StorageHead;
  runtimeId: string;
  height: number;
  timestamp: number;
  stateHash: string;
  entities: RuntimeAdapterGraphEntityFrame[];
};

export type RuntimeAdapterHistoryFrameBatch = {
  requestedHeights: number[];
  frames: RuntimeAdapterViewFrame[];
  unavailable: Array<{
    height: number;
    code: string;
    message: string;
  }>;
};

export type RuntimeAdapterFrameSummary = {
  height: number;
  timestamp: number;
  prevFrameHash?: string;
  frameHash?: string;
  stateHash: string;
  hashMode?: StorageFrameRecord['hashMode'];
  materializedState?: boolean;
  canonicalStateHash?: string;
  entityHashes?: StorageFrameRecord['entityHashes'];
  canonicalEntityHashes?: StorageFrameRecord['canonicalEntityHashes'];
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
    overlays: number;
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

const readBoundedLimit = (rawValue: unknown, fallback: number): number => {
  const raw = Number(rawValue ?? fallback);
  if (!Number.isFinite(raw)) throw new RuntimeAdapterError('E_BAD_QUERY', 'limit must be finite');
  return Math.max(1, Math.min(500, Math.floor(raw)));
};

const readAtHeight = (query?: RuntimeAdapterReadQuery): number | null => {
  if (query?.atHeight === undefined) return null;
  const raw = Number(query.atHeight);
  if (!Number.isFinite(raw) || raw < 1) throw new RuntimeAdapterError('E_BAD_QUERY', 'atHeight must be a positive integer');
  return Math.floor(raw);
};

const readHeightBatch = (query?: RuntimeAdapterReadQuery): number[] => {
  const raw = query?.heights;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((part) => part.trim()).filter(Boolean)
      : [];
  if (values.length === 0) throw new RuntimeAdapterError('E_BAD_QUERY', 'heights must contain at least one height');
  if (values.length > 128) throw new RuntimeAdapterError('E_BAD_QUERY', 'heights batch is capped at 128');
  const heights: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const height = Number(value);
    if (!Number.isFinite(height) || height < 1 || !Number.isInteger(height)) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'heights must be positive integers');
    }
    if (seen.has(height)) continue;
    seen.add(height);
    heights.push(height);
  }
  return heights;
};

const normalizeRuntimeIdForRecovery = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const inferRecoverySignersForAdapter = (env: Env): RuntimeRecoverySignerV1[] => {
  const runtimeId = normalizeRuntimeIdForRecovery(env.runtimeId);
  if (!runtimeId) return [];
  let entityId = '';
  let jurisdiction = '';
  let name = 'Runtime signer';
  for (const [key, replica] of env.eReplicas?.entries?.() || []) {
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
  const bundle = buildRuntimeRecoveryBundle(ctx.env, {
    signers: inferRecoverySignersForAdapter(ctx.env),
    createdAt: Math.max(0, Math.floor(Number(ctx.env.timestamp || ctx.env.height || 0))),
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

const envHeight = (env: Env): number => Math.max(0, Math.floor(Number(env.height ?? 0)));

const latestHeadHeight = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));

const headMaterializedHeight = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)));

const headSnapshotHeight = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestSnapshotHeight ?? 0)));

const assertRequestedHeightAvailable = (
  requestedHeight: number,
  head: StorageHead,
  scope: string,
): void => {
  const latestHeight = latestHeadHeight(head);
  if (requestedHeight > latestHeight) {
    throw new RuntimeAdapterError(
      'E_NOT_FOUND',
      `${scope} height unavailable: requested=${requestedHeight} latest=${latestHeight}`,
    );
  }
};

const findReplica = (env: Env, entityId: string): EntityReplica | null => {
  const normalized = normalizeEntityId(entityId);
  for (const replica of env.eReplicas?.values?.() ?? []) {
    if (normalizeEntityId(replica.entityId) === normalized) return replica;
  }
  return null;
};

const labelForState = (state: EntityState): string => {
  const name = String(state.profile?.name || '').trim();
  return name || state.entityId;
};

const isHubState = (state: EntityState): boolean =>
  state.profile?.isHub === true || Boolean(state.orderbookExt?.hubProfile);

const jurisdictionSummary = (jurisdiction: unknown): RuntimeAdapterEntitySummary['jurisdiction'] | undefined => {
  if (!jurisdiction || typeof jurisdiction !== 'object') return undefined;
  const value = jurisdiction as {
    name?: unknown;
    address?: unknown;
    chainId?: unknown;
    depositoryAddress?: unknown;
    entityProviderAddress?: unknown;
  };
  const name = String(value.name ?? '').trim();
  const address = String(value.address ?? '').trim();
  const chainId = value.chainId as number | string | undefined;
  const depositoryAddress = String(value.depositoryAddress ?? '').trim();
  const entityProviderAddress = String(value.entityProviderAddress ?? '').trim();
  if (!name && !address && chainId === undefined && !depositoryAddress && !entityProviderAddress) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(chainId !== undefined ? { chainId } : {}),
    ...(depositoryAddress ? { depositoryAddress } : {}),
    ...(entityProviderAddress ? { entityProviderAddress } : {}),
  };
};

const summaryFromProfile = (
  profile: Profile,
  fallbackHeight: number,
): RuntimeAdapterEntitySummary | null => {
  const entityId = normalizeEntityId(profile.entityId);
  if (!entityId) return null;
  const profileName = String(profile.name || profile.metadata?.hubName || '').trim();
  const jurisdiction = jurisdictionSummary(profile.metadata?.jurisdiction);
  const runtimeId = normalizeEntityId(profile.runtimeId);
  return {
    entityId,
    ...(runtimeId ? { runtimeId } : {}),
    label: profileName || entityId,
    height: Math.max(0, Math.floor(Number(profile.lastUpdated || fallbackHeight || 0))),
    ...(profile.metadata?.isHub === true ? { isHub: true } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
  };
};

const mergeEntitySummaries = (
  summaries: RuntimeAdapterEntitySummary[],
  additions: RuntimeAdapterEntitySummary[],
): RuntimeAdapterEntitySummary[] => {
  const byEntityId = new Map<string, RuntimeAdapterEntitySummary>();
  const mergeSummary = (
    existing: RuntimeAdapterEntitySummary | undefined,
    summary: RuntimeAdapterEntitySummary,
    entityId: string,
  ): RuntimeAdapterEntitySummary => {
    const merged: RuntimeAdapterEntitySummary = {
      ...(existing ?? {}),
      ...summary,
      entityId,
    };
    if (!summary.jurisdiction && existing?.jurisdiction) merged.jurisdiction = existing.jurisdiction;
    if ((!summary.label || summary.label === entityId) && existing?.label) merged.label = existing.label;
    if (summary.isHub === true || existing?.isHub === true) merged.isHub = true;
    return merged;
  };
  for (const summary of additions) {
    const entityId = normalizeEntityId(summary.entityId);
    if (!entityId) continue;
    byEntityId.set(entityId, { ...summary, entityId });
  }
  for (const summary of summaries) {
    const entityId = normalizeEntityId(summary.entityId);
    if (!entityId) continue;
    byEntityId.set(entityId, mergeSummary(byEntityId.get(entityId), summary, entityId));
  }
  return Array.from(byEntityId.values()).sort((left, right) => compareAscii(left.entityId, right.entityId));
};

const listLiveGossipProfileSummaries = (ctx: RuntimeAdapterResolveContext): RuntimeAdapterEntitySummary[] => {
  const profiles = ctx.env.gossip?.getProfiles?.() ?? [];
  const height = envHeight(ctx.env);
  const summaries: RuntimeAdapterEntitySummary[] = [];
  for (const profile of profiles) {
    const summary = summaryFromProfile(profile, height);
    if (summary) summaries.push(summary);
  }
  return summaries;
};

const headFromEnv = (env: Env): StorageHead => {
  const storage = env.runtimeConfig?.storage;
  const height = envHeight(env);
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: height,
    latestMaterializedHeight: height,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: Math.max(
      1,
      Number(storage?.snapshotPeriodFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES),
    ),
    retainSnapshots: Math.max(1, Number(storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS)),
    epochMaxBytes: Math.max(1, Number(storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES)),
    accountMerkleRadix: storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
    retainedHistoryBytes: 0,
  };
};

const readBestHead = async (ctx: RuntimeAdapterResolveContext): Promise<StorageHead> => {
  const fallback = headFromEnv(ctx.env);
  if (!ctx.readHead) return fallback;
  const stored = await ctx.readHead();
  if (!stored) return fallback;
  const liveHeight = envHeight(ctx.env);
  if (latestHeadHeight(stored) >= liveHeight) return stored;
  const latestHeight = Math.max(liveHeight, latestHeadHeight(stored));
  return {
    ...stored,
    latestHeight,
    latestMaterializedHeight: Math.min(latestHeight, Math.max(headMaterializedHeight(stored), headMaterializedHeight(fallback))),
    latestSnapshotHeight: Math.min(latestHeight, Math.max(headSnapshotHeight(stored), headSnapshotHeight(fallback))),
    retainedHistoryBytes: Math.max(
      0,
      Math.floor(Number(stored.retainedHistoryBytes ?? fallback.retainedHistoryBytes ?? 0)),
    ),
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

const listLiveEntitySummaries = (
  ctx: RuntimeAdapterResolveContext,
): RuntimeAdapterEntitySummary[] => {
  const liveReplicas = Array.from(ctx.env.eReplicas?.values?.() ?? [])
    .map((replica) => {
      const isHub = isHubState(replica.state);
      const jurisdiction = jurisdictionSummary(replica.state.config?.jurisdiction);
      const runtimeId = normalizeEntityId(String(ctx.env.runtimeId || ''));
      return {
        entityId: normalizeEntityId(replica.entityId),
        ...(runtimeId ? { runtimeId } : {}),
        ...withDefinedProp('signerId', replica.signerId),
        label: labelForState(replica.state),
        height: Math.max(0, Math.floor(Number(replica.state.height ?? 0))),
        ...(isHub ? { isHub: true } : {}),
        ...(jurisdiction ? { jurisdiction } : {}),
      };
    });
  return mergeEntitySummaries(liveReplicas, listLiveGossipProfileSummaries(ctx));
};

const listEntitySummaries = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
  options: { allowPartial?: boolean; forceStorageAtHeight?: boolean } = {},
): Promise<RuntimeAdapterEntitySummary[]> => {
  const height = readAtHeight(query);
  const useStorage = height !== null
    && (options.forceStorageAtHeight === true || height !== envHeight(ctx.env));
  if (useStorage) {
    if (ctx.readHead) {
      const head = await ctx.readHead();
      if (!head) throw new RuntimeAdapterError('E_NOT_FOUND', `storage head not found at height ${height}`);
      assertRequestedHeightAvailable(height, head, 'entity summary');
    }
    if (!ctx.listEntityIdsAtHeight) {
      throw new RuntimeAdapterError('E_INTERNAL', 'storage entity listing is required for historical reads');
    }
    const ids = await ctx.listEntityIdsAtHeight(height);
    const summaries: RuntimeAdapterEntitySummary[] = [];
    const requestedEntityId = normalizeEntityId(String(query?.entityId || ''));
    const ctxRuntimeId = normalizeEntityId(String(ctx.env.runtimeId || ''));
    for (const id of ids) {
      const normalizedId = normalizeEntityId(id);
      const loadedView = ctx.loadEntityViewPage
        ? await ctx.loadEntityViewPage(id, height, { limit: 1, accountsLimit: 1, booksLimit: 1 })
        : null;
      const loaded = !loadedView && ctx.loadEntityState ? await ctx.loadEntityState(id, height) : null;
      if (!loadedView && !loaded) {
        if (options.allowPartial && (!requestedEntityId || normalizedId !== requestedEntityId)) continue;
        throw new RuntimeAdapterError('E_NOT_FOUND', `entity summary not found at height ${height}: ${normalizedId}`);
      }
      const profileName = loadedView ? String(loadedView.core.profile?.name || '').trim() : '';
      const isHub = loadedView
        ? loadedView.core.profile?.isHub === true || Boolean(loadedView.core.orderbookHubProfile)
        : loaded ? isHubState(loaded) : false;
      const jurisdiction = jurisdictionSummary(loadedView?.core.config?.jurisdiction ?? loaded?.config?.jurisdiction);
      summaries.push({
        entityId: normalizedId,
        ...(ctxRuntimeId ? { runtimeId: ctxRuntimeId } : {}),
        ...withDefinedProp('signerId', loadedView?.core.signerId),
        label: profileName || (loaded ? labelForState(loaded) : normalizedId),
        height: loadedView?.core.height ?? loaded?.height ?? height,
        ...(isHub ? { isHub: true } : {}),
        ...(jurisdiction ? { jurisdiction } : {}),
      });
    }
    if (summaries.length === 0 && ids.length > 0) {
      throw new RuntimeAdapterError('E_NOT_FOUND', `entity summary not found at height ${height}`);
    }
    return summaries.sort((left, right) => compareAscii(left.entityId, right.entityId));
  }

  return listLiveEntitySummaries(ctx);
};

const readPageIndex = (rawValue: unknown): number => {
  if (rawValue === undefined || rawValue === null || rawValue === '') return -1;
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw < 0) throw new RuntimeAdapterError('E_BAD_QUERY', 'page index must be a non-negative integer');
  return Math.floor(raw);
};

const buildPageMeta = (
  keys: readonly string[],
  start: number,
  limit: number,
  visibleKeys: readonly string[],
): Omit<RuntimeAdapterAccountPage, 'items'> => {
  const safeLimit = Math.max(1, limit);
  return {
    nextCursor: start + safeLimit < keys.length ? visibleKeys[visibleKeys.length - 1] ?? null : null,
    prevCursor: start > 0 ? keys[Math.max(0, start - safeLimit)] ?? null : null,
    firstCursor: visibleKeys[0] ?? null,
    lastCursor: visibleKeys[visibleKeys.length - 1] ?? null,
    pageIndex: Math.floor(start / safeLimit),
    pageCount: Math.ceil(keys.length / safeLimit),
    totalItems: keys.length,
    limit: safeLimit,
  };
};

const emptyPageMeta = (limit: number): Omit<RuntimeAdapterAccountPage, 'items'> => ({
  nextCursor: null,
  prevCursor: null,
  firstCursor: null,
  lastCursor: null,
  pageIndex: 0,
  pageCount: 0,
  totalItems: 0,
  limit,
});

const singleAccountPage = (
  accountId: string,
  account: StorageAccountDoc | null,
  limit: number,
): RuntimeAdapterAccountPage => account
  ? {
      items: [account],
      nextCursor: null,
      prevCursor: null,
      firstCursor: accountId,
      lastCursor: accountId,
      pageIndex: 0,
      pageCount: 1,
      totalItems: 1,
      limit,
    }
  : { items: [], ...emptyPageMeta(limit) };

const projectLiveAccountsPage = (
  state: EntityState,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterAccountPage => {
  const limit = readBoundedLimit(query?.accountsLimit ?? query?.limit, 10);
  const accountId = normalizeEntityId(String(query?.accountId || ''));
  if (accountId) {
    const account = state.accounts.get(accountId);
    return singleAccountPage(accountId, account ? projectAccountDoc(account) : null, limit);
  }
  const cursor = normalizeEntityId(String(query?.accountsCursor ?? query?.cursor ?? ''));
  const pageIndex = readPageIndex(query?.accountsPage);
  const orderedKeys = sortedStringMapKeys(state.accounts as Map<string, unknown>);
  const keys = query?.sortDir === 'desc' ? [...orderedKeys].reverse() : orderedKeys;
  const start = sortedStringMapStartIndex(keys, cursor, pageIndex, limit);
  const visibleKeys = keys.slice(start, start + limit);
  return {
    items: visibleKeys.map((id) => {
      const account = state.accounts.get(id);
      if (!account) throw new RuntimeAdapterError('E_INTERNAL', `live account index is stale: ${id}`);
      return projectAccountDoc(account);
    }),
    ...buildPageMeta(keys, start, limit, visibleKeys),
  };
};

const projectLiveBooksPage = (
  state: EntityState,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterBookPage => {
  const limit = readBoundedLimit(query?.booksLimit ?? query?.limit, 10);
  const cursor = String(query?.booksCursor ?? query?.cursor ?? '').trim();
  const books = state.orderbookExt?.books;
  if (!books) {
    return { items: [], ...emptyPageMeta(limit) };
  }
  const pageIndex = readPageIndex(query?.booksPage);
  const orderedKeys = sortedStringMapKeys(books as Map<string, unknown>);
  const keys = query?.sortDir === 'desc' ? [...orderedKeys].reverse() : orderedKeys;
  const start = sortedStringMapStartIndex(keys, cursor, pageIndex, limit);
  const visibleKeys = keys.slice(start, start + limit);
  return {
    items: visibleKeys.map((pairId) => {
      const book = books.get(pairId);
      if (!book) throw new RuntimeAdapterError('E_INTERNAL', `live book index is stale: ${pairId}`);
      return { pairId, book };
    }),
    ...buildPageMeta(keys, start, limit, visibleKeys),
  };
};

const projectLiveEntityViewPage = (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  query?: RuntimeAdapterReadQuery,
): {
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
} => {
  const replica = findReplica(ctx.env, entityId);
  if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
  return {
    core: projectEntityReplicaCoreView(replica.state, replica),
    accounts: projectLiveAccountsPage(replica.state, query),
    books: projectLiveBooksPage(replica.state, query),
  };
};

const loadRequiredEntityViewPage = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  height: number,
  query?: RuntimeAdapterReadQuery,
): Promise<{
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}> => {
  if (!ctx.loadEntityViewPage) {
    throw new RuntimeAdapterError('E_INTERNAL', 'storage view page loader is required for paged entity reads');
  }
  const stored = await ctx.loadEntityViewPage(entityId, height, query);
  if (!stored) throw new RuntimeAdapterError('E_NOT_FOUND', `entity view not found at height ${height}: ${normalizeEntityId(entityId)}`);
  return stored;
};

const withDefinedProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const compactArrayTail = <T>(value: readonly T[] | undefined, limit = 20): T[] | undefined =>
  Array.isArray(value) ? value.slice(-limit) : undefined;

const compactMapHead = <K, V>(value: Map<K, V> | undefined, limit = 20): Map<K, V> | undefined =>
  value instanceof Map ? new Map(Array.from(value.entries()).slice(0, limit)) : undefined;

const compactMapTail = <K, V>(value: Map<K, V> | undefined, limit = 20): Map<K, V> | undefined =>
  value instanceof Map ? new Map(Array.from(value.entries()).slice(-limit)) : undefined;

const compactRecordTail = <V>(value: Record<string, V> | undefined, limit = 20): Record<string, V> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).slice(-limit));
};

const compactAccountFrameForView = (
  frame: StorageAccountDoc['currentFrame'],
  txLimit = 20,
  deltaLimit = 100,
): StorageAccountDoc['currentFrame'] => ({
  height: frame.height,
  timestamp: frame.timestamp,
  jHeight: frame.jHeight,
  accountTxs: compactArrayTail(frame.accountTxs, txLimit) ?? [],
  prevFrameHash: frame.prevFrameHash,
  accountStateRoot: frame.accountStateRoot,
  stateHash: frame.stateHash,
  ...withDefinedProp('byLeft', frame.byLeft),
  deltas: Array.isArray(frame.deltas) ? frame.deltas.slice(0, deltaLimit) : [],
});

const compactAccountProofBodyForView = (proofBody: StorageAccountDoc['proofBody']): StorageAccountDoc['proofBody'] => ({
  tokenIds: proofBody.tokenIds.slice(0, 100),
  deltas: proofBody.deltas.slice(0, 100),
  ...withDefinedProp('htlcLocks', compactArrayTail(proofBody.htlcLocks, 20)),
});

const compactAccountDocForView = (doc: StorageAccountDoc): StorageAccountDoc => {
  const compact: StorageAccountDoc = {
    leftEntity: doc.leftEntity,
    rightEntity: doc.rightEntity,
    domain: structuredClone(doc.domain),
    watchSeed: '',
    status: doc.status,
    mempool: [],
    currentFrame: compactAccountFrameForView(doc.currentFrame),
    deltas: compactMapHead(doc.deltas, 100) ?? new Map(),
    locks: compactMapTail(doc.locks, 20) ?? new Map(),
    swapOffers: new Map(),
    globalCreditLimits: doc.globalCreditLimits,
    currentHeight: doc.currentHeight,
    pendingSignatures: [],
    rollbackCount: doc.rollbackCount,
    leftPendingJClaims: doc.leftPendingJClaims,
    rightPendingJClaims: doc.rightPendingJClaims,
    lastFinalizedJHeight: doc.lastFinalizedJHeight,
    proofHeader: doc.proofHeader,
    proofBody: compactAccountProofBodyForView(doc.proofBody),
    disputeConfig: doc.disputeConfig,
    jNonce: doc.jNonce,
    pendingWithdrawals: compactMapTail(doc.pendingWithdrawals, 20) ?? new Map(),
    requestedRebalance: compactMapHead(doc.requestedRebalance, 100) ?? new Map(),
    requestedRebalanceFeeState: compactMapHead(doc.requestedRebalanceFeeState, 100) ?? new Map(),
    shadow: {
      rebalance: {
        policy: compactMapHead(doc.shadow.rebalance.policy, 100) ?? new Map(),
        submittedAtByToken: compactMapHead(doc.shadow.rebalance.submittedAtByToken, 100) ?? new Map(),
        ...(doc.shadow.rebalance.activeQuote ? { activeQuote: doc.shadow.rebalance.activeQuote } : {}),
        ...(doc.shadow.rebalance.pendingRequest ? { pendingRequest: doc.shadow.rebalance.pendingRequest } : {}),
      },
    },
  };

  const pulls = compactMapTail(doc.pulls, 20);
  if (pulls) compact.pulls = pulls;
  if (doc.pendingFrame) compact.pendingFrame = compactAccountFrameForView(doc.pendingFrame);
  if (doc.lastOutboundFrameAck) compact.lastOutboundFrameAck = doc.lastOutboundFrameAck;
  if (doc.pendingForwards) compact.pendingForwards = doc.pendingForwards;
  if (doc.hankoSignature) compact.hankoSignature = doc.hankoSignature;
  if (doc.lastRollbackFrameHash) compact.lastRollbackFrameHash = doc.lastRollbackFrameHash;
  if (doc.currentFrameHanko) compact.currentFrameHanko = doc.currentFrameHanko;
  if (doc.counterpartyFrameHanko) compact.counterpartyFrameHanko = doc.counterpartyFrameHanko;
  if (doc.boardResealMigration) compact.boardResealMigration = { ...doc.boardResealMigration };
  if (doc.currentDisputeProofHanko) compact.currentDisputeProofHanko = doc.currentDisputeProofHanko;
  if (doc.currentDisputeProofNonce !== undefined) compact.currentDisputeProofNonce = doc.currentDisputeProofNonce;
  if (doc.currentDisputeProofBodyHash) compact.currentDisputeProofBodyHash = doc.currentDisputeProofBodyHash;
  if (doc.currentDisputeHash) compact.currentDisputeHash = doc.currentDisputeHash;
  if (doc.counterpartyDisputeProofHanko) compact.counterpartyDisputeProofHanko = doc.counterpartyDisputeProofHanko;
  if (doc.counterpartyDisputeProofNonce !== undefined) compact.counterpartyDisputeProofNonce = doc.counterpartyDisputeProofNonce;
  if (doc.counterpartyDisputeProofBodyHash) compact.counterpartyDisputeProofBodyHash = doc.counterpartyDisputeProofBodyHash;
  if (doc.counterpartyDisputeHash) compact.counterpartyDisputeHash = doc.counterpartyDisputeHash;
  if (doc.counterpartySettlementHanko) compact.counterpartySettlementHanko = doc.counterpartySettlementHanko;
  const disputeProofNoncesByHash = compactRecordTail(doc.disputeProofNoncesByHash, 20);
  if (disputeProofNoncesByHash) compact.disputeProofNoncesByHash = disputeProofNoncesByHash;
  if (doc.rebalanceFeePolicies) compact.rebalanceFeePolicies = doc.rebalanceFeePolicies;
  return compact;
};

const compactDebtLedgerForView = (
  value: StorageEntityCoreDoc['outDebtsByToken'] | StorageEntityCoreDoc['inDebtsByToken'],
  outerLimit = 20,
  innerLimit = 20,
): typeof value => {
  if (!(value instanceof Map)) return undefined;
  return new Map(Array.from(value.entries()).slice(0, outerLimit).map(([tokenId, bucket]) => [
    tokenId,
    bucket instanceof Map ? new Map(Array.from(bucket.entries()).slice(0, innerLimit)) : bucket,
  ]));
};

const compactExternalWalletMap = <V>(
  value: Map<string, Map<string, V>>,
  outerLimit = 20,
  innerLimit = 20,
): Map<string, Map<string, V>> =>
  new Map(Array.from(value.entries()).slice(0, outerLimit).map(([owner, records]) => [
    owner,
    records instanceof Map ? new Map(Array.from(records.entries()).slice(0, innerLimit)) : new Map(),
  ]));

const compactExternalWalletForView = (wallet: ExternalWalletState | undefined): ExternalWalletState | undefined =>
  wallet
    ? {
      balances: compactExternalWalletMap(wallet.balances),
      allowances: compactExternalWalletMap(wallet.allowances),
    }
    : undefined;

const compactHubProfileForView = (profile: StorageEntityCoreDoc['orderbookHubProfile']): StorageEntityCoreDoc['orderbookHubProfile'] | undefined =>
  profile
    ? {
      ...profile,
      supportedPairs: profile.supportedPairs.slice(0, 50),
    }
    : undefined;

const BATCH_VIEW_OP_LIMIT = 50;

const compactProofBodyForBatchView = (proofBody: unknown): unknown => {
  if (!proofBody || typeof proofBody !== 'object') return proofBody;
  const body = proofBody as {
    watchSeed?: unknown;
    offdeltas?: unknown[];
    tokenIds?: unknown[];
    transformers?: Array<{ allowances?: unknown[] }>;
  };
  return {
    ...body,
    watchSeed: '',
    offdeltas: compactArrayTail(body.offdeltas, 100) ?? [],
    tokenIds: compactArrayTail(body.tokenIds, 100) ?? [],
    transformers: compactArrayTail(body.transformers, 20)?.map((transformer) => ({
      ...transformer,
      allowances: compactArrayTail(transformer.allowances, 50) ?? [],
    })) ?? [],
  };
};

const compactJBatchForView = (batch: JBatch | undefined): JBatch | undefined => {
  if (!batch) return undefined;
  return {
    flashloans: compactArrayTail(batch.flashloans, BATCH_VIEW_OP_LIMIT) ?? [],
    reserveToReserve: compactArrayTail(batch.reserveToReserve, BATCH_VIEW_OP_LIMIT) ?? [],
    reserveToCollateral: (compactArrayTail(batch.reserveToCollateral, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      pairs: compactArrayTail(op.pairs, BATCH_VIEW_OP_LIMIT) ?? [],
    })),
    collateralToReserve: compactArrayTail(batch.collateralToReserve, BATCH_VIEW_OP_LIMIT) ?? [],
    settlements: (compactArrayTail(batch.settlements, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      diffs: compactArrayTail(op.diffs, 100) ?? [],
      forgiveDebtsInTokenIds: compactArrayTail(op.forgiveDebtsInTokenIds, 100) ?? [],
      sig: op.sig ? '[redacted]' : '',
      hankoData: op.hankoData ? '[redacted]' : '',
    })),
    disputeStarts: (compactArrayTail(batch.disputeStarts, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      initialProofbody: compactProofBodyForBatchView(op.initialProofbody) as typeof op.initialProofbody,
      watchSeed: '',
      sig: op.sig ? '[redacted]' : '',
      starterInitialArguments: op.starterInitialArguments ? '[redacted]' : '',
      starterIncrementedArguments: op.starterIncrementedArguments ? '[redacted]' : '',
    })),
    disputeFinalizations: (compactArrayTail(batch.disputeFinalizations, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      finalProofbody: compactProofBodyForBatchView(op.finalProofbody) as typeof op.finalProofbody,
      starterArguments: op.starterArguments ? '[redacted]' : '',
      otherArguments: op.otherArguments ? '[redacted]' : '',
      sig: op.sig ? '[redacted]' : '',
    })),
    externalTokenToReserve: compactArrayTail(batch.externalTokenToReserve, BATCH_VIEW_OP_LIMIT) ?? [],
    reserveToExternalToken: compactArrayTail(batch.reserveToExternalToken, BATCH_VIEW_OP_LIMIT) ?? [],
    revealSecrets: (compactArrayTail(batch.revealSecrets, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      secret: op.secret ? '[redacted]' : '',
    })),
    hub_id: batch.hub_id,
  };
};

const compactSentJBatchForView = (sentBatch: SentJBatch | undefined): SentJBatch | undefined => {
  if (!sentBatch) return undefined;
  const batch = compactJBatchForView(sentBatch.batch);
  if (!batch) return undefined;
  return {
    ...sentBatch,
    batch,
    encodedBatch: sentBatch.encodedBatch ? '[redacted]' : '',
  };
};

const compactJBatchStateForView = (state: JBatchState | undefined): JBatchState | undefined => {
  if (!state) return undefined;
  const batch = compactJBatchForView(state.batch);
  if (!batch) return undefined;
  const compactState: JBatchState = {
    batch,
    jurisdiction: state.jurisdiction,
    lastBroadcast: state.lastBroadcast,
    broadcastCount: state.broadcastCount,
    failedAttempts: state.failedAttempts,
    status: state.status,
  };
  if (typeof state.entityNonce === 'number') compactState.entityNonce = state.entityNonce;
  const sentBatch = compactSentJBatchForView(state.sentBatch);
  if (sentBatch) compactState.sentBatch = sentBatch;
  return compactState;
};

const compactEntityCoreForRemote = (core: RuntimeAdapterEntityCoreDoc): RuntimeAdapterEntityCoreDoc => {
  const compact: RuntimeAdapterEntityCoreDoc = {
    entityId: core.entityId,
    ...withDefinedProp('signerId', core.signerId),
    ...withDefinedProp('isProposer', core.isProposer),
    entityEncPrivKey: '',
    height: core.height,
    timestamp: core.timestamp,
    ...(core.entityEncPubKey ? { entityEncPubKey: core.entityEncPubKey } : {}),
    profile: core.profile,
    config: core.config,
    nonces: compactMapTail(core.nonces, 100) ?? new Map(),
    messages: core.messages.slice(-20),
    proposals: new Map(Array.from(core.proposals.entries()).slice(-20)),
    reserves: compactMapHead(core.reserves, 100) ?? new Map(),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    jBlockChain: core.jBlockChain.slice(-20),
    htlcRoutes: compactMapTail(core.htlcRoutes, 20) ?? new Map(),
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: new Map(Array.from(core.lockBook.entries()).slice(-20)),
  };

  if (core.prevFrameHash) compact.prevFrameHash = core.prevFrameHash;
  const externalWallet = compactExternalWalletForView(core.externalWallet);
  if (externalWallet) compact.externalWallet = externalWallet;
  const deferredAccountProposals = compactMapTail(core.deferredAccountProposals, 20);
  if (deferredAccountProposals) compact.deferredAccountProposals = deferredAccountProposals;
  if (core.batchHistory) compact.batchHistory = core.batchHistory.slice(-20);
  const jBatchState = compactJBatchStateForView(core.jBatchState);
  if (jBatchState) compact.jBatchState = jBatchState;
  if (core.accountInputQueue) compact.accountInputQueue = core.accountInputQueue.slice(-20);
  const htlcNotes = compactMapTail(core.htlcNotes, 20);
  if (htlcNotes) compact.htlcNotes = htlcNotes;
  const outDebtsByToken = compactDebtLedgerForView(core.outDebtsByToken);
  if (outDebtsByToken) compact.outDebtsByToken = outDebtsByToken;
  const inDebtsByToken = compactDebtLedgerForView(core.inDebtsByToken);
  if (inDebtsByToken) compact.inDebtsByToken = inDebtsByToken;
  const pendingSwapFillRatios = compactMapTail(core.pendingSwapFillRatios, 20);
  if (pendingSwapFillRatios) compact.pendingSwapFillRatios = pendingSwapFillRatios;
  if (core.swapTradingPairs) compact.swapTradingPairs = core.swapTradingPairs.slice(0, 50);
  const crossJurisdictionSwaps = compactMapTail(core.crossJurisdictionSwaps, 20);
  if (crossJurisdictionSwaps) compact.crossJurisdictionSwaps = crossJurisdictionSwaps;
  const pendingCrossJurisdictionFillAcks = compactMapTail(core.pendingCrossJurisdictionFillAcks, 20);
  if (pendingCrossJurisdictionFillAcks) compact.pendingCrossJurisdictionFillAcks = pendingCrossJurisdictionFillAcks;
  const crossJurisdictionBookAdmissions = compactMapTail(core.crossJurisdictionBookAdmissions, 20);
  if (crossJurisdictionBookAdmissions) compact.crossJurisdictionBookAdmissions = crossJurisdictionBookAdmissions;
  const orderbookReferrals = compactMapTail(core.orderbookReferrals, 20);
  if (orderbookReferrals) compact.orderbookReferrals = orderbookReferrals;
  const orderbookHubProfile = compactHubProfileForView(core.orderbookHubProfile);
  if (orderbookHubProfile) compact.orderbookHubProfile = orderbookHubProfile;
  if (core.hubRebalanceConfig) compact.hubRebalanceConfig = core.hubRebalanceConfig;
  return compact;
};

const accountCounterpartyIdForView = (entityId: string, doc: StorageAccountDoc): string => {
  const normalized = normalizeEntityId(entityId);
  const left = normalizeEntityId(doc.leftEntity);
  const right = normalizeEntityId(doc.rightEntity);
  return left === normalized ? right : left;
};

const absoluteBigInt = (value: bigint): bigint => value < 0n ? -value : value;

const accountPageSummaryForView = (
  entityId: string,
  page: RuntimeAdapterAccountPage,
): RuntimeAdapterAccountPageSummary => {
  const limit = Math.max(1, Number(page.limit ?? (page.items.length || 1)));
  const totalItems = Number.isFinite(Number(page.totalItems)) ? Math.max(0, Math.floor(Number(page.totalItems))) : null;
  const pageIndex = Number.isFinite(Number(page.pageIndex)) ? Math.max(0, Math.floor(Number(page.pageIndex))) : null;
  const pageCount = Number.isFinite(Number(page.pageCount)) ? Math.max(0, Math.floor(Number(page.pageCount))) : null;
  const sampleIds = page.items.slice(0, 8).map((doc) => accountCounterpartyIdForView(entityId, doc));
  const pageStateHashes = Array.from(new Set(page.items
    .map((doc) => String(doc.currentFrame?.stateHash || doc.currentDisputeProofBodyHash || doc.counterpartyDisputeProofBodyHash || '').trim())
    .filter(Boolean)))
    .slice(0, 8);
  const visibleTopDeltas = page.items
    .flatMap((doc) => {
      const counterpartyId = accountCounterpartyIdForView(entityId, doc);
      return Array.from(doc.deltas.entries()).map(([tokenId, delta]) => {
        const netDelta = BigInt(delta.offdelta ?? 0n) + BigInt(delta.ondelta ?? 0n);
        return {
          counterpartyId,
          tokenId: Number(delta.tokenId ?? tokenId),
          delta: String(netDelta),
          magnitude: absoluteBigInt(netDelta),
        };
      });
    })
    .sort((left, right) => {
      if (left.magnitude === right.magnitude) return compareAscii(left.counterpartyId, right.counterpartyId);
      return left.magnitude > right.magnitude ? -1 : 1;
    })
    .slice(0, 8)
    .map(({ counterpartyId, tokenId, delta }) => ({ counterpartyId, tokenId, delta }));

  return {
    totalItems,
    visibleItems: page.items.length,
    limit,
    pageIndex,
    pageCount,
    hasMore: Boolean(page.nextCursor) || (totalItems !== null && pageIndex !== null && pageCount !== null && pageIndex + 1 < pageCount),
    sampleIds,
    pageStateHashes,
    visibleTopDeltas,
  };
};

const compactBookSideForView = (
  bucketIds: readonly bigint[],
  buckets: ReadonlyMap<string, PriceBucketState>,
  orderSource: ReadonlyMap<string, BookOrderState>,
  maxLevels: number,
  maxOrdersPerLevel: number,
): {
  bucketIds: bigint[];
  buckets: Map<string, PriceBucketState>;
  orders: Map<string, BookOrderState>;
  levels: number;
} => {
  const nextBucketIds: bigint[] = [];
  const nextBuckets = new Map<string, PriceBucketState>();
  const nextOrders = new Map<string, BookOrderState>();
  let levels = 0;

  for (const bucketId of bucketIds) {
    if (levels >= maxLevels) break;
    const sourceBucket = buckets.get(String(bucketId));
    if (!sourceBucket) continue;
    const nextPrices: bigint[] = [];
    const nextLevels = new Map<string, PriceLevelState>();
    for (const priceTicks of sourceBucket.pricesAsc) {
      if (levels >= maxLevels) break;
      const sourceLevel = sourceBucket.levels.get(String(priceTicks));
      if (!sourceLevel) continue;
      if (sourceLevel.totalQtyLots <= 0n) continue;
      const selectedOrderIds: string[] = [];
      for (const orderId of sourceLevel.orderIds) {
        if (selectedOrderIds.length >= maxOrdersPerLevel) break;
        const order = orderSource.get(orderId);
        if (!order || order.qtyLots <= 0n) continue;
        selectedOrderIds.push(orderId);
        nextOrders.set(orderId, order);
      }
      if (selectedOrderIds.length === 0) continue;
      nextPrices.push(priceTicks);
      nextLevels.set(String(priceTicks), {
        priceTicks: sourceLevel.priceTicks,
        orderIds: selectedOrderIds,
        totalQtyLots: sourceLevel.totalQtyLots,
      });
      levels += 1;
    }
    if (nextLevels.size > 0) {
      nextBucketIds.push(bucketId);
      nextBuckets.set(String(bucketId), {
        bucketId: sourceBucket.bucketId,
        pricesAsc: nextPrices,
        levels: nextLevels,
      });
    }
  }

  return { bucketIds: nextBucketIds, buckets: nextBuckets, orders: nextOrders, levels };
};

const compactBookStateForView = (book: BookState, maxLevelsPerSide = 5, maxOrdersPerLevel = 20): BookState => {
  const bids = compactBookSideForView(
    book.bidBucketIdsDesc,
    book.bidBuckets,
    book.orders,
    maxLevelsPerSide,
    maxOrdersPerLevel,
  );
  const asks = compactBookSideForView(
    book.askBucketIdsAsc,
    book.askBuckets,
    book.orders,
    maxLevelsPerSide,
    maxOrdersPerLevel,
  );
  return {
    params: book.params,
    orders: new Map([...bids.orders, ...asks.orders]),
    bidBuckets: bids.buckets,
    askBuckets: asks.buckets,
    bidBucketIdsDesc: bids.bucketIds,
    askBucketIdsAsc: asks.bucketIds,
    nextSeq: book.nextSeq,
    tradeCount: book.tradeCount,
    tradeQtySum: book.tradeQtySum,
    eventHash: book.eventHash,
  };
};

const compactViewPageForRemote = (entityId: string, view: {
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}): {
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
} => ({
  core: compactEntityCoreForRemote(view.core),
  accounts: {
    ...view.accounts,
    items: view.accounts.items.map(compactAccountDocForView),
    summary: accountPageSummaryForView(entityId, view.accounts),
  },
  books: {
    ...view.books,
    items: view.books.items.map((item) => ({
      pairId: item.pairId,
      book: compactBookStateForView(item.book),
    })),
  },
});

const storageHeadCanServeHeight = async (
  ctx: RuntimeAdapterResolveContext,
  height: number,
): Promise<boolean> => {
  if (height < 1) return false;
  if (!ctx.readHead) return false;
  const head = await ctx.readHead();
  if (!head) return false;
  return latestHeadHeight(head) >= height;
};

const loadStorageViewPageIfAvailable = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  height: number,
  query?: RuntimeAdapterReadQuery,
): Promise<{
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
} | null> => {
  if (!ctx.loadEntityViewPage) return null;
  if (!await storageHeadCanServeHeight(ctx, height)) return null;
  const stored = await ctx.loadEntityViewPage!(entityId, height, query);
  return stored ?? null;
};

type RuntimeAdapterReplicaLocalCoreOverlay = {
  signerId: string;
  isProposer: boolean;
  entityEncPubKey: string;
  entityEncPrivKey: '';
  htlcNotes?: EntityState['htlcNotes'];
};

const snapshotReplicaLocalCoreOverlay = (
  replica: EntityReplica | null | undefined,
): RuntimeAdapterReplicaLocalCoreOverlay | null => {
  if (!replica) return null;
  return {
    signerId: normalizeEntityId(replica.signerId),
    isProposer: replica.isProposer,
    entityEncPubKey: replica.state.entityEncPubKey,
    entityEncPrivKey: '',
    ...(replica.state.htlcNotes instanceof Map
      ? { htlcNotes: new Map(replica.state.htlcNotes) }
      : {}),
  };
};

const loadViewPageForHeight = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  height: number,
  isCurrentHeight: boolean,
  query?: RuntimeAdapterReadQuery,
): Promise<{
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}> => {
  if (isCurrentHeight) {
    const localCore = snapshotReplicaLocalCoreOverlay(findReplica(ctx.env, entityId));
    const stored = await loadStorageViewPageIfAvailable(ctx, entityId, height, query);
    if (!stored) return projectLiveEntityViewPage(ctx, entityId, query);
    return localCore
      ? { ...stored, core: { ...stored.core, ...localCore } }
      : stored;
  }
  return await loadRequiredEntityViewPage(ctx, entityId, height, query);
};

const scoreDefaultLiveEntity = (replica: EntityReplica): number => {
  const accountCount = Math.max(0, Math.floor(Number(replica.state?.accounts?.size ?? 0)));
  const bookCount = Math.max(0, Math.floor(Number(replica.state?.orderbookExt?.books?.size ?? 0)));
  const hubScore = isHubState(replica.state) ? 1 : 0;
  const height = Math.max(0, Math.floor(Number(replica.state?.height ?? 0)));
  return accountCount * 1_000_000 + bookCount * 1_000 + hubScore * 100 + Math.min(height, 99);
};

const chooseDefaultActiveEntityId = (
  ctx: RuntimeAdapterResolveContext,
  entities: RuntimeAdapterEntitySummary[],
): string | null => {
  if (entities.length === 0) return null;

  const available = new Set(entities.map((entity) => normalizeEntityId(entity.entityId)).filter(Boolean));
  let best: { entityId: string; score: number } | null = null;
  for (const replica of ctx.env.eReplicas?.values?.() ?? []) {
    const entityId = normalizeEntityId(replica.entityId);
    if (!entityId || !available.has(entityId)) continue;
    const score = scoreDefaultLiveEntity(replica);
    if (
      !best ||
      score > best.score ||
      (score === best.score && compareAscii(entityId, best.entityId) < 0)
    ) {
      best = { entityId, score };
    }
  }
  return best?.entityId ?? entities[0]?.entityId ?? null;
};

const projectViewFrame = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterViewFrame> => {
  const requestedHeight = readAtHeight(query);
  const currentEnvHeight = envHeight(ctx.env);
  const isCurrentHeight = requestedHeight === null || requestedHeight === currentEnvHeight;
  if (!isCurrentHeight && !ctx.readHead) {
    throw new RuntimeAdapterError('E_INTERNAL', 'storage head reader is required for historical reads');
  }
  const persistedHead = !isCurrentHeight ? await ctx.readHead!() : null;
  if (!isCurrentHeight && !persistedHead) {
    throw new RuntimeAdapterError('E_NOT_FOUND', `storage head not found at height ${requestedHeight}`);
  }
  if (!isCurrentHeight) {
    assertRequestedHeightAvailable(requestedHeight!, persistedHead!, 'view-frame');
  }
  const head = persistedHead ?? await readBestHead(ctx);
  const height = requestedHeight ?? currentEnvHeight;
  const heightQuery = requestedHeight !== null && height > 0 ? { ...query, atHeight: height } : query;
  const requestedEntityId = normalizeEntityId(String(query?.entityId || ''));
  const entities = await listEntitySummaries(ctx, heightQuery, {
    allowPartial: !isCurrentHeight || Boolean(requestedEntityId),
  });
  const activeEntityId = requestedEntityId || chooseDefaultActiveEntityId(ctx, entities);
  if (!activeEntityId) {
    return { head, height, entities, activeEntityId: null, activeEntity: null };
  }

  const accountQuery: RuntimeAdapterReadQuery = {
    ...heightQuery,
    limit: readBoundedLimit(query?.accountsLimit, query?.limit ?? 10),
  };
  const accountsCursor = query?.accountsCursor ?? query?.cursor;
  if (accountsCursor) accountQuery.cursor = accountsCursor;
  const bookQuery: RuntimeAdapterReadQuery = {
    ...heightQuery,
    limit: readBoundedLimit(query?.booksLimit, query?.limit ?? 10),
  };
  if (query?.booksCursor) bookQuery.cursor = query.booksCursor;

  const storedQuery: RuntimeAdapterReadQuery = {
    ...heightQuery,
  };
  if (accountQuery.limit !== undefined) {
    storedQuery.limit = accountQuery.limit;
    storedQuery.accountsLimit = accountQuery.limit;
  }
  if (accountQuery.cursor) storedQuery.accountsCursor = accountQuery.cursor;
  if (query?.accountId) storedQuery.accountId = query.accountId;
  if (query?.accountsPage !== undefined) storedQuery.accountsPage = query.accountsPage;
  if (bookQuery.limit !== undefined) storedQuery.booksLimit = bookQuery.limit;
  if (bookQuery.cursor) storedQuery.booksCursor = bookQuery.cursor;
  if (query?.booksPage !== undefined) storedQuery.booksPage = query.booksPage;
  const stored = await loadViewPageForHeight(ctx, activeEntityId, height, isCurrentHeight, storedQuery);
  const compactStored = compactViewPageForRemote(activeEntityId, stored);
  const fallbackJurisdiction = jurisdictionSummary(compactStored.core.config?.jurisdiction);
  const summary = entities.find((entity) => normalizeEntityId(entity.entityId) === activeEntityId) ?? {
    entityId: activeEntityId,
    label: String(compactStored.core.profile?.name || '').trim() || activeEntityId,
    height: Math.max(0, Math.floor(Number(compactStored.core.height ?? height))),
    ...(compactStored.core.profile?.isHub === true || Boolean(compactStored.core.orderbookHubProfile) ? { isHub: true } : {}),
    ...(fallbackJurisdiction ? { jurisdiction: fallbackJurisdiction } : {}),
  };

  return {
    head,
    height,
    entities,
    activeEntityId,
    activeEntity: {
      summary,
      core: compactStored.core,
      accounts: compactStored.accounts,
      books: compactStored.books,
    },
  };
};

const projectGraphEntityCore = (core: RuntimeAdapterEntityCoreDoc): RuntimeAdapterGraphEntityCore => ({
  entityId: core.entityId,
  ...withDefinedProp('signerId', core.signerId),
  height: core.height,
  timestamp: core.timestamp,
  ...withDefinedProp('prevFrameHash', core.prevFrameHash),
  reserves: new Map(core.reserves),
  profile: { name: core.profile.name, isHub: core.profile.isHub },
  isHub: core.profile.isHub || Boolean(core.orderbookHubProfile),
});

const GRAPH_ACCOUNT_ACTIVITY_SAMPLE_LIMIT = 2;

const projectGraphAccountActivity = (tx: AccountTx): RuntimeAdapterGraphAccountActivity => {
  const data = tx.data && typeof tx.data === 'object'
    ? tx.data as unknown as Record<string, unknown>
    : {};
  const tokenId = Number(data['tokenId']);
  const amount = data['amount'];
  const fromEntityId = typeof data['fromEntityId'] === 'string' ? data['fromEntityId'] : undefined;
  const toEntityId = typeof data['toEntityId'] === 'string' ? data['toEntityId'] : undefined;
  return {
    type: tx.type,
    ...(Number.isSafeInteger(tokenId) && tokenId >= 0 ? { tokenId } : {}),
    ...(typeof amount === 'bigint' ? { amount } : {}),
    ...withDefinedProp('fromEntityId', fromEntityId),
    ...withDefinedProp('toEntityId', toEntityId),
  };
};

const projectGraphAccountActivities = (
  txs: readonly AccountTx[],
): RuntimeAdapterGraphAccountActivity[] => txs
  .slice(-GRAPH_ACCOUNT_ACTIVITY_SAMPLE_LIMIT)
  .map(projectGraphAccountActivity);

const projectGraphAccountFrame = (
  frame: StorageAccountDoc['currentFrame'],
): RuntimeAdapterGraphAccountFrame => ({
  height: frame.height,
  timestamp: frame.timestamp,
  jHeight: frame.jHeight,
  prevFrameHash: frame.prevFrameHash,
  accountStateRoot: frame.accountStateRoot,
  stateHash: frame.stateHash,
  ...withDefinedProp('byLeft', frame.byLeft),
  accountTxs: projectGraphAccountActivities(frame.accountTxs),
  accountTxCount: frame.accountTxs.length,
});

const projectGraphAccount = (doc: StorageAccountDoc): RuntimeAdapterGraphAccount => ({
  leftEntity: doc.leftEntity,
  rightEntity: doc.rightEntity,
  status: doc.status,
  mempool: projectGraphAccountActivities(doc.mempool),
  mempoolCount: doc.mempool.length,
  currentFrame: projectGraphAccountFrame(doc.currentFrame),
  deltas: new Map(doc.deltas),
  currentHeight: doc.currentHeight,
  ...(doc.pendingFrame ? { pendingFrame: projectGraphAccountFrame(doc.pendingFrame) } : {}),
  rollbackCount: doc.rollbackCount,
  ...withDefinedProp('lastRollbackFrameHash', doc.lastRollbackFrameHash),
  ...(doc.activeDispute ? {
    activeDispute: {
      startedByLeft: doc.activeDispute.startedByLeft,
      disputeTimeout: doc.activeDispute.disputeTimeout,
      initialDisputeNonce: doc.activeDispute.initialNonce,
    },
  } : {}),
});

export const assertRuntimeAdapterGraphFrameWireBudget = (frame: RuntimeAdapterGraphFrame): number => {
  const encoded = encodeRuntimeAdapterMessage({
    v: XLN_PROTOCOL_VERSION,
    inReplyTo: 'graph-frame-budget',
    ok: true,
    payload: frame,
  });
  const maxBytes = runtimeAdapterMaxMessageBytes();
  if (encoded.byteLength > maxBytes) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      `graph-frame response exceeds wire budget: ${encoded.byteLength} bytes > ${maxBytes}`,
    );
  }
  return encoded.byteLength;
};

const projectGraphFrame = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterGraphFrame> => {
  const requestedHeight = readAtHeight(query);
  const currentEnvHeight = envHeight(ctx.env);
  const isLiveQuery = requestedHeight === null;
  const height = requestedHeight ?? currentEnvHeight;
  const entityLimit = readBoundedLimit(query?.limit, 500);
  const accountsLimit = readBoundedLimit(query?.accountsLimit, 500);
  const capturedRuntimeId = normalizeEntityId(String(ctx.env.runtimeId || ''));
  const capturedTimestamp = Math.max(0, Math.floor(Number(ctx.env.timestamp || 0)));

  // A live graph read is a projection of the in-memory R-frame, not a
  // historical storage query. Capture every graph DTO before the first await:
  // snapshot publication may legitimately prune the old diff chain while this
  // request is in flight, and the live Env is replaced at each committed frame.
  const capturedLive = isLiveQuery ? (() => {
    const summaries = listLiveEntitySummaries(ctx);
    if (summaries.length > entityLimit) {
      throw new RuntimeAdapterError(
        'E_BAD_QUERY',
        `graph-frame has ${summaries.length} entities; limit is ${entityLimit}. Select a runtime/filter before rendering`,
      );
    }
    const localEntityIds = new Set(
      Array.from(ctx.env.eReplicas?.values?.() ?? []).map((replica) => normalizeEntityId(replica.entityId)),
    );
    const entities: RuntimeAdapterGraphEntityFrame[] = [];
    let accountObservationCount = 0;
    for (const summary of summaries) {
      const normalizedEntityId = normalizeEntityId(summary.entityId);
      if (!localEntityIds.has(normalizedEntityId)) {
        entities.push({
          summary,
          core: null,
          accounts: { items: [], ...emptyPageMeta(accountsLimit) },
        });
        continue;
      }
      const replica = findReplica(ctx.env, normalizedEntityId);
      if (!replica) throw new RuntimeAdapterError('E_INTERNAL', `live graph replica disappeared: ${normalizedEntityId}`);
      const totalAccounts = replica.state.accounts.size;
      if (totalAccounts > accountsLimit) {
        throw new RuntimeAdapterError(
          'E_BAD_QUERY',
          `graph-frame entity ${summary.entityId} has ${totalAccounts} accounts; limit is ${accountsLimit}. Select a runtime/filter before rendering`,
        );
      }
      const live = projectLiveEntityViewPage(ctx, normalizedEntityId, {
        ...query,
        accountsLimit,
        booksLimit: 1,
      });
      accountObservationCount += live.accounts.items.length;
      if (accountObservationCount > accountsLimit) {
        throw new RuntimeAdapterError(
          'E_BAD_QUERY',
          `graph-frame has ${accountObservationCount} account observations; limit is ${accountsLimit}. Select a runtime/filter before rendering`,
        );
      }
      const accountPage = { ...live.accounts };
      delete accountPage.summary;
      entities.push({
        summary,
        core: projectGraphEntityCore(live.core),
        accounts: { ...accountPage, items: live.accounts.items.map(projectGraphAccount) },
      });
    }
    return { summaries, entities };
  })() : null;

  if (!isLiveQuery && !ctx.readHead) {
    throw new RuntimeAdapterError('E_INTERNAL', 'storage head reader is required for historical graph reads');
  }
  const persistedHead = !isLiveQuery ? await ctx.readHead!() : null;
  if (!isLiveQuery && !persistedHead) {
    throw new RuntimeAdapterError('E_NOT_FOUND', `storage head not found at height ${requestedHeight}`);
  }
  if (!isLiveQuery) assertRequestedHeightAvailable(requestedHeight!, persistedHead!, 'graph-frame');

  const head = persistedHead ?? await readBestHead(ctx);
  const heightQuery = requestedHeight !== null && height > 0 ? { ...query, atHeight: height } : query;
  const summaries = capturedLive?.summaries ?? await listEntitySummaries(ctx, heightQuery, {
    allowPartial: false,
    forceStorageAtHeight: true,
  });
  if (summaries.length > entityLimit) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      `graph-frame has ${summaries.length} entities; limit is ${entityLimit}. Select a runtime/filter before rendering`,
    );
  }

  const entities: RuntimeAdapterGraphEntityFrame[] = capturedLive?.entities ?? [];
  let accountObservationCount = 0;
  if (!capturedLive) {
    for (const summary of summaries) {
      const stored = await loadViewPageForHeight(ctx, summary.entityId, height, false, {
        ...heightQuery,
        accountsLimit,
        booksLimit: 1,
      });
      const totalAccounts = Math.max(stored.accounts.items.length, Number(stored.accounts.totalItems ?? 0));
      if (stored.accounts.nextCursor || totalAccounts > stored.accounts.items.length) {
        throw new RuntimeAdapterError(
          'E_BAD_QUERY',
          `graph-frame entity ${summary.entityId} has ${totalAccounts} accounts; limit is ${accountsLimit}. Select a runtime/filter before rendering`,
        );
      }
      accountObservationCount += stored.accounts.items.length;
      if (accountObservationCount > accountsLimit) {
        throw new RuntimeAdapterError(
          'E_BAD_QUERY',
          `graph-frame has ${accountObservationCount} account observations; limit is ${accountsLimit}. Select a runtime/filter before rendering`,
        );
      }
      const accountPage = { ...stored.accounts };
      delete accountPage.summary;
      entities.push({
        summary,
        core: projectGraphEntityCore(stored.core),
        accounts: { ...accountPage, items: stored.accounts.items.map(projectGraphAccount) },
      });
    }
  }

  const knownEntityIds = new Set(entities.map((entity) => normalizeEntityId(entity.summary.entityId)));
  for (const entity of [...entities]) {
    for (const account of entity.accounts.items) {
      for (const endpoint of [account.leftEntity, account.rightEntity]) {
        const endpointId = normalizeEntityId(endpoint);
        if (!endpointId || knownEntityIds.has(endpointId)) continue;
        if (entities.length >= entityLimit) {
          throw new RuntimeAdapterError(
            'E_BAD_QUERY',
            `graph-frame has more than ${entityLimit} account endpoints. Select a runtime/filter before rendering`,
          );
        }
        knownEntityIds.add(endpointId);
        entities.push({
          summary: {
            entityId: endpointId,
            ...(capturedRuntimeId ? { runtimeId: capturedRuntimeId } : {}),
            label: endpointId,
            height,
          },
          core: null,
          accounts: { items: [], ...emptyPageMeta(accountsLimit) },
        });
      }
    }
  }
  entities.sort((left, right) => compareAscii(left.summary.entityId, right.summary.entityId));

  const record = ctx.readFrame ? await ctx.readFrame(height) : null;
  const fallbackTimestamp = entities.reduce(
    (latest, entity) => Math.max(latest, Number(entity.core?.timestamp || 0)),
    isLiveQuery ? capturedTimestamp : 0,
  );
  const timestamp = Math.max(
    0,
    Math.floor(Number(record?.timestamp ?? fallbackTimestamp)),
  );
  const frame: RuntimeAdapterGraphFrame = {
    head,
    runtimeId: capturedRuntimeId,
    height,
    timestamp,
    stateHash: String(record?.stateHash || ''),
    entities,
  };
  assertRuntimeAdapterGraphFrameWireBudget(frame);
  return frame;
};

const projectHistoryFrameBatch = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterHistoryFrameBatch> => {
  const requestedHeights = readHeightBatch(query);
  const frames: RuntimeAdapterViewFrame[] = [];
  const unavailable: RuntimeAdapterHistoryFrameBatch['unavailable'] = [];
  const baseQuery: RuntimeAdapterReadQuery = { ...(query ?? {}) };
  delete baseQuery.heights;
  const isUnavailableHistoryError = (error: unknown): boolean => {
    if (error instanceof RuntimeAdapterError) {
      return error.code === 'E_NOT_FOUND';
    }
    const message = error instanceof Error ? error.message : String(error || '');
    return message.includes('STORAGE_DIFF_MISSING') ||
      message.includes('entity not found at height') ||
      message.includes('height unavailable');
  };

  for (const height of requestedHeights) {
    try {
      frames.push(await projectViewFrame(ctx, { ...baseQuery, atHeight: height }));
    } catch (error) {
      if (isUnavailableHistoryError(error)) {
        unavailable.push({
          height,
          code: error instanceof RuntimeAdapterError ? error.code : 'E_NOT_FOUND',
          message: error instanceof Error ? error.message : String(error || 'history frame unavailable'),
        });
        continue;
      }
      throw error;
    }
  }

  return { requestedHeights, frames, unavailable };
};

const compactFrameRecordForRemote = (frame: StorageFrameRecord): RuntimeAdapterFrameSummary => {
  const runtimeInput = frame.runtimeInput ?? { runtimeTxs: [], jInputs: [], entityInputs: [] };
  const entityInputs = runtimeInput.entityInputs ?? [];
  return {
    height: frame.height,
    timestamp: frame.timestamp,
    ...(frame.prevFrameHash ? { prevFrameHash: frame.prevFrameHash } : {}),
    ...(frame.frameHash ? { frameHash: frame.frameHash } : {}),
    stateHash: frame.stateHash,
    ...(frame.hashMode ? { hashMode: frame.hashMode } : {}),
    ...(frame.materializedState !== undefined ? { materializedState: frame.materializedState } : {}),
    ...(frame.canonicalStateHash ? { canonicalStateHash: frame.canonicalStateHash } : {}),
    ...(frame.entityHashes ? { entityHashes: frame.entityHashes } : {}),
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
      overlays: frame.overlayRecords?.length ?? 0,
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
  const runtimeId = normalizeEntityId(String(ctx.env.runtimeId || '')) || 'embedded';
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
      stateHash: String(frame.stateHash || ''),
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

export const resolveRuntimeAdapterRead = async <T = unknown>(
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

  if (parts.length === 1 && parts[0] === 'payment-routes') {
    if (!ctx.findPaymentRoutes) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route reads are unavailable for this adapter');
    }
    return await ctx.findPaymentRoutes(query) as T;
  }

  if (parts.length === 1 && parts[0] === 'solvency-summary') {
    return projectSolvencySummary(ctx, query) as T;
  }

  if (parts[0] === 'recovery' && parts[1] === 'bundles' && parts.length === 3) {
    const lookupKey = decodeURIComponent(parts[2] || '').trim();
    if (!lookupKey) throw new RuntimeAdapterError('E_BAD_PATH', 'recovery lookup key is required');
    return await buildPeerRecoveryBundleRead(ctx, lookupKey) as T;
  }

  if (parts[0] === 'receipt' && parts.length === 2) {
    if (!ctx.readReceipt) throw new RuntimeAdapterError('E_BAD_QUERY', 'receipt reads are unavailable for this adapter');
    const receiptId = decodeURIComponent(parts[1] || '').trim();
    if (!receiptId) throw new RuntimeAdapterError('E_BAD_PATH', 'receipt id is required');
    const receipt = await ctx.readReceipt(receiptId);
    if (!receipt) throw new RuntimeAdapterError('E_NOT_FOUND', `receipt not found: ${receiptId}`);
    return projectRuntimeIngressReceiptForWire(receipt) as T;
  }

  if (parts[0] === 'entity' && parts.length >= 2) {
    const entityId = parts[1];
    if (!entityId) throw new RuntimeAdapterError('E_BAD_PATH', 'entity id is required');

    if (parts.length === 3 && (parts[2] === 'accounts' || parts[2] === 'books' || parts[2] === 'book-docs')) {
      const height = readAtHeight(query);
      const targetHeight = height ?? envHeight(ctx.env);
      if (targetHeight < 1) throw new RuntimeAdapterError('E_BAD_QUERY', 'paged entity reads require a persisted runtime height');
      const accountId = normalizeEntityId(String(query?.accountId || ''));
      if (parts[2] === 'accounts' && accountId) {
        const limit = readBoundedLimit(query?.accountsLimit ?? query?.limit, 10);
        const isCurrentHeight = height === null || targetHeight === envHeight(ctx.env);
        if (isCurrentHeight) {
          const stored = ctx.loadEntityAccountDoc && await storageHeadCanServeHeight(ctx, targetHeight)
            ? await ctx.loadEntityAccountDoc(entityId, accountId, targetHeight)
            : null;
          if (stored) {
            const page = singleAccountPage(accountId, compactAccountDocForView(stored), limit);
            return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
          }
          const replica = findReplica(ctx.env, entityId);
          if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
          const account = replica.state.accounts.get(accountId);
          const page = singleAccountPage(accountId, account ? compactAccountDocForView(projectAccountDoc(account)) : null, limit);
          return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
        }
        if (!ctx.loadEntityAccountDoc) {
          throw new RuntimeAdapterError('E_BAD_QUERY', 'historical account reads are unavailable for this adapter');
        }
        const account = await ctx.loadEntityAccountDoc(entityId, accountId, targetHeight);
        const page = singleAccountPage(accountId, account ? compactAccountDocForView(account) : null, limit);
        return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
      }
      const isCurrentHeight = height === null || targetHeight === envHeight(ctx.env);
      const stored = await loadViewPageForHeight(ctx, entityId, targetHeight, isCurrentHeight, query);
      const compactStored = compactViewPageForRemote(entityId, stored);
      return (parts[2] === 'accounts' ? compactStored.accounts : compactStored.books) as T;
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
      return compactAccountDocForView(projectAccountDoc(account)) as T;
    }

    const { state, replica } = await resolveEntityState(ctx, entityId, query);

    if (parts.length === 2) {
      const core = replica
        ? projectEntityReplicaCoreView(state, replica)
        : projectEntityCoreDoc(state);
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

  throw new RuntimeAdapterError('E_BAD_PATH', `unsupported adapter path: ${path}`);
};
