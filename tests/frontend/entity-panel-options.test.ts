import { describe, expect, test } from 'bun:test';

import {
  buildMoveEntityOptions,
  buildMoveSourceAccountOptions,
  buildOpenAccountEntityOptions,
  isFullEntityId,
} from '../../frontend/src/lib/components/Entity/entity-panel-options';

const id = (suffix: string): string => `0x${suffix.padStart(64, '0')}`;

describe('entity panel option helpers', () => {
  test('validates full entity ids strictly', () => {
    expect(isFullEntityId(id('a'))).toBe(true);
    expect(isFullEntityId(` ${id('b')} `)).toBe(true);
    expect(isFullEntityId('0xabc')).toBe(false);
    expect(isFullEntityId(`0x${'g'.repeat(64)}`)).toBe(false);
  });

  test('builds open-account options from replicas and profiles excluding self and existing accounts', () => {
    const self = id('1');
    const existing = id('2');
    const candidate = id('3');
    const profileOnly = id('4');
    const options = buildOpenAccountEntityOptions({
      replica: { state: { entityId: self } } as any,
      tabEntityId: self,
      accountIds: [existing],
      activeReplicas: new Map([
        [`${self}:signer`, {} as any],
        [`${existing}:signer`, {} as any],
        [`${candidate}:signer`, {} as any],
      ]),
      profiles: [
        { entityId: profileOnly },
        { entityId: 'not-a-full-id' },
      ] as any,
    });

    expect(options).toEqual([candidate, profileOnly].sort());
  });

  test('builds move entity options with stable first-seen ordering', () => {
    const self = id('1');
    const account = id('2');
    const openCandidate = id('3');
    const replicaCandidate = id('4');
    const profileCandidate = id('5');

    expect(buildMoveEntityOptions({
      replica: { state: { entityId: self } } as any,
      tabEntityId: self,
      accountIds: [account],
      openAccountEntityOptions: [openCandidate, account],
      activeReplicas: new Map([[`${replicaCandidate}:signer`, {} as any]]),
      profiles: [{ entityId: profileCandidate }] as any,
    })).toEqual([self, account, openCandidate, replicaCandidate, profileCandidate]);
  });

  test('builds move source account options preferring workspace order', () => {
    expect(buildMoveSourceAccountOptions({
      workspaceAccountIds: [' B ', 'a'],
      accountIds: ['a', 'c'],
    })).toEqual(['b', 'a', 'c']);
  });
});
