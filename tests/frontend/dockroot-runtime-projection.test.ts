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

test('DockRoot keeps Dev Lab Architect out of the default operator cockpit', () => {
  const source = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');

  expect(source).toContain('const LEGACY_DEV_PANEL_NAMES = new Set');
  expect(source).toContain('function resolveDevLabEnabled');
  expect(source).toContain("params.get('devLab') === '1'");
  expect(source).toContain("localStorage.getItem('xln-dev-lab') === '1'");
  expect(source).toContain('function layoutRequiresDevLab');
  expect(source).toContain('function panelRequiresDevLab');
  expect(source).toContain('if (!devLabEnabled && panelRequiresDevLab(options.name))');
  expect(source).toContain("void import('./panels/ArchitectPanel.svelte')");
  expect(source).toContain('if (devLabEnabled) {');
  expect(source).toContain("title: '🎬 Dev Lab'");
  expect(source).toContain("position: { direction: 'within', referencePanel: primaryDockReferencePanel() }");
  expect(source).toContain("showEntityPanelStatus(div, 'Legacy Dev Lab panel is disabled for the operator cockpit.', true)");
  expect(source).not.toContain("import ArchitectPanel from './panels/ArchitectPanel.svelte'");
  expect(source).not.toContain("title: '🎬 Architect'");
  expect(source).not.toContain("architectPanel?.api.setActive()");
});

test('DockRoot does not auto-mount raw Env legacy panels in the default operator cockpit', () => {
  const source = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');
  const defaultPanelStart = source.indexOf("ensurePanel({\n      id: 'graph3d'");
  const restoreStart = source.indexOf('if (shouldRestoreLayout && savedLayout)');
  expect(defaultPanelStart).toBeGreaterThan(0);
  expect(restoreStart).toBeGreaterThan(defaultPanelStart);
  const defaultPanelSource = source.slice(defaultPanelStart, restoreStart);
  const devLabBlockStart = defaultPanelSource.indexOf('if (devLabEnabled) {');
  expect(devLabBlockStart).toBeGreaterThan(0);
  const gossipPanelStart = defaultPanelSource.indexOf("ensurePanel({\n      id: 'gossip'");
  expect(gossipPanelStart).toBeGreaterThan(devLabBlockStart);
  const operatorDefaultSource = `${defaultPanelSource.slice(0, devLabBlockStart)}${defaultPanelSource.slice(gossipPanelStart)}`;
  const devLabSource = defaultPanelSource.slice(devLabBlockStart, gossipPanelStart);

  for (const panelId of ['architect', 'jurisdiction', 'runtime-io', 'settings']) {
    expect(operatorDefaultSource).not.toContain(`id: '${panelId}'`);
    expect(devLabSource).toContain(`id: '${panelId}'`);
  }
  expect(operatorDefaultSource).toContain("id: 'graph3d'");
  expect(operatorDefaultSource).toContain("id: 'gossip'");
  expect(devLabSource).not.toContain("id: 'gossip'");
});

test('DockRoot blocks Env-only panels on remote runtimes instead of mounting blank fake Env views', () => {
  const source = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');

  expect(source).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore'");
  expect(source).toContain('const ENV_ONLY_PANEL_NAMES = new Set');
  expect(source).toContain("'graph3d'");
  const envOnlyStart = source.indexOf('const ENV_ONLY_PANEL_NAMES = new Set');
  const envOnlyEnd = source.indexOf(']);', envOnlyStart);
  expect(envOnlyStart).toBeGreaterThan(0);
  expect(envOnlyEnd).toBeGreaterThan(envOnlyStart);
  expect(source.slice(envOnlyStart, envOnlyEnd)).not.toContain("'solvency'");
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
