import { describe, expect, test } from 'bun:test';

import {
  initialOpsEntityWorkspaceSnapshot,
  OpsEntityWorkspaceSource,
  projectOpsEntityWorkspaceObserverSnapshot,
  requireOpsEntityRemoteSession,
} from '../../../frontend/apps/ops/src/ops-entity-workspace-source';
import {
  emptyEntityWorkspaceAccounts,
  projectEntityWorkspaceAccounts,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-accounts';
import {
  emptyEntityWorkspaceContext,
  projectEntityWorkspaceContext,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-context';
import {
  emptyEntityWorkspaceOwnership,
  projectEntityWorkspaceOwnership,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-ownership';
import {
  emptyEntityWorkspaceProfile,
  projectEntityWorkspaceProfile,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-profile';

const REMOTE_SESSION = {
  mode: 'remote',
  wsUrl: ' wss://runtime.example/rpc ',
  access: 'admin',
  sessionKey: ' tab-confined-capability ',
};

const SELECTED_CONTEXT = projectEntityWorkspaceContext({
  runtimeId: 'runtime-a',
  frame: {
    height: 18,
    activeEntityId: '0xaaaa',
    activeEntity: {
      summary: { entityId: '0xaaaa', label: 'Treasury' },
      core: { entityId: '0xaaaa', signerId: '0xbbbb' },
      accounts: { items: [], totalItems: 0 },
    },
  },
});

const OWNERSHIP_FRAME = {
  height: 18,
  activeEntityId: '0xaaaa',
  activeEntity: {
    summary: { entityId: '0xaaaa', label: 'Treasury' },
    core: {
      entityId: '0xaaaa',
      signerId: '0xbbbb',
      config: {
        mode: 'proposer-based', threshold: 1n,
        validators: ['0xbbbb'], shares: { '0xbbbb': 1n },
      },
      profile: {
        name: 'Treasury', isHub: true, entityKind: 'company', sectors: ['finance'],
        avatar: '', bio: 'Settlement infrastructure', website: 'https://xln.example',
      },
    },
    accounts: { items: [], totalItems: 0, pageIndex: 0, pageCount: 0, limit: 8 },
  },
};

const SELECTED_OWNERSHIP = projectEntityWorkspaceOwnership({
  context: SELECTED_CONTEXT,
  frame: OWNERSHIP_FRAME,
});

const SELECTED_ACCOUNTS = projectEntityWorkspaceAccounts({
  context: SELECTED_CONTEXT,
  frame: OWNERSHIP_FRAME,
});

const SELECTED_PROFILE = projectEntityWorkspaceProfile({
  context: SELECTED_CONTEXT,
  frame: OWNERSHIP_FRAME,
});

const SELECTED_PROJECTION = {
  accounts: SELECTED_ACCOUNTS,
  context: SELECTED_CONTEXT,
  ownership: SELECTED_OWNERSHIP,
  profile: SELECTED_PROFILE,
};

describe('React Entity workspace Runtime read boundary', () => {
  test('requires a complete tab-confined remote admin session', () => {
    expect(requireOpsEntityRemoteSession(REMOTE_SESSION)).toEqual({
      wsUrl: 'wss://runtime.example/rpc',
      authKey: 'tab-confined-capability',
    });
    expect(() => requireOpsEntityRemoteSession({ ...REMOTE_SESSION, mode: 'embedded' }))
      .toThrow('OPS_ENTITY_REMOTE_SESSION_REQUIRED');
    expect(() => requireOpsEntityRemoteSession({ ...REMOTE_SESSION, access: 'inspect' }))
      .toThrow('OPS_ENTITY_REMOTE_ADMIN_ACCESS_REQUIRED');
    expect(() => requireOpsEntityRemoteSession({ ...REMOTE_SESSION, wsUrl: ' ' }))
      .toThrow('OPS_ENTITY_REMOTE_ENDPOINT_REQUIRED');
    expect(() => requireOpsEntityRemoteSession({ ...REMOTE_SESSION, sessionKey: null }))
      .toThrow('OPS_ENTITY_REMOTE_AUTH_REQUIRED');
  });

  test('keeps embedded or missing sessions explicitly unavailable without starting a Runtime', async () => {
    const config = { mode: 'embedded', wsUrl: null, access: null, sessionKey: null };
    const source = new OpsEntityWorkspaceSource(config);
    expect(initialOpsEntityWorkspaceSnapshot(config)).toMatchObject({
      context: { status: 'empty', runtimeId: null },
      readState: { status: 'unavailable' },
    });
    await source.start();
    expect(source.getSnapshot().readState.status).toBe('unavailable');
  });

  test('projects loading, ready, and fail-loud observer states without stale identity', () => {
    expect(projectOpsEntityWorkspaceObserverSnapshot('runtime-a', SELECTED_PROJECTION, {
      loading: true, data: null, error: null, height: 18,
    })).toEqual({
      ...SELECTED_PROJECTION,
      readState: { status: 'loading', message: 'Reading the committed Entity context…' },
    });
    expect(projectOpsEntityWorkspaceObserverSnapshot('runtime-a', {
      accounts: emptyEntityWorkspaceAccounts(),
      context: emptyEntityWorkspaceContext(), ownership: emptyEntityWorkspaceOwnership(),
      profile: emptyEntityWorkspaceProfile(),
    }, {
      loading: false, data: SELECTED_PROJECTION, error: null, height: 18,
    })).toEqual({ ...SELECTED_PROJECTION, readState: { status: 'ready', message: '' } });
    expect(projectOpsEntityWorkspaceObserverSnapshot('runtime-a', SELECTED_PROJECTION, {
      loading: false, data: null, error: 'ENTITY_WORKSPACE_FRAME_INVALID', height: 18,
    })).toMatchObject({
      context: { status: 'empty', runtimeId: 'runtime-a', entityId: null },
      accounts: { status: 'empty' },
      ownership: { status: 'empty' },
      profile: { status: 'empty' },
      readState: { status: 'error', message: 'ENTITY_WORKSPACE_FRAME_INVALID' },
    });
  });

  test('loads only on the workspace route and exposes bounded reads plus full cleanup', async () => {
    const [main, page, runtime, source] = await Promise.all([
      Bun.file('frontend/apps/ops/src/main.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-entity-workspace.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-entity-workspace-runtime.ts').text(),
      Bun.file('frontend/apps/ops/src/ops-entity-workspace-source.ts').text(),
    ]);
    expect(main).toContain("page.kind === 'workspace'");
    expect(main).toContain("import('./ops-entity-workspace-runtime')");
    expect(page).toContain('opsEntityWorkspaceSource.subscribe');
    expect(runtime).toContain("window.addEventListener('pagehide'");
    expect(runtime).toContain('if (!event.persisted) opsEntityWorkspaceSource.stop()');
    expect(source).toContain("await import('../../../../core/api/runtime-adapter/remote.ts')");
    expect(source).toContain('accountsLimit: 8');
    expect(source).toContain('accountsPage: this.accountsPage');
    expect(source).toContain('projectEntityWorkspaceAccounts({ context, frame })');
    expect(source).toContain('projectEntityWorkspaceOwnership({ context, frame })');
    expect(source).toContain('projectEntityWorkspaceProfile({ context, frame })');
    expect(source).toContain('this.observer?.destroy()');
    expect(source).toContain('this.session?.release()');
    expect(source).not.toContain('.send(');
  });

  test('validates Account page navigation before issuing another bounded read', async () => {
    const source = new OpsEntityWorkspaceSource({
      mode: 'embedded', wsUrl: null, access: null, sessionKey: null,
    });
    expect(() => source.selectAccountsPage(0)).toThrow('OPS_ENTITY_ACCOUNT_PAGE_INVALID:0');
    const implementation = await Bun.file('frontend/apps/ops/src/ops-entity-workspace-source.ts').text();
    expect(implementation).toContain('page >= accounts.pageCount');
    expect(implementation).toContain('void this.observer?.refresh()');
  });
});
