import { describe, expect, test } from 'bun:test';

import {
  EDGE_ROUTES,
  SURFACES,
  getSurface,
  resolveRouteOwner,
} from '../../../frontend/config/surfaces';

describe('frontend route ownership', () => {
  test('assigns every planned application route', () => {
    expect(resolveRouteOwner('/')).toBe('site');
    expect(resolveRouteOwner('/docs')).toBe('docs');
    expect(resolveRouteOwner('/address/0xabc')).toBe('wallet');
    expect(resolveRouteOwner('/qa/hlt')).toBe('ops');
    expect(resolveRouteOwner('/ai/session-1')).toBe('ops');
  });

  test('keeps server routes and unknown paths edge-owned', () => {
    expect(resolveRouteOwner('/admin')).toBe('edge');
    expect(resolveRouteOwner('/api/tower/healthz')).toBe('edge');
    expect(resolveRouteOwner('/rpc8')).toBe('edge');
    expect(resolveRouteOwner('/runtime.js')).toBe('edge');
    expect(resolveRouteOwner('/not-yet-classified')).toBe('edge');
  });

  test('handles trailing slashes without accepting a URL instead of a pathname', () => {
    expect(resolveRouteOwner('/docs/')).toBe('docs');
    expect(() => resolveRouteOwner('/docs?mode=full')).toThrow('SURFACE_PATHNAME_INVALID');
    expect(() => resolveRouteOwner('docs')).toThrow('SURFACE_PATHNAME_INVALID');
  });

  test('uses unique ports, artifact directories, asset directories, and route declarations', () => {
    const uniqueValues = (values: readonly (string | number)[]): boolean =>
      new Set(values).size === values.length;

    expect(uniqueValues(SURFACES.map(({ developmentPort }) => developmentPort))).toBe(true);
    expect(uniqueValues(SURFACES.map(({ artifactDirectory }) => artifactDirectory))).toBe(true);
    expect(uniqueValues(SURFACES.map(({ assetDirectory }) => assetDirectory))).toBe(true);

    const declaredRoutes = [
      ...SURFACES.flatMap(({ routes }) => routes.map(({ kind, pathname }) => `${kind}:${pathname}`)),
      ...EDGE_ROUTES.map(({ kind, pathname }) => `${kind}:${pathname}`),
    ];
    expect(uniqueValues(declaredRoutes)).toBe(true);
  });

  test('returns the complete surface definition', () => {
    expect(getSurface('wallet')).toMatchObject({
      developmentPort: 8084,
      hmrPath: '/__hmr/wallet',
      artifactDirectory: '.artifacts/wallet',
      assetDirectory: 'assets/wallet',
    });
  });
});
