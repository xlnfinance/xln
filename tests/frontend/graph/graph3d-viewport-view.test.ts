import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  GRAPH3D_CANONICITY_OPTIONS,
  createGraph3dFpsOverlayView,
  createGraph3dViewportStatusView,
  createGraph3dVrHudView,
} from '../../../frontend/packages/runtime-client/src/graph3d-viewport-view';

describe('Graph3D viewport presentation model', () => {
  test('pins the exact merged-view reference options', () => {
    expect(GRAPH3D_CANONICITY_OPTIONS).toEqual([
      { value: 'timestamp', label: 'Latest timestamp' },
      { value: 'height', label: 'Highest height' },
      { value: 'left', label: 'Left entity' },
      { value: 'right', label: 'Right entity' },
      { value: 'hub', label: 'Hub view' },
    ]);
  });

  test('derives projection copy and hides an empty status stack', () => {
    expect(createGraph3dViewportStatusView({
      sourceCount: 1,
      desyncCount: 0,
      projectionError: '',
      runtimeNodeLabels: ['Alice', 'Hub'],
      timelineRuntimeId: '',
      timelineRuntimeColor: '',
      timelineHeight: 0,
      timelineTimestamp: 0,
    })).toEqual({
      projectionStatus: '1 source · 0 desync',
      runtimeNodeSummary: 'Alice · Hub',
      showStatusStack: false,
      projectionError: '',
      timeline: null,
    });
  });

  test('projects timeline evidence once and preserves fail-fast timestamp formatting', () => {
    expect(createGraph3dViewportStatusView({
      sourceCount: 2,
      desyncCount: 3,
      projectionError: 'projection failed',
      runtimeNodeLabels: [],
      timelineRuntimeId: 'runtime-a',
      timelineRuntimeColor: '#00ff88',
      timelineHeight: 42,
      timelineTimestamp: 1_700_000_000_000,
    })).toEqual({
      projectionStatus: '2 sources · 3 desync',
      runtimeNodeSummary: '',
      showStatusStack: true,
      projectionError: 'projection failed',
      timeline: {
        runtimeId: 'runtime-a',
        runtimeColor: '#00ff88',
        heightLabel: 'h42',
        timestampIso: '2023-11-14T22:13:20.000Z',
      },
    });
    expect(() => createGraph3dViewportStatusView({
      sourceCount: 0,
      desyncCount: 0,
      projectionError: '',
      runtimeNodeLabels: [],
      timelineRuntimeId: 'runtime-a',
      timelineRuntimeColor: '#fff',
      timelineHeight: 0,
      timelineTimestamp: Number.NaN,
    })).toThrow();
  });

  test('pins FPS thresholds, numeric labels, and bars-mode copy', () => {
    expect(createGraph3dFpsOverlayView(55, 16.666, 'close')).toEqual({
      tone: 'good',
      fpsLabel: '55.0',
      frameTimeLabel: '16.67ms/frame',
      barsTitle: 'Toggle bars positioning: Center (close)',
      barsLabel: 'Bars: ⬌ Center',
    });
    expect(createGraph3dFpsOverlayView(30, 20, 'spread').tone).toBe('ok');
    expect(createGraph3dFpsOverlayView(29.9, 20, 'spread')).toEqual({
      tone: 'bad',
      fpsLabel: '29.9',
      frameTimeLabel: '20.00ms/frame',
      barsTitle: 'Toggle bars positioning: Sides (spread)',
      barsLabel: 'Bars: ↔ Sides',
    });
  });

  test('projects VR visibility/stats and keeps rendering in Svelte facades', () => {
    expect(createGraph3dVrHudView(true, 12, 59.6)).toEqual({
      visible: true,
      entityCount: 12,
      fps: 60,
    });
    const viewport = readFileSync('frontend/src/lib/view/components/Graph3DViewport.svelte', 'utf8');
    const fps = readFileSync('frontend/src/lib/view/components/Graph3DFpsOverlay.svelte', 'utf8');
    const vr = readFileSync('frontend/src/lib/view/components/VRControlsHUD.svelte', 'utf8');
    const projection = readFileSync('frontend/src/lib/network3d/runtimeGraphProjection.ts', 'utf8');
    const controls = readFileSync('frontend/src/lib/stores/network/runtimeGraphControlStore.ts', 'utf8');

    expect(viewport).toContain('createGraph3dViewportStatusView({');
    expect(viewport).toContain('GRAPH3D_CANONICITY_OPTIONS');
    expect(viewport).not.toContain('new Date(timelineTimestamp).toISOString()');
    expect(fps).toContain('createGraph3dFpsOverlayView(renderFps, frameTime, barsMode)');
    expect(fps).not.toContain('renderFps.toFixed(1)');
    expect(vr).toContain('createGraph3dVrHudView(isVRActive, entityCount, currentFPS)');
    expect(vr).not.toContain('Math.round(currentFPS)');
    expect(projection).toContain('export type RuntimeGraphCanonicity = Graph3dViewportCanonicity');
    expect(controls).toContain('GRAPH3D_CANONICITY_OPTIONS.map(({ value }) => value)');
  });
});
