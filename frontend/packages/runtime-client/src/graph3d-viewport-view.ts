// Framework-neutral presentation state for the Graph3D viewport chrome. The
// canonical Svelte components and future React surface share these exact
// labels, thresholds, and visibility rules; DOM events and styling stay in the
// framework facades.

export type Graph3dViewportCanonicity = 'timestamp' | 'height' | 'left' | 'right' | 'hub';
export type Graph3dFpsTone = 'good' | 'ok' | 'bad';

export const GRAPH3D_CANONICITY_OPTIONS = [
  { value: 'timestamp', label: 'Latest timestamp' },
  { value: 'height', label: 'Highest height' },
  { value: 'left', label: 'Left entity' },
  { value: 'right', label: 'Right entity' },
  { value: 'hub', label: 'Hub view' },
] as const satisfies readonly Readonly<{
  value: Graph3dViewportCanonicity;
  label: string;
}>[];

export type Graph3dViewportStatusView = Readonly<{
  projectionStatus: string;
  runtimeNodeSummary: string;
  showStatusStack: boolean;
  projectionError: string;
  timeline: Readonly<{
    runtimeId: string;
    runtimeColor: string;
    heightLabel: string;
    timestampIso: string;
  }> | null;
}>;

type Graph3dViewportStatusInput = Readonly<{
  sourceCount: number;
  desyncCount: number;
  projectionError: string;
  runtimeNodeLabels: readonly string[];
  timelineRuntimeId: string;
  timelineRuntimeColor: string;
  timelineHeight: number;
  timelineTimestamp: number;
}>;

export const createGraph3dViewportStatusView = ({
  sourceCount,
  desyncCount,
  projectionError,
  runtimeNodeLabels,
  timelineRuntimeId,
  timelineRuntimeColor,
  timelineHeight,
  timelineTimestamp,
}: Graph3dViewportStatusInput): Graph3dViewportStatusView => {
  const timeline = timelineRuntimeId ? {
    runtimeId: timelineRuntimeId,
    runtimeColor: timelineRuntimeColor,
    heightLabel: `h${timelineHeight}`,
    timestampIso: new Date(timelineTimestamp).toISOString(),
  } : null;

  return {
    projectionStatus: `${sourceCount} source${sourceCount === 1 ? '' : 's'} · ${desyncCount} desync`,
    runtimeNodeSummary: runtimeNodeLabels.join(' · '),
    showStatusStack: Boolean(projectionError || timeline),
    projectionError,
    timeline,
  };
};

export type Graph3dFpsOverlayView = Readonly<{
  tone: Graph3dFpsTone;
  fpsLabel: string;
  frameTimeLabel: string;
  barsTitle: string;
  barsLabel: string;
}>;

export const createGraph3dFpsOverlayView = (
  renderFps: number,
  frameTime: number,
  barsMode: 'close' | 'spread',
): Graph3dFpsOverlayView => {
  const barsPosition = barsMode === 'close' ? 'Center (close)' : 'Sides (spread)';
  return {
    tone: renderFps >= 55 ? 'good' : renderFps >= 30 ? 'ok' : 'bad',
    fpsLabel: renderFps.toFixed(1),
    frameTimeLabel: `${frameTime.toFixed(2)}ms/frame`,
    barsTitle: `Toggle bars positioning: ${barsPosition}`,
    barsLabel: barsMode === 'close' ? 'Bars: ⬌ Center' : 'Bars: ↔ Sides',
  };
};

export type Graph3dVrHudView = Readonly<{
  visible: boolean;
  entityCount: number;
  fps: number;
}>;

export const createGraph3dVrHudView = (
  isVRActive: boolean,
  entityCount: number,
  currentFps: number,
): Graph3dVrHudView => ({
  visible: isVRActive,
  entityCount,
  fps: Math.round(currentFps),
});
