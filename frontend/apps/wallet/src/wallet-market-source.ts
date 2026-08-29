import type { RuntimeAdapter } from '../../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import {
  RuntimeQueryObserver,
  type RuntimeQuerySnapshot,
} from '../../../packages/runtime-client/src/runtime-query-observer';
import { normalizeEntityIdForRuntimeView } from '../../../packages/runtime-client/src/runtime-view-model';
import {
  abandonTerminalWalletPaymentCommand,
  executeWalletPaymentCommand,
  prepareWalletPaymentCommand,
  type WalletPreparedCommand,
} from './wallet-payment-command';
import type { WalletPaymentCommandState } from './wallet-payment-source';
import {
  buildWalletMarketCancelInput,
  buildWalletMarketOrderInput,
  type WalletMarketOrderDraft,
} from './wallet-market-command';
import type { WalletMarketActivityKind } from './wallet-market-activity';
import {
  decodeWalletMarketActivity,
} from './wallet-market-activity';
import {
  decodeWalletMarketContext,
  decodeWalletMarketProjection,
  type WalletMarketProjection,
} from './wallet-market-model';
import {
  createWalletRuntimeQueryClient,
  loadWalletMarketMath,
  loadWalletRuntimeReadDependencies,
  walletRuntimeReadErrorMessage,
  type WalletMarketMath,
  type WalletRuntimeReadDependencies,
} from './wallet-runtime-read-boundary';

export type WalletMarketSourceSnapshot = Readonly<{
  status: 'unavailable' | 'connecting' | 'loading' | 'ready' | 'error';
  message: string;
  projection: WalletMarketProjection | null;
  command: WalletPaymentCommandState;
}>;

const idleCommand = (): WalletPaymentCommandState => ({
  status: 'idle', message: '', commandId: '', durable: false, retryable: false,
});

const contextOnlyProjection = (
  frame: unknown,
  activityValue: unknown,
  activityKind: WalletMarketActivityKind,
  activityPage: number,
  math: WalletRuntimeReadDependencies['math'],
): WalletMarketProjection => {
  const context = decodeWalletMarketContext(frame, math);
  const activity = decodeWalletMarketActivity(activityValue, math);
  return {
    ...context.payment,
    logicalTimestamp: context.logicalTimestamp,
    hubs: context.hubs,
    selectedHubId: '',
    pairs: [],
    selectedPairId: '',
    openOrders: [],
    crossRoutes: [],
    activity: activity.events,
    activityKind,
    activityPage,
    activityNextBeforeHeight: activity.nextBeforeHeight,
  };
};

export class WalletMarketSource {
  private readonly listeners = new Set<() => void>();
  private snapshot: WalletMarketSourceSnapshot;
  private adapter: RuntimeAdapter | null = null;
  private dependencies: WalletRuntimeReadDependencies | null = null;
  private marketMath: WalletMarketMath | null = null;
  private observer: RuntimeQueryObserver<WalletMarketProjection> | null = null;
  private teardowns: Array<() => void> = [];
  private generation = 0;
  private started = false;
  private selectedEntityId = '';
  private selectedHubId = '';
  private selectedPairId = '';
  private activityKind: WalletMarketActivityKind = 'all';
  private activityPage = 0;
  private activityCursors: Array<number | null> = [null];
  private pendingCommand: WalletPreparedCommand | null = null;
  private commandBusy = false;

  constructor(private readonly config: RuntimeAdapterStorageSnapshot) {
    this.snapshot = {
      status: config.mode === 'remote' ? 'connecting' : 'unavailable',
      message: config.mode === 'remote'
        ? 'Connecting to the selected Runtime…'
        : 'Markets require a connected Runtime. The React embedded Runtime boot flow is not active yet.',
      projection: null,
      command: idleCommand(),
    };
  }

