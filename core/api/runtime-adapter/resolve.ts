import type { AccountTx } from '../../types/account';
import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { readRuntimeEntityMetricStats } from '../../runtime/observability/entity-metrics';
import { normalizeEntityId } from '../../storage/keys';
import {
  projectEntityCoreDoc,
  projectEntityReplicaCoreView,
} from '../../storage/read/projections';
import type {
  StorageAccountDoc,
  StorageEntityCoreDoc,
  RuntimeFrame,
  StorageHead,
} from '../../storage/types';
import { compareAscii } from '../../support/collections/sorted-map-index';
import { RuntimeAdapterError } from './errors';
import {
  detachRuntimeAdapterPayload,
  encodeRuntimeAdapterMessageForBrowser,
  runtimeAdapterMaxMessageBytes,
  runtimeAdapterMessageByteLength,
} from './codec';
import { XLN_PROTOCOL_VERSION } from '../../protocol/version';
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
  RuntimeAdapterEntitySummary,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSolvencySummary,
  RuntimeAdapterTimelineIndexPage,
} from './types';
import {
  assertRequestedHeightAvailable,
  emptyPageMeta,
  envHeight,
  findReplica,
  isHubState,
  jurisdictionSummary,
  listEntitySummaries,
  listLiveEntitySummaries,
  loadViewPageForHeight,
  projectLiveEntityViewPage,
  readAtHeight,
  readBestHead,
  readBoundedLimit,
  withDefinedProp,
  type NativeMapView,
  type RuntimeAdapterAccountPage,
  type RuntimeAdapterEntityCoreDoc,
  type RuntimeAdapterResolveContext,
} from './read/context';
import {
  accountPageSummaryForView,
  compactAccountDocForView,
  compactEntityCoreForRemote,
  compactViewPageForRemote,
  singleAccountViewPage,
  type RuntimeAdapterAccountViewPage,
  type RuntimeAdapterPortableBookPage,
} from './read/compact-view';

import { calculateSolvency } from '../../runtime/swap-cmd/solvency';
import { acquireRuntimeCommittedRead } from '../../runtime/frame/lifecycle/writer-lock';

