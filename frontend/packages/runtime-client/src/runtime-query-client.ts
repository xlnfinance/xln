export type RuntimeReadQueryModel = Readonly<{
  atHeight?: number;
  heights?: unknown;
}>;

export type RuntimeReadAdapterModel<Query extends RuntimeReadQueryModel> = Readonly<{
  currentHeight?: unknown;
  read<T = unknown>(path: string, query?: Query): Promise<T>;
}>;

export type RuntimeQueryResultSchema = {
  head: unknown;
  frameSummary: unknown;
  entities: unknown;
  viewFrame: unknown;
  account: unknown;
  swapHistory: unknown;
  historyFrameBatch: unknown;
  timelineIndex: unknown;
  activity: unknown;
  solvencySummary: unknown;
  checkpoints: Array<{ height?: number }>;
  receiptStatus: unknown;
  recoveryBundles: unknown;
};

export type RuntimeQueryClientDependencies<Query extends RuntimeReadQueryModel> = Readonly<{
  resolveAdapter: () => RuntimeReadAdapterModel<Query> | null;
  readRuntimeId: () => string;
  readCurrentHeight: () => number;
  createEmptyQuery: () => Query;
}>;

type RuntimeQueryCacheEntry<T> = {
  height: number;
  data: T;
};

const MAX_QUERY_CACHE_ENTRIES = 200;
const queryCache = new Map<string, RuntimeQueryCacheEntry<unknown>>();

const normalizeHeight = (height: unknown): number => {
  const normalized = Math.floor(Number(height || 0));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0;
};

const responseHeight = (value: unknown): number | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const headValue = record['head'];
  const head = headValue && typeof headValue === 'object' && !Array.isArray(headValue)
    ? headValue as Record<string, unknown>
    : null;
  const candidates = [record['height'], record['latestHeight'], head?.['latestHeight']]
    .filter((candidate) => candidate !== undefined && candidate !== null)
    .map(normalizeHeight);
  return candidates.length > 0 ? Math.max(...candidates) : null;
};

const stableQueryValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableQueryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableQueryValue(entryValue)]),
    );
  }
  return value;
};

const cacheKey = (
  runtimeId: string,
  path: string,
  query?: RuntimeReadQueryModel,
): string => `${runtimeId}|${path}|${JSON.stringify(stableQueryValue(query ?? {}))}`;

const trimQueryCache = (): void => {
  while (queryCache.size > MAX_QUERY_CACHE_ENTRIES) {
    const first = queryCache.keys().next().value;
    if (!first) return;
    queryCache.delete(first);
  }
};

export const clearRuntimeQueryCache = (): void => {
  queryCache.clear();
};

export class RuntimeQueryClient<
  Query extends RuntimeReadQueryModel = RuntimeReadQueryModel,
  Results extends RuntimeQueryResultSchema = RuntimeQueryResultSchema,
