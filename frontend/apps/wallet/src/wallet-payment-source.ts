import type { RuntimeAdapter } from '../../../../core/api/runtime-adapter/types';
import type {
  RuntimePaymentDeliveryMode,
  RuntimePaymentEntityTx,
  RuntimePaymentInput,
} from '../../../packages/runtime-client/src/payment-command-types';
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
import {
  buildWalletEntityTxInput,
  buildWalletPaymentInput,
  decodeWalletPaymentProjection,
  decodeWalletPaymentRoutes,
  type WalletPaymentMath,
  type WalletPaymentProjection,
  type WalletPaymentQuoteRequest,
  type WalletPaymentRoute,
} from './wallet-payment-model';
import {
  buildWalletOperationTx,
  type WalletOperationDraft,
} from './wallet-payment-operations-model';
import {
  createWalletRuntimeQueryClient,
  loadWalletRuntimeReadDependencies,
  walletRuntimeReadErrorMessage,
} from './wallet-runtime-read-boundary';

type QuoteState = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  routes: readonly WalletPaymentRoute[];
}>;

export type WalletPaymentCommandState = Readonly<{
  status: 'idle' | 'submitting' | 'pending' | 'observed' | 'error';
  message: string;
  commandId: string;
  durable: boolean;
  retryable: boolean;
}>;

export type WalletPaymentSourceSnapshot = Readonly<{
  status: 'unavailable' | 'connecting' | 'loading' | 'ready' | 'error';
  message: string;
  projection: WalletPaymentProjection | null;
  quote: QuoteState;
  command: WalletPaymentCommandState;
}>;

const idleQuote = (): QuoteState => ({ status: 'idle', message: '', routes: [] });
const idleCommand = (): WalletPaymentCommandState => ({
  status: 'idle', message: '', commandId: '', durable: false, retryable: false,
});

export class WalletPaymentSource {
  private readonly listeners = new Set<() => void>();
  private snapshot: WalletPaymentSourceSnapshot;
  private adapter: RuntimeAdapter | null = null;
  private math: WalletPaymentMath | null = null;
  private observer: RuntimeQueryObserver<WalletPaymentProjection> | null = null;
  private teardowns: Array<() => void> = [];
  private generation = 0;
  private quoteGeneration = 0;
  private started = false;
  private selectedEntityId = '';
  private quoteRequest: WalletPaymentQuoteRequest | null = null;
  private pendingCommand: WalletPreparedCommand | null = null;
  private commandBusy = false;

  constructor(private readonly config: RuntimeAdapterStorageSnapshot) {
    this.snapshot = {
      status: config.mode === 'remote' ? 'connecting' : 'unavailable',
      message: config.mode === 'remote'
        ? 'Connecting to the selected Runtime…'
        : 'Payments require a connected Runtime. The React embedded Runtime boot flow is not active yet.',
      projection: null,
      quote: idleQuote(),
      command: idleCommand(),
    };
  }

