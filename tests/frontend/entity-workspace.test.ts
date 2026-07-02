import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildEntityWorkspaceView,
  defaultLensForCapabilities,
  entityWorkspaceTabForLens,
  resolveEntityWorkspaceCapabilities,
} from '../../frontend/src/lib/components/Entity/entity-workspace';

test('entity workspace exposes capability lenses without fake frontend roles', () => {
  const capabilities = resolveEntityWorkspaceCapabilities({
    mode: 'remote',
    authLevel: 'inspect',
  }, {
    entityId: '0xabc',
    isHub: true,
    accountCount: 2,
    bookCount: 1,
  });

  expect(capabilities.canRead).toBe(true);
  expect(capabilities.canWrite).toBe(false);
  expect(capabilities.readOnlyReason).toContain('inspect');
  expect(capabilities.lenses.map((lens) => lens.id)).toEqual(['wallet', 'ops', 'liquidity', 'audit']);
  expect(capabilities.lenses.find((lens) => lens.id === 'wallet')?.enabled).toBe(false);
  expect(capabilities.lenses.find((lens) => lens.id === 'ops')?.enabled).toBe(false);
  expect(capabilities.lenses.find((lens) => lens.id === 'liquidity')?.enabled).toBe(false);
  expect(capabilities.lenses.find((lens) => lens.id === 'audit')?.enabled).toBe(true);
  expect(defaultLensForCapabilities(capabilities)).toBe('audit');
});

test('entity workspace treats admin remote and embedded runtimes as writable command surfaces', () => {
  const admin = resolveEntityWorkspaceCapabilities({ mode: 'remote', authLevel: 'admin' }, {
    entityId: '0xabc',
    accountCount: 1,
  });
  const embedded = resolveEntityWorkspaceCapabilities({ mode: 'embedded', authLevel: null }, {
    entityId: '0xabc',
    accountCount: 1,
  });

  expect(admin.canWrite).toBe(true);
  expect(embedded.canWrite).toBe(true);
  expect(admin.lenses.find((lens) => lens.id === 'wallet')?.enabled).toBe(true);
  expect(admin.lenses.find((lens) => lens.id === 'ops')?.enabled).toBe(true);
  expect(embedded.lenses.find((lens) => lens.id === 'wallet')?.enabled).toBe(true);
  expect(embedded.lenses.find((lens) => lens.id === 'ops')?.enabled).toBe(true);
  expect(admin.lenses.find((lens) => lens.id === 'audit')?.canWrite).toBe(false);
});

test('entity workspace maps lenses onto existing panel surfaces', () => {
  expect(entityWorkspaceTabForLens('wallet')).toEqual({ activeTab: 'assets' });
  expect(entityWorkspaceTabForLens('ops')).toEqual({ activeTab: 'accounts', accountWorkspaceTab: 'activity' });
  expect(entityWorkspaceTabForLens('liquidity')).toEqual({ activeTab: 'accounts', accountWorkspaceTab: 'swap' });
  expect(entityWorkspaceTabForLens('audit')).toEqual({ activeTab: 'accounts', accountWorkspaceTab: 'activity' });
});

