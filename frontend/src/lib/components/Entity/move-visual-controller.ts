import type { MoveEndpoint } from './move-routes';

export type MoveSide = 'from' | 'to';
export type MoveAnchor = { x: number; y: number };
export type MoveNodeParams = { side: MoveSide; endpoint: MoveEndpoint };
export type MoveNodeActionResult = {
  update: (next: MoveNodeParams) => void;
  destroy: () => void;
};

type TimerHandle = unknown;

type MoveVisualControllerDeps = {
  getFromEndpoint: () => MoveEndpoint;
  getToEndpoint: () => MoveEndpoint;
  getDragSource: () => MoveEndpoint | null;
  isLineReady: () => boolean;
  setLineReady: (ready: boolean) => void;
  setCommittedLineReady: (ready: boolean) => void;
  bumpLayoutVersion: () => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  ResizeObserverCtor?: typeof ResizeObserver;
};

const nodeKey = (side: MoveSide, endpoint: MoveEndpoint): string => `${side}:${endpoint}`;

export function createMoveVisualController(deps: MoveVisualControllerDeps) {
  let root: HTMLDivElement | null = null;
  let layoutRaf: number | null = null;
  let layoutSettleRaf: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let committedLinePrimed = false;
  let committedLineTimeout: TimerHandle | null = null;
  const nodeRefs = new Map<string, HTMLButtonElement>();

  const requestFrame = deps.requestAnimationFrame
    ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
  const cancelFrame = deps.cancelAnimationFrame
    ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);
  const setTimer: (callback: () => void, delayMs: number) => TimerHandle =
    deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer: (handle: TimerHandle) => void =
    deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const ResizeObserverImpl = deps.ResizeObserverCtor
    ?? (typeof ResizeObserver === 'function' ? ResizeObserver : null);

  const cancelScheduledMeasurement = (): void => {
    if (layoutRaf !== null && cancelFrame) cancelFrame(layoutRaf);
    if (layoutSettleRaf !== null && cancelFrame) cancelFrame(layoutSettleRaf);
    layoutRaf = null;
    layoutSettleRaf = null;
    if (committedLineTimeout) {
      clearTimer(committedLineTimeout);
      committedLineTimeout = null;
    }
  };

  const resetMeasurement = (): void => {
    deps.setLineReady(false);
    deps.setCommittedLineReady(false);
    committedLinePrimed = false;
    cancelScheduledMeasurement();
  };

  const scheduleCommittedLineReady = (): void => {
    if (committedLineTimeout) clearTimer(committedLineTimeout);
    if (deps.getDragSource()) return;
    if (committedLinePrimed) {
      deps.bumpLayoutVersion();
      deps.setCommittedLineReady(true);
      return;
    }
    deps.setCommittedLineReady(false);
    committedLineTimeout = setTimer(() => {
      committedLineTimeout = null;
      deps.bumpLayoutVersion();
      deps.setCommittedLineReady(true);
      committedLinePrimed = true;
    }, 200);
  };

  const getNodeAnchor = (side: MoveSide, endpoint: MoveEndpoint): MoveAnchor | null => {
    const rootRect = root?.getBoundingClientRect();
    const node = nodeRefs.get(nodeKey(side, endpoint))
      || root?.querySelector<HTMLButtonElement>(`[data-move-side="${side}"][data-move-endpoint="${endpoint}"]`)
      || null;
    const nodeRect = node?.getBoundingClientRect();
    if (
      !rootRect
      || !nodeRect
      || rootRect.width <= 0
      || rootRect.height <= 0
      || nodeRect.width <= 0
      || nodeRect.height <= 0
    ) {
      return null;
    }
    return {
      x: side === 'from'
        ? nodeRect.right - rootRect.left
        : nodeRect.left - rootRect.left,
      y: nodeRect.top - rootRect.top + (nodeRect.height / 2),
    };
  };

  const bumpNodeLayout = (): void => {
    deps.bumpLayoutVersion();
    if (!requestFrame || !cancelFrame) {
      const hasAnchors = Boolean(
        getNodeAnchor('from', deps.getFromEndpoint())
        && getNodeAnchor('to', deps.getToEndpoint()),
      );
      deps.setLineReady(hasAnchors);
      if (hasAnchors) scheduleCommittedLineReady();
      return;
    }

    deps.setLineReady(false);
    deps.setCommittedLineReady(false);
    cancelScheduledMeasurement();
    layoutRaf = requestFrame(() => {
      layoutRaf = null;
      layoutSettleRaf = requestFrame(() => {
        layoutSettleRaf = null;
        const fromAnchor = getNodeAnchor('from', deps.getFromEndpoint());
        const toAnchor = getNodeAnchor('to', deps.getToEndpoint());
        if (fromAnchor && toAnchor) {
          deps.bumpLayoutVersion();
          deps.setLineReady(true);
          scheduleCommittedLineReady();
          return;
        }
        requestFrame(() => {
          const retryFromAnchor = getNodeAnchor('from', deps.getFromEndpoint());
          const retryToAnchor = getNodeAnchor('to', deps.getToEndpoint());
          if (!retryFromAnchor || !retryToAnchor) return;
          deps.bumpLayoutVersion();
          deps.setLineReady(true);
          scheduleCommittedLineReady();
        });
      });
    });
  };

  const setRoot = (node: HTMLDivElement | null): void => {
    if (node === root) return;
    resizeObserver?.disconnect();
    resizeObserver = null;
    resetMeasurement();
    root = node;
    if (root && ResizeObserverImpl) {
      resizeObserver = new ResizeObserverImpl(() => bumpNodeLayout());
      resizeObserver.observe(root);
    }
    bumpNodeLayout();
  };

  const setNodeRef = (side: MoveSide, endpoint: MoveEndpoint, node: HTMLButtonElement | null): void => {
    const key = nodeKey(side, endpoint);
    if (node) {
      nodeRefs.set(key, node);
    } else {
      nodeRefs.delete(key);
    }
    bumpNodeLayout();
  };

  const nodeAction = (node: HTMLButtonElement, params: MoveNodeParams): MoveNodeActionResult => {
    setNodeRef(params.side, params.endpoint, node);
    return {
      update(next) {
        setNodeRef(params.side, params.endpoint, null);
        setNodeRef(next.side, next.endpoint, node);
        params = next;
      },
      destroy() {
        setNodeRef(params.side, params.endpoint, null);
      },
    };
  };

  const beginDrag = (): void => {
    deps.setCommittedLineReady(false);
    if (committedLineTimeout) {
      clearTimer(committedLineTimeout);
      committedLineTimeout = null;
    }
  };

  const clearDrag = (): void => {
    if (deps.isLineReady()) scheduleCommittedLineReady();
  };

  const destroy = (): void => {
    resetMeasurement();
    resizeObserver?.disconnect();
    resizeObserver = null;
    root = null;
    nodeRefs.clear();
  };

  return {
    beginDrag,
    bumpNodeLayout,
    clearDrag,
    destroy,
    getNodeAnchor,
    nodeAction,
    resetMeasurement,
    scheduleCommittedLineReady,
    setRoot,
  };
}
