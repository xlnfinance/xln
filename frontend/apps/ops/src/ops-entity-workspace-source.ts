import type {
  RuntimeAdapter,
  RuntimeAdapterReadQuery,
} from '../../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import {
  emptyEntityWorkspaceContext,
  projectEntityWorkspaceContext,
  type EntityWorkspaceContext,
  type EntityWorkspaceReadState,
} from '../../../packages/runtime-client/src/entity-workspace-context';
import { RuntimeQueryClient } from '../../../packages/runtime-client/src/runtime-query-client';
import {
  RuntimeQueryObserver,
  type RuntimeQuerySnapshot,
} from '../../../packages/runtime-client/src/runtime-query-observer';

type RuntimeReadSession = Readonly<{
  adapter: RuntimeAdapter;
  release: () => void;
}>;

export type OpsEntityWorkspaceSourceSnapshot = Readonly<{
  context: EntityWorkspaceContext;
  readState: EntityWorkspaceReadState;
}>;

export type OpsEntityWorkspaceSourceDependencies = Readonly<{
  openSession: (config: RuntimeAdapterStorageSnapshot) => Promise<RuntimeReadSession>;
}>;

type RemoteSessionConfig = Readonly<{
  wsUrl: string;
  authKey: string;
}>;

export const requireOpsEntityRemoteSession = (
  snapshot: RuntimeAdapterStorageSnapshot,
): RemoteSessionConfig => {
  if (snapshot.mode !== 'remote') throw new Error('OPS_ENTITY_REMOTE_SESSION_REQUIRED');
  if (snapshot.access !== 'admin') throw new Error('OPS_ENTITY_REMOTE_ADMIN_ACCESS_REQUIRED');
  const wsUrl = String(snapshot.wsUrl || '').trim();
  if (!wsUrl) throw new Error('OPS_ENTITY_REMOTE_ENDPOINT_REQUIRED');
  const authKey = String(snapshot.sessionKey || '').trim();
  if (!authKey) throw new Error('OPS_ENTITY_REMOTE_AUTH_REQUIRED');
  return { wsUrl, authKey };
};

export const openOpsEntityRuntimeReadSession = async (
  snapshot: RuntimeAdapterStorageSnapshot,
): Promise<RuntimeReadSession> => {
  const config = requireOpsEntityRemoteSession(snapshot);
  await import('../../../../core/support/process/runtime-process.ts');
  const { RemoteRuntimeAdapter } = await import('../../../../core/api/runtime-adapter/remote.ts');
  const adapter = new RemoteRuntimeAdapter();
  try {
    await adapter.connect({ mode: 'remote', ...config });
  } catch (error: unknown) {
    adapter.disconnect();
    throw error;
  }
  return { adapter, release: () => adapter.disconnect() };
};

const unavailableSnapshot = (): OpsEntityWorkspaceSourceSnapshot => ({
  context: emptyEntityWorkspaceContext(),
  readState: {
    status: 'unavailable',
    message: 'Select a remote Runtime in the wallet before opening this candidate workspace.',
  },
});

export const initialOpsEntityWorkspaceSnapshot = (
  config: RuntimeAdapterStorageSnapshot,
): OpsEntityWorkspaceSourceSnapshot => config.mode === 'remote'
  ? {
      context: emptyEntityWorkspaceContext(),
      readState: { status: 'connecting', message: 'Connecting to the selected Runtime…' },
    }
  : unavailableSnapshot();

export const projectOpsEntityWorkspaceObserverSnapshot = (
  runtimeId: string,
  currentContext: EntityWorkspaceContext,
  snapshot: RuntimeQuerySnapshot<EntityWorkspaceContext>,
): OpsEntityWorkspaceSourceSnapshot => {
  if (snapshot.loading) {
    return {
      context: snapshot.data ?? currentContext,
      readState: { status: 'loading', message: 'Reading the committed Entity context…' },
    };
  }
  if (snapshot.error) {
    return {
      context: emptyEntityWorkspaceContext(runtimeId),
      readState: { status: 'error', message: snapshot.error },
    };
  }
  if (!snapshot.data) {
    return {
      context: emptyEntityWorkspaceContext(runtimeId),
      readState: { status: 'error', message: 'Runtime returned no Entity workspace context.' },
    };
  }
  return { context: snapshot.data, readState: { status: 'ready', message: '' } };
};

