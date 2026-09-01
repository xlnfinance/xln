import { describe, expect, test } from 'bun:test';
import type { EnvSnapshot } from '../../../core/api/public/runtime-module';

import {
  buildScenarioFrameVisual,
  clampScenarioFrameIndex,
  focusScenarioFrameIndex,
  formatScenarioBuilderText,
  readScenarioPreviewRequest,
  requireScenarioOption,
  scenarioPreviewHref,
} from '../../../frontend/packages/runtime-client/src/scenario-player-model';
import { opsPageMetadata, resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';

const frame = (height: number, title: string, disputed = false): EnvSnapshot => ({
  state: {
    height,
    eReplicas: new Map([
      ['alice:signer', { entityId: 'alice', state: { entityId: 'alice', accounts: new Map([['hub', { activeDispute: disputed }]]) } }],
      ['hub:signer', { entityId: 'hub', state: { entityId: 'hub', accounts: new Map([['alice', { activeDispute: disputed }]]) } }],
    ]),
  },
  gossip: { profiles: [
    { entityId: 'alice', name: 'Alice', metadata: {} },
    { entityId: 'hub', name: 'Hub', metadata: { isHub: true } },
  ] },
  meta: { title },
  description: disputed ? 'Dispute opened' : 'Account ready',
} as unknown as EnvSnapshot);

const frames = [frame(1, 'Ready'), frame(2, 'Freeze account', true)];

describe('React ops scenarios model', () => {
  test('projects committed frames and collapse evidence without Runtime formulas', () => {
    const option = requireScenarioOption('hub-collapse');
    const visual = buildScenarioFrameVisual(frames[1]!, option);
    expect(visual.nodes.map(node => node.label)).toEqual(['Alice', 'Hub']);
    expect(visual.edges).toHaveLength(1);
    expect(visual.collapse).toBe(true);
    expect(focusScenarioFrameIndex(option, frames)).toBe(1);
    expect(clampScenarioFrameIndex(99, frames.length)).toBe(1);
    expect(formatScenarioBuilderText(frames[1]!, visual, option, 1, 2)).toContain('activeDisputes=2');
  });

  test('strictly validates wallet preview handoffs', () => {
    expect(scenarioPreviewHref('hub-collapse', 1)).toBe('/app?locktest=1&scenarioPreview=1&scenario=hub-collapse&frame=1');
    expect(readScenarioPreviewRequest('?locktest=1&scenarioPreview=1&scenario=swap&frame=7')).toEqual({ id: 'swap', frame: 7 });
    expect(() => readScenarioPreviewRequest('?scenarioPreview=1&scenario=swap&frame=7')).toThrow('RUNTIME_SCENARIO_PREVIEW_MARKERS_REQUIRED');
    expect(() => requireScenarioOption('missing')).toThrow('RUNTIME_SCENARIO_UNKNOWN:missing');
  });

  test('owns /scenarios with explicit operator metadata', () => {
    const page = resolveOpsPage('/scenarios');
    expect(page).toEqual({ kind: 'scenarios', pathname: '/scenarios' });
    expect(opsPageMetadata(page).title).toBe('xln Scenario Player');
  });
});

describe('React scenario Runtime ownership', () => {
  test('uses one real runtime.js source for ops and wallet with loud errors and teardown', async () => {
    const [source, runtime, walletRuntime, walletShell] = await Promise.all([
      Bun.file('frontend/packages/browser/src/runtime-scenario-source.ts').text(),
      Bun.file('frontend/apps/ops/src/ops-scenarios-runtime.ts').text(),
      Bun.file('frontend/apps/wallet/src/wallet-scenario-preview-runtime.ts').text(),
      Bun.file('frontend/apps/wallet/src/app-shell.tsx').text(),
    ]);
    expect(source).toContain('createBrowserRuntimeModuleLoader<XLNModule>');
    expect(source).toContain('recordBrowserScenario');
    expect(source).toContain("status: 'error'");
    expect(source).toContain('stopScenarioPreviewInfra');
    expect(runtime).toContain("addEventListener('pagehide'");
    expect(runtime).toContain('opsScenariosSource.stop()');
    expect(walletRuntime).toContain('startFromPreviewSearch(window.location.search)');
    expect(walletShell).toContain("import('./wallet-scenario-preview')");
    expect(walletShell).toContain("view !== 'scenario-preview'");
  });

  test('lazy-loads scenario route and wallet preview runtimes', async () => {
    const [app, opsMain, walletMain] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-app.tsx').text(),
      Bun.file('frontend/apps/ops/src/main.tsx').text(),
      Bun.file('frontend/apps/wallet/src/main.tsx').text(),
    ]);
    expect(app).toContain("import('./ops-scenarios')");
    expect(opsMain).toContain("import('./ops-scenarios-runtime')");
    expect(walletMain).toContain("import('./wallet-scenario-preview-runtime')");
  });
});
