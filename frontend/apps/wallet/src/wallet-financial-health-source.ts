import type { RuntimeAdapter } from '../../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import {
  RuntimeQueryObserver,
  type RuntimeQuerySnapshot,
} from '../../../packages/runtime-client/src/runtime-query-observer';
import { normalizeEntityIdForRuntimeView } from '../../../packages/runtime-client/src/runtime-view-model';
import {
  decodeWalletFinancialHealthProjection,
  readWalletFrameActiveEntityId,
  type WalletFinancialHealthProjection,
} from './wallet-financial-health-model';
import { readWalletSolvencyHeight } from './wallet-financial-health-solvency';
import {
  createWalletRuntimeQueryClient,
  loadWalletRuntimeReadDependencies,
  walletRuntimeReadErrorMessage,
} from './wallet-runtime-read-boundary';

type WalletFinancialHealthWaitingStatus = 'unavailable' | 'connecting' | 'error';

export type WalletFinancialHealthSourceSnapshot =
  | Readonly<{
    status: WalletFinancialHealthWaitingStatus;
    message: string;
    projection: null;
  }>
  | Readonly<{
    status: 'loading';
    message: string;
    projection: WalletFinancialHealthProjection | null;
  }>
  | Readonly<{
    status: 'ready';
    message: '';
    projection: WalletFinancialHealthProjection;
  }>;

const observerSnapshot = (
  snapshot: RuntimeQuerySnapshot<WalletFinancialHealthProjection>,
): WalletFinancialHealthSourceSnapshot => {
  if (snapshot.loading) return {
    status: 'loading',
    message: 'Reading committed financial health…',
    projection: snapshot.data,
  };
  if (snapshot.error) return { status: 'error', message: snapshot.error, projection: null };
  if (!snapshot.data) {
    return { status: 'error', message: 'Runtime returned no financial-health projection.', projection: null };
  }
  return { status: 'ready', message: '', projection: snapshot.data };
};

export class WalletFinancialHealthSource {
  private readonly listeners = new Set<() => void>();
  private snapshot: WalletFinancialHealthSourceSnapshot;
  private adapter: RuntimeAdapter | null = null;
  private observer: RuntimeQueryObserver<WalletFinancialHealthProjection> | null = null;
  private observerTeardown: (() => void) | null = null;
  private generation = 0;
  private started = false;
  private selectedEntityId = '';
  private accountsPage = 0;
  private historyCursors: Array<number | null> = [null];
  private historyPage = 0;

  constructor(private readonly config: RuntimeAdapterStorageSnapshot) {
    this.snapshot = config.mode === 'remote'
      ? { status: 'connecting', message: 'Connecting to the selected Runtime…', projection: null }
      : {
        status: 'unavailable',
        message: 'Financial health requires a connected Runtime. The React embedded Runtime boot flow is not active yet.',
        projection: null,
      };
  }

  readonly getSnapshot = (): WalletFinancialHealthSourceSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly start = async (): Promise<void> => {
    if (this.started) return;
    this.started = true;
    if (this.config.mode !== 'remote') return;
    const generation = ++this.generation;
    this.publish({ status: 'connecting', message: 'Connecting to the selected Runtime…', projection: null });
    try {
      const dependencies = await loadWalletRuntimeReadDependencies(this.config);
      if (!this.isCurrent(generation)) {
        dependencies.adapter.disconnect();
        return;
      }
      this.adapter = dependencies.adapter;
      this.installObserver(dependencies.adapter, dependencies.math);
    } catch (error: unknown) {
      if (!this.isCurrent(generation)) return;
      this.started = false;
      this.releaseRuntimeConnection();
      this.publish({ status: 'error', message: walletRuntimeReadErrorMessage(error), projection: null });
    }
  };

  readonly refresh = (): Promise<void> => this.observer?.refresh() ?? this.start();