> {
  constructor(
    private readonly dependencies: RuntimeQueryClientDependencies<Query>,
    private readonly cacheRuntimeId?: string,
  ) {}

  private async read<T>(path: string, query?: Query): Promise<T> {
    const adapter = this.dependencies.resolveAdapter();
    if (!adapter) throw new Error('Runtime adapter is not connected');
    return adapter.read<T>(path, query);
  }

  private async cachedRead<T>(path: string, query?: Query): Promise<T> {
    const adapter = this.dependencies.resolveAdapter();
    if (!adapter) throw new Error('Runtime adapter is not connected');
    const requestHeight = normalizeHeight(
      query?.atHeight ?? adapter.currentHeight ?? this.dependencies.readCurrentHeight(),
    );
    const runtimeId = this.cacheRuntimeId || this.dependencies.readRuntimeId();
    const key = cacheKey(runtimeId, path, query);
    const cached = queryCache.get(key) as RuntimeQueryCacheEntry<T> | undefined;
    if (cached && cached.height === requestHeight) return cached.data;
    const data = await adapter.read<T>(path, query);
    const observedHeight = query?.atHeight === undefined ? responseHeight(data) : null;
    queryCache.set(key, { height: observedHeight ?? requestHeight, data });
    trimQueryCache();
    return data;
  }

  readHead(): Promise<Results['head']> {
    return this.cachedRead<Results['head']>('head');
  }

  async readFrameSummary(height: number): Promise<Results['frameSummary']> {
    const normalized = Math.floor(Number(height));
    if (!Number.isSafeInteger(normalized) || normalized < 1) {
      throw new Error('RUNTIME_FRAME_HEIGHT_INVALID');
    }
    return this.read<Results['frameSummary']>(`frame/${normalized}`);
  }

  readEntities(query?: Query): Promise<Results['entities']> {
    return this.cachedRead<Results['entities']>('entities', query);
  }

  readViewFrame(query?: Query): Promise<Results['viewFrame']> {
    return this.cachedRead<Results['viewFrame']>(
      'view-frame',
      query ?? this.dependencies.createEmptyQuery(),
    );
  }

  readAccount(entityId: string, counterpartyId: string, query?: Query): Promise<Results['account']> {
    const owner = String(entityId || '').trim().toLowerCase();
    const counterparty = String(counterpartyId || '').trim().toLowerCase();
    if (!owner || !counterparty) throw new Error('RUNTIME_ACCOUNT_PROJECTION_ID_MISSING');
    return this.cachedRead<Results['account']>(
      `entity/${encodeURIComponent(owner)}/account/${encodeURIComponent(counterparty)}`,
      query ?? this.dependencies.createEmptyQuery(),
    );
  }

  /**
   * Certified Account-frame history stays a separate paged read. The caller
   * owns its exact unknown-to-view decoder at the UI boundary.
   */
  readSwapHistory(
    entityId: string,
    counterpartyId: string,
    query?: Query,
  ): Promise<Results['swapHistory']> {
    const owner = String(entityId || '').trim().toLowerCase();
    const counterparty = String(counterpartyId || '').trim().toLowerCase();
    if (!owner || !counterparty) throw new Error('RUNTIME_SWAP_HISTORY_ID_MISSING');
    return this.cachedRead<Results['swapHistory']>(
      `entity/${encodeURIComponent(owner)}/account/${encodeURIComponent(counterparty)}/swap-history`,
      query ?? this.dependencies.createEmptyQuery(),
    );
  }

  readHistoryFrameBatch(query: Query): Promise<Results['historyFrameBatch']> {
    if (!query.heights) throw new Error('history-frame-batch requires heights');
    return this.cachedRead<Results['historyFrameBatch']>('history-frame-batch', query);
  }

  readTimelineIndex(query?: Query): Promise<Results['timelineIndex']> {
    return this.cachedRead<Results['timelineIndex']>(
      'timeline-index',
      query ?? this.dependencies.createEmptyQuery(),
    );
  }

  readActivity(query: Query): Promise<Results['activity']> {
    return this.cachedRead<Results['activity']>('activity', query);
  }

  readSolvencySummary(query?: Query): Promise<Results['solvencySummary']> {
    return this.cachedRead<Results['solvencySummary']>(
      'solvency-summary',
      query ?? this.dependencies.createEmptyQuery(),
    );
  }

  readCheckpoints(): Promise<Results['checkpoints']> {
    return this.cachedRead<Results['checkpoints']>('checkpoints');
  }

  async readReceiptStatus(receiptId: string): Promise<Results['receiptStatus']> {
    const id = String(receiptId || '').trim();
    if (!id) throw new Error('REMOTE_RUNTIME_RECEIPT_ID_MISSING');
    return this.read<Results['receiptStatus']>(`receipt/${encodeURIComponent(id)}`);
  }

  async readRecoveryBundles(lookupKey: string): Promise<Results['recoveryBundles']> {
    const key = String(lookupKey || '').trim();
    if (!key) throw new Error('REMOTE_RUNTIME_RECOVERY_LOOKUP_KEY_MISSING');
    return this.read<Results['recoveryBundles']>(`recovery/bundles/${encodeURIComponent(key)}`);
  }
}
