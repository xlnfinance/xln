import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildHierarchicalNavigationView } from '../../frontend/src/lib/components/Navigation/runtime-navigation-view';

const runtimeA = 'runtime-a';
const runtimeB = 'runtime-b';
const signerA = '0xAaAa';
const signerB = '0xBbBb';
const entityA = '0xentity-a';
const entityB = '0xentity-b';
const accountA = '0xaccount-a';

test('hierarchical navigation projects runtime state into breadcrumb items', () => {
  const runtimes = new Map([
    [runtimeA, {
      id: runtimeA,
      label: 'Runtime A',
      entityCount: 2,
    }],
    [runtimeB, {
      id: runtimeB,
      label: 'Runtime B',
      entityCount: 0,
    }],
  ]);

  const view = buildHierarchicalNavigationView(
    runtimes,
    {
      runtime: runtimeA,
      jurisdiction: null,
      signer: signerA.toLowerCase(),
      entity: entityA.toUpperCase(),
      account: null,
    },
    {
      signers: [
        { address: signerA, name: 'Alice' },
        { address: signerB, name: 'Bob' },
      ],
    } as never,
    {
      runtimeId: runtimeA,
      entities: [
        {
          entityId: entityA,
          signerId: signerA,
          label: entityA,
          jurisdiction: { name: 'Testnet', chainId: 31337 },
        },
        {
          entityId: entityB,
          signerId: signerB,
          label: entityB,
          jurisdiction: { name: 'Testnet', chainId: 31337 },
        },
      ],
      frame: {
        activeEntityId: entityA,
        activeEntity: {
          summary: { entityId: entityA },
          accounts: {
            items: [{ leftEntity: entityA, rightEntity: accountA }],
            totalItems: 1,
          },
        },
      },
    },
  );

  expect(view.runtimeItems).toEqual([
    { id: runtimeA, label: 'Runtime A', count: 2 },
    { id: runtimeB, label: 'Runtime B', count: 0 },
  ]);
  expect(view.jurisdictionItems).toEqual([{ id: 'Testnet', label: 'Testnet', count: 0 }]);
  expect(view.signerItems).toEqual([
    { id: signerA, label: 'Alice' },
    { id: signerB, label: 'Bob' },
  ]);
  expect(view.entityItems).toEqual([{ id: entityA, label: entityA, count: 1 }]);
  expect(view.accountItems).toEqual([{ id: accountA, label: `A${accountA.slice(0, 8)}` }]);
});

test('HierarchicalNav consumes a projected navigation view instead of reading full runtime env', () => {
  const source = readFileSync('frontend/src/lib/components/Navigation/HierarchicalNav.svelte', 'utf8');
  const helper = readFileSync('frontend/src/lib/components/Navigation/runtime-navigation-view.ts', 'utf8');
  expect(source).toContain('buildHierarchicalNavigationView');
  expect(source).toContain('$runtimeView');
  expect(source).toContain('navigationView.runtimeItems');
  expect(source).toContain('runtimeOperations.selectRuntime(id)');
  expect(source).toContain("import { errorLog } from '$lib/stores/errorLogStore';");
  expect(source).toContain("errorLog.log('Runtime switch failed', 'Navigation'");
  expect(source).not.toContain('activeRuntimeId.set');
  expect(source).not.toContain('console.error');
  expect(source).not.toContain('console.warn');
  expect(source).not.toContain('console.info');
  expect(source).not.toContain('eReplicas');
  expect(source).not.toContain('jReplicas');
  expect(source).not.toContain('runtime.env');
  expect(helper).not.toContain('eReplicas');
  expect(helper).not.toContain('jReplicas');
  expect(helper).not.toContain('runtime.env');
  expect(helper).not.toContain("from '$lib/stores/runtimeStore'");
});