test('entity workspace shell consumes a projected workspace view instead of traversing replicas inline', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntityWorkspace.svelte', 'utf8');
  expect(source).toContain('resolvedWorkspaceView');
  expect(source).toContain("from '$lib/stores/runtimeViewStore'");
  expect(source).toContain('refreshRuntimeView({');
  expect(source).toContain('workspaceProjectionFrame = view.frame');
  expect(source).toContain("const entityId = handle.mode === 'remote'");
  expect(source).toContain('? (tabEntityId || runtimeActiveEntityId)');
  expect(source).not.toContain('tabEntityId && tabEntityId === runtimeActiveEntityId ? tabEntityId : runtimeActiveEntityId');
  expect(source).toContain(': tabEntityId;');
  expect(source).toContain('${handle.id}|${handle.status}|${handle.authLevel ?? \'\'}|${entityId}');
  expect(source).not.toContain("if (handle.mode !== 'remote')");
  expect(source).not.toContain('${handle.height}|${$runtimeView.height}|${envRevision}|${entityId}');
  expect(source).toContain('accountsLimit: WORKSPACE_VIEW_PAGE_SIZE');
  expect(source).toContain('runtimeProjectionFrame={workspaceProjectionFrame}');
  expect(source).not.toContain('appRuntimeAdapterActiveEntityId');
  expect(source).not.toContain('runtimeQueryClient.readViewFrame');
  expect(source).toContain('buildEntityWorkspaceView(');
  expect(source).toContain('workspaceProjectionFrame ? { ...workspaceProjectionFrame, runtimeId: $runtimeControllerHandle.id } : null');
  expect(source).toContain('entity-workspace-projection-error');
  expect(source).toContain('lensNavigationVersion += 1');
  expect(source).toContain('workspaceLensNavigationVersion={lensNavigationVersion}');
  expect(source).toContain('<EntityAuditPanel');
  expect(source).toContain("{#if selectedLens === 'audit'}");
  expect(source).toContain("userModeHeader && selectedLens === 'audit'");
  expect(source).toContain('<ContextSwitcher');
  expect(source).toContain('on:entitySelect');
  expect(source).not.toContain('buildEntityWorkspaceView(env');
  expect(source).not.toContain('source?.eReplicas');
  expect(source).not.toContain('function findEntityReplica');
  expect(source).not.toContain('workspaceReplica');
});

test('audit lens is a typed projection surface and does not route to settings Env ownership', () => {
  const workspace = readFileSync('frontend/src/lib/components/Entity/EntityWorkspace.svelte', 'utf8');
  const model = readFileSync('frontend/src/lib/components/Entity/entity-workspace.ts', 'utf8');
  const audit = readFileSync('frontend/src/lib/components/Entity/EntityAuditPanel.svelte', 'utf8');

  expect(model).not.toContain("case 'audit':\n      return { activeTab: 'settings'");
  expect(workspace).toContain('<EntityAuditPanel');
  expect(workspace).not.toContain("workspaceLens={selectedLens || 'audit'}");
  expect(audit).toContain("from '$lib/stores/runtimeViewStore'");
  expect(audit).toContain('refreshRuntimeView({');
  expect(audit).toContain('$runtimeView.head');
  expect(audit).toContain('$runtimeView.frame');
  expect(audit).toContain('runtimeQueryClient.readActivity');
  expect(audit).toContain('data-testid="entity-audit-accounts-shown"');
  expect(audit).toContain('data-testid="entity-audit-accounts-total"');
  expect(audit).toContain('data-testid="entity-audit-books-shown"');
  expect(audit).toContain('data-testid="entity-audit-books-total"');
  expect(audit).toContain('data-testid="entity-audit-activity-scanned"');
  expect(audit).toContain('data-testid="entity-audit-activity-latest"');
  expect(audit).not.toContain('runtimeQueryClient.readHead');
  expect(audit).not.toContain('runtimeQueryClient.readViewFrame');
  expect(audit).not.toContain('xlnEnvironment');
  expect(audit).not.toContain('$xlnEnvironment');
  expect(audit).not.toContain('runtimeFrameEnv');
  expect(audit).not.toContain('EntitySettingsPanel');
});

