import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type GraphViewportHandlers = Readonly<{
  onMouseDown: (event: MouseEvent) => void;
  onMouseUp: (event: MouseEvent) => void;
  onMouseMove: (event: MouseEvent) => void;
  onMouseOut: (event: MouseEvent) => void;
  onClick: (event: MouseEvent) => void;
  onDoubleClick: (event: MouseEvent) => void;
  onTouchStart: (event: TouchEvent) => void;
  onTouchMove: (event: TouchEvent) => void;
  onTouchEnd: (event: TouchEvent) => void;
  onResize: () => void;
}>;

export type GraphLifecycleBinding = Readonly<{ dispose: () => void }>;

export const bindGraphViewportLifecycle = (
  container: HTMLDivElement,
  canvas: HTMLCanvasElement,
  handlers: GraphViewportHandlers,
): GraphLifecycleBinding => {
  const browserWindow = container.ownerDocument.defaultView;
  if (!browserWindow) throw new Error('GRAPH_VIEWPORT_WINDOW_MISSING');
  let resizeTimer: number | null = null;
  let resizeFrame: number | null = null;
  let disposed = false;

  const queueResize = (): void => {
    if (resizeTimer !== null) browserWindow.clearTimeout(resizeTimer);
    resizeTimer = browserWindow.setTimeout(() => {
      resizeTimer = null;
      resizeFrame = browserWindow.requestAnimationFrame(() => {
        resizeFrame = null;
        if (!disposed) handlers.onResize();
      });
    }, 50);
  };

  canvas.addEventListener('mousedown', handlers.onMouseDown);
  canvas.addEventListener('mouseup', handlers.onMouseUp);
  canvas.addEventListener('mousemove', handlers.onMouseMove);
  canvas.addEventListener('mouseout', handlers.onMouseOut);
  canvas.addEventListener('click', handlers.onClick);
  canvas.addEventListener('dblclick', handlers.onDoubleClick);
  canvas.addEventListener('touchstart', handlers.onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', handlers.onTouchMove, { passive: false });
  canvas.addEventListener('touchend', handlers.onTouchEnd);
  browserWindow.addEventListener('resize', handlers.onResize);
  const observer = new ResizeObserver(queueResize);
  observer.observe(container);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('mousedown', handlers.onMouseDown);
      canvas.removeEventListener('mouseup', handlers.onMouseUp);
      canvas.removeEventListener('mousemove', handlers.onMouseMove);
      canvas.removeEventListener('mouseout', handlers.onMouseOut);
      canvas.removeEventListener('click', handlers.onClick);
      canvas.removeEventListener('dblclick', handlers.onDoubleClick);
      canvas.removeEventListener('touchstart', handlers.onTouchStart);
      canvas.removeEventListener('touchmove', handlers.onTouchMove);
      canvas.removeEventListener('touchend', handlers.onTouchEnd);
      browserWindow.removeEventListener('resize', handlers.onResize);
      observer.disconnect();
      if (resizeTimer !== null) browserWindow.clearTimeout(resizeTimer);
      if (resizeFrame !== null) browserWindow.cancelAnimationFrame(resizeFrame);
      resizeTimer = null;
      resizeFrame = null;
    },
  };
};

export const bindGraphControlsLifecycle = (
  controls: OrbitControls,
  handlers: Readonly<{ onChange: () => void; onEnd: () => void }>,
): GraphLifecycleBinding => {
  controls.addEventListener('change', handlers.onChange);
  controls.addEventListener('end', handlers.onEnd);
  return {
    dispose: () => {
      controls.removeEventListener('change', handlers.onChange);
      controls.removeEventListener('end', handlers.onEnd);
    },
  };
};
