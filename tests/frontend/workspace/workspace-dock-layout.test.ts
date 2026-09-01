import { describe, expect, test } from 'bun:test';
import type { SerializedDockview } from 'dockview';

import {
  WORKSPACE_LAYOUT_VERSION,
  parseWorkspaceLayoutEnvelope,
  serializeWorkspaceDockLayout,
} from '../../../frontend/packages/runtime-client/src/workspace-dock-layout';
import { resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';

const LAYOUT = {
  grid: {
    root: {
      type: 'branch',
      data: [{ type: 'leaf', data: { id: 'group-1', views: [] }, size: 1 }],
      size: 1,
    },
    height: 720,
    width: 1280,
    orientation: 'HORIZONTAL',
  },
  panels: {},
} as unknown as SerializedDockview;

describe('workspace Dockview layout contract', () => {
  test('reads both autosaved and Settings-enriched Svelte envelopes', () => {
    const standard = parseWorkspaceLayoutEnvelope(serializeWorkspaceDockLayout(LAYOUT, '2026-09-01T00:00:00.000Z'));
    const enriched = parseWorkspaceLayoutEnvelope(JSON.stringify({
      version: WORKSPACE_LAYOUT_VERSION,
      timestamp: '2026-09-01T00:00:00.000Z',
      dockview: LAYOUT,
      camera: { distance: 500 },
      settings: { rendererMode: 'webgl' },
    }));

    expect(standard.dockview).toEqual(LAYOUT);
    expect(enriched).toMatchObject({
      dockview: LAYOUT,
      camera: { distance: 500 },
      settings: { rendererMode: 'webgl' },
    });
  });

  test('rejects malformed persisted data before Dockview receives it', () => {
    expect(() => parseWorkspaceLayoutEnvelope('{')).toThrow('WORKSPACE_LAYOUT_JSON_INVALID');
    expect(() => parseWorkspaceLayoutEnvelope('[]')).toThrow('WORKSPACE_LAYOUT_INVALID');
    expect(() => parseWorkspaceLayoutEnvelope('{"dockview":{}}')).toThrow('WORKSPACE_DOCK_LAYOUT_INVALID');
    expect(() => parseWorkspaceLayoutEnvelope(JSON.stringify({ dockview: LAYOUT, timestamp: 7 })))
      .toThrow('WORKSPACE_LAYOUT_TIMESTAMP_INVALID');
  });

  test('adds a production React adapter without claiming the incomplete /embed route', async () => {
    const [reactSource, svelteSource] = await Promise.all([
      Bun.file('frontend/packages/ui/src/workspace-dock.tsx').text(),
      Bun.file('frontend/src/lib/view/DockRoot.svelte').text(),
    ]);

    expect(reactSource).toContain('DockviewReact');
    expect(reactSource).toContain("import 'dockview/dist/styles/dockview.css'");
    expect(reactSource).toContain('openWorkspaceDockSession');
    expect(reactSource).toContain('sessionRef.current?.dispose()');
    expect(reactSource).not.toContain('CandidateShell');
    expect(reactSource).not.toContain('placeholder');
    expect(svelteSource).toContain('parseWorkspaceLayoutEnvelope(savedLayout).dockview');
    expect(svelteSource).toContain('serializeWorkspaceDockLayout(dockview.toJSON()');
    expect(svelteSource).toContain('layoutChangeDisposable.dispose()');
    expect(resolveOpsPage('/embed')).toEqual({ kind: 'pending', pathname: '/embed' });
  });
});
