export type RuntimeQuerySnapshot<T> = Readonly<{
  loading: boolean;
  data: T | null;
  error: string | null;
  height: number;
}>;

export type RuntimeQueryObserverDependencies = Readonly<{
  readHeight: () => number;
  subscribeHeight: (listener: () => void) => () => void;
  subscribeAdapter: (listener: () => void) => () => void;
}>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Runtime query failed');

export class RuntimeQueryObserver<T> {
  private snapshot: RuntimeQuerySnapshot<T>;
  private readonly listeners = new Set<() => void>();
  private readonly teardowns: Array<() => void> = [];
  private disposed = false;
  private version = 0;

  constructor(
    private readonly reader: () => Promise<T>,
    private readonly dependencies: RuntimeQueryObserverDependencies,
  ) {
    this.snapshot = {
      loading: true,
      data: null,
      error: null,
      height: dependencies.readHeight(),
    };
    this.teardowns.push(
      dependencies.subscribeHeight(() => { void this.refresh(); }),
      dependencies.subscribeAdapter(() => { void this.refresh(); }),
    );
    void this.refresh();
  }

  readonly getSnapshot = (): RuntimeQuerySnapshot<T> => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly refresh = async (): Promise<void> => {
    if (this.disposed) return;
    const currentVersion = ++this.version;
    this.publish({ ...this.snapshot, loading: true, error: null });
    try {
      const data = await this.reader();
      if (!this.isCurrent(currentVersion)) return;
      this.publish({
        loading: false,
        data,
        error: null,
        height: this.dependencies.readHeight(),
      });
    } catch (error) {
      if (!this.isCurrent(currentVersion)) return;
      this.publish({
        loading: false,
        data: null,
        error: errorMessage(error),
        height: this.dependencies.readHeight(),
      });
    }
  };

  readonly destroy = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.version += 1;
    for (const teardown of this.teardowns.splice(0).reverse()) teardown();
    this.listeners.clear();
  };

  private isCurrent(version: number): boolean {
    return !this.disposed && version === this.version;
  }

  private publish(snapshot: RuntimeQuerySnapshot<T>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
