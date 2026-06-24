import { describe, expect, test } from 'bun:test';

import {
  getCurrentEntityJurisdictionKey,
  getCurrentEntityJurisdictionName,
  getEntityJurisdictionKey,
  isSameJurisdictionEntity,
  jurisdictionKey,
} from '../../frontend/src/lib/components/Entity/entity-panel-model';

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
      eReplicas: new Map([
        ['alice:signer', {
          entityId: 'alice',
          state: { entityId: 'alice', config: { jurisdiction: { chainId: 10 } } },
        }],
      ]),
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
      eReplicas: new Map([
        ['hub:signer', {
          entityId: 'hub',
          state: { entityId: 'hub', config: { jurisdiction: { chainId: 10 } } },
        }],
        ['remote:signer', {
          entityId: 'remote',
          state: { entityId: 'remote', config: { jurisdiction: { chainId: 20 } } },
        }],
      ]),
    } as any;

    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'hub')).toBe(true);
    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'remote')).toBe(false);
    expect(isSameJurisdictionEntity({} as any, null, '', 'left', 'right')).toBe(true);
  });
});
