import { describe, expect, test } from 'bun:test';

import {
  crossOrderbookPairLabel,
  entityInitials,
  firstAvailableHubId,
  formatEntityNetworkLabel,
  getTokenMapValue,
  jurisdictionBadgeText,
  normalizeJurisdictionDisplayName,
  nonNegative,
  parseCrossAssetKey,
  resolveHubIdCandidate,
  sameOrderbookPairLabel,
  tokenNetworkLabel,
} from '../../frontend/src/lib/components/Entity/swap-panel-helpers';

const tokenSymbol = (tokenId: number): string => {
  if (tokenId === 1) return 'WETH';
  if (tokenId === 2) return 'USDC';
  return `T${tokenId}`;
};

describe('swap panel helpers', () => {
  test('normalizes dev jurisdiction labels and strips repeated suffixes', () => {
    expect(normalizeJurisdictionDisplayName('arrakis')).toBe('Testnet');
    expect(normalizeJurisdictionDisplayName('Arrakis (shared anvil)')).toBe('Testnet');
    expect(normalizeJurisdictionDisplayName('Wakanda')).toBe('Testnet');
    expect(normalizeJurisdictionDisplayName('Base Sepolia')).toBe('Base Sepolia');

    expect(formatEntityNetworkLabel('Hub Alpha (Testnet)', 'arrakis')).toBe('Hub Alpha (Testnet)');
    expect(formatEntityNetworkLabel('Hub Alpha Testnet', 'Testnet')).toBe('Hub Alpha (Testnet)');
    expect(formatEntityNetworkLabel('', '')).toBe('Unknown');
  });

  test('resolves known and advertised hub candidates deterministically', () => {
    const knownHubIds = ['0xHubA', '0xHubB'];
    const advertised = new Set(['0xhubc']);
    const isHub = (entityId: string): boolean => advertised.has(entityId.toLowerCase());

    expect(resolveHubIdCandidate(' 0xhuba ', knownHubIds, isHub)).toBe('0xHubA');
    expect(resolveHubIdCandidate('0xHubC', knownHubIds, isHub)).toBe('0xhubc');
    expect(resolveHubIdCandidate('0xUnknown', knownHubIds, isHub)).toBe('');
    expect(firstAvailableHubId(knownHubIds, ['0xUnknown', '0xHubC'], isHub)).toBe('0xhubc');
    expect(firstAvailableHubId(knownHubIds, ['0xUnknown'], isHub)).toBe('0xHubA');
  });

  test('parses cross-asset keys and formats pair labels with injected symbols', () => {
    expect(parseCrossAssetKey('chain-a:2')).toEqual({ jurisdictionRef: 'chain-a', tokenId: 2 });
    expect(parseCrossAssetKey('chain-a:0')).toBeNull();
    expect(parseCrossAssetKey(':2')).toBeNull();
    expect(parseCrossAssetKey('chain-a:two')).toBeNull();

    expect(tokenNetworkLabel(1, 'wakanda', tokenSymbol)).toBe('WETH (Testnet)');
    expect(sameOrderbookPairLabel(1, 2, 'Base Sepolia', tokenSymbol)).toBe('WETH-USDC (Base Sepolia)');
    expect(crossOrderbookPairLabel(1, 'arrakis', 2, 'Base Sepolia', tokenSymbol)).toBe('WETH (Testnet) - USDC (Base Sepolia)');
  });

  test('formats compact identity markers and token maps', () => {
    expect(entityInitials('0xabcdef', 'Grace Tron')).toBe('GR');
    expect(entityInitials('0xabcdef')).toBe('0X');
    expect(jurisdictionBadgeText('Base Sepolia')).toBe('BS');
    expect(jurisdictionBadgeText('arrakis')).toBe('TE');
    expect(jurisdictionBadgeText('')).toBe('J');

    expect(getTokenMapValue(new Map<number, string>([[1, 'number-key']]), 1)).toBe('number-key');
    expect(getTokenMapValue(new Map<string, string>([['2', 'string-key']]), 2)).toBe('string-key');
    expect(getTokenMapValue(undefined, 2)).toBeUndefined();
    expect(nonNegative(-1n)).toBe(0n);
    expect(nonNegative(2n)).toBe(2n);
  });
});
