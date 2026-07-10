import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('DockRoot resolves entity panel seeds through RuntimeView projections', () => {
  const source = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');

  expect(source).toContain("import { refreshRuntimeView } from '$lib/stores/runtimeViewStore'");
  expect(source).toContain('resolveEntityPanelDataFromProjection');
  expect(source).toContain('refreshRuntimeView({');
  expect(source).toContain('seedFromViewFrame');
  expect(source).toContain("showEntityPanelStatus(div, 'Loading entity projection...')");
  expect(source).toContain("import { errorLog } from '$lib/stores/errorLogStore'");
  expect(source).toContain("errorLog.log(message, 'DockRoot', details)");
  expect(source).toContain("logDockRootDiagnostic('Failed to resolve entity panel projection'");
  expect(source).not.toContain('console.warn');
  expect(source).not.toContain('console.error');
  expect(source).not.toContain('console.info');
  expect(source).not.toContain("from '$lib/stores/runtimeQueryClient'");
  expect(source).not.toContain('runtimeQueryClient.readViewFrame');
  expect(source).not.toContain('resolveEntityPanelData(panelId)');
  expect(source).not.toContain('env?.eReplicas');
  expect(source).not.toContain('env.eReplicas');
  expect(source).not.toContain('jReplicas');
  expect(source).not.toContain('parameters.api?.close?.()');
});

test('DockRoot treats Dock mode itself as the developer workspace without a devLab gate', () => {
  const source = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');

  expect(source).toContain("void import('./panels/ArchitectPanel.svelte')");
  expect(source).toContain("title: '🎬 Architect'");
  expect(source).toContain("position: { direction: 'below', referencePanel: 'wallet-main' }");
  expect(source).not.toContain('devLabEnabled');
  expect(source).not.toContain('xln-dev-lab');
  expect(source).not.toContain('LEGACY_DEV_PANEL_NAMES');
  expect(source).not.toContain("import ArchitectPanel from './panels/ArchitectPanel.svelte'");
});

test('DockRoot defaults to Graph left plus pinned wallet and tools on the right', () => {
  const source = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');

  expect(source).toContain("id: 'graph3d'");
  expect(source).toContain("id: 'wallet-main'");
  expect(source).toContain("component: 'wallet'");
  expect(source).toContain("tabComponent: 'pinned-tab'");
  expect(source).toContain("position: { direction: 'right', referencePanel: 'graph3d' }");
  expect(source).toContain("position: { direction: 'below', referencePanel: 'wallet-main' }");
  for (const panelId of [
    'runtime-io',
    'settings',
    'console',
    'gossip',
    'solvency',
    'entity-audit',
    'jmachine-inspector',
    'runtime-manager',
    'leveldb-inspector',
    'runtime-diagnostics',
  ]) {
    expect(source).toContain(`id: '${panelId}'`);
  }
  expect(source).toContain("import IndexedDbInspector from '$lib/components/Settings/IndexedDbInspector.svelte'");
  expect(source).toContain("import RemoteRuntimeManager from '$lib/components/Runtime/RemoteRuntimeManager.svelte'");
  expect(source).toContain("appStateOperations.setMode('user')");
  expect(source).toContain('showDockTimeMachine = !embedMode || $settings.showTimeMachine');
});

test('DockRoot blocks Env-only panels on remote runtimes instead of mounting blank fake Env views', () => {
  const source = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');

  expect(source).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore'");
  expect(source).toContain('const ENV_ONLY_PANEL_NAMES = new Set');
  const envOnlyStart = source.indexOf('const ENV_ONLY_PANEL_NAMES = new Set');
  const envOnlyEnd = source.indexOf(']);', envOnlyStart);
  expect(envOnlyStart).toBeGreaterThan(0);
  expect(envOnlyEnd).toBeGreaterThan(envOnlyStart);
  expect(source.slice(envOnlyStart, envOnlyEnd)).not.toContain("'solvency'");
  expect(source.slice(envOnlyStart, envOnlyEnd)).not.toContain("'graph3d'");
  expect(source.slice(envOnlyStart, envOnlyEnd)).not.toContain("'settings'");
  expect(source).toContain('function shouldBlockRemoteEnvOnlyPanel');
  expect(source).toContain("$runtimeControllerHandle.mode === 'remote'");
  expect(source).toContain('panelRequiresRuntimeEnv(panelName)');
  const blockStart = source.indexOf('function shouldBlockRemoteEnvOnlyPanel');
  const blockEnd = source.indexOf('\n  function showRemoteProjectionBoundary', blockStart);
  expect(blockStart).toBeGreaterThan(0);
  expect(blockEnd).toBeGreaterThan(blockStart);
  expect(source.slice(blockStart, blockEnd)).not.toContain('$runtimeFrameEnv');
  expect(source).toContain('showRemoteProjectionBoundary(div, options.name)');
  expect(source).toContain('embedded-only until its projection endpoint is available');
  expect(source).toContain('Remote runtime state is readable in Entity, Gossip, Activity, and Time Machine.');
});

test('Dock entity opening replaces the pinned wallet by default and supports explicit new tabs', () => {
  const dock = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');
  const wallet = readFileSync('frontend/src/lib/view/UserModePanel.svelte', 'utf8');
  const settings = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');

  expect(dock).toContain("localStorage.getItem('xln-dock-entity-open-mode') === 'new-tab'");
  expect(dock).toContain("panelBridge.emit('dock:selectEntity'");
  expect(dock).toContain("dockview.getPanel('wallet-main')?.api.setActive()");
  expect(wallet).toContain("panelBridge.on('dock:selectEntity'");
  expect(wallet).toContain('dockMode = false');
  expect(settings).toContain('data-testid="dock-entity-open-mode"');
  expect(settings).toContain('Replace pinned Main Wallet');
  expect(settings).toContain('Open a new entity tab');
  expect(settings).toContain('data-testid="network-machine-timeline-mode"');
  expect(settings).toContain("focusDockPanel('leveldb-inspector')");
  expect(settings).toContain("focusDockPanel('entity-audit')");
  expect(settings).toContain('TabStylePicker');
});