type RuntimeAdapterViewEntityFrame = {
  summary: RuntimeAdapterEntitySummary;
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountViewPage;
  books: RuntimeAdapterPortableBookPage;
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

type RuntimeAdapterGraphAccountActivity = {
  type: string;
  tokenId?: number;
  amount?: bigint;
  fromEntityId?: string;
  toEntityId?: string;
};

type RuntimeAdapterGraphAccountFrame = Pick<
  StorageAccountDoc['currentFrame'],
  'height' | 'timestamp' | 'jHeight' | 'prevFrameHash' | 'accountStateRoot' | 'stateHash'
> & {
  accountTxs: RuntimeAdapterGraphAccountActivity[];
  accountTxCount: number;
};

type RuntimeAdapterGraphAccount = {
  leftEntity: string;
  rightEntity: string;
  status: StorageAccountDoc['status'];
  mempool: RuntimeAdapterGraphAccountActivity[];
  mempoolCount: number;
  currentFrame: RuntimeAdapterGraphAccountFrame;
  deltas: NativeMapView<StorageAccountDoc['state']['deltas']>;
  currentHeight: number;
  pendingFrame?: RuntimeAdapterGraphAccountFrame;
  rollbackCount: number;
  lastRollbackFrameHash?: string;
  activeDispute?: {
    startedByLeft: boolean;
    disputeTimeout: number;
    initialNonce: number;
  };
};

type RuntimeAdapterGraphAccountPage = Omit<RuntimeAdapterAccountPage, 'items' | 'summary'> & {
  items: RuntimeAdapterGraphAccount[];
};

type RuntimeAdapterGraphEntityFrame = {
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
  for (const replica of ctx.env.state.eReplicas?.values?.() ?? []) {
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
  const storedJurisdiction = jurisdictionSummary(compactStored.core.config?.jurisdiction);
  const summary = entities.find((entity) => normalizeEntityId(entity.entityId) === activeEntityId) ?? {
    entityId: activeEntityId,
    label: String(compactStored.core.profile?.name || '').trim() || activeEntityId,
    height: Math.max(0, Math.floor(Number(compactStored.core.height ?? height))),
    ...(compactStored.core.profile?.isHub === true ? { isHub: true } : {}),
    ...(storedJurisdiction ? { jurisdiction: storedJurisdiction } : {}),
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
  isHub: core.profile.isHub,
});

const GRAPH_ACCOUNT_ACTIVITY_SAMPLE_LIMIT = 2;

const projectGraphAccountActivity = (tx: AccountTx): RuntimeAdapterGraphAccountActivity => {
  const tokenId = Number(Reflect.get(tx.data, 'tokenId'));
  const amount = Reflect.get(tx.data, 'amount');
  const rawFromEntityId = Reflect.get(tx.data, 'fromEntityId');
  const rawToEntityId = Reflect.get(tx.data, 'toEntityId');
  const fromEntityId = typeof rawFromEntityId === 'string' ? rawFromEntityId : undefined;
  const toEntityId = typeof rawToEntityId === 'string' ? rawToEntityId : undefined;
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
  accountTxs: projectGraphAccountActivities(frame.accountTxs),
  accountTxCount: frame.accountTxs.length,
});

const projectGraphAccount = (doc: StorageAccountDoc): RuntimeAdapterGraphAccount => ({
  leftEntity: doc.state.leftEntity,
  rightEntity: doc.state.rightEntity,
  status: doc.status,
  mempool: projectGraphAccountActivities(doc.mempool),
  mempoolCount: doc.mempool.length,
  currentFrame: projectGraphAccountFrame(doc.currentFrame),
  deltas: new Map(doc.state.deltas),
  currentHeight: doc.currentHeight,
  ...(doc.pendingFrame ? { pendingFrame: projectGraphAccountFrame(doc.pendingFrame) } : {}),
  rollbackCount: doc.rollbackCount,
  ...withDefinedProp('lastRollbackFrameHash', doc.lastRollbackFrameHash),
  ...(doc.activeDispute ? {
    activeDispute: {
      startedByLeft: doc.activeDispute.startedByLeft,
      disputeTimeout: doc.activeDispute.disputeTimeout,
      initialNonce: doc.activeDispute.initialNonce,
    },
  } : {}),
});

/**
 * Budget the bytes the server actually sends: tagged JSON, which is larger
 * than msgpack (BigInt and Map are tagged). A msgpack budget let a frame pass
 * here and then fail as a generic E_INTERNAL "response too large".
 */
export const assertRuntimeAdapterGraphFrameWireBudget = (frame: RuntimeAdapterGraphFrame): number => {
  const encodedBytes = runtimeAdapterMessageByteLength(encodeRuntimeAdapterMessageForBrowser({
    v: XLN_PROTOCOL_VERSION,
    inReplyTo: 'graph-frame-budget',
    ok: true,
    payload: frame,
  }));
  const maxBytes = runtimeAdapterMaxMessageBytes();
  if (encodedBytes > maxBytes) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      `graph-frame response exceeds wire budget: ${encodedBytes} bytes > ${maxBytes}`,
    );
  }
  return encodedBytes;
};

type CapturedLiveGraph = {
  summaries: RuntimeAdapterEntitySummary[];
  entities: RuntimeAdapterGraphEntityFrame[];
};

const captureLiveGraph = (
  ctx: RuntimeAdapterResolveContext,
  query: RuntimeAdapterReadQuery | undefined,
  entityLimit: number,
  accountsLimit: number,
): CapturedLiveGraph => {
  const summaries = listLiveEntitySummaries(ctx);
  if (summaries.length > entityLimit) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      `graph-frame has ${summaries.length} entities; limit is ${entityLimit}. Select a core/filter before rendering`,
    );
  }
  const localEntityIds = new Set(
    Array.from(ctx.env.state.eReplicas?.values?.() ?? [])
      .map(replica => normalizeEntityId(replica.entityId)),
  );
  const entities: RuntimeAdapterGraphEntityFrame[] = [];
  let accountObservationCount = 0;
  for (const summary of summaries) {
    const entityId = normalizeEntityId(summary.entityId);
    if (!localEntityIds.has(entityId)) {
      entities.push({
        summary,
        core: null,
        accounts: { items: [], ...emptyPageMeta(accountsLimit) },
      });
      continue;
    }
    const replica = findReplica(ctx.env, entityId);
    if (!replica) {
      throw new RuntimeAdapterError(
        'E_INTERNAL',
        `live graph replica disappeared: ${entityId}`,
      );
    }
    const totalAccounts = replica.state.accounts.size;
    if (totalAccounts > accountsLimit) {
      throw new RuntimeAdapterError(
        'E_BAD_QUERY',
        `graph-frame entity ${summary.entityId} has ${totalAccounts} accounts; limit is ${accountsLimit}. Select a core/filter before rendering`,
      );
    }
    const live = projectLiveEntityViewPage(ctx, entityId, {
      ...query,
      accountsLimit,
      booksLimit: 1,
    });
    accountObservationCount += live.accounts.items.length;
    if (accountObservationCount > accountsLimit) {
      throw new RuntimeAdapterError(
        'E_BAD_QUERY',
        `graph-frame has ${accountObservationCount} account observations; limit is ${accountsLimit}. Select a core/filter before rendering`,
      );
    }
    const accountPage = { ...live.accounts };
    delete accountPage.summary;
    entities.push({
      summary,
      core: projectGraphEntityCore(live.core),
      accounts: {
        ...accountPage,
        items: live.accounts.items.map(projectGraphAccount),
      },
    });
  }
  return { summaries, entities };
};

