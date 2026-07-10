import type { XlnMascotDockPlacement, XlnMascotDockSide } from '$lib/types/ui';

export type MascotPoint = Readonly<{ x: number; y: number }>;
export type MascotViewport = Readonly<{
  width: number;
  height: number;
  insetTop?: number;
  insetRight?: number;
  insetBottom?: number;
  insetLeft?: number;
}>;

export type MascotPanelRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export const MASCOT_SIZE = 64;
export const MASCOT_EDGE_GAP = 12;
export const MASCOT_PANEL_GAP = 12;
export const DEFAULT_XLN_MASCOT_DOCK: XlnMascotDockPlacement = {
  version: 1,
  side: 'right',
  offsetRatio: 0.72,
};

const DOCK_SIDES: readonly XlnMascotDockSide[] = ['left', 'right', 'top', 'bottom'];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : min, min), Math.max(min, max));

export function normalizeXlnMascotDock(value: unknown): XlnMascotDockPlacement {
  if (!value || typeof value !== 'object') return { ...DEFAULT_XLN_MASCOT_DOCK };
  const candidate = value as Partial<XlnMascotDockPlacement>;
  if (candidate.version !== 1 || !DOCK_SIDES.includes(candidate.side as XlnMascotDockSide)) {
    return { ...DEFAULT_XLN_MASCOT_DOCK };
  }
  return {
    version: 1,
    side: candidate.side as XlnMascotDockSide,
    offsetRatio: clamp(Number(candidate.offsetRatio), 0, 1),
  };
}

function bounds(viewport: MascotViewport) {
  const minX = (viewport.insetLeft ?? 0) + MASCOT_EDGE_GAP;
  const minY = (viewport.insetTop ?? 0) + MASCOT_EDGE_GAP;
  return {
    minX,
    minY,
    maxX: Math.max(minX, viewport.width - (viewport.insetRight ?? 0) - MASCOT_EDGE_GAP - MASCOT_SIZE),
    maxY: Math.max(minY, viewport.height - (viewport.insetBottom ?? 0) - MASCOT_EDGE_GAP - MASCOT_SIZE),
  };
}

export function resolveMascotPoint(
  placementInput: XlnMascotDockPlacement,
  viewport: MascotViewport,
): MascotPoint {
  const placement = normalizeXlnMascotDock(placementInput);
  const box = bounds(viewport);
  const xAlong = box.minX + (box.maxX - box.minX) * placement.offsetRatio;
  const yAlong = box.minY + (box.maxY - box.minY) * placement.offsetRatio;
  if (placement.side === 'left') return { x: box.minX, y: yAlong };
  if (placement.side === 'right') return { x: box.maxX, y: yAlong };
  if (placement.side === 'top') return { x: xAlong, y: box.minY };
  return { x: xAlong, y: box.maxY };
}

export function clampMascotPoint(point: MascotPoint, viewport: MascotViewport): MascotPoint {
  const box = bounds(viewport);
  return {
    x: clamp(point.x, box.minX, box.maxX),
    y: clamp(point.y, box.minY, box.maxY),
  };
}

export function snapMascotToEdge(
  pointInput: MascotPoint,
  viewport: MascotViewport,
): XlnMascotDockPlacement {
  const point = clampMascotPoint(pointInput, viewport);
  const box = bounds(viewport);
  const distances: Record<XlnMascotDockSide, number> = {
    left: Math.abs(point.x - box.minX),
    right: Math.abs(box.maxX - point.x),
    top: Math.abs(point.y - box.minY),
    bottom: Math.abs(box.maxY - point.y),
  };
  const side = DOCK_SIDES.reduce((best, candidate) =>
    distances[candidate] < distances[best] ? candidate : best,
  );
  const horizontal = side === 'top' || side === 'bottom';
  const current = horizontal ? point.x : point.y;
  const min = horizontal ? box.minX : box.minY;
  const max = horizontal ? box.maxX : box.maxY;
  return {
    version: 1,
    side,
    offsetRatio: max === min ? 0.5 : clamp((current - min) / (max - min), 0, 1),
  };
}

export function resolveMascotPanelRect(
  placementInput: XlnMascotDockPlacement,
  mascotPoint: MascotPoint,
  viewport: MascotViewport,
): MascotPanelRect {
  const placement = normalizeXlnMascotDock(placementInput);
  const edge = MASCOT_EDGE_GAP;
  const width = Math.min(380, Math.max(280, viewport.width - edge * 2));
  const height = Math.min(540, Math.max(360, viewport.height - edge * 2));
  const centeredX = mascotPoint.x + MASCOT_SIZE / 2 - width / 2;
  const centeredY = mascotPoint.y + MASCOT_SIZE / 2 - height / 2;
  let x = centeredX;
  let y = centeredY;
  if (placement.side === 'left') x = mascotPoint.x + MASCOT_SIZE + MASCOT_PANEL_GAP;
  if (placement.side === 'right') x = mascotPoint.x - width - MASCOT_PANEL_GAP;
  if (placement.side === 'top') y = mascotPoint.y + MASCOT_SIZE + MASCOT_PANEL_GAP;
  if (placement.side === 'bottom') y = mascotPoint.y - height - MASCOT_PANEL_GAP;
  return {
    x: clamp(x, edge, viewport.width - edge - width),
    y: clamp(y, edge, viewport.height - edge - height),
    width,
    height,
  };
}

export function moveMascotDock(
  placementInput: XlnMascotDockPlacement,
  key: string,
  changeSide: boolean,
): XlnMascotDockPlacement {
  const placement = normalizeXlnMascotDock(placementInput);
  if (changeSide) {
    const sideByKey: Partial<Record<string, XlnMascotDockSide>> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'top',
      ArrowDown: 'bottom',
    };
    const side = sideByKey[key];
    return side ? { ...placement, side } : placement;
  }
  const negative = key === 'ArrowLeft' || key === 'ArrowUp';
  const positive = key === 'ArrowRight' || key === 'ArrowDown';
  if (!negative && !positive) return placement;
  return { ...placement, offsetRatio: clamp(placement.offsetRatio + (negative ? -0.05 : 0.05), 0, 1) };
}