test('entity settings workspace is a projection command surface, not the legacy Env panel', () => {
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  const settings = readFileSync('frontend/src/lib/components/Entity/EntitySettingsProjectionPanel.svelte', 'utf8');

  expect(tabs).toContain("import EntitySettingsProjectionPanel from './EntitySettingsProjectionPanel.svelte'");
  expect(tabs).toContain('<EntitySettingsProjectionPanel');
  expect(tabs).toContain('saveSettingsProjectionProfile');
  expect(tabs).toContain("type: 'profile-update' as const");
  expect(tabs).toContain('importJMachineViaRuntime');
  expect(tabs).toContain('importSettingsJMachine');
  expect(tabs).not.toContain("Settings/EntitySettingsPanel");
  expect(tabs).not.toContain('<EntitySettingsPanel');
  expect(settings).toContain('runtimeControllerHandle');
  expect(settings).toContain('onSaveProfile');
  expect(settings).toContain('onImportJMachine');
  expect(settings).toContain('settings-network-add-jmachine-toggle');
  expect(settings).toContain('<AddJMachine');
  expect(settings).toContain('<PushWakePanel');
  expect(settings).toContain('runtimeEnv: Env | null');
  expect(settings).toContain('settingsSubview: SettingsSubview');
  expect(settings).toContain('data-testid="settings-theme-select"');
  expect(settings).toContain('settingsOperations.setTheme');
  expect(settings).toContain('data-testid="entity-settings-projection-panel"');
  expect(settings).not.toContain('xlnEnvironment');
  expect(settings).not.toContain('$xlnEnvironment');
  expect(settings).not.toContain('runtimeFrameEnv');
  expect(settings).not.toContain('getXLN');
  expect(settings).not.toContain('enqueueAndProcess');
  expect(settings).not.toContain('jmachineOperations');
  expect(settings).not.toContain('IndexedDbInspector');
  expect(settings).not.toContain('FormationPanel');
  expect(settings).not.toContain('GossipPanel');
});

test('default workspace lens does not override explicit entity panel hash routes', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  expect(source).toContain('export let workspaceLensNavigationVersion');
  expect(source).toContain('function hasExplicitEntityPanelHashRoute()');
  expect(source).toContain('canonicalizeEntityPanelRoute(getLocationHashRoute(window.location)) !== null');
  expect(source).toContain("shouldApplyDefaultLensRoute = !hasExplicitEntityPanelHashRoute() && workspaceLens !== 'wallet'");
  expect(source).toContain('userTriggeredLensNavigation || shouldApplyDefaultLensRoute');
  expect(source).toContain('routeSyncSignature = [');
  expect(source).toContain('routeSyncSignature;');
});

test('entity workspace view builder projects replica state into capability counts', () => {
  const entityId = '0xabc';
  const view = buildEntityWorkspaceView({
    runtimeId: 'radapter:ws://127.0.0.1:1234',
    height: 42,
    entities: [{ entityId, label: 'Hub', height: 42, isHub: true }],
    activeEntityId: entityId,
    activeEntity: {
      summary: { entityId, label: 'Hub', height: 42, isHub: true },
      core: {
        profile: { isHub: true },
        proposals: new Map([['proposal-1', {}]]),
        reserves: new Map([[1, {}]]),
        orderbookHubProfile: { entityId },
      },
      accounts: { items: [{}], totalItems: 1, nextCursor: null },
      books: { items: [{ pairId: 'USDC/WETH', book: {} }], totalItems: 1, nextCursor: null },
    },
  } as any, entityId);

  expect(view).toMatchObject({
    entityId,
    runtimeId: 'radapter:ws://127.0.0.1:1234',
    height: 42,
    isHub: true,
    accountCount: 1,
    bookCount: 1,
    proposalCount: 1,
    reserveCount: 1,
  });
});

test('entity workspace model does not import full runtime Env', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/entity-workspace.ts', 'utf8');
  expect(source).toContain('RuntimeAdapterViewFrame');
  expect(source).not.toContain('Env, EnvSnapshot');
  expect(source).not.toContain('eReplicas');
  expect(source).not.toContain('jReplicas');
});

test('entity workspace is the only mounted entity shell', () => {
  const userMode = readFileSync('frontend/src/lib/view/UserModePanel.svelte', 'utf8');
  const dockWrapper = readFileSync('frontend/src/lib/view/panels/wrappers/EntityPanelWrapper.svelte', 'utf8');
  const runtimeCreation = readFileSync('frontend/src/lib/components/Views/RuntimeCreation.svelte', 'utf8');

  expect(userMode).toContain('EntityWorkspace');
  expect(dockWrapper).toContain('EntityWorkspace');
  expect(userMode).not.toContain('<EntityPanelTabs');
  expect(dockWrapper).not.toContain('<EntityPanelTabs');
  expect(runtimeCreation).not.toContain('Entity = Wallet');
});

