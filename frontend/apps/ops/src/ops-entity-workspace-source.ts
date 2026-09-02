import type {
  RuntimeAdapter,
  RuntimeAdapterReadQuery,
} from '../../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import {
  emptyEntityWorkspaceAccounts,
  projectEntityWorkspaceAccounts,
  type EntityWorkspaceAccounts,
} from '../../../packages/runtime-client/src/entity-workspace-accounts';
import {
  emptyEntityWorkspaceContext,
  projectEntityWorkspaceContext,
  type EntityWorkspaceContext,
  type EntityWorkspaceReadState,
} from '../../../packages/runtime-client/src/entity-workspace-context';
import {
  emptyEntityWorkspaceOwnership,
  projectEntityWorkspaceOwnership,
  type EntityWorkspaceOwnership,
} from '../../../packages/runtime-client/src/entity-workspace-ownership';
import {
  emptyEntityWorkspaceProfile,
  projectEntityWorkspaceProfile,
  type EntityWorkspaceProfile,
} from '../../../packages/runtime-client/src/entity-workspace-profile';
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
  accounts: EntityWorkspaceAccounts;
  context: EntityWorkspaceContext;
  ownership: EntityWorkspaceOwnership;
  profile: EntityWorkspaceProfile;
  readState: EntityWorkspaceReadState;
}>;

type OpsEntityWorkspaceProjection = Readonly<{
  accounts: EntityWorkspaceAccounts;
  context: EntityWorkspaceContext;
  ownership: EntityWorkspaceOwnership;
  profile: EntityWorkspaceProfile;
}>;

export type OpsEntityWorkspaceSourceDependencies = Readonly<{
  openSession: (config: RuntimeAdapterStorageSnapshot) => Promise<RuntimeReadSession>;
}>;

type RemoteSessionConfig = Readonly<{
  wsUrl: string;
  authKey: string;
}>;

const emptyProjection = (runtimeId: unknown = null): OpsEntityWorkspaceProjection => ({
  accounts: emptyEntityWorkspaceAccounts(),
  context: emptyEntityWorkspaceContext(runtimeId),
  ownership: emptyEntityWorkspaceOwnership(),
  profile: emptyEntityWorkspaceProfile(),
});

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
  ...emptyProjection(),
  readState: {
    status: 'unavailable',
    message: 'Select a remote Runtime in the wallet before opening this candidate workspace.',
  },
});

export const initialOpsEntityWorkspaceSnapshot = (
  config: RuntimeAdapterStorageSnapshot,
): OpsEntityWorkspaceSourceSnapshot => config.mode === 'remote'
  ? {
      ...emptyProjection(),
      readState: { status: 'connecting', message: 'Connecting to the selected Runtime…' },
    }
  : unavailableSnapshot();

export const projectOpsEntityWorkspaceObserverSnapshot = (
  runtimeId: string,
  currentProjection: OpsEntityWorkspaceProjection,
  snapshot: RuntimeQuerySnapshot<OpsEntityWorkspaceProjection>,
): OpsEntityWorkspaceSourceSnapshot => {
  if (snapshot.loading) {
    return {
      ...(snapshot.data ?? currentProjection),
      readState: { status: 'loading', message: 'Reading the committed Entity context…' },
    };
  }
  if (snapshot.error) {
    return {
      ...emptyProjection(runtimeId),
      readState: { status: 'error', message: snapshot.error },
    };
  }
  if (!snapshot.data) {
    return {
      ...emptyProjection(runtimeId),
      readState: { status: 'error', message: 'Runtime returned no Entity workspace context.' },
    };
  }
  return { ...snapshot.data, readState: { status: 'ready', message: '' } };
};

export class OpsEntityWorkspaceSource {
  private readonly listeners = new Set<() => void>();
  private snapshot: OpsEntityWorkspaceSourceSnapshot;
  private session: RuntimeReadSession | null = null;
  private observer: RuntimeQueryObserver<OpsEntityWorkspaceProjection> | null = null;
  private observerTeardown: (() => void) | null = null;
  private generation = 0;
  private accountsPage = 0;
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
      ...emptyProjection(),
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
        ...emptyProjection(),
        readState: {
          status: 'error',
          message: error instanceof Error ? error.message : String(error || 'Runtime connection failed'),
        },
      });
    }
  };

  readonly refresh = (): Promise<void> => this.observer?.refresh() ?? this.start();

  readonly selectAccountsPage = (page: number): void => {
    const accounts = this.snapshot.accounts;
    if (accounts.status !== 'selected' || !Number.isSafeInteger(page) || page < 0 || page >= accounts.pageCount) {
      throw new Error(`OPS_ENTITY_ACCOUNT_PAGE_INVALID:${String(page)}`);
    }
    if (page === this.accountsPage) return;
    this.accountsPage = page;
    void this.observer?.refresh();
  };

  readonly stop = (): void => {
    this.started = false;
    this.accountsPage = 0;
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
      ...emptyProjection(adapter.runtimeId),
      readState: { status: 'loading', message: 'Reading the committed Entity context…' },
    });
    const observer = new RuntimeQueryObserver(
      async () => {
        const frame = await client.readViewFrame({
          accountsLimit: 8,
          accountsPage: this.accountsPage,
          booksLimit: 1,
        });
        const context = projectEntityWorkspaceContext({ runtimeId: adapter.runtimeId, frame });
        return {
          accounts: projectEntityWorkspaceAccounts({ context, frame }),
          context,
          ownership: projectEntityWorkspaceOwnership({ context, frame }),
          profile: projectEntityWorkspaceProfile({ context, frame }),
        };
      },
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
      {
        accounts: this.snapshot.accounts,
        context: this.snapshot.context,
        ownership: this.snapshot.ownership,
        profile: this.snapshot.profile,
      },
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
