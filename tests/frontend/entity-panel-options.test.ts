import { describe, expect, test } from 'bun:test';

import {
  buildConfigureTokenOptions,
  buildMoveEntityOptions,
  buildMoveHubEntityOptions,
  buildMoveSourceAccountOptions,
  buildOpenAccountEntityOptions,
  isFullEntityId,
  normalizeWorkspaceAccountId,
  resolveConfigureTokenId,
  resolveMoveTargetHubEntityId,
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

  test('normalizes workspace account ids by existing casing', () => {
    expect(normalizeWorkspaceAccountId(' 0xabc ', ['0xABC', '0xDEF'])).toBe('0xABC');
    expect(normalizeWorkspaceAccountId(' xyz ', ['0xABC'])).toBe('xyz');
  });

  test('builds hub options from recipient profile and self workspace accounts', () => {
    const self = id('1');
    const hub = id('2');
    const profileHub = id('3');
    const remote = id('4');

    expect(buildMoveHubEntityOptions({
      targetEntityId: remote,
      selfEntityId: self,
      workspaceAccountIds: [hub],
      profiles: [
        { entityId: remote, accounts: [{ counterpartyId: profileHub }, { counterpartyId: 'bad' }] },
      ],
    })).toEqual([profileHub]);
    expect(buildMoveHubEntityOptions({
      targetEntityId: self,
      selfEntityId: self,
      workspaceAccountIds: [hub],
      profiles: [],
    })).toEqual([hub]);
  });

  test('resolves target hub unless manually overridden', () => {
    const first = id('1');
    const workspace = id('2');
    const stale = id('3');

    expect(resolveMoveTargetHubEntityId({
      currentTargetHubId: '',
      workspaceAccountId: workspace,
      options: [first],
      manualOverride: false,
    })).toBe(workspace);
    expect(resolveMoveTargetHubEntityId({
      currentTargetHubId: stale,
      workspaceAccountId: workspace,
      options: [first, workspace],
      manualOverride: false,
    })).toBe(workspace);
    expect(resolveMoveTargetHubEntityId({
      currentTargetHubId: stale,
      workspaceAccountId: workspace,
      options: [first],
      manualOverride: true,
    })).toBe(stale);
  });

  test('builds configure token options and preserves valid selection', () => {
    const tokenInfo = new Map([
      [1, { symbol: 'USDC' }],
      [2, { symbol: 'ETH' }],
      [3, { symbol: 'DAI' }],
      [9, { symbol: 'WBTC' }],
    ]);
    const options = buildConfigureTokenOptions({
      reserveTokenIds: [9, 'bad', 0],
      getTokenInfo: (tokenId) => tokenInfo.get(tokenId) || {},
      compareSymbols: (left, right) => left.localeCompare(right),
    });

    expect(options.map((option) => option.id)).toEqual([3, 2, 1, 9]);
    expect(resolveConfigureTokenId(9, options)).toBe(9);
    expect(resolveConfigureTokenId(7, options)).toBe(3);
  });
});