test('user mode remote workspace mounts from RuntimeView instead of Env replica selection', () => {
  const userMode = readFileSync('frontend/src/lib/view/UserModePanel.svelte', 'utf8');
  const dockWrapper = readFileSync('frontend/src/lib/view/panels/wrappers/EntityPanelWrapper.svelte', 'utf8');
  const workspace = readFileSync('frontend/src/lib/components/Entity/EntityWorkspace.svelte', 'utf8');

  expect(userMode).toContain("import { runtimeView, setRuntimeViewActiveEntityId } from '$lib/stores/runtimeViewStore'");
  expect(userMode).toContain('setRuntimeViewActiveEntityId');
  expect(userMode).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore'");
  expect(userMode).toContain('$runtimeView.frame');
  expect(userMode).toContain('$runtimeView.activeEntityId');
  expect(userMode).toContain('get(runtimeControllerHandle).mode');
  expect(userMode).toContain('$runtimeControllerHandle.mode');
  expect(userMode).toContain('liveEnvResolver?: () => Env | null;');
  expect(userMode).toContain('const currentLiveRuntimeEnv = $derived.by(() =>');
  expect(userMode).toContain('if (isRemoteRuntime) return null;');
  expect(userMode).toContain('const live = liveEnvResolver?.() ?? null;');
  expect(userMode).toContain('const frame = !isRemoteRuntime && liveRuntimeEnv ? createRuntimeViewEnv(liveRuntimeEnv) : env;');
  expect(userMode).toContain('const workspaceEnv = $derived.by<RuntimeFrame | null>(() =>');
  expect(userMode).toContain('isRemoteRuntime ? null : currentFrame');
  expect(userMode).toContain('const workspaceLiveEnv = $derived.by<Env | null>(() =>');
  expect(userMode).toContain('isRemoteRuntime ? null : (currentLiveRuntimeEnv ?? $runtimeFrameEnv)');
  expect(userMode).toContain('function resolveWorkspaceLiveEnv(): Env | null');
  expect(userMode).toContain('const workspaceRuntimeFrameContext = $derived.by<EntityWorkspaceRuntimeFrameContext>(() =>');
  expect(userMode).toContain('runtimeFrameContext={workspaceRuntimeFrameContext}');
  expect(userMode).not.toContain('env={workspaceEnv}');
  expect(userMode).not.toContain('liveEnv={workspaceLiveEnv}');
  expect(userMode).not.toContain('liveEnvResolver={resolveWorkspaceLiveEnv}');
  expect(userMode).not.toContain('liveEnv={currentLiveRuntimeEnv ?? $runtimeFrameEnv}');
  expect(userMode).not.toContain('liveEnvResolver={() => currentLiveRuntimeEnv ?? $runtimeFrameEnv}');
  expect(userMode).toContain('remoteWorkspaceAvailable');
  expect(userMode).toContain("viewMode === 'entity' && (currentFrame || remoteWorkspaceAvailable)");
  expect(userMode).not.toContain('appRuntimeAdapterMode');
  expect(userMode).not.toContain('appRuntimeAdapterActiveEntityId');

  const remoteEffectStart = userMode.indexOf('if (!isRemoteRuntime) return;');
  const remoteEffectEnd = userMode.indexOf('$effect(() => {\n    if (isRemoteRuntime || !currentFrame?.eReplicas)', remoteEffectStart);
  expect(remoteEffectStart).toBeGreaterThan(0);
  expect(remoteEffectEnd).toBeGreaterThan(remoteEffectStart);
  const remoteEffect = userMode.slice(remoteEffectStart, remoteEffectEnd);
  expect(remoteEffect).not.toContain('currentFrame?.eReplicas');
  expect(remoteEffect).not.toContain('findReplicaByEntityInFrame');
  expect(remoteEffect).not.toContain('firstReplicaWithRelationshipsInFrame');

  expect(workspace).toContain('export let runtimeFrameContext: EntityWorkspaceRuntimeFrameContext');
  expect(workspace).toContain('{:else if runtimeFrameEnv || workspaceProjectionFrame}');
  expect(workspace).toContain('runtimeFrameContext={frameContext}');
  expect(workspace).not.toContain('env={runtimeFrameEnv}');
  expect(workspace).not.toContain('liveEnv={runtimeFrameLiveEnv}');
  expect(workspace).not.toContain('envRevision={runtimeFrameRevision}');
  expect(workspace).not.toContain('history={runtimeFrameHistory}');
  expect(workspace).not.toContain('timeIndex={runtimeFrameTimeIndex}');
  expect(workspace).not.toContain('isLive={runtimeFrameIsLive}');
  expect(workspace).not.toContain('onGoToLive={runtimeFrameGoToLive}');
  expect(workspace).not.toContain('export let env:');
  expect(workspace).not.toContain('export let liveEnv');
  expect(workspace).not.toContain('export let liveEnvResolver');
  expect(workspace).not.toContain('export let history');
  expect(workspace).not.toContain('export let timeIndex');
  expect(workspace).not.toContain('export let isLive');
  expect(workspace).not.toContain('export let onGoToLive');
  expect(workspace).toContain('entity-workspace-action-unavailable');

  expect(dockWrapper).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';");
  expect(dockWrapper).toContain("const isRemoteRuntime = $derived.by<boolean>(() => $runtimeControllerHandle.mode === 'remote');");
  expect(dockWrapper).toContain('if (isRemoteRuntime) return null;');
  expect(dockWrapper).toContain("activeEnv || (isRemoteRuntime && $runtimeControllerHandle.status === 'connected')");
  expect(dockWrapper).toContain('function resolveLiveEnv(): Env | null');
  expect(dockWrapper).toContain('return isRemoteRuntime ? null : activeEnv;');
  expect(dockWrapper).toContain('{#if canMountWorkspace}');
  expect(dockWrapper).toContain('const runtimeFrameContext = $derived.by<EntityWorkspaceRuntimeFrameContext>(() =>');
  expect(dockWrapper).toContain('{runtimeFrameContext}');
  expect(dockWrapper).not.toContain('liveEnvResolver={resolveLiveEnv}');
  expect(dockWrapper).not.toContain('env={activeEnv}');
  expect(dockWrapper).not.toContain('liveEnv={activeEnv}');
  expect(dockWrapper).not.toContain('{#if activeEnv}');
  expect(dockWrapper).not.toContain('liveEnvResolver={() => runtimeFrameEnv ? ($runtimeFrameEnv ?? null) : null}');
});

