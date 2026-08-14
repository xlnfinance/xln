import type {
  Profile,
  ProfileEntityKind,
  ProfileEntitySector,
} from '../../../../entity/profile';
import { getJurisdictionStackId } from '../../../../jurisdiction/machine/jurisdiction-stack';
import { toEntityId, type EntityId } from '../../../../protocol/identity';
import { compareStableText } from '../../../../protocol/serialization';
import {
  toUnixMs,
  toUsdMarketCapTicks,
  toUsdPriceTicks,
  type UnixMs,
  type UsdMarketCapTicks,
  type UsdPriceTicks,
} from '../../../../protocol/units';
import type { RelayMarketSnapshotPayload } from '../aggregate';

export const ENTITY_SHARE_SUPPLY = 100_000_000_000n;
export const ENTITY_DIVIDEND_CLASS_BIT = 1n << 255n;
export const MARKET_CAP_STALE_AFTER_MS = 5 * 60 * 1_000;

export type MarketCapToken = Readonly<{
  symbol: string;
  address: string;
  decimals: number;
  tokenId: number;
  tokenType: 0 | 1 | 2;
  externalTokenId: bigint;
}>;

export type MarketCapCatalog = Readonly<{
  jurisdictionRef: string;
  entityProviderAddress: string;
  tokens: readonly MarketCapToken[];
}>;

export type EntityShareMarketPair = Readonly<{
  entityNumber: bigint;
  controlPairId: string | null;
  dividendPairId: string | null;
}>;

export type EntityMarketPrice = Readonly<{
  shareClass: 'CONTROL' | 'DIVIDEND';
  pairId: string | null;
  priceTicks: string | null;
  observedAt: UnixMs | null;
  sourceHubEntityIds: EntityId[];
}>;

export type EntityMarketCapStatus = 'fresh' | 'stale' | 'no-price';

export type EntityMarketCapEntry = Readonly<{
  entityId: EntityId;
  entityNumber: string;
  name: string;
  isHub: boolean;
  entityKind: ProfileEntityKind | null;
  sectors: ProfileEntitySector[];
  online: boolean;
  jurisdictionRef: string;
  status: EntityMarketCapStatus;
  control: EntityMarketPrice;
  dividend: EntityMarketPrice;
  marketCapUsdTicks: string | null;
  lastTradeObservedAt: UnixMs | null;
}>;

const parseUsdPriceTicks = (value: string): UsdPriceTicks => {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`MARKET_CAP_PRICE_TICKS_INVALID:${value}`);
  return toUsdPriceTicks(BigInt(value));
};

const toMarketCapTicks = (control: UsdPriceTicks, dividend: UsdPriceTicks): UsdMarketCapTicks =>
  toUsdMarketCapTicks(ENTITY_SHARE_SUPPLY * (control + dividend));

const pairId = (left: number, right: number): string =>
  left < right ? `${left}/${right}` : `${right}/${left}`;

const numberedEntity = (profile: Profile): Readonly<{ entityId: EntityId; entityNumber: bigint }> | null => {
  let entityNumber: bigint;
  try {
    entityNumber = BigInt(profile.entityId);
  } catch {
    return null;
  }
  if (entityNumber <= 0n || entityNumber >= ENTITY_DIVIDEND_CLASS_BIT) return null;
  return { entityId: toEntityId(profile.entityId), entityNumber };
};

const profileJurisdictionRef = (profile: Profile): string => {
  const jurisdiction = profile.metadata.jurisdiction;
  if (!jurisdiction) return '';
  return getJurisdictionStackId({
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
  });
};

const shareToken = (
  tokens: readonly MarketCapToken[],
  entityProviderAddress: string,
  entityNumber: bigint,
  shareClass: 'CONTROL' | 'DIVIDEND',
): MarketCapToken | null => {
  const expectedExternalId = shareClass === 'CONTROL'
    ? entityNumber
    : entityNumber | ENTITY_DIVIDEND_CLASS_BIT;
  const expectedSymbol = `${shareClass}-${entityNumber.toString()}`;
  const provider = entityProviderAddress.toLowerCase();
  const matches = tokens.filter(token =>
    token.tokenType === 2
    && token.address.toLowerCase() === provider
    && token.externalTokenId === expectedExternalId
    && token.symbol === expectedSymbol
  );
  if (matches.length > 1) throw new Error(`MARKET_CAP_SHARE_TOKEN_AMBIGUOUS:${expectedSymbol}`);
  return matches[0] ?? null;
};