  readonly selectEntity = (entityId: string): void => {
    const normalized = normalizeEntityIdForRuntimeView(entityId);
    const projection = this.snapshot.projection;
    if (!projection?.entities.some((entity) => entity.entityId === normalized)) {
      throw new Error(`WALLET_HEALTH_ENTITY_UNKNOWN:${normalized}`);
    }
    if (normalized === this.selectedEntityId || normalized === projection.activeEntityId) return;
    this.selectedEntityId = normalized;
    this.accountsPage = 0;
    this.resetHistory();
    void this.observer?.refresh();
  };

  readonly selectAccountsPage = (page: number): void => {
    const projection = this.snapshot.projection;
    if (!projection || !Number.isSafeInteger(page) || page < 0 || page >= projection.accountsPageCount) {
      throw new Error(`WALLET_HEALTH_ACCOUNT_PAGE_INVALID:${String(page)}`);
    }
    if (page === this.accountsPage) return;
    this.accountsPage = page;
    void this.observer?.refresh();
  };

  readonly selectOlderHistory = (): void => {
    if (this.snapshot.status === 'loading') throw new Error('WALLET_HEALTH_HISTORY_BUSY');
    const next = this.snapshot.projection?.historyNextBeforeHeight ?? null;
    if (next === null) throw new Error('WALLET_HEALTH_HISTORY_OLDER_UNAVAILABLE');
    if (this.historyPage === this.historyCursors.length - 1) this.historyCursors.push(next);
    this.historyPage += 1;
    void this.observer?.refresh();
  };

  readonly selectNewerHistory = (): void => {
    if (this.snapshot.status === 'loading') throw new Error('WALLET_HEALTH_HISTORY_BUSY');
    if (this.historyPage <= 0) throw new Error('WALLET_HEALTH_HISTORY_NEWER_UNAVAILABLE');
    this.historyPage -= 1;
    void this.observer?.refresh();
  };

  readonly stop = (): void => {
    this.started = false;
    this.generation += 1;
    this.releaseRuntimeConnection();
  };

  private installObserver(
    adapter: RuntimeAdapter,
    math: Awaited<ReturnType<typeof loadWalletRuntimeReadDependencies>>['math'],
  ): void {
    const client = createWalletRuntimeQueryClient(adapter);
    const observer = new RuntimeQueryObserver(async () => {
      const solvency = await client.readSolvencySummary();
      const height = readWalletSolvencyHeight(solvency);
      const frame = await client.readViewFrame({
        ...(height > 0 ? { atHeight: height } : {}),
        accountsLimit: 100,
        booksLimit: 1,
        accountsPage: this.accountsPage,
        ...(this.selectedEntityId ? { entityId: this.selectedEntityId } : {}),
      });
      const activeEntityId = readWalletFrameActiveEntityId(frame);
      const activity = activeEntityId ? await client.readActivity({
        entityId: activeEntityId,
        kind: 'all',
        limit: 25,
        scanLimit: 250,
        beforeHeight: this.historyCursors[this.historyPage] ?? height + 1,
      }) : null;
      return decodeWalletFinancialHealthProjection({
        frame,
        solvency,
        activity,
        historyPage: this.historyPage,
      }, math);
    }, {
      readHeight: () => adapter.currentHeight,
      subscribeHeight: (listener) => adapter.onChange(() => listener()),
      subscribeAdapter: (listener) => adapter.onStatus(() => listener()),
    });
    this.observer = observer;
    this.observerTeardown = observer.subscribe(this.syncObserver);
    this.syncObserver();
  }

  private readonly syncObserver = (): void => {
    if (!this.observer) return;
    const snapshot = observerSnapshot(this.observer.getSnapshot());
    if (snapshot.status === 'error' && this.adapter?.status === 'error') {
      this.started = false;
      this.generation += 1;
      this.releaseRuntimeConnection();
    }
    this.publish(snapshot);
  };

  private resetHistory(): void {
    this.historyCursors = [null];
    this.historyPage = 0;
  }

  private releaseRuntimeConnection(): void {
    this.observerTeardown?.();
    this.observerTeardown = null;
    this.observer?.destroy();
    this.observer = null;
    this.adapter?.disconnect();
    this.adapter = null;
  }

  private isCurrent(generation: number): boolean {
    return this.started && generation === this.generation;
  }

  private publish(snapshot: WalletFinancialHealthSourceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