test('remote projection entity panel does not hide account surface behind Env availability', () => {
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  const accountWorkspace = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');
  const assets = readFileSync('frontend/src/lib/components/Entity/EntityAssetsTab.svelte', 'utf8');
  const debt = readFileSync('frontend/src/lib/components/Entity/DebtPanel.svelte', 'utf8');

  expect(tabs).toContain('{:else if replica}');
  expect(tabs).not.toContain('{:else if activeEnv && replica}');
  expect(tabs).not.toContain('{:else if activeEnv && isAccountFocused');
  expect(accountWorkspace).toContain('export let activeEnv: Env | EnvSnapshot | null = null');
  expect(accountWorkspace).toContain('{#if activeEnv || swapRuntimeView}');
  expect(accountWorkspace).toContain('Swap projection is not available yet.');
  expect(accountWorkspace).not.toContain('Swap requires a live runtime frame.');
  expect(accountWorkspace).not.toContain('Settlement history requires a runtime frame.');
  expect(assets).not.toContain('export let activeEnv');
  expect(assets).not.toContain('EnvSnapshot');
  expect(assets).toContain('export let entityNames: Map<string, string>');
  expect(assets).not.toContain('export let activeLiveEnv');
  expect(debt).toContain('export let entityStateOverride: EntityState | null = null');
  expect(debt).toContain('export let entityNames: Map<string, string>');
  expect(debt).not.toContain('export let sourceEnv');
  expect(debt).not.toContain('sourceEnvResolver');
  expect(debt).not.toContain('sourceEnvStore');
  expect(debt).not.toContain('eReplicas');
});