export const buildShareMarketPairs = (
  catalog: MarketCapCatalog,
  entityNumbers: readonly bigint[],
): Map<string, EntityShareMarketPair> => {
  const usdtTokens = catalog.tokens.filter(token =>
    token.symbol === 'USDT'
    && token.tokenType === 0
    && token.tokenId === 1
    && token.decimals === 6
  );
  if (usdtTokens.length > 1) throw new Error(`MARKET_CAP_USDT_AMBIGUOUS:${catalog.jurisdictionRef}`);
  const usdt = usdtTokens[0] ?? null;
  const pairs = new Map<string, EntityShareMarketPair>();
  for (const entityNumber of entityNumbers) {
    const control = shareToken(catalog.tokens, catalog.entityProviderAddress, entityNumber, 'CONTROL');
    const dividend = shareToken(catalog.tokens, catalog.entityProviderAddress, entityNumber, 'DIVIDEND');
    pairs.set(entityNumber.toString(), {
      entityNumber,
      controlPairId: usdt && control ? pairId(usdt.tokenId, control.tokenId) : null,
      dividendPairId: usdt && dividend ? pairId(usdt.tokenId, dividend.tokenId) : null,
    });
  }
  return pairs;
};

const marketPrice = (
  shareClass: 'CONTROL' | 'DIVIDEND',
  pair: string | null,
  market: RelayMarketSnapshotPayload | null,
): EntityMarketPrice => ({
  shareClass,
  pairId: pair,
  priceTicks: market?.lastTradePrice ?? null,
  observedAt: market?.lastTradeObservedAt === null || market?.lastTradeObservedAt === undefined
    ? null
    : toUnixMs(market.lastTradeObservedAt),
  sourceHubEntityIds: market
    && market.lastTradeHubEntityId
    ? [toEntityId(market.lastTradeHubEntityId)]
    : [],
});

const latestObservedAt = (control: EntityMarketPrice, dividend: EntityMarketPrice): UnixMs | null => {
  if (control.observedAt === null || dividend.observedAt === null) return null;
  return control.observedAt > dividend.observedAt ? control.observedAt : dividend.observedAt;
};

const sameSharePairs = (
  left: ReadonlyMap<string, EntityShareMarketPair>,
  right: ReadonlyMap<string, EntityShareMarketPair>,
): boolean => {
  if (left.size !== right.size) return false;
  for (const [entityNumber, pair] of left) {
    const candidate = right.get(entityNumber);
    if (
      !candidate
      || candidate.entityNumber !== pair.entityNumber
      || candidate.controlPairId !== pair.controlPairId
      || candidate.dividendPairId !== pair.dividendPairId
    ) return false;
  }
  return true;
};

