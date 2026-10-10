import type { AccountTx } from '../../../types/account';
import { normalizeEntityId } from '../../../storage/keys';
import type {
  StorageAccountDoc,
  StorageEntityCoreDoc,
  StorageHead,
} from '../../../storage/types';
import { compareAscii } from '../../../support/collections/sorted-map-index';
import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { RuntimeAdapterError } from '../errors';
import {
  encodeRuntimeAdapterMessageForBrowser,
  runtimeAdapterMaxMessageBytes,
  runtimeAdapterMessageByteLength,
} from '../codec';
import type { RuntimeAdapterEntitySummary, RuntimeAdapterReadQuery } from '../types';
import {
  assertRequestedHeightAvailable,
  emptyPageMeta,
  envHeight,
  findReplica,
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
} from './context';

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

export const projectGraphFrame = async (
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
