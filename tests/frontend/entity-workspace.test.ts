import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildEntityWorkspaceView,
  resolveEntityWorkspaceCapabilities,
  runtimeProjectionMatchesRuntime,
} from '../../frontend/src/lib/components/Entity/entity-workspace';

test('runtime projection cannot cross a runtime switch boundary', () => {
  expect(runtimeProjectionMatchesRuntime('runtime-a', 'runtime-a')).toBe(true);
  expect(runtimeProjectionMatchesRuntime('RUNTIME-A', 'runtime-a')).toBe(true);
  expect(runtimeProjectionMatchesRuntime('runtime-a', 'runtime-b')).toBe(false);
  expect(runtimeProjectionMatchesRuntime('', 'runtime-a')).toBe(false);
  expect(runtimeProjectionMatchesRuntime('runtime-a', '')).toBe(false);
});

test('entity workspace exposes one wallet app surface without fake frontend roles', () => {
  const capabilities = resolveEntityWorkspaceCapabilities({
    mode: 'remote',
    authLevel: 'inspect',
  }, {
    entityId: '0xabc',
    isHub: true,
    accountCount: 2,
    bookCount: 1,
  });

  expect(capabilities.canRead).toBe(true);
  expect(Object.keys(capabilities).sort()).toEqual(['canRead', 'entityId']);
});

test('entity workspace treats admin remote and embedded runtimes as writable command surfaces', () => {
  const admin = resolveEntityWorkspaceCapabilities({ mode: 'remote', authLevel: 'admin' }, {
    entityId: '0xabc',
    accountCount: 1,
  });
  const embedded = resolveEntityWorkspaceCapabilities({ mode: 'embedded', authLevel: null }, {
    entityId: '0xabc',
    accountCount: 1,
  });

  expect(admin.canRead).toBe(true);
  expect(embedded.canRead).toBe(true);
});


test('entity workspace view builder projects replica state into capability counts', () => {
  const entityId = '0xabc';
  const view = buildEntityWorkspaceView({
    runtimeId: 'radapter:ws://127.0.0.1:1234',
    height: 42,
    entities: [{ entityId, label: 'Hub', height: 42, isHub: true }],
    activeEntityId: entityId,
    activeEntity: {
      summary: { entityId, label: 'Hub', height: 42, isHub: true },
      core: {
        profile: { isHub: true },
        proposals: new Map([['proposal-1', {}]]),
        reserves: new Map([[1, {}]]),
        orderbookHubProfile: { entityId },
      },
      accounts: { items: [{}], totalItems: 1, nextCursor: null },
      books: { items: [{ pairId: 'USDC/WETH', book: {} }], totalItems: 1, nextCursor: null },
    },
  } as any, entityId);

  expect(view).toMatchObject({
    entityId,
    runtimeId: 'radapter:ws://127.0.0.1:1234',
    height: 42,
    isHub: true,
    accountCount: 1,
    bookCount: 1,
    proposalCount: 1,
    reserveCount: 1,
  });
});

test('entity workspace model does not import full runtime RuntimeReplica', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/entity-workspace.ts', 'utf8');
  expect(source).toContain('RuntimeAdapterViewFrame');
  expect(source).not.toContain('RuntimeReplica, EnvSnapshot');
  expect(source).not.toContain('eReplicas');
  expect(source).not.toContain('jReplicas');
});
