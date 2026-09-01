import { describe, expect, test } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(path).text();

describe('Graph3D framework-neutral lifecycle', () => {
  test('pairs every canvas and viewport subscription with deterministic cleanup', async () => {
    const source = await read('frontend/packages/ui/src/graph3d-lifecycle.ts');

    for (const eventName of [
      'mousedown',
      'mouseup',
      'mousemove',
      'mouseout',
      'click',
      'dblclick',
      'touchstart',
      'touchmove',
      'touchend',
    ]) {
      expect(source).toContain(`canvas.addEventListener('${eventName}'`);
      expect(source).toContain(`canvas.removeEventListener('${eventName}'`);
    }
    expect(source).toContain("browserWindow.addEventListener('resize', handlers.onResize)");
    expect(source).toContain("browserWindow.removeEventListener('resize', handlers.onResize)");
    expect(source).toContain('observer.disconnect()');
    expect(source).toContain('browserWindow.clearTimeout(resizeTimer)');
    expect(source).toContain('browserWindow.cancelAnimationFrame(resizeFrame)');
    expect(source).toContain("controls.addEventListener('change', handlers.onChange)");
    expect(source).toContain("controls.removeEventListener('change', handlers.onChange)");
    expect(source).toContain("controls.addEventListener('end', handlers.onEnd)");
    expect(source).toContain("controls.removeEventListener('end', handlers.onEnd)");
  });

  test('moves Svelte Graph3D onto the shared lifecycle and frees Three.js/XR resources', async () => {
    const source = await read('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte');

    expect(source).toContain('bindGraphViewportLifecycle(container, renderer.domElement');
    expect(source).toContain('bindGraphControlsLifecycle(controls');
    expect(source).toContain('viewportLifecycle?.dispose()');
    expect(source).toContain('controlsLifecycle?.dispose()');
    expect(source).not.toContain('renderer.domElement.addEventListener');
    expect(source).not.toContain('window.addEventListener("resize"');
    expect(source).not.toContain('new ResizeObserver');
    expect(source).toContain('graphDestroyed = true');
    expect(source).toContain('if (graphDestroyed) return;');
    expect(source).toContain('void xrSession.end()');
    expect(source).toContain('disposeGraphObject3D(scene)');
    expect(source).toContain('renderer.setAnimationLoop(null)');
    expect(source).toContain('renderer.domElement.remove()');
    expect(source).toContain('delete window.__debugScene');
    expect(source).toContain('delete window.__debugCamera');
    expect(source).toContain('delete window.__debugRenderer');
  });

  test('debug registrations expose an ownership-safe disposer', async () => {
    const [debugSource, graphSource] = await Promise.all([
      read('frontend/src/lib/utils/runtime/debugSurface.ts'),
      read('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte'),
    ]);

    expect(debugSource).toContain('): () => void {');
    expect(debugSource).toContain('descriptor?.get === factory');
    expect(debugSource).toContain('delete currentRoot[name]');
    expect(graphSource).toContain('const unregisterGraphDebugSurface = registerDebugSurface("graph"');
    expect(graphSource).toContain('unregisterGraphDebugSurface()');
  });
});
