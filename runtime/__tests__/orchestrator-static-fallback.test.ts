import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

test('mesh orchestrator serves frontend static fallback before 404', () => {
  const source = readFileSync('runtime/orchestrator/orchestrator.ts', 'utf8');
  const staticAssets = readFileSync('runtime/api/server/static-assets.ts', 'utf8');
  const fallback = 'serveStaticApp(request, pathname, FRONTEND_STATIC_DIR)';
  const unhandled = 'Unhandled mesh-control route';

  expect(source).toContain("import { serveStaticApp } from '../api/server/static-assets';");
  expect(source).toContain("const FRONTEND_STATIC_DIR = './frontend/build';");
  expect(staticAssets).toContain("if (pathname === '/runtime.js')");
  expect(staticAssets).toContain("{ error: 'RUNTIME_BUNDLE_MISSING' }");
  expect(staticAssets).toContain('{ status: 503');
  expect(staticAssets).toContain("staticPath === '/index.html' ? null : await serveStatic('/index.html', staticDir)");
  expect(source.indexOf(fallback)).toBeGreaterThan(0);
  expect(source.indexOf(unhandled)).toBeGreaterThan(source.indexOf(fallback));
});
