import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'core/orchestrator/hub-node.ts'), 'utf8');

const sourceBlock = (startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

test('checkpoint export owns one fail-closed bootstrap pause lease', () => {
  const snapshot = sourceBlock(
    "if (url.pathname === '/api/control/runtime/snapshot')",
    "const stopP2P = url.pathname === '/api/control/p2p/stop'",
  );

  expect(snapshot).toContain(
    'const releaseBootstrapPause = await dependencies.pauseBootstrap();',
  );
  expect(snapshot).toContain('finally {');
  expect(snapshot).toContain('releaseBootstrapPause();');
  expect(snapshot).not.toContain('resumeBootstrap');
});

test('producer pause timeout throws and overlapping leases cannot resume early', () => {
  const controller = sourceBlock(
    'const createHubMeshBootstrapController = (',
    'const installHubShutdownHandlers = (',
  );

  expect(controller).toContain('pauseLeaseCount += 1;');
  expect(controller).toContain("throw new Error('MESH_PRODUCER_PAUSE_TIMEOUT');");
  expect(controller).toContain('pauseLeaseCount -= 1;');
  expect(controller).toContain('if (pauseLeaseCount > 0');
  expect(controller.lastIndexOf('paused = false;')).toBeGreaterThan(
    controller.indexOf('if (pauseLeaseCount > 0'),
  );
});