  readonly getSnapshot = (): WalletPaymentSourceSnapshot => this.snapshot;

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
      const dependencies = await loadWalletRuntimeReadDependencies(this.config);
      if (!this.isCurrent(generation)) {
        dependencies.adapter.disconnect();
        return;
      }
      this.adapter = dependencies.adapter;
      this.math = dependencies.math;
      this.installObserver(dependencies.adapter, dependencies.math);
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
    this.quoteGeneration += 1;
    this.releaseRuntime();
  };

  readonly refresh = (): Promise<void> => this.observer?.refresh() ?? this.start();

  readonly selectEntity = (entityId: string): void => {
    const normalized = normalizeEntityIdForRuntimeView(entityId);
    const projection = this.snapshot.projection;
    if (!projection?.entities.some((entity) => entity.entityId === normalized)) {
      throw new Error(`WALLET_PAYMENT_ENTITY_UNKNOWN:${normalized}`);
    }
    if (normalized === projection.activeEntityId) return;
    if (this.pendingCommand) throw new Error('WALLET_PAYMENT_ENTITY_CHANGE_PENDING_COMMAND');
    this.selectedEntityId = normalized;
    this.clearQuote();
    void this.observer?.refresh();
  };

  readonly quotePayment = async (input: Readonly<{
    targetEntityId: string;
    tokenId: number;
    amount: string;
    deliveryMode: RuntimePaymentDeliveryMode;
  }>): Promise<void> => {
    const adapter = this.requireAdapter();
    const math = this.requireMath();
    const projection = this.requireProjection();
    const targetEntityId = normalizeEntityIdForRuntimeView(input.targetEntityId);
    const recipient = projection.recipients.find((candidate) => candidate.entityId === targetEntityId);
    if (!recipient) throw new Error('WALLET_PAYMENT_RECIPIENT_UNKNOWN');
    if (recipient.blocked) throw new Error('WALLET_PAYMENT_RECIPIENT_ACCOUNT_BLOCKED');
    if (!projection.tokens.some(({ tokenId }) => tokenId === input.tokenId)) {
      throw new Error('WALLET_PAYMENT_TOKEN_UNKNOWN');
    }
    const recipientAmount = math.parseTokenAmount(input.tokenId, input.amount.trim());
    if (recipientAmount <= 0n) throw new Error('WALLET_PAYMENT_AMOUNT_NOT_POSITIVE');
    const request: WalletPaymentQuoteRequest = {
      sourceEntityId: projection.activeEntityId,
      targetEntityId,
      tokenId: input.tokenId,
      recipientAmount,
      deliveryMode: input.deliveryMode,
    };
    const generation = ++this.quoteGeneration;
    this.quoteRequest = request;
    this.patch({ quote: { status: 'loading', message: 'Finding committed-capacity routes…', routes: [] } });
    try {
      const response = await adapter.read('payment-routes', {
        sourceEntityId: request.sourceEntityId,
        targetEntityId: request.targetEntityId,
        tokenId: request.tokenId,
        amount: request.recipientAmount.toString(),
      });
      if (generation !== this.quoteGeneration) return;
      const routes = decodeWalletPaymentRoutes(response, request);
      if (routes.length === 0) throw new Error(`WALLET_PAYMENT_ROUTE_MODE_UNAVAILABLE:${input.deliveryMode}`);
      this.patch({ quote: { status: 'ready', message: '', routes } });
    } catch (error: unknown) {
      if (generation !== this.quoteGeneration) return;
      this.patch({ quote: { status: 'error', message: walletRuntimeReadErrorMessage(error), routes: [] } });
    }
  };

  readonly submitQuotedPayment = async (description: string): Promise<void> => {
    const projection = this.requireProjection();
    const request = this.quoteRequest;
    const route = this.snapshot.quote.routes[0];
    if (!request || !route || this.snapshot.quote.status !== 'ready') {
      throw new Error('WALLET_PAYMENT_QUOTE_REQUIRED');
    }
    await this.submitInput(buildWalletPaymentInput({
      projection,
      targetEntityId: request.targetEntityId,
      tokenId: request.tokenId,
      deliveryMode: request.deliveryMode,
      description,
      route,
    }));
  };

  readonly submitEntityTx = async (entityTx: RuntimePaymentEntityTx): Promise<void> => {
    await this.submitInput(buildWalletEntityTxInput(this.requireProjection(), entityTx));
  };

  readonly submitOperation = async (draft: WalletOperationDraft): Promise<void> => {
    const projection = this.requireProjection();
    const entityTx = buildWalletOperationTx(draft, projection, this.requireMath());
    await this.submitInput(buildWalletEntityTxInput(projection, entityTx));
  };

  readonly validateInvoiceAmount = (tokenId: number, amount: string): string | null => {
    const normalized = amount.trim();
    if (!normalized) return null;
    try {
      if (this.requireMath().parseTokenAmount(tokenId, normalized) <= 0n) {
        return 'Amount must be greater than zero.';
      }
      return null;
    } catch (error: unknown) {
      return walletRuntimeReadErrorMessage(error);
    }
  };

  readonly retryPendingCommand = async (): Promise<void> => {
    if (!this.pendingCommand) throw new Error('WALLET_PAYMENT_PENDING_COMMAND_MISSING');
    await this.executePending(this.pendingCommand);
  };

  private async submitInput(input: RuntimePaymentInput): Promise<void> {
    if (this.pendingCommand || this.commandBusy) throw new Error('WALLET_PAYMENT_COMMAND_ALREADY_PENDING');
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
        this.clearQuote();
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

  private installObserver(adapter: RuntimeAdapter, math: WalletPaymentMath): void {
    const client = createWalletRuntimeQueryClient(adapter);
    const observer = new RuntimeQueryObserver(
      async () => decodeWalletPaymentProjection(await client.readViewFrame({
        accountsLimit: 100,
        booksLimit: 1,
        ...(this.selectedEntityId ? { entityId: this.selectedEntityId } : {}),
      }), math),
      {
        readHeight: () => adapter.currentHeight,
        subscribeHeight: (listener) => adapter.onChange(() => listener()),
        subscribeAdapter: (listener) => adapter.onStatus(() => listener()),
      },
    );
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
    const observed: RuntimeQuerySnapshot<WalletPaymentProjection> = this.observer.getSnapshot();
    if (observed.loading) {
      this.patch({ status: 'loading', message: 'Reading committed payment capacity…', projection: observed.data });
      return;
    }
    if (observed.error || !observed.data) {
      this.patch({ status: 'error', message: observed.error || 'Runtime returned no payment projection.', projection: null });
      return;
    }
    const previous = this.snapshot.projection;
    if (previous && (previous.height !== observed.data.height || previous.activeEntityId !== observed.data.activeEntityId)) {
      this.clearQuote();
    }
    this.patch({ status: 'ready', message: '', projection: observed.data });
  };

  private async reconcilePending(): Promise<void> {
    if (!this.pendingCommand || this.commandBusy || this.adapter?.status !== 'connected') return;
    await this.executePending(this.pendingCommand).catch(() => undefined);
  }

  private clearQuote(): void {
    this.quoteGeneration += 1;
    this.quoteRequest = null;
    this.patch({ quote: idleQuote() });
  }

  private requireAdapter(): RuntimeAdapter {
    if (!this.adapter || this.adapter.status !== 'connected') throw new Error('WALLET_PAYMENT_RUNTIME_NOT_CONNECTED');
    return this.adapter;
  }

  private requireMath(): WalletPaymentMath {
    if (!this.math) throw new Error('WALLET_PAYMENT_MATH_UNAVAILABLE');
    return this.math;
  }

  private requireProjection(): WalletPaymentProjection {
    if (!this.snapshot.projection?.activeEntityId) throw new Error('WALLET_PAYMENT_ENTITY_UNAVAILABLE');
    return this.snapshot.projection;
  }

  private releaseRuntime(): void {
    for (const teardown of this.teardowns.splice(0)) teardown();
    this.observer?.destroy();
    this.observer = null;
    this.adapter?.disconnect();
    this.adapter = null;
    this.math = null;
  }

  private isCurrent(generation: number): boolean {
    return this.started && generation === this.generation;
  }

  private patch(patch: Partial<WalletPaymentSourceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
