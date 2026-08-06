import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FRONTEND_ROUTES } from '../src/lib/contracts/frontendSurfaces';
import {
  createReactViteSurfaceContract,
  resolveReactFrontendSurface,
} from '../packages/build-contracts/vite-surfaces';

const FRONTEND_ROOT = resolve(import.meta.dir, '..');

describe('canonical Vite surface contract', () => {
  test('keeps authenticated relay traffic on the browser-facing host', () => {
    const source = readFileSync(join(FRONTEND_ROOT, 'vite.config.ts'), 'utf8');
    const relayStart = source.indexOf("'/relay': {");
    const relayEnd = source.indexOf('\n  },', relayStart);
    const relaySource = source.slice(relayStart, relayEnd);

    expect(relayStart).toBeGreaterThan(0);
    expect(relaySource).toContain('changeOrigin: false');
    expect(relaySource).toContain('configure: configureWsProxyLifecycle');
  });

  test('maps every page route to one exact MPA entry and surface root', () => {
    for (const surface of ['site', 'docs', 'wallet', 'ops'] as const) {
      const expectedRoutes = FRONTEND_ROUTES.filter(route => route.surface === surface && route.kind === 'page');
      const contract = createReactViteSurfaceContract(FRONTEND_ROOT, surface);
      expect(contract.root).toBe(resolve(FRONTEND_ROOT, `apps/${surface}/entries`));
      expect(contract.outDir).toBe(resolve(FRONTEND_ROOT, `build/${surface}`));
      expect(contract.routes).toEqual(expectedRoutes);
      expect(contract.inputs).toEqual(Object.fromEntries(expectedRoutes.map(route => [
        route.id,
        resolve(FRONTEND_ROOT, `apps/${surface}/entries`, route.outputEntry!),
      ])));
    }
  });

  test('serves the complete same-origin route set in development', () => {
    const source = readFileSync(join(FRONTEND_ROOT, 'vite.config.ts'), 'utf8');
    const all = createReactViteSurfaceContract(FRONTEND_ROOT, 'all');
    const pageRoutes = FRONTEND_ROUTES.filter(route => route.surface !== 'edge' && route.kind === 'page');
    expect(all.root).toBe(FRONTEND_ROOT);
    expect(all.outDir).toBe(resolve(FRONTEND_ROOT, 'build/.preview'));
    expect(all.routes).toEqual(pageRoutes);
    expect(Object.keys(all.inputs)).toHaveLength(pageRoutes.length);
    expect(source).toContain("attrs: { href: devHtmlBase(context.filename) }");
    expect(source).toContain("canonicalRoutePlugin(contract, command === 'serve')");
    expect(source).toContain("response.end('RADAPTER_QUERY_PARAMETERS_FORBIDDEN')");
  });

  test('rejects unknown surface selectors instead of choosing a fallback', () => {
    expect(resolveReactFrontendSurface(undefined)).toBe('all');
    expect(resolveReactFrontendSurface('site')).toBe('site');
    expect(resolveReactFrontendSurface('docs')).toBe('docs');
    expect(resolveReactFrontendSurface('wallet')).toBe('wallet');
    expect(resolveReactFrontendSurface('ops')).toBe('ops');
    expect(() => resolveReactFrontendSurface('unknown')).toThrow('REACT_FRONTEND_SURFACE_UNKNOWN:unknown');
  });

  test('passes the exact parent Bun executable to nested asset builds', () => {
    const source = readFileSync(join(FRONTEND_ROOT, 'scripts/build-surfaces.ts'), 'utf8');
    expect(source).toContain('env: { ...env, XLN_BUN_EXECUTABLE: process.execPath }');
  });
});
