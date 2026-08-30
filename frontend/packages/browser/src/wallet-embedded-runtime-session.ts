export type WalletEmbeddedRuntimeStatus = 'idle' | 'booting' | 'ready' | 'standby' | 'error';

export type WalletEmbeddedRuntimeSessionSnapshot = Readonly<{
  status: WalletEmbeddedRuntimeStatus;
  runtimeId: string;
  height: number;
  message: string;
}>;

export type WalletEmbeddedRuntimeResource<Adapter> = Readonly<{
  adapter: Adapter;
  runtimeId: string;
  readHeight: () => number;
  subscribeHeight: (listener: (height: number) => void) => () => void;
  subscribeStatus: (listener: (status: string) => void) => () => void;
  stop: () => Promise<void>;
}>;

export type WalletEmbeddedRuntimeSessionDependencies<Adapter> = Readonly<{
  acquireLock: (onLoseLock: () => Promise<void>) => Promise<() => void>;
  boot: () => Promise<WalletEmbeddedRuntimeResource<Adapter>>;
  errorMessage?: (error: unknown) => string;
}>;

export type WalletEmbeddedRuntimeSession<Adapter> = Readonly<{
  getSnapshot: () => WalletEmbeddedRuntimeSessionSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => Promise<Adapter>;
  stop: () => Promise<void>;
  requireAdapter: () => Adapter;
}>;

const idleSnapshot = (): WalletEmbeddedRuntimeSessionSnapshot => ({
  status: 'idle', runtimeId: '', height: 0, message: 'Local Runtime has not started.',
});

const defaultErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Embedded Runtime failed');

export const createWalletEmbeddedRuntimeSession = <Adapter>(
  dependencies: WalletEmbeddedRuntimeSessionDependencies<Adapter>,
): WalletEmbeddedRuntimeSession<Adapter> => {
  const listeners = new Set<() => void>();
  let snapshot = idleSnapshot();
  let resource: WalletEmbeddedRuntimeResource<Adapter> | null = null;
  let releaseLock: (() => void) | null = null;
  let startInFlight: Promise<Adapter> | null = null;
  let generation = 0;
  let resourceTeardowns: Array<() => void> = [];

  const publish = (next: WalletEmbeddedRuntimeSessionSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const releaseResource = async (): Promise<void> => {
    for (const teardown of resourceTeardowns.splice(0)) teardown();
    const current = resource;
    if (!current) return;
    await current.stop();
    if (resource === current) resource = null;
  };

  const handleLockLoss = async (ownedGeneration: number): Promise<void> => {
    if (ownedGeneration !== generation) return;
    generation += 1;
    try {
      await releaseResource();
      releaseLock = null;
      publish({
        status: 'standby', runtimeId: '', height: 0,
        message: 'Use the active tab, or reload this page to request Runtime ownership.',
      });
    } catch (error: unknown) {
      publish({ status: 'error', runtimeId: '', height: 0, message: (dependencies.errorMessage ?? defaultErrorMessage)(error) });
      throw error;
    }
  };

  const installResource = (
    next: WalletEmbeddedRuntimeResource<Adapter>,
    ownedGeneration: number,
  ): Adapter => {
    resource = next;
    resourceTeardowns = [
      next.subscribeHeight((height) => {
        if (ownedGeneration !== generation) return;
        publish({ ...snapshot, height: Math.max(0, Math.floor(height)) });
      }),
      next.subscribeStatus((status) => {
        if (ownedGeneration !== generation || status !== 'error') return;
        publish({ ...snapshot, status: 'error', message: 'Embedded Runtime adapter disconnected with an error.' });
      }),
    ];
    publish({
      status: 'ready', runtimeId: next.runtimeId, height: next.readHeight(), message: '',
    });
    return next.adapter;
  };

  const startAttempt = async (): Promise<Adapter> => {
    const ownedGeneration = ++generation;
    publish({ status: 'booting', runtimeId: '', height: 0, message: 'Starting local Runtime…' });
    try {
      releaseLock = await dependencies.acquireLock(() => handleLockLoss(ownedGeneration));
      if (ownedGeneration !== generation) throw new Error('EMBEDDED_RUNTIME_BOOT_CANCELLED');
      const next = await dependencies.boot();
      if (ownedGeneration === generation) return installResource(next, ownedGeneration);
      await next.stop();
      throw new Error('EMBEDDED_RUNTIME_BOOT_CANCELLED');
    } catch (error: unknown) {
      releaseLock?.();
      releaseLock = null;
      if (ownedGeneration === generation) {
        publish({ status: 'error', runtimeId: '', height: 0, message: (dependencies.errorMessage ?? defaultErrorMessage)(error) });
      }
      throw error;
    }
  };

  const start = async (): Promise<Adapter> => {
    if (resource) return resource.adapter;
    if (!startInFlight) startInFlight = startAttempt();
    try {
      return await startInFlight;
    } finally {
      startInFlight = null;
    }
  };

  const stop = async (): Promise<void> => {
    generation += 1;
    try {
      await releaseResource();
      releaseLock?.();
      releaseLock = null;
      publish(idleSnapshot());
    } catch (error: unknown) {
      publish({ status: 'error', runtimeId: '', height: 0, message: (dependencies.errorMessage ?? defaultErrorMessage)(error) });
      throw error;
    }
  };

  const requireAdapter = (): Adapter => {
    if (!resource || snapshot.status !== 'ready') throw new Error('EMBEDDED_RUNTIME_NOT_READY');
    return resource.adapter;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    start,
    stop,
    requireAdapter,
  };
};