const appendGraphAccountEndpoints = (
  entities: RuntimeAdapterGraphEntityFrame[],
  entityLimit: number,
  accountsLimit: number,
  runtimeId: string,
  height: number,
): void => {
  const knownEntityIds = new Set(
    entities.map(entity => normalizeEntityId(entity.summary.entityId)),
  );
  for (const entity of [...entities]) {
    for (const account of entity.accounts.items) {
      for (const endpoint of [account.leftEntity, account.rightEntity]) {
        const entityId = normalizeEntityId(endpoint);
        if (!entityId || knownEntityIds.has(entityId)) continue;
        if (entities.length >= entityLimit) {
          throw new RuntimeAdapterError(
            'E_BAD_QUERY',
            `graph-frame has more than ${entityLimit} account endpoints. Select a core/filter before rendering`,
          );
        }
        knownEntityIds.add(entityId);
        entities.push({
          summary: {
            entityId,
            ...(runtimeId ? { runtimeId } : {}),
            label: entityId,
            height,
          },
          core: null,
          accounts: { items: [], ...emptyPageMeta(accountsLimit) },
        });
      }
    }
  }
  entities.sort((left, right) =>
    compareAscii(left.summary.entityId, right.summary.entityId),
  );
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
  const capturedTimestamp = Math.max(0, Math.floor(Number(ctx.env.state.timestamp || 0)));

  // A live graph read is a projection of the in-memory R-frame, not a
  // historical storage query. Capture every graph DTO before the first await:
  // snapshot publication may legitimately prune the old diff chain while this
  // request is in flight, and the live RuntimeReplica is replaced at each committed frame.
  const capturedLive = isLiveQuery
    ? captureLiveGraph(ctx, query, entityLimit, accountsLimit)
    : null;

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
      `graph-frame has ${summaries.length} entities; limit is ${entityLimit}. Select a core/filter before rendering`,
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
          `graph-frame entity ${summary.entityId} has ${totalAccounts} accounts; limit is ${accountsLimit}. Select a core/filter before rendering`,
        );
      }
      accountObservationCount += stored.accounts.items.length;
      if (accountObservationCount > accountsLimit) {
        throw new RuntimeAdapterError(
          'E_BAD_QUERY',
          `graph-frame has ${accountObservationCount} account observations; limit is ${accountsLimit}. Select a core/filter before rendering`,
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

  appendGraphAccountEndpoints(
    entities,
    entityLimit,
    accountsLimit,
    capturedRuntimeId,
    height,
  );

  const record = ctx.readFrame ? await ctx.readFrame(height) : null;
  const projectedTimestamp = entities.reduce(
    (latest, entity) => Math.max(latest, Number(entity.core?.timestamp || 0)),
    isLiveQuery ? capturedTimestamp : 0,
  );
  const timestamp = Math.max(
    0,
    Math.floor(Number(record?.timestamp ?? projectedTimestamp)),
  );
  const frame: RuntimeAdapterGraphFrame = {
    head,
    runtimeId: capturedRuntimeId,
    height,
    timestamp,
    stateHash: String(record?.canonicalStateHash || ''),
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
  for (const height of requestedHeights) {
    try {
      frames.push(await projectViewFrame(ctx, { ...baseQuery, atHeight: height }));
    } catch (error) {
      // Storage reports an unretained height as null, which the projection
      // types as E_NOT_FOUND. Any other failure is real and propagates; text
      // matching used to turn unrelated storage errors into "unavailable".
      if (error instanceof RuntimeAdapterError && error.code === 'E_NOT_FOUND') {
        unavailable.push({ height, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
  }

  return { requestedHeights, frames, unavailable };
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