  readonly getSnapshot = (): WalletMarketSourceSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly start = async (): Promise<void> => {
    if (this.started) return;
    this.started = true;
    if (this.config.mode !== 'remote') return;
    const generation = ++this.generation;
    this.patch({ status: 'connecting', message: 'Connecting to the selected Runtime…' });
    try {
      const [dependencies, marketMath] = await Promise.all([
        loadWalletRuntimeReadDependencies(this.config),
        loadWalletMarketMath(),
      ]);
      if (!this.isCurrent(generation)) {
        dependencies.adapter.disconnect();
        return;
      }
      this.adapter = dependencies.adapter;
      this.dependencies = dependencies;
      this.marketMath = marketMath;
      this.installObserver(dependencies);
    } catch (error: unknown) {
      if (!this.isCurrent(generation)) return;
      this.started = false;
      this.releaseRuntime();
      this.patch({ status: 'error', message: walletRuntimeReadErrorMessage(error), projection: null });
    }
  };

  readonly stop = (): void => {
    this.started = false;
    this.generation += 1;
    this.releaseRuntime();
  };

  readonly refresh = (): Promise<void> => this.observer?.refresh() ?? this.start();

  readonly selectEntity = (entityId: string): void => {
    const normalized = normalizeEntityIdForRuntimeView(entityId);
    const projection = this.requireProjection();
    if (!projection.entities.some((entity) => entity.entityId === normalized)) {
      throw new Error(`WALLET_MARKET_ENTITY_UNKNOWN:${normalized}`);
    }
    if (normalized === projection.activeEntityId) return;
    this.requireNoPendingCommand('WALLET_MARKET_ENTITY_CHANGE_PENDING_COMMAND');
    this.selectedEntityId = normalized;
    this.selectedHubId = '';
    this.selectedPairId = '';
    this.resetActivity();
    void this.observer?.refresh();
  };

  readonly selectHub = (hubEntityId: string): void => {
    const normalized = normalizeEntityIdForRuntimeView(hubEntityId);
    const projection = this.requireProjection();
    if (!projection.hubs.some((hub) => hub.entityId === normalized)) {
      throw new Error('WALLET_MARKET_HUB_UNKNOWN');
    }
    if (normalized === projection.selectedHubId) return;
    this.requireNoPendingCommand('WALLET_MARKET_HUB_CHANGE_PENDING_COMMAND');
    this.selectedHubId = normalized;
    this.selectedPairId = '';
    void this.observer?.refresh();
  };

  readonly selectPair = (pairId: string): void => {
    const projection = this.requireProjection();
    if (!projection.pairs.some((pair) => pair.pairId === pairId)) {
      throw new Error('WALLET_MARKET_PAIR_UNKNOWN');
    }
    if (pairId === projection.selectedPairId) return;
    this.requireNoPendingCommand('WALLET_MARKET_PAIR_CHANGE_PENDING_COMMAND');
    this.selectedPairId = pairId;
    this.patch({ projection: { ...projection, selectedPairId: pairId } });
  };

  readonly selectActivityKind = (kind: WalletMarketActivityKind): void => {
    if (!['all', 'onchain', 'offchain'].includes(kind)) throw new Error('WALLET_MARKET_ACTIVITY_KIND_INVALID');
    if (kind === this.activityKind) return;
    this.activityKind = kind;
    this.resetActivity();
    void this.observer?.refresh();
  };

  readonly selectOlderActivity = (): void => {
    if (this.snapshot.status === 'loading') throw new Error('WALLET_MARKET_ACTIVITY_BUSY');
    const next = this.snapshot.projection?.activityNextBeforeHeight ?? null;
    if (next === null) throw new Error('WALLET_MARKET_ACTIVITY_OLDER_UNAVAILABLE');
    if (this.activityPage === this.activityCursors.length - 1) this.activityCursors.push(next);
    this.activityPage += 1;
    void this.observer?.refresh();
  };

  readonly selectNewerActivity = (): void => {
    if (this.snapshot.status === 'loading') throw new Error('WALLET_MARKET_ACTIVITY_BUSY');
    if (this.activityPage <= 0) throw new Error('WALLET_MARKET_ACTIVITY_NEWER_UNAVAILABLE');
    this.activityPage -= 1;
    void this.observer?.refresh();
  };

