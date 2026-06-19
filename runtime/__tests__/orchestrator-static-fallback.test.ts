import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

test('mesh orchestrator serves frontend static fallback before 404', () => {
  const source = readFileSync('runtime/orchestrator/orchestrator.ts', 'utf8');
  const fallback = "const fallback = await serveStatic('/index.html', FRONTEND_STATIC_DIR);";
  const unhandled = 'Unhandled mesh-control route';

  expect(source).toContain("import { serveRuntimeBundle, serveStatic } from '../server/static-assets';");
  expect(source).toContain("const FRONTEND_STATIC_DIR = './frontend/build';");
  expect(source).toContain("if (pathname === '/runtime.js')");
  expect(source.indexOf(fallback)).toBeGreaterThan(0);
  expect(source.indexOf(unhandled)).toBeGreaterThan(source.indexOf(fallback));
});
