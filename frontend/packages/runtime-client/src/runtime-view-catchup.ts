import type { RuntimeAdapterStatus } from './runtime-handle';

export type RuntimeViewCatchupState = Readonly<{
  atHeight: number | null;
  frameHeight: number;
  hasFrame: boolean;
  status: RuntimeAdapterStatus;
}>;

export type RuntimeViewCatchupDependencies<TimerHandle> = Readonly<{
  readState: () => RuntimeViewCatchupState;
  refresh: () => Promise<void>;
  publishTimeout: (message: string) => void;
  reportRefreshError: (error: unknown) => void;
  scheduleRetry: (listener: () => void, delayMs: number) => TimerHandle;
  cancelRetry: (timer: TimerHandle) => void;
  retryLimit?: number;
}>;

const normalizeHeight = (value: unknown): number =>
  Math.max(0, Math.floor(Number(value) || 0));

export const runtimeViewCatchupRetryDelayMs = (attempt: number): number =>
  Math.min(250, 50 * (2 ** normalizeHeight(attempt)));

export class RuntimeViewCatchupCoordinator<TimerHandle> {
  private inFlight = false;
  private pendingHeight = 0;
  private retryTimer: TimerHandle | null = null;
  private retryTarget = 0;
  private retryAttempt = 0;
  private disposed = false;
  private readonly retryLimit: number;

  constructor(private readonly dependencies: RuntimeViewCatchupDependencies<TimerHandle>) {
    this.retryLimit = dependencies.retryLimit === undefined
      ? 20
      : normalizeHeight(dependencies.retryLimit);
  }

  readonly observeHeight = (height: number): void => {
    if (this.disposed) return;
    const nextHeight = normalizeHeight(height);
    const state = this.dependencies.readState();
    if (!this.needsCatchup(state, nextHeight)) return;
    if (nextHeight > this.pendingHeight) this.clearRetry();
    this.pendingHeight = Math.max(this.pendingHeight, nextHeight);
    if (!state.hasFrame) return;
    void this.continue();
  };

  readonly continue = async (): Promise<void> => {
    if (this.disposed || this.inFlight) return;
    if (!this.needsCatchup(this.dependencies.readState(), this.pendingHeight)) {
      this.clearRetry();
      return;
    }
    this.inFlight = true;
    try {
      await this.dependencies.refresh();
    } catch (error) {
      this.dependencies.reportRefreshError(error);
    } finally {
      this.inFlight = false;
      if (this.disposed) return;
      if (this.needsCatchup(this.dependencies.readState(), this.pendingHeight)) {
        this.scheduleRetry();
      } else {
        this.clearRetry();
      }
    }
  };

  readonly reset = (): void => {
    this.pendingHeight = 0;
    this.clearRetry();
  };

  readonly destroy = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
  };

  private needsCatchup(state: RuntimeViewCatchupState, targetHeight: number): boolean {
    return state.atHeight === null &&
      state.status === 'connected' &&
      targetHeight > normalizeHeight(state.frameHeight);
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer !== null || this.inFlight) return;
    const state = this.dependencies.readState();
    const targetHeight = this.pendingHeight;
    if (!this.needsCatchup(state, targetHeight)) {
      this.clearRetry();
      return;
    }
    if (this.retryTarget !== targetHeight) {
      this.retryTarget = targetHeight;
      this.retryAttempt = 0;
    }
    if (this.retryAttempt >= this.retryLimit) {
      this.dependencies.publishTimeout(
        `RUNTIME_VIEW_CATCHUP_TIMEOUT: target=h${targetHeight} frame=h${normalizeHeight(state.frameHeight)}`,
      );
      return;
    }
    const delayMs = runtimeViewCatchupRetryDelayMs(this.retryAttempt++);
    this.retryTimer = this.dependencies.scheduleRetry(() => {
      this.retryTimer = null;
      void this.continue();
    }, delayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.dependencies.cancelRetry(this.retryTimer);
    this.retryTimer = null;
    this.retryTarget = 0;
    this.retryAttempt = 0;
  }
}