export class OpsEntityWorkspaceSource {
  private readonly listeners = new Set<() => void>();
  private snapshot: OpsEntityWorkspaceSourceSnapshot;
  private session: RuntimeReadSession | null = null;
  private observer: RuntimeQueryObserver<EntityWorkspaceContext> | null = null;
  private observerTeardown: (() => void) | null = null;
  private generation = 0;
  private started = false;

  constructor(
    private readonly config: RuntimeAdapterStorageSnapshot,
    private readonly dependencies: OpsEntityWorkspaceSourceDependencies = {
      openSession: openOpsEntityRuntimeReadSession,
    },
  ) {
    this.snapshot = initialOpsEntityWorkspaceSnapshot(config);
  }

  readonly getSnapshot = (): OpsEntityWorkspaceSourceSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly start = async (): Promise<void> => {
    if (this.started || this.config.mode !== 'remote') return;
    this.started = true;
    const generation = ++this.generation;
    this.publish({
      context: emptyEntityWorkspaceContext(),
      readState: { status: 'connecting', message: 'Connecting to the selected Runtime…' },
    });
    try {
      const session = await this.dependencies.openSession(this.config);
      if (!this.isCurrent(generation)) {
        session.release();
        return;
      }
      this.session = session;
      this.installObserver(session.adapter);
    } catch (error: unknown) {
      if (!this.isCurrent(generation)) return;
      this.started = false;
      this.releaseRuntimeConnection();
      this.publish({
        context: emptyEntityWorkspaceContext(),
        readState: {
          status: 'error',
          message: error instanceof Error ? error.message : String(error || 'Runtime connection failed'),
        },
      });
    }
  };

  readonly refresh = (): Promise<void> => this.observer?.refresh() ?? this.start();

  readonly stop = (): void => {
    this.started = false;
    this.generation += 1;
    this.releaseRuntimeConnection();
    this.publish(initialOpsEntityWorkspaceSnapshot(this.config));
  };

  private installObserver(adapter: RuntimeAdapter): void {
    const client = new RuntimeQueryClient<RuntimeAdapterReadQuery>({
      resolveAdapter: () => adapter,
      readRuntimeId: () => adapter.runtimeId,
      readCurrentHeight: () => adapter.currentHeight,
      createEmptyQuery: () => ({}),
    });
    this.publish({
      context: emptyEntityWorkspaceContext(adapter.runtimeId),
      readState: { status: 'loading', message: 'Reading the committed Entity context…' },
    });
    const observer = new RuntimeQueryObserver(
      async () => projectEntityWorkspaceContext({
        runtimeId: adapter.runtimeId,
        frame: await client.readViewFrame({ accountsLimit: 1, booksLimit: 1 }),
      }),
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
    const observer = this.observer;
    const adapter = this.session?.adapter;
    if (!observer || !adapter) return;
    const next = projectOpsEntityWorkspaceObserverSnapshot(
      adapter.runtimeId,
      this.snapshot.context,
      observer.getSnapshot(),
    );
    if (next.readState.status === 'error' && adapter.status === 'error') {
      this.started = false;
      this.generation += 1;
      this.releaseRuntimeConnection();
    }
    this.publish(next);
  };

  private releaseRuntimeConnection(): void {
    this.observerTeardown?.();
    this.observerTeardown = null;
    this.observer?.destroy();
    this.observer = null;
    this.session?.release();
    this.session = null;
  }

  private isCurrent(generation: number): boolean {
    return this.started && generation === this.generation;
  }

  private publish(snapshot: OpsEntityWorkspaceSourceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
