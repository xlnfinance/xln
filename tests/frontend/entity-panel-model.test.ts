import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildEntityPanelView,
  getCurrentEntityJurisdictionKey,
  getCurrentEntityJurisdictionName,
  getEntityJurisdictionKey,
  getEntityJurisdictionKeyFromReplicas,
  hasDevnetJurisdiction,
  isSameJurisdictionEntity,
  isSameJurisdictionEntityInReplicas,
  jurisdictionKey,
} from '../../frontend/src/lib/components/Entity/entity-panel-model';
import { buildAccountPageView, resolveAccountListEntityName } from '../../frontend/src/lib/components/Entity/account-list-view';

describe('entity panel model helpers', () => {
  test('builds stable jurisdiction keys from contract config', () => {
    expect(jurisdictionKey({ chainId: 31337, depositoryAddress: '0xABCDEF', name: 'Ignored' }))
      .toBe('dep:31337:0xabcdef');
    expect(jurisdictionKey({ chainId: 31338, name: 'Fallback' })).toBe('chain:31338');
    expect(jurisdictionKey({ name: 'Base Sepolia' })).toBe('base sepolia');
    expect(jurisdictionKey('Testnet')).toBe('testnet');
  });

  test('resolves current entity jurisdiction from replica before active env fallback', () => {
    const env = { activeJurisdiction: 'Fallback' } as any;
    const replica = {
      state: {
        config: { jurisdiction: { name: 'Configured', chainId: 1 } },
      },
    } as any;

    expect(getCurrentEntityJurisdictionName(env, replica)).toBe('Configured');
    expect(getCurrentEntityJurisdictionKey(env, replica)).toBe('chain:1');
    expect(getCurrentEntityJurisdictionName(env, null)).toBe('Fallback');
    expect(getCurrentEntityJurisdictionKey(env, null)).toBe('fallback');
  });

  test('resolves entity jurisdiction from replicas and gossip fallback', () => {
    const env = {
      state: { eReplicas: new Map([
        ['alice:signer', {
          entityId: 'alice',
          state: { entityId: 'alice', config: { jurisdiction: { chainId: 10 } } },
        }],
      ]) },
      gossip: {
        getProfiles: () => [
          { entityId: 'bob', metadata: { jurisdiction: { name: 'Remote J' } } },
        ],
      },
    } as any;

    expect(getEntityJurisdictionKey(env, 'ALICE')).toBe('chain:10');
    expect(getEntityJurisdictionKey(env, 'bob')).toBe('remote j');
    expect(getEntityJurisdictionKey(env, 'missing')).toBe('');
  });

  test('compares entity jurisdiction with current replica context', () => {
    const replica = {
      state: {
        entityId: 'alice',
        config: { jurisdiction: { chainId: 10 } },
      },
    } as any;
    const env = {
      state: { eReplicas: new Map([
        ['hub:signer', {
          entityId: 'hub',
          state: { entityId: 'hub', config: { jurisdiction: { chainId: 10 } } },
        }],
        ['remote:signer', {
          entityId: 'remote',
          state: { entityId: 'remote', config: { jurisdiction: { chainId: 20 } } },
        }],
      ]) },
    } as any;

    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'hub')).toBe(true);
    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'remote')).toBe(false);
    expect(isSameJurisdictionEntity(null, null, '', 'left', 'right')).toBe(true);
    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'unknown-hub')).toBe(true);
  });

  test('compares entity jurisdiction from projected replica maps without RuntimeReplica ownership', () => {
    const replica = {
      state: {
        entityId: 'alice',
        config: { jurisdiction: { chainId: 10 } },
      },
    } as any;
    const replicas = new Map([
      ['hub:signer', {
        entityId: 'hub',
        state: { entityId: 'hub', config: { jurisdiction: { chainId: 10 } } },
      }],
      ['remote:signer', {
        entityId: 'remote',
        state: { entityId: 'remote', config: { jurisdiction: { chainId: 20 } } },
      }],
    ]) as any;

    expect(getEntityJurisdictionKeyFromReplicas(replicas, 'HUB')).toBe('chain:10');
    expect(isSameJurisdictionEntityInReplicas(replicas, replica, 'alice', 'alice', 'hub')).toBe(true);
    expect(isSameJurisdictionEntityInReplicas(replicas, replica, 'alice', 'alice', 'remote')).toBe(false);
    expect(isSameJurisdictionEntityInReplicas(replicas, replica, 'alice', 'alice', 'unknown-hub')).toBe(true);
  });

  test('projects entity panel read model from env once at the model boundary', () => {
    const view = buildEntityPanelView({
      runtimeId: 'runtime-1',
      state: {
        height: 42,
        timestamp: 1234,
        eReplicas: new Map([
          ['alice:signer-a', {
            entityId: 'alice',
            state: { entityId: 'alice', accounts: new Map([['bob', {}]]) },
          }],
          ['h1:signer-h1', {
            entityId: 'h1',
            state: { entityId: 'h1', profile: { name: 'H1', isHub: true }, accounts: new Map() },
          }],
        ]),
        jReplicas: new Map([
          ['testnet', { name: 'Testnet', chainId: 31337 }],
        ]),
      },
      activeJurisdiction: 'Testnet',
      gossip: {
        getProfiles: () => [
          { entityId: 'alice', name: 'Alice', metadata: { isHub: false } },
        ],
      },
    } as any, 'ALICE', 'signer-a', 'rev-1');

    expect(view.runtimeId).toBe('runtime-1');
    expect(view.height).toBe(42);
    expect(view.timestamp).toBe(1234);
    expect(view.activeJurisdictionName).toBe('Testnet');
    expect(view.replica?.state?.entityId).toBe('alice');
    expect(view.replicas?.size).toBe(2);
    expect(view.profiles.map((profile) => profile.name)).toEqual(['Alice']);
    expect(view.entityNames.get('alice')).toBe('Alice');
    expect(view.entityNames.get('h1')).toBe('H1');
    expect(view.profileByEntityId.get('alice')?.name).toBe('Alice');
    expect(view.jurisdictions).toEqual([{ name: 'Testnet', chainId: 31337 }]);
    expect(view.isDevnet).toBe(true);
  });

  test('projects remote runtime view accounts into the entity account list model', () => {
    const entityId = '0xaaa';
    const signerId = '0xsigner';
    const hubOne = '0xh1';
    const hubTwo = '0xh2';
    const frame = {
      height: 77,
      head: { latestHeight: 77 },
      entities: [
        { entityId, signerId, label: 'B', height: 77, jurisdiction: { name: 'Testnet', chainId: 31337 } },
        { entityId: hubOne, label: 'H1', height: 77, isHub: true, jurisdiction: { name: 'Testnet', chainId: 31337 } },
        { entityId: hubTwo, label: 'H2', height: 77, isHub: true, jurisdiction: { name: 'Testnet', chainId: 31337 } },
      ],
      activeEntityId: entityId,
      activeEntity: {
        summary: { entityId, signerId, label: 'B', height: 77, jurisdiction: { name: 'Testnet', chainId: 31337 } },
        core: {
          entityId,
          signerId,
          height: 76,
          timestamp: 5678,
          profile: { name: 'B' },
          config: { jurisdiction: { name: 'Testnet', chainId: 31337 } },
          lockBook: new Map(),
          htlcRoutes: new Map(),
          htlcFeesEarned: 0n,
        },
        accounts: {
          items: [
            {
              state: {
                leftEntity: entityId,
                rightEntity: hubOne,
                deltas: new Map([[1, { offdelta: 10n }]]),
                locks: new Map(),
                swapOffers: new Map(),
                globalCreditLimits: new Map(),
                lastFinalizedJHeight: 3,
                requestedRebalance: new Map(),
                requestedRebalanceFeeState: new Map(),
                rebalancePolicy: new Map(),
              },
              status: 'open',
              currentHeight: 5,
              currentFrame: { height: 5, timestamp: 1000, outcome: [], accountTxs: [] },
              mempool: [],
              pendingSignatures: [],
              rollbackCount: 0,
              pendingWithdrawals: new Map(),
            },
            {
              state: {
                leftEntity: hubTwo,
                rightEntity: entityId,
                deltas: new Map([[1, { offdelta: -2n }]]),
                locks: new Map(),
                swapOffers: new Map(),
                globalCreditLimits: new Map(),
                lastFinalizedJHeight: 2,
                requestedRebalance: new Map(),
                requestedRebalanceFeeState: new Map(),
                rebalancePolicy: new Map(),
              },
              status: 'open',
              currentHeight: 4,
              currentFrame: { height: 4, timestamp: 900, outcome: [], accountTxs: [] },
              mempool: [],
              pendingSignatures: [],
              rollbackCount: 0,
              pendingWithdrawals: new Map(),
            },
          ],
          nextCursor: null,
          totalItems: 2,
          limit: 10,
          pageIndex: 0,
          pageCount: 1,
        },
        books: { items: [], nextCursor: null, totalItems: 0, limit: 10, pageIndex: 0, pageCount: 0 },
      },
    };

    const view = buildEntityPanelView(
      { runtimeId: 'remote-h2' } as any,
      entityId,
      signerId,
      'rev-remote',
      frame as never,
    );
    const accountPage = buildAccountPageView(view.replica, false, 0, '');

    expect(view.height).toBe(77);
    expect(view.timestamp).toBe(5678);
    expect(view.replica?.state?.accounts?.size).toBe(2);
    expect(view.replica?.state?.accounts?.get(hubOne)?.state.deltas.get(1)?.offdelta).toBe(10n);
    expect(view.replica?.state?.accounts?.get(hubTwo)?.state.deltas.get(1)?.offdelta).toBe(-2n);
    expect(view.entityNames.get(hubOne)).toBe('H1');
    expect(view.jurisdictions).toEqual([{ name: 'Testnet', chainId: 31337 }]);
    expect(view.isDevnet).toBe(true);
    expect(accountPage.entries.map((entry) => entry.counterpartyId)).toEqual([hubOne, hubTwo]);
  });

});
