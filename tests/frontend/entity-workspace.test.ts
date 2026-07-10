import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildEntityWorkspaceView,
  resolveEntityWorkspaceCapabilities,
  runtimeProjectionMatchesRuntime,
} from '../../frontend/src/lib/components/Entity/entity-workspace';

test('runtime projection cannot cross a runtime switch boundary', () => {
  expect(runtimeProjectionMatchesRuntime('runtime-a', 'runtime-a')).toBe(true);
  expect(runtimeProjectionMatchesRuntime('RUNTIME-A', 'runtime-a')).toBe(true);
  expect(runtimeProjectionMatchesRuntime('runtime-a', 'runtime-b')).toBe(false);
  expect(runtimeProjectionMatchesRuntime('', 'runtime-a')).toBe(false);
  expect(runtimeProjectionMatchesRuntime('runtime-a', '')).toBe(false);
});

test('entity workspace exposes one wallet app surface without fake frontend roles', () => {
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
  expect(Object.keys(capabilities).sort()).toEqual(['canRead', 'entityId']);
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

  expect(admin.canRead).toBe(true);
  expect(embedded.canRead).toBe(true);
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
  expect(source).toContain('${selectedRuntimeId}|${handle.status}|${entityId}');
  expect(source).toContain('runtimeProjectionMatchesRuntime($runtimeView.runtimeId, selectedRuntimeId)');
  expect(source).not.toContain('entity-workspace-readonly');
  expect(source).not.toContain('readOnlyReason');
  expect(source).not.toContain("if (handle.mode !== 'remote')");
  expect(source).not.toContain('${handle.height}|${$runtimeView.height}|${envRevision}|${entityId}');
  expect(source).toContain('accountsLimit: WORKSPACE_VIEW_PAGE_SIZE');
  expect(source).toContain('runtimeProjectionFrame={workspaceProjectionFrame}');
  expect(source).not.toContain('appRuntimeAdapterActiveEntityId');
  expect(source).not.toContain('runtimeQueryClient.readViewFrame');
  expect(source).toContain('buildEntityWorkspaceView(');
  expect(source).toContain('workspaceProjectionFrame ? { ...workspaceProjectionFrame, runtimeId: $runtimeControllerHandle.id } : null');
  expect(source).toContain('entity-workspace-projection-error');
  expect(source).not.toContain('lensNavigationVersion');
  expect(source).not.toContain('workspaceLensNavigationVersion');
  expect(source).not.toContain('<EntityAuditPanel');
  expect(source).not.toContain("selectedLens === 'audit'");
  expect(source).not.toContain('entity-lens-ops');
  expect(source).not.toContain('entity-lens-liquidity');
  expect(source).not.toContain('class="lens-button"');
  expect(source).not.toContain('<ContextSwitcher');
  expect(source).toContain('on:entitySelect');
  expect(source).not.toContain('buildEntityWorkspaceView(env');
  expect(source).not.toContain('source?.eReplicas');
  expect(source).not.toContain('function findEntityReplica');
  expect(source).not.toContain('workspaceReplica');
});

test('entity workspace has no separate audit ops or liquidity projection lenses in app flow', () => {
  const workspace = readFileSync('frontend/src/lib/components/Entity/EntityWorkspace.svelte', 'utf8');
  const model = readFileSync('frontend/src/lib/components/Entity/entity-workspace.ts', 'utf8');

  expect(model).not.toContain("'audit'");
  expect(model).not.toContain("'ops'");
  expect(model).not.toContain("'liquidity'");
  expect(workspace).not.toContain('EntityAuditPanel');
  expect(workspace).not.toContain('entity-lens-audit');
  expect(workspace).not.toContain('entity-lens-ops');
  expect(workspace).not.toContain('entity-lens-liquidity');
  expect(workspace).not.toContain('data-lens');
  expect(workspace).toContain('<EntityPanelTabs');
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
  expect(settings).toContain('data-testid="settings-time-machine-toggle"');
  expect(settings).toContain('settingsOperations.setTheme');
  expect(settings).toContain('settingsOperations.setShowTimeMachine');
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

test('entity panel routing is owned by the existing wallet app tabs', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  expect(source).not.toContain('workspaceLens');
  expect(source).not.toContain('workspaceLensNavigationVersion');
  expect(source).not.toContain('entityWorkspaceTabForLens');
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
  expect(userMode).toContain('runtimeProjectionMatchesRuntime($runtimeView.runtimeId, $activeRuntimeId)');
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
  expect(userMode).toContain('const workspaceEmbeddedRuntimeContext = $derived.by<EntityWorkspaceEmbeddedRuntimeContext>(() =>');
  expect(userMode).toContain('runtimeFrameContext={workspaceRuntimeFrameContext}');
  expect(userMode).toContain('embeddedRuntimeContext={workspaceEmbeddedRuntimeContext}');
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
  expect(workspace).toContain('export let embeddedRuntimeContext: EntityWorkspaceEmbeddedRuntimeContext');
  expect(workspace).toContain('{#if runtimeFrameEnv || workspaceProjectionFrame}');
  expect(workspace).toContain('runtimeFrameContext={frameContext}');
  expect(workspace).toContain('embeddedRuntimeContext={embeddedFrameContext}');
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
  expect(dockWrapper).toContain('const embeddedRuntimeContext = $derived.by<EntityWorkspaceEmbeddedRuntimeContext>(() =>');
  expect(dockWrapper).toContain('{runtimeFrameContext}');
  expect(dockWrapper).toContain('{embeddedRuntimeContext}');
  expect(dockWrapper).not.toContain('liveEnvResolver={resolveLiveEnv}');
  expect(dockWrapper).not.toContain('env={activeEnv}');
  expect(dockWrapper).not.toContain('liveEnv={activeEnv}');
  expect(dockWrapper).not.toContain('{#if activeEnv}');
  expect(dockWrapper).not.toContain('liveEnvResolver={() => runtimeFrameEnv ? ($runtimeFrameEnv ?? null) : null}');
});

test('runtime frame context separates projection metadata from embedded Env action context', () => {
  const runtimeContext = readFileSync('frontend/src/lib/components/Entity/runtime-frame-context.ts', 'utf8');
  const embeddedContext = readFileSync('frontend/src/lib/components/Entity/embedded-runtime-context.ts', 'utf8');
  const workspace = readFileSync('frontend/src/lib/components/Entity/EntityWorkspace.svelte', 'utf8');
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

  expect(runtimeContext).not.toContain('Env');
  expect(runtimeContext).not.toContain('EnvSnapshot');
  expect(runtimeContext).toContain('envRevision');
  expect(runtimeContext).toContain('timeIndex');
  expect(runtimeContext).toContain('isLive');
  expect(embeddedContext).toContain('Env, EnvSnapshot');
  expect(embeddedContext).toContain('liveEnvResolver');
  expect(workspace).toContain("from './embedded-runtime-context'");
  expect(tabs).toContain("from './embedded-runtime-context'");
  expect(tabs).toContain('$: env = embeddedRuntimeContext.env;');
  expect(tabs).not.toContain('$: env = runtimeFrameContext.env;');
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
