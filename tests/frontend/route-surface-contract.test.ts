import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  FRONTEND_ROUTES,
  FRONTEND_SURFACES,
  findFrontendRoute,
  validateFrontendSurfaceContract,
  type FrontendRoute,
} from '../../frontend/src/lib/contracts/frontendSurfaces';
import {
  buildFrontendMigrationContractReport,
  serializeFrontendMigrationContractReport,
} from '../../frontend/src/lib/contracts/frontendMigrationContract';

const ROUTES_ROOT = 'frontend/src/routes';

const routePattern = (directory: string): string => {
  const route = relative(ROUTES_ROOT, directory).replaceAll('\\', '/');
  if (!route) return '/';
  const segments = route.split('/').map(segment => {
    const optional = segment.match(/^\[\[([^\]]+)\]\]$/);
    if (optional) return `:${optional[1]}?`;
    const required = segment.match(/^\[([^\]]+)\]$/);
    return required ? `:${required[1]}` : segment;
  });
  return `/${segments.join('/')}`;
};

const discoverCurrentRoutePatterns = (directory = ROUTES_ROOT): readonly string[] => {
  const patterns = new Set<string>();
  const visit = (current: string): void => {
    const entries = readdirSync(current);
    if (entries.some(entry => /^\+(?:page|server)\.(?:svelte|ts|js)$/.test(entry))) {
      patterns.add(routePattern(current));
    }
    for (const entry of entries) {
      const child = join(current, entry);
      if (statSync(child).isDirectory()) visit(child);
    }
  };
  visit(directory);
  return [...patterns].sort();
};

describe('frontend surface contract', () => {
  test('assigns every current route and endpoint to exactly one future owner', () => {
    const contracted = FRONTEND_ROUTES
      .filter(route => route.kind !== 'resource')
      .map(route => route.pattern)
      .sort();

    expect(contracted).toEqual(discoverCurrentRoutePatterns());
    expect(validateFrontendSurfaceContract()).toEqual([]);
  });

  test('keeps origin-sensitive and edge routes on their explicit boundaries', () => {
    const owner = (pattern: string) => FRONTEND_ROUTES.find(route => route.pattern === pattern)?.surface;

    expect(owner('/')).toBe('site');
    expect(owner('/docs')).toBe('docs');
    expect(owner('/app')).toBe('wallet');
    expect(owner('/address/:entityId')).toBe('wallet');
    expect(owner('/health')).toBe('ops');
    expect(owner('/embed')).toBe('ops');
    expect(owner('/admin')).toBe('edge');
    expect(owner('/radapter')).toBe('edge');
    expect(owner('/rpc')).toBe('edge');
    expect(owner('/resetdb')).toBe('edge');
    expect(findFrontendRoute('/address/0x1234')?.id).toBe('wallet-address-detail');
    expect(findFrontendRoute('/ai')?.id).toBe('ops-ai');
    expect(findFrontendRoute('/ai/chat-1')?.id).toBe('ops-ai');
    expect(findFrontendRoute('/docs-catalog/core/00_QA.md')?.id).toBe('docs-catalog');
  });

  test('rejects duplicate routes instead of choosing an implicit winner', () => {
    const duplicate = { ...FRONTEND_ROUTES[0], id: 'duplicate-home' } as FrontendRoute;
    expect(validateFrontendSurfaceContract(FRONTEND_SURFACES, [...FRONTEND_ROUTES, duplicate]))
      .toContain('DUPLICATE_ROUTE_PATTERN:/');
  });

  test('serializes a deterministic migration report', () => {
    expect(buildFrontendMigrationContractReport().version).toBe(1);
    expect(serializeFrontendMigrationContractReport()).toBe(serializeFrontendMigrationContractReport());
  });
});
