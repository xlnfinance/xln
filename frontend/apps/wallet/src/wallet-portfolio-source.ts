import type {
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
} from '../../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import { RuntimeQueryClient } from '../../../packages/runtime-client/src/runtime-query-client';
import {
  RuntimeQueryObserver,
  type RuntimeQuerySnapshot,
} from '../../../packages/runtime-client/src/runtime-query-observer';
import { normalizeEntityIdForRuntimeView } from '../../../packages/runtime-client/src/runtime-view-model';
import {
  decodeWalletPortfolioProjection,
  type WalletPortfolioMath,
  type WalletPortfolioProjection,
} from './wallet-portfolio-model';

type WalletPortfolioWaitingStatus = 'unavailable' | 'connecting' | 'error';

export type WalletPortfolioSourceSnapshot =
  | Readonly<{
    status: WalletPortfolioWaitingStatus;
    message: string;
    projection: null;
  }>
  | Readonly<{
    status: 'loading';
    message: string;
    projection: WalletPortfolioProjection | null;
  }>
  | Readonly<{
    status: 'ready';
    message: '';
    projection: WalletPortfolioProjection;
  }>;

type WalletPortfolioDependencies = Readonly<{
  adapter: RuntimeAdapter;
  math: WalletPortfolioMath;
}>;

const unavailableSnapshot = (message: string): WalletPortfolioSourceSnapshot => ({
  status: 'unavailable',
  message,
  projection: null,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Runtime portfolio read failed');

const loadWalletPortfolioDependencies = async (): Promise<WalletPortfolioDependencies> => {
  // The canonical Runtime browser boundary installs the process surface used by
  // transitive protocol modules. It must finish before the adapter graph loads.
  await import('../../../../core/support/process/runtime-process.ts');
  const [remote, account, financial] = await Promise.all([
    import('../../../../core/api/runtime-adapter/remote.ts'),
    import('../../../../core/account/utils.ts'),
    import('../../../../core/account/financial-utils.ts'),
  ]);
  return {
    adapter: new remote.RemoteRuntimeAdapter(),
    math: {
      deriveDelta: (delta, isLeft) => account.deriveDelta(delta, isLeft),
      formatTokenAmount: financial.formatTokenAmount,
      getTokenInfo: account.getTokenInfo,
      isLeftEntity: account.isLeftEntity,
    },
  };
};

const remoteRuntimeConfig = (
  snapshot: RuntimeAdapterStorageSnapshot,
): RuntimeAdapterConfig => {
  const wsUrl = String(snapshot.wsUrl || '').trim();
  if (!wsUrl) throw new Error('Remote Runtime endpoint is missing.');
  const authKey = String(snapshot.sessionKey || '').trim();
  return {
    mode: 'remote',
    wsUrl,
    ...(authKey ? { authKey } : {}),
  };
};

const observerSnapshot = (
  snapshot: RuntimeQuerySnapshot<WalletPortfolioProjection>,
): WalletPortfolioSourceSnapshot => {
  if (snapshot.loading) {
    return {
      status: 'loading',
      message: 'Reading committed assets and accounts…',
      projection: snapshot.data,
    };
  }
  if (snapshot.error) {
    return { status: 'error', message: snapshot.error, projection: null };
  }
  if (!snapshot.data) {
    return { status: 'error', message: 'Runtime returned no portfolio projection.', projection: null };
  }
  return { status: 'ready', message: '', projection: snapshot.data };
};

export class WalletPortfolioSource {
  private readonly listeners = new Set<() => void>();
  private snapshot: WalletPortfolioSourceSnapshot;
  private adapter: RuntimeAdapter | null = null;
  private observer: RuntimeQueryObserver<WalletPortfolioProjection> | null = null;
  private observerTeardown: (() => void) | null = null;
  private generation = 0;
  private started = false;
  private selectedEntityId = '';
  private accountsPage = 0;

  constructor(private readonly config: RuntimeAdapterStorageSnapshot) {
    this.snapshot = config.mode === 'remote'
      ? { status: 'connecting', message: 'Connecting to the selected Runtime…', projection: null }
      : unavailableSnapshot(
        'Assets and accounts require a connected Runtime. The React embedded Runtime boot flow is not active yet.',
      );
  }

  readonly getSnapshot = (): WalletPortfolioSourceSnapshot => this.snapshot;

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
      const dependencies = await loadWalletPortfolioDependencies();
      if (!this.isCurrent(generation)) {
        dependencies.adapter.disconnect();
        return;
      }
      this.adapter = dependencies.adapter;
      await this.adapter.connect(remoteRuntimeConfig(this.config));
      if (!this.isCurrent(generation)) return;
      this.installObserver(this.adapter, dependencies.math);
    } catch (error: unknown) {
      if (!this.isCurrent(generation)) return;
      this.releaseRuntimeConnection();
      this.publish({ status: 'error', message: errorMessage(error), projection: null });
    }
  };

  readonly refresh = (): Promise<void> => this.observer?.refresh() ?? this.start();

  readonly selectEntity = (entityId: string): void => {
    const normalized = normalizeEntityIdForRuntimeView(entityId);
    const projection = this.snapshot.projection;
    if (!projection?.entities.some((entity) => entity.entityId === normalized)) {
      throw new Error(`WALLET_PORTFOLIO_ENTITY_UNKNOWN:${normalized}`);
    }
    if (normalized === this.selectedEntityId || normalized === projection.activeEntityId) return;
    this.selectedEntityId = normalized;
    this.accountsPage = 0;
    void this.observer?.refresh();
  };

  readonly selectAccountsPage = (page: number): void => {
    const projection = this.snapshot.projection;
    if (!projection || !Number.isSafeInteger(page) || page < 0 || page >= projection.accountsPageCount) {
      throw new Error(`WALLET_PORTFOLIO_ACCOUNT_PAGE_INVALID:${String(page)}`);
    }
    if (page === this.accountsPage) return;
    this.accountsPage = page;
    void this.observer?.refresh();
  };

  readonly stop = (): void => {
    this.started = false;
    this.generation += 1;
    this.releaseRuntimeConnection();
  };

  private releaseRuntimeConnection(): void {
    this.observerTeardown?.();
    this.observerTeardown = null;
    this.observer?.destroy();
    this.observer = null;
    this.adapter?.disconnect();
    this.adapter = null;
  }

  private installObserver(adapter: RuntimeAdapter, math: WalletPortfolioMath): void {
    const client = new RuntimeQueryClient<RuntimeAdapterReadQuery>({
      resolveAdapter: () => adapter,
      readRuntimeId: () => adapter.runtimeId,
      readCurrentHeight: () => adapter.currentHeight,
      createEmptyQuery: () => ({}),
    });
    const observer = new RuntimeQueryObserver(
      async () => decodeWalletPortfolioProjection(await client.readViewFrame({
        accountsLimit: 25,
        booksLimit: 1,
        accountsPage: this.accountsPage,
        ...(this.selectedEntityId ? { entityId: this.selectedEntityId } : {}),
      }), math),
      {
        readHeight: () => adapter.currentHeight,
        subscribeHeight: (listener) => adapter.onChange(() => listener()),
        subscribeAdapter: (listener) => adapter.onStatus(() => listener()),
      },
    );
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

  private isCurrent(generation: number): boolean {
    return this.started && generation === this.generation;
  }

  private publish(snapshot: WalletPortfolioSourceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
