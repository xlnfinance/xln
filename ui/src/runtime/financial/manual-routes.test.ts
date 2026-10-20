import { expect, test } from 'bun:test';
import {
  buildRoutedRouteCandidates,
  buildRoutedRoutePaths,
} from '@xln/frontend/lib/components/Entity/routed-swap-planner';
import {
  getDefaultSwapTradingPairs,
  getSwapPairOrientation,
  getTokenInfo,
  isLiquidSwapToken,
} from '@xln/core/account/utils';
import { crossBookMarket } from './cross-book';

const sourceStack = `stack:31337:0x${'11'.repeat(20)}`;
const targetStack = `stack:31338:0x${'22'.repeat(20)}`;
const sourceHub = `0x${'aa'.repeat(32)}`;
const targetHub = `0x${'bb'.repeat(32)}`;
const input = {
  mode: 'cross' as const,
  target: { targetHubEntityId: targetHub, targetJurisdiction: 'Tron', targetJurisdictionRef: targetStack },
  sourceHubId: sourceHub,
  sourceJurisdictionRef: sourceStack,
  sourceJurisdiction: 'Testnet',
  sourceToken: 3,
  targetToken: 3,
  allowedSwapTokenIds: [1, 2, 3],
  resolvePairOrientation: getSwapPairOrientation,
  tradingPairsForHub: getDefaultSwapTradingPairs,
  isLiquidToken: isLiquidSwapToken,
  tokenSymbol: (id: number) => getTokenInfo(id).symbol,
  compareStableText: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
};

test('manual USDT route uses same-J steps around the canonical USDC Cross venue without claiming a quote', () => {
  const paths = buildRoutedRoutePaths(input);
  const path = paths.find(candidate => candidate.bridgeTokenId === 1)!;
  expect(path.hops.map(hop => hop.kind)).toEqual(['same', 'cross', 'same']);
  expect(path.hops.map(hop => [hop.fromTokenId, hop.toTokenId])).toEqual([
    [3, 1],
    [1, 1],
    [1, 3],
  ]);
  expect(path.hops.map(hop => hop.sourceJurisdictionRef)).toEqual([sourceStack, sourceStack, targetStack]);
  const market = crossBookMarket(
    { jurisdiction: sourceStack, tokenId: 1, hubId: sourceHub },
    { jurisdiction: targetStack, tokenId: 1, hubId: targetHub },
  );
  expect(path.hops[1]!.pairId).toBe(market.pairId);
  expect(path.hops[1]!.bookHubId).toBe(market.hubId);
  expect(path).not.toHaveProperty('estimatedOutAmount');
  expect(path).not.toHaveProperty('liveHopCount');
  expect(new Set(paths.map(candidate => candidate.id)).size).toBe(paths.length);
});

test('unsupported same-J pairs do not invent a manual route', () => {
  const paths = buildRoutedRoutePaths({ ...input, tradingPairsForHub: () => [] });
  expect(paths.map(path => path.id)).toEqual(['direct-cross']);
  expect(paths.filter(path => path.hops.length > 1)).toHaveLength(0);
});

test('manual topology requires the actual cross destination and source stack', () => {
  expect(buildRoutedRoutePaths({ ...input, target: null })).toEqual([]);
  expect(buildRoutedRoutePaths({ ...input, sourceJurisdictionRef: '' })).toEqual([]);
  expect(buildRoutedRoutePaths({ ...input, mode: 'same' })).toEqual([]);
});

test('quoted API rejects invalid topology before reading metadata or attempting a quote', () => {
  const quoted = {
    ...input,
    quoteInputAmount: 1n,
    formatAmount: (amount: bigint) => amount.toString(),
    estimateHopOutput: () => {
      throw new Error('unexpected quote for invalid topology');
    },
  };
  expect(buildRoutedRouteCandidates({ ...quoted, mode: 'same', targetToken: 0 })).toEqual([]);
  expect(buildRoutedRouteCandidates({ ...quoted, sourceJurisdictionRef: '', targetToken: 0 })).toEqual([]);
  expect(buildRoutedRouteCandidates({ ...quoted, targetToken: 0 })).toEqual([]);
});
