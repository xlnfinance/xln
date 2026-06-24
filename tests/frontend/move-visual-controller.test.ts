import { describe, expect, test } from 'bun:test';

import { createMoveVisualController } from '../../frontend/src/lib/components/Entity/move-visual-controller';
import type { MoveEndpoint } from '../../frontend/src/lib/components/Entity/move-routes';

type RectLike = Pick<DOMRect, 'left' | 'right' | 'top' | 'width' | 'height'>;

const rect = (left: number, top: number, width: number, height: number): RectLike => ({
  left,
  right: left + width,
  top,
  width,
  height,
});

const fakeNode = (box: RectLike): HTMLButtonElement => ({
  getBoundingClientRect: () => box,
} as unknown as HTMLButtonElement);

const fakeRoot = (box: RectLike): HTMLDivElement => ({
  getBoundingClientRect: () => box,
  querySelector: () => null,
} as unknown as HTMLDivElement);

describe('move visual controller', () => {
  test('measures from/to anchors relative to the visual root', () => {
    let lineReady = false;
    let committedReady = false;
    let layoutVersion = 0;
    let from: MoveEndpoint = 'external';
    let to: MoveEndpoint = 'reserve';
    const controller = createMoveVisualController({
      getFromEndpoint: () => from,
      getToEndpoint: () => to,
      getDragSource: () => null,
      isLineReady: () => lineReady,
      setLineReady: (ready) => lineReady = ready,
      setCommittedLineReady: (ready) => committedReady = ready,
      bumpLayoutVersion: () => layoutVersion += 1,
      setTimeout: (() => 0) as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
    });

    controller.setRoot(fakeRoot(rect(10, 20, 300, 200)));
    const sourceAction = controller.nodeAction(fakeNode(rect(30, 50, 40, 20)), { side: 'from', endpoint: 'external' });
    const targetAction = controller.nodeAction(fakeNode(rect(210, 90, 50, 30)), { side: 'to', endpoint: 'reserve' });

    expect(controller.getNodeAnchor('from', 'external')).toEqual({ x: 60, y: 40 });
    expect(controller.getNodeAnchor('to', 'reserve')).toEqual({ x: 200, y: 85 });
    expect(lineReady).toBe(true);
    expect(committedReady).toBe(false);
    expect(layoutVersion).toBeGreaterThan(0);

    to = 'account';
    targetAction.update({ side: 'to', endpoint: 'account' });
    expect(controller.getNodeAnchor('to', 'reserve')).toBeNull();
    expect(controller.getNodeAnchor('to', 'account')).toEqual({ x: 200, y: 85 });

    sourceAction.destroy();
    expect(controller.getNodeAnchor('from', 'external')).toBeNull();
  });

  test('reset and destroy clear measured state', () => {
    let lineReady = true;
    let committedReady = true;
    const controller = createMoveVisualController({
      getFromEndpoint: () => 'external',
      getToEndpoint: () => 'reserve',
      getDragSource: () => null,
      isLineReady: () => lineReady,
      setLineReady: (ready) => lineReady = ready,
      setCommittedLineReady: (ready) => committedReady = ready,
      bumpLayoutVersion: () => undefined,
    });

    controller.setRoot(fakeRoot(rect(0, 0, 100, 100)));
    controller.nodeAction(fakeNode(rect(0, 0, 20, 20)), { side: 'from', endpoint: 'external' });
    controller.resetMeasurement();
    expect(lineReady).toBe(false);
    expect(committedReady).toBe(false);

    controller.destroy();
    expect(controller.getNodeAnchor('from', 'external')).toBeNull();
  });
});
