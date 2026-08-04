import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildHierarchicalNavigationView } from '../../frontend/src/lib/components/Navigation/runtime-navigation-view';

const runtimeA = 'runtime-a';
const runtimeB = 'runtime-b';
const signerA = '0xAaAa';
const signerB = '0xBbBb';
const entityA = '0xentity-a';
const entityB = '0xentity-b';
const entityC = '0xentity-c';
const accountA = '0xaccount-a';

test('hierarchical navigation projects runtime state into breadcrumb items', () => {
  const runtimes = new Map([
    [runtimeA, {
      id: runtimeA,
      type: 'local',
      label: 'Runtime A',
      entityCount: 3,
    }],
    [runtimeB, {
      id: runtimeB,
      type: 'remote',
      label: 'Runtime B',
      entityCount: 0,
    }],
  ]);

  const view = buildHierarchicalNavigationView(
    runtimes,
    {
      runtime: runtimeA,
      jurisdiction: 'Testnet',
      signer: signerA.toLowerCase(),
      entity: entityA.toUpperCase(),
      account: null,
    },
    {
      id: runtimeA,
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
        {
          entityId: entityC,
          signerId: signerA,
          label: entityC,
          jurisdiction: { name: 'Tron', chainId: 728126428 },
        },
      ],
      frame: {
        activeEntityId: entityA,
        activeEntity: {
          summary: { entityId: entityA },
          accounts: {
            items: [{ state: { leftEntity: entityA, rightEntity: accountA } }],
            totalItems: 1,
          },
        },
      },
    },
  );

  expect(view.runtimeItems).toEqual([
    { id: runtimeA, label: 'Runtime A', count: 3 },
    { id: runtimeB, label: 'Runtime B', count: 0 },
  ]);
  expect(view.jurisdictionItems).toEqual([
    { id: 'Testnet', label: 'Testnet', count: 2 },
    { id: 'Tron', label: 'Tron', count: 1 },
  ]);
  expect(view.signerItems).toEqual([
    { id: signerA, label: 'Alice' },
    { id: signerB, label: 'Bob' },
  ]);
  expect(view.entityItems).toEqual([{ id: entityA, label: entityA, count: 1 }]);
  expect(view.accountItems).toEqual([{ id: accountA, label: `A${accountA.slice(0, 8)}` }]);
});

test('remote runtime navigation does not inherit local vault signer selection', () => {
  const view = buildHierarchicalNavigationView(
    new Map([
      [runtimeA, { id: runtimeA, type: 'local', label: 'Runtime A' }],
      [runtimeB, { id: runtimeB, type: 'remote', label: 'Runtime B' }],
    ]),
    {
      runtime: runtimeB,
      jurisdiction: 'Testnet',
      signer: signerA,
      entity: null,
      account: null,
    },
    {
      id: runtimeA,
      signers: [{ address: signerA, name: 'Alice' }],
    } as never,
    {
      runtimeId: runtimeB,
      entities: [{
        entityId: entityB,
        signerId: signerB,
        label: entityB,
        jurisdiction: { name: 'Testnet', chainId: 31337 },
      }],
    },
  );

  expect(view.signerItems).toEqual([]);
  expect(view.entityItems).toEqual([{ id: entityB, label: entityB, count: 0 }]);
});
