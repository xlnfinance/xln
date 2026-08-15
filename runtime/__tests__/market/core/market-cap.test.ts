import { expect, test } from 'bun:test';

import type { Profile } from '../../../entity/profile';
import type { RelayMarketSnapshotPayload } from '../../../network/relay/market/aggregate';
import {
  ENTITY_DIVIDEND_CLASS_BIT,
  buildEntityMarketCapEntries,
  type MarketCapCatalog,
} from '../../../network/relay/market/cap/market-cap';
import {
  buildMarketCapFacets,
  buildMarketCapJurisdictionLeaders,
  decodeMarketCapQuery,
  selectMarketCapEntries,
} from '../../../network/relay/market/cap/market-cap-wire';
import { toUnixMs } from '../../../protocol/units';

const jurisdictionRef = `stack:1:0x${'c'.repeat(40)}`;
const provider = `0x${'d'.repeat(40)}`;
const hubEntityId = `0x${'1'.repeat(64)}`;
const numberedEntityId = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;

const profile = (entityId: string, name: string): Profile => ({
  entityId,
  entityEncryptionPublicKey: '',
  name,
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  runtimeId: `0x${'2'.repeat(40)}`,
  runtimeEncPubKey: '',
  publicAccounts: [],
  wsUrl: null,
  relays: [],
  metadata: {
    isHub: BigInt(entityId) === 7n,
    entityKind: 'company',
    sectors: ['finance', 'technology'],
    routingFeePPM: 1,
    baseFee: 0n,
    jurisdiction: {
      name: 'Test',
      chainId: 1,
      depositoryAddress: `0x${'c'.repeat(40)}`,
      entityProviderAddress: provider,
    },
  },
  accounts: [],
});

const catalog: MarketCapCatalog = {
  jurisdictionRef,
  entityProviderAddress: provider,
  tokens: [
    { symbol: 'USDT', address: `0x${'a'.repeat(40)}`, decimals: 6, tokenId: 1, tokenType: 0, externalTokenId: 1n },
    { symbol: 'CONTROL-7', address: provider, decimals: 0, tokenId: 2, tokenType: 2, externalTokenId: 7n },
    {
      symbol: 'DIVIDEND-7',
      address: provider,
      decimals: 0,
      tokenId: 3,
      tokenType: 2,
      externalTokenId: ENTITY_DIVIDEND_CLASS_BIT | 7n,
    },
  ],
};

const market = (pairId: string, price: string, observedAt: number): RelayMarketSnapshotPayload => ({
  format: 'exact-price-levels',
  pairId,
  jurisdictionRef,
  depth: 1,
  displayDecimals: 4,
  priceScale: '10000',
  bids: [],
  asks: [],
  spread: null,
  spreadPercent: '-',
  lastTradePrice: price,
  lastTradeObservedAt: observedAt,
  lastTradeHubEntityId: hubEntityId,
  source: 'relayAggregate',
  sourceCount: 1,
  sources: [{
    hubEntityId,
    jurisdictionRef,
    entityHeight: 1,
    entityStateHash: null,
    hubUpdatedAt: observedAt,
    snapshotUpdatedAt: observedAt,
    tradeCount: 1,
    lastTradePrice: price,
  }],
  updatedAt: observedAt,
});

test('market cap requires CONTROL and DIVIDEND and marks relay-observed prices stale after five minutes', () => {
  const now = 1_000_000;
  const fresh = buildEntityMarketCapEntries({
    profiles: [profile(numberedEntityId(7), 'Seven')],
    onlineRuntimeIds: new Set(),
    catalogs: [catalog],
    markets: [market('1/2', '10000', now), market('1/3', '5000', now)],
    now: toUnixMs(now),
  });
  expect(fresh[0]).toMatchObject({
    entityNumber: '7',
    status: 'fresh',
    marketCapUsdTicks: '1500000000000000',
    control: { shareClass: 'CONTROL', priceTicks: '10000' },
    dividend: { shareClass: 'DIVIDEND', priceTicks: '5000' },
  });

  const stale = buildEntityMarketCapEntries({
    profiles: [profile(numberedEntityId(7), 'Seven')],
    onlineRuntimeIds: new Set(),
    catalogs: [catalog],
    markets: [market('1/2', '10000', now - 300_001), market('1/3', '5000', now)],
    now: toUnixMs(now),
  });
  expect(stale[0]?.status).toBe('stale');

  const missing = buildEntityMarketCapEntries({
    profiles: [profile(numberedEntityId(7), 'Seven')],
    onlineRuntimeIds: new Set(),
    catalogs: [catalog],
    markets: [market('1/2', '10000', now)],
    now: toUnixMs(now),
  });
  expect(missing[0]).toMatchObject({ status: 'no-price', marketCapUsdTicks: null });
});

test('rejects catalogs that assign the same USDT tokenId to different contracts', () => {
  const divergentCatalog: MarketCapCatalog = {
    ...catalog,
    tokens: catalog.tokens.map(token => token.symbol === 'USDT'
      ? { ...token, address: `0x${'b'.repeat(40)}` }
      : token),
  };
  expect(() => buildEntityMarketCapEntries({
    profiles: [profile(numberedEntityId(7), 'Seven')],
    onlineRuntimeIds: new Set(),
    catalogs: [catalog, divergentCatalog],
    markets: [],
    now: toUnixMs(1_000),
  })).toThrow(`MARKET_CAP_CATALOG_DIVERGENCE:${jurisdictionRef}`);
});

test('top list query is exact, capped at 100, and supports canonical profile facets', () => {
  const params = new URLSearchParams(`status=fresh&role=hub&jurisdiction=${jurisdictionRef}&kind=company&sector=technology&sort=control&direction=desc&limit=10&q=seven`);
  const query = decodeMarketCapQuery(params);
  const entries = buildEntityMarketCapEntries({
    profiles: [profile(numberedEntityId(7), 'Seven')],
    onlineRuntimeIds: new Set(),
    catalogs: [catalog],
    markets: [market('1/2', '10000', 1_000), market('1/3', '5000', 1_000)],
    now: toUnixMs(1_000),
  });
  expect(selectMarketCapEntries(entries, query).map(entry => entry.entityNumber)).toEqual(['7']);
  expect(buildMarketCapFacets(entries)).toEqual({
    jurisdictionRefs: [jurisdictionRef],
    entityKinds: ['company'],
    sectors: ['finance', 'technology'],
  });
  expect(buildMarketCapJurisdictionLeaders(entries)).toEqual([{
    jurisdictionRef,
    entityCount: 1,
    pricedEntityCount: 1,
    freshEntityCount: 1,
    marketCapUsdTicks: '1500000000000000',
  }]);
  expect(() => decodeMarketCapQuery(new URLSearchParams('limit=101'))).toThrow('MARKET_CAP_QUERY_LIMIT_INVALID');
  expect(() => decodeMarketCapQuery(new URLSearchParams('sort=unknown'))).toThrow('MARKET_CAP_QUERY_SORT_INVALID');
  expect(() => decodeMarketCapQuery(new URLSearchParams('sector=technology&sector=finance'))).toThrow('MARKET_CAP_QUERY_FIELDS_INVALID');
});