export const buildEntityMarketCapEntries = (input: Readonly<{
  profiles: readonly Profile[];
  onlineRuntimeIds: ReadonlySet<string>;
  catalogs: readonly MarketCapCatalog[];
  markets: readonly RelayMarketSnapshotPayload[];
  now: UnixMs;
}>): EntityMarketCapEntry[] => {
  const numbered = input.profiles.flatMap(profile => {
    const identity = numberedEntity(profile);
    const jurisdictionRef = profileJurisdictionRef(profile);
    return identity && jurisdictionRef ? [{ profile, jurisdictionRef, ...identity }] : [];
  });
  if (new Set(numbered.map(entry => entry.entityId)).size !== numbered.length) {
    throw new Error('MARKET_CAP_ENTITY_DUPLICATE');
  }
  const entityNumbersByJurisdiction = new Map<string, bigint[]>();
  for (const entry of numbered) {
    const values = entityNumbersByJurisdiction.get(entry.jurisdictionRef) ?? [];
    values.push(entry.entityNumber);
    entityNumbersByJurisdiction.set(entry.jurisdictionRef, values);
  }
  const pairsByJurisdiction = new Map<string, Map<string, EntityShareMarketPair>>();
  const providerByJurisdiction = new Map<string, string>();
  for (const catalog of input.catalogs) {
    const values = entityNumbersByJurisdiction.get(catalog.jurisdictionRef) ?? [];
    const pairs = buildShareMarketPairs(catalog, values);
    const previous = pairsByJurisdiction.get(catalog.jurisdictionRef);
    const provider = catalog.entityProviderAddress.toLowerCase();
    const previousProvider = providerByJurisdiction.get(catalog.jurisdictionRef);
    if (previousProvider && previousProvider !== provider) {
      throw new Error(`MARKET_CAP_PROVIDER_DIVERGENCE:${catalog.jurisdictionRef}`);
    }
    if (previous && !sameSharePairs(previous, pairs)) {
      throw new Error(`MARKET_CAP_CATALOG_DIVERGENCE:${catalog.jurisdictionRef}`);
    }
    pairsByJurisdiction.set(catalog.jurisdictionRef, pairs);
    providerByJurisdiction.set(catalog.jurisdictionRef, provider);
  }
  const marketByKey = new Map<string, RelayMarketSnapshotPayload>();
  for (const market of input.markets) {
    const key = `${market.jurisdictionRef}:${market.pairId}`;
    if (marketByKey.has(key)) throw new Error(`MARKET_CAP_MARKET_DUPLICATE:${key}`);
    marketByKey.set(key, market);
  }
  return numbered.map(({ profile, entityId, entityNumber, jurisdictionRef }) => {
    const pairs = pairsByJurisdiction.get(jurisdictionRef)?.get(entityNumber.toString()) ?? null;
    const controlMarket = pairs?.controlPairId
      ? marketByKey.get(`${jurisdictionRef}:${pairs.controlPairId}`) ?? null
      : null;
    const dividendMarket = pairs?.dividendPairId
      ? marketByKey.get(`${jurisdictionRef}:${pairs.dividendPairId}`) ?? null
      : null;
    const control = marketPrice('CONTROL', pairs?.controlPairId ?? null, controlMarket);
    const dividend = marketPrice('DIVIDEND', pairs?.dividendPairId ?? null, dividendMarket);
    const lastTradeObservedAt = latestObservedAt(control, dividend);
    const hasBothPrices = control.priceTicks !== null && dividend.priceTicks !== null;
    const stale = hasBothPrices && (
      control.observedAt === null
      || dividend.observedAt === null
      || input.now - control.observedAt > MARKET_CAP_STALE_AFTER_MS
      || input.now - dividend.observedAt > MARKET_CAP_STALE_AFTER_MS
    );
    const status: EntityMarketCapStatus = !hasBothPrices ? 'no-price' : stale ? 'stale' : 'fresh';
    const marketCapUsdTicks = control.priceTicks !== null && dividend.priceTicks !== null
      ? toMarketCapTicks(parseUsdPriceTicks(control.priceTicks), parseUsdPriceTicks(dividend.priceTicks)).toString()
      : null;
    return {
      entityId,
      entityNumber: entityNumber.toString(),
      name: profile.name,
      isHub: profile.metadata.isHub,
      entityKind: profile.metadata.entityKind ?? null,
      sectors: [...(profile.metadata.sectors ?? [])],
      online: input.onlineRuntimeIds.has(profile.runtimeId.toLowerCase()),
      jurisdictionRef,
      status,
      control,
      dividend,
      marketCapUsdTicks,
      lastTradeObservedAt,
    };
  }).sort((left, right) => {
    const leftCap = left.marketCapUsdTicks === null ? null : BigInt(left.marketCapUsdTicks);
    const rightCap = right.marketCapUsdTicks === null ? null : BigInt(right.marketCapUsdTicks);
    if (left.status === 'fresh' && right.status !== 'fresh') return -1;
    if (right.status === 'fresh' && left.status !== 'fresh') return 1;
    if (leftCap !== null && rightCap !== null && leftCap !== rightCap) return leftCap > rightCap ? -1 : 1;
    return compareStableText(left.name, right.name) || compareStableText(left.entityNumber, right.entityNumber);
  });
};