  readonly submitOrder = async (draft: WalletMarketOrderDraft): Promise<void> => {
    const dependencies = this.requireDependencies();
    const input = buildWalletMarketOrderInput(
      draft,
      this.requireProjection(),
      dependencies.math,
      this.requireMarketMath(),
    );
    await this.submitInput(input);
  };

  readonly cancelOrder = async (offerId: string): Promise<void> => {
    await this.submitInput(buildWalletMarketCancelInput(this.requireProjection(), offerId));
  };

  readonly retryPendingCommand = async (): Promise<void> => {
    if (!this.pendingCommand) throw new Error('WALLET_MARKET_PENDING_COMMAND_MISSING');
    await this.executePending(this.pendingCommand);
  };

  private installObserver(dependencies: WalletRuntimeReadDependencies): void {
    const { adapter, math } = dependencies;
    const client = createWalletRuntimeQueryClient(adapter);
    const observer = new RuntimeQueryObserver(async () => {
      const activeFrame = await client.readViewFrame({
        accountsLimit: 100,
        booksLimit: 1,
        ...(this.selectedEntityId ? { entityId: this.selectedEntityId } : {}),
      });
      const context = decodeWalletMarketContext(activeFrame, math);
      const activeEntityId = context.payment.activeEntityId;
      if (!activeEntityId) throw new Error('WALLET_MARKET_ENTITY_UNAVAILABLE');
      const selectedHubId = context.hubs.some((hub) => hub.entityId === this.selectedHubId)
        ? this.selectedHubId
        : context.hubs[0]?.entityId ?? '';
      const activityPromise = client.readActivity({
        entityId: activeEntityId,
        kind: this.activityKind,
        limit: 25,
        scanLimit: 250,
        beforeHeight: this.activityCursors[this.activityPage] ?? context.payment.height + 1,
      });
      if (!selectedHubId) {
        return contextOnlyProjection(activeFrame, await activityPromise, this.activityKind, this.activityPage, math);
      }
      const [hubFrame, activity] = await Promise.all([
        client.readViewFrame({ entityId: selectedHubId, accountsLimit: 1, booksLimit: 50 }),
        activityPromise,
      ]);
      return decodeWalletMarketProjection({
        activeFrame,
        hubFrame,
        activity,
        selectedHubId,
        selectedPairId: this.selectedPairId,
        activityKind: this.activityKind,
        activityPage: this.activityPage,
      }, math);
    }, {
      readHeight: () => adapter.currentHeight,
      subscribeHeight: (listener) => adapter.onChange(() => listener()),
      subscribeAdapter: (listener) => adapter.onStatus(() => listener()),
    });
    this.observer = observer;
    this.teardowns.push(observer.subscribe(this.syncObserver));
    this.teardowns.push(adapter.onChange(() => { void this.reconcilePending(); }));
    this.teardowns.push(adapter.onStatus((status) => {
      if (status === 'connected') void this.reconcilePending();
    }));
    this.syncObserver();
  }

  private readonly syncObserver = (): void => {
    if (!this.observer) return;
    const observed: RuntimeQuerySnapshot<WalletMarketProjection> = this.observer.getSnapshot();
    if (observed.loading) {
      this.patch({ status: 'loading', message: 'Reading committed markets and activity…', projection: observed.data });
      return;
    }
    if (observed.error || !observed.data) {
      this.patch({ status: 'error', message: observed.error || 'Runtime returned no market projection.', projection: null });
      return;
    }
    this.selectedHubId = observed.data.selectedHubId;
    this.selectedPairId = observed.data.selectedPairId;
    this.patch({ status: 'ready', message: '', projection: observed.data });
  };

