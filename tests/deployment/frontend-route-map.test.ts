import { describe, expect, test } from 'bun:test';

import { FRONTEND_ROUTES } from '../../frontend/src/lib/contracts/frontendSurfaces';
import {
  frontendReleaseRouteMatrix,
  resolveFrontendReleaseRoute,
} from '../../scripts/deployment/frontend-route-map';

describe('frontend release route map', () => {
  test('resolves every contracted route without cross-surface fallback', () => {
    expect(frontendReleaseRouteMatrix()).toHaveLength(FRONTEND_ROUTES.length);
    expect(resolveFrontendReleaseRoute('/')).toEqual({ kind: 'surface', surface: 'site', outputEntry: 'index.html' });
    expect(resolveFrontendReleaseRoute('/docs')).toEqual({ kind: 'surface', surface: 'docs', outputEntry: 'index.html' });
    expect(resolveFrontendReleaseRoute('/app')).toEqual({ kind: 'surface', surface: 'wallet', outputEntry: 'index.html' });
    expect(resolveFrontendReleaseRoute('/address/entity')).toEqual({ kind: 'surface', surface: 'wallet', outputEntry: 'address/index.html' });
    expect(resolveFrontendReleaseRoute('/health')).toEqual({ kind: 'surface', surface: 'ops', outputEntry: 'health/index.html' });
  });

  test('maps resources, redirects, and server endpoints explicitly', () => {
    expect(resolveFrontendReleaseRoute('/docs-catalog/core/00_QA.md')).toEqual({
      kind: 'surface', surface: 'docs', outputEntry: 'docs-catalog/core/00_QA.md',
    });
    expect(resolveFrontendReleaseRoute('/admin')).toEqual({ kind: 'redirect', location: '/health' });
    expect(resolveFrontendReleaseRoute('/radapter')).toEqual({ kind: 'redirect', location: '/app' });
    expect(resolveFrontendReleaseRoute('/rpc')).toEqual({ kind: 'server', endpoint: '/rpc' });
    expect(resolveFrontendReleaseRoute('/resetdb')).toEqual({ kind: 'server', endpoint: '/resetdb' });
  });

  test('does not let site fallback swallow unknown or unsafe paths', () => {
    expect(resolveFrontendReleaseRoute('/unknown')).toEqual({ kind: 'not-found' });
    expect(resolveFrontendReleaseRoute('/app.html')).toEqual({ kind: 'not-found' });
    expect(resolveFrontendReleaseRoute('/../wallet/index.html')).toEqual({ kind: 'not-found' });
    expect(resolveFrontendReleaseRoute('app')).toEqual({ kind: 'not-found' });
  });
});
