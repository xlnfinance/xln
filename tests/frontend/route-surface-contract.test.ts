import { describe, expect, test } from 'bun:test';

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

describe('frontend surface contract', () => {
  test('assigns every canonical route and endpoint to exactly one owner', () => {
    expect(FRONTEND_ROUTES.length).toBeGreaterThan(0);
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