  private async submitInput(input: WalletPreparedCommand['input']): Promise<void> {
    if (this.pendingCommand || this.commandBusy) throw new Error('WALLET_MARKET_COMMAND_ALREADY_PENDING');
    this.commandBusy = true;
    this.patch({ command: { ...idleCommand(), status: 'submitting', message: 'Submitting one idempotent Runtime command…' } });
    try {
      const command = await prepareWalletPaymentCommand(this.requireAdapter(), input);
      this.pendingCommand = command;
      await this.executePending(command);
    } catch (error: unknown) {
      if (!this.pendingCommand) {
        this.patch({ command: { ...idleCommand(), status: 'error', message: walletRuntimeReadErrorMessage(error) } });
      }
      throw error;
    } finally {
      this.commandBusy = false;
    }
  }

  private async executePending(command: WalletPreparedCommand): Promise<void> {
    if (this.commandBusy && this.snapshot.command.status !== 'submitting') return;
    this.commandBusy = true;
    try {
      const result = await executeWalletPaymentCommand(this.requireAdapter(), command);
      const shortId = command.commandId.slice(-12);
      if (result.status === 'observed') {
        this.pendingCommand = null;
        this.patch({ command: {
          status: 'observed', message: `Committed at Runtime height ${result.height}.`,
          commandId: shortId, durable: command.durable, retryable: false,
        } });
        await this.observer?.refresh();
        return;
      }
      this.patch({ command: {
        status: 'pending',
        message: `Accepted after height ${result.height}. Do not submit a second command while observation is pending.`,
        commandId: shortId,
        durable: command.durable,
        retryable: true,
      } });
      if (this.adapter && this.adapter.currentHeight > result.height) {
        queueMicrotask(() => { void this.reconcilePending(); });
      }
    } catch (error: unknown) {
      const failure = await abandonTerminalWalletPaymentCommand(command, error);
      if (failure.terminal) this.pendingCommand = null;
      this.patch({ command: {
        status: 'error',
        message: failure.terminal ? failure.message : `Outcome unresolved. ${failure.message}`,
        commandId: command.commandId.slice(-12),
        durable: command.durable,
        retryable: failure.retryable,
      } });
      throw error;
    } finally {
      this.commandBusy = false;
    }
  }

  private async reconcilePending(): Promise<void> {
    const command = this.pendingCommand;
    if (!command || this.commandBusy || this.adapter?.status !== 'connected') return;
    try {
      await this.executePending(command);
    } catch (error: unknown) {
      if (this.snapshot.command.status !== 'error') {
        this.patch({ command: {
          status: 'error',
          message: walletRuntimeReadErrorMessage(error),
          commandId: command.commandId.slice(-12),
          durable: command.durable,
          retryable: true,
        } });
      }
    }
  }

  private resetActivity(): void {
    this.activityCursors = [null];
    this.activityPage = 0;
  }

  private requireNoPendingCommand(code: string): void {
    if (this.pendingCommand || this.commandBusy) throw new Error(code);
  }

  private requireAdapter(): RuntimeAdapter {
    if (!this.adapter || this.adapter.status !== 'connected') throw new Error('WALLET_MARKET_RUNTIME_NOT_CONNECTED');
    return this.adapter;
  }

  private requireDependencies(): WalletRuntimeReadDependencies {
    if (!this.dependencies) throw new Error('WALLET_MARKET_DEPENDENCIES_UNAVAILABLE');
    return this.dependencies;
  }

  private requireMarketMath(): WalletMarketMath {
    if (!this.marketMath) throw new Error('WALLET_MARKET_MATH_UNAVAILABLE');
    return this.marketMath;
  }

  private requireProjection(): WalletMarketProjection {
    if (!this.snapshot.projection?.activeEntityId) throw new Error('WALLET_MARKET_ENTITY_UNAVAILABLE');
    return this.snapshot.projection;
  }

  private releaseRuntime(): void {
    for (const teardown of this.teardowns.splice(0)) teardown();
    this.observer?.destroy();
    this.observer = null;
    this.adapter?.disconnect();
    this.adapter = null;
    this.dependencies = null;
    this.marketMath = null;
  }

  private isCurrent(generation: number): boolean {
    return this.started && generation === this.generation;
  }

  private patch(patch: Partial<WalletMarketSourceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
