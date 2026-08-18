import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import { toEntityId } from '../../../../protocol/identity';
import { compareStableText } from '../../../../protocol/serialization';
import { toUnixMs } from '../../../../protocol/units';
import { isJurisdictionStackRef } from '../../../../jurisdiction/machine/jurisdiction-stack';
import {
  PROFILE_ENTITY_KINDS,
  PROFILE_ENTITY_SECTORS,
  type ProfileEntityKind,
  type ProfileEntitySector,
} from '../../../../entity/profile';
import {
  ENTITY_SHARE_SUPPLY,
  MARKET_CAP_STALE_AFTER_MS,
  type EntityMarketCapEntry,
  type EntityMarketCapStatus,
  type EntityMarketPrice,
  type MarketCapToken,
} from './market-cap';

export type MarketCapSort = 'valuation' | 'control' | 'dividend' | 'number' | 'name' | 'recent';
export type MarketCapDirection = 'asc' | 'desc';
export type MarketCapRole = 'all' | 'hub' | 'non-hub';
export type MarketCapTaxonomyFilter<T extends string> = T | 'all' | 'unclassified';

export type MarketCapQuery = Readonly<{
  status: EntityMarketCapStatus | 'all';
  role: MarketCapRole;
  jurisdiction: string | 'all';
  entityKind: MarketCapTaxonomyFilter<ProfileEntityKind>;
  sector: MarketCapTaxonomyFilter<ProfileEntitySector>;
  sort: MarketCapSort;
  direction: MarketCapDirection;
  limit: number;
  query: string;
}>;

export type MarketCapJurisdictionRank = Readonly<{
  jurisdictionRef: string;
  entityCount: number;
  pricedEntityCount: number;
  freshEntityCount: number;
  marketCapUsdTicks: string;
}>;

export type MarketCapFacets = Readonly<{
  jurisdictionRefs: string[];
  entityKinds: ProfileEntityKind[];
  sectors: ProfileEntitySector[];
}>;

export type MarketCapPublicResponse = Readonly<{
  format: 'entity-market-cap';
  generatedAt: number;
  staleAfterMs: number;
  connectedHubCount: number;
  numberedEntityCount: number;
  freshCount: number;
  staleCount: number;
  noPriceCount: number;
  facets: MarketCapFacets;
  jurisdictionLeaders: MarketCapJurisdictionRank[];
  returned: number;
  entries: EntityMarketCapEntry[];
}>;

const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const requireDecimal = (value: unknown, code: string): string => {
  const text = requireString(value, code);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(code);
  return text;
};

export const decodeMarketCapTokens = (value: unknown): MarketCapToken[] => {
  const envelope = requireBoundaryRecord(value, 'MARKET_CAP_TOKENS_INVALID');
  requireExactBoundaryKeys(envelope, ['tokens'], [], 'MARKET_CAP_TOKENS_FIELDS_INVALID');
  if (!Array.isArray(envelope['tokens'])) throw new Error('MARKET_CAP_TOKENS_LIST_INVALID');
  const tokens = envelope['tokens'].map((candidate, index) => {
    const token = requireBoundaryRecord(candidate, `MARKET_CAP_TOKEN_INVALID:${index}`);
    requireExactBoundaryKeys(token, [
      'symbol', 'name', 'address', 'decimals', 'tokenId', 'tokenType', 'externalTokenId',
    ], [], `MARKET_CAP_TOKEN_FIELDS_INVALID:${index}`);
    const symbol = requireString(token['symbol'], `MARKET_CAP_TOKEN_SYMBOL_INVALID:${index}`);
    const name = requireString(token['name'], `MARKET_CAP_TOKEN_NAME_INVALID:${index}`);
    const address = requireString(token['address'], `MARKET_CAP_TOKEN_ADDRESS_INVALID:${index}`).toLowerCase();
    if (!symbol || !name || !/^0x[0-9a-f]{40}$/.test(address)) {
      throw new Error(`MARKET_CAP_TOKEN_TEXT_INVALID:${index}`);
    }
    const decimals = requireBoundaryInteger(token['decimals'], `MARKET_CAP_TOKEN_DECIMALS_INVALID:${index}`, 0);
    const tokenId = requireBoundaryInteger(token['tokenId'], `MARKET_CAP_TOKEN_ID_INVALID:${index}`, 1);
    const tokenTypeValue = requireBoundaryInteger(token['tokenType'], `MARKET_CAP_TOKEN_TYPE_INVALID:${index}`, 0);
    if (tokenTypeValue > 2 || typeof token['externalTokenId'] !== 'bigint' || token['externalTokenId'] < 0n) {
      throw new Error(`MARKET_CAP_TOKEN_KIND_INVALID:${index}`);
    }
    const tokenType: 0 | 1 | 2 = tokenTypeValue === 0 ? 0 : tokenTypeValue === 1 ? 1 : 2;
    return { symbol, name, address, decimals, tokenId, tokenType, externalTokenId: token['externalTokenId'] };
  });
  if (new Set(tokens.map(token => token.tokenId)).size !== tokens.length) {
    throw new Error('MARKET_CAP_TOKEN_ID_DUPLICATE');
  }
  return tokens;
};

export const decodeMarketCapQuery = (params: URLSearchParams): MarketCapQuery => {
  const allowedKeys = new Set(['status', 'role', 'jurisdiction', 'kind', 'sector', 'sort', 'direction', 'limit', 'q']);
  for (const key of params.keys()) {
    if (!allowedKeys.has(key) || params.getAll(key).length !== 1) throw new Error('MARKET_CAP_QUERY_FIELDS_INVALID');
  }
  const statusRaw = params.get('status') ?? 'all';
  const roleRaw = params.get('role') ?? 'all';
  const jurisdictionRaw = params.get('jurisdiction') ?? 'all';
  const kindRaw = params.get('kind') ?? 'all';
  const sectorRaw = params.get('sector') ?? 'all';
  const sortRaw = params.get('sort') ?? 'valuation';
  const directionRaw = params.get('direction') ?? 'desc';
  if (!['all', 'fresh', 'stale', 'no-price'].includes(statusRaw)) throw new Error('MARKET_CAP_QUERY_STATUS_INVALID');
  if (!['all', 'hub', 'non-hub'].includes(roleRaw)) throw new Error('MARKET_CAP_QUERY_ROLE_INVALID');
  if (jurisdictionRaw !== 'all' && (!isJurisdictionStackRef(jurisdictionRaw) || jurisdictionRaw.toLowerCase() !== jurisdictionRaw)) {
    throw new Error('MARKET_CAP_QUERY_JURISDICTION_INVALID');
  }
  if (!['all', 'unclassified', ...PROFILE_ENTITY_KINDS].includes(kindRaw as ProfileEntityKind)) {
    throw new Error('MARKET_CAP_QUERY_KIND_INVALID');
  }
  if (!['all', 'unclassified', ...PROFILE_ENTITY_SECTORS].includes(sectorRaw as ProfileEntitySector)) {
    throw new Error('MARKET_CAP_QUERY_SECTOR_INVALID');
  }
  if (!['valuation', 'control', 'dividend', 'number', 'name', 'recent'].includes(sortRaw)) throw new Error('MARKET_CAP_QUERY_SORT_INVALID');
  if (directionRaw !== 'asc' && directionRaw !== 'desc') throw new Error('MARKET_CAP_QUERY_DIRECTION_INVALID');
  const limitRaw = params.get('limit') ?? '100';
  if (!/^[1-9]\d*$/.test(limitRaw)) throw new Error('MARKET_CAP_QUERY_LIMIT_INVALID');
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new Error('MARKET_CAP_QUERY_LIMIT_INVALID');
  const query = (params.get('q') ?? '').trim().toLowerCase();
  if (query.length > 100) throw new Error('MARKET_CAP_QUERY_TEXT_INVALID');
  return {
    status: statusRaw as MarketCapQuery['status'],
    role: roleRaw as MarketCapRole,
    jurisdiction: jurisdictionRaw,
    entityKind: kindRaw as MarketCapQuery['entityKind'],
    sector: sectorRaw as MarketCapQuery['sector'],
    sort: sortRaw as MarketCapSort,
    direction: directionRaw,
    limit,
    query,
  };
};

const compareEntries = (left: EntityMarketCapEntry, right: EntityMarketCapEntry, sort: MarketCapSort): number => {
  if (sort === 'name') return compareStableText(left.name.toLowerCase(), right.name.toLowerCase());
  if (sort === 'number') {
    const a = BigInt(left.entityNumber);
    const b = BigInt(right.entityNumber);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (sort === 'recent') {
    const a = left.lastTradeObservedAt ?? -1;
    const b = right.lastTradeObservedAt ?? -1;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const value = (entry: EntityMarketCapEntry): bigint | null => {
    if (sort === 'control') return entry.control.priceTicks === null ? null : ENTITY_SHARE_SUPPLY * BigInt(entry.control.priceTicks);
    if (sort === 'dividend') return entry.dividend.priceTicks === null ? null : ENTITY_SHARE_SUPPLY * BigInt(entry.dividend.priceTicks);
    return entry.marketCapUsdTicks === null ? null : BigInt(entry.marketCapUsdTicks);
  };
  const a = value(left);
  const b = value(right);
  if (a === null && b !== null) return -1;
  if (a !== null && b === null) return 1;
  if (a !== null && b !== null && a !== b) return a < b ? -1 : 1;
  return 0;
};

export const selectMarketCapEntries = (
  entries: readonly EntityMarketCapEntry[],
  query: MarketCapQuery,
): EntityMarketCapEntry[] => entries
  .filter(entry => query.status === 'all' || entry.status === query.status)
  .filter(entry => query.role === 'all' || (query.role === 'hub' ? entry.isHub : !entry.isHub))
  .filter(entry => query.jurisdiction === 'all' || entry.jurisdictionRef === query.jurisdiction)
  .filter(entry => query.entityKind === 'all'
    || (query.entityKind === 'unclassified' ? entry.entityKind === null : entry.entityKind === query.entityKind))
  .filter(entry => query.sector === 'all'
    || (query.sector === 'unclassified' ? entry.sectors.length === 0 : entry.sectors.includes(query.sector)))
  .filter(entry => !query.query || `${entry.entityNumber} ${entry.name} ${entry.entityKind ?? ''} ${entry.sectors.join(' ')}`.toLowerCase().includes(query.query))
  .sort((left, right) => {
    const leftMissing = query.sort === 'control'
      ? left.control.priceTicks === null
      : query.sort === 'dividend'
        ? left.dividend.priceTicks === null
        : left.marketCapUsdTicks === null;
    const rightMissing = query.sort === 'control'
      ? right.control.priceTicks === null
      : query.sort === 'dividend'
        ? right.dividend.priceTicks === null
        : right.marketCapUsdTicks === null;
    if (['valuation', 'control', 'dividend'].includes(query.sort) && leftMissing !== rightMissing) {
      return leftMissing ? 1 : -1;
    }
    if (query.sort === 'recent' && (left.lastTradeObservedAt === null) !== (right.lastTradeObservedAt === null)) {
      return left.lastTradeObservedAt === null ? 1 : -1;
    }
    const compared = compareEntries(left, right, query.sort);
    const directed = query.direction === 'asc' ? compared : -compared;
    return directed || compareStableText(left.entityNumber, right.entityNumber);
  })
  .slice(0, query.limit);

export const buildMarketCapFacets = (entries: readonly EntityMarketCapEntry[]): MarketCapFacets => ({
  jurisdictionRefs: Array.from(new Set(entries.map(entry => entry.jurisdictionRef))).sort(compareStableText),
  entityKinds: Array.from(new Set(entries.flatMap(entry => entry.entityKind ? [entry.entityKind] : []))).sort(compareStableText),
  sectors: Array.from(new Set(entries.flatMap(entry => entry.sectors))).sort(compareStableText),
});

export const buildMarketCapJurisdictionLeaders = (
  entries: readonly EntityMarketCapEntry[],
): MarketCapJurisdictionRank[] => {
  const grouped = new Map<string, EntityMarketCapEntry[]>();
  for (const entry of entries) grouped.set(entry.jurisdictionRef, [...(grouped.get(entry.jurisdictionRef) ?? []), entry]);
  return Array.from(grouped, ([jurisdictionRef, scoped]) => ({
    jurisdictionRef,
    entityCount: scoped.length,
    pricedEntityCount: scoped.filter(entry => entry.marketCapUsdTicks !== null).length,
    freshEntityCount: scoped.filter(entry => entry.status === 'fresh').length,
    marketCapUsdTicks: scoped.reduce(
      (total, entry) => total + (entry.marketCapUsdTicks === null ? 0n : BigInt(entry.marketCapUsdTicks)),
      0n,
    ).toString(),
  })).sort((left, right) => {
    const a = BigInt(left.marketCapUsdTicks);
    const b = BigInt(right.marketCapUsdTicks);
    return (a === b ? 0 : a > b ? -1 : 1) || compareStableText(left.jurisdictionRef, right.jurisdictionRef);
  }).slice(0, 100);
};

const decodeMarketPrice = (value: unknown, shareClass: 'CONTROL' | 'DIVIDEND'): EntityMarketPrice => {
  const price = requireBoundaryRecord(value, `MARKET_CAP_${shareClass}_INVALID`);
  requireExactBoundaryKeys(price, [
    'shareClass', 'pairId', 'priceTicks', 'observedAt', 'sourceHubEntityIds',
  ], [], `MARKET_CAP_${shareClass}_FIELDS_INVALID`);
  if (price['shareClass'] !== shareClass) throw new Error(`MARKET_CAP_${shareClass}_CLASS_INVALID`);
  const pairId = price['pairId'] === null ? null : requireString(price['pairId'], `MARKET_CAP_${shareClass}_PAIR_INVALID`);
  const priceTicks = price['priceTicks'] === null ? null : requireDecimal(price['priceTicks'], `MARKET_CAP_${shareClass}_PRICE_INVALID`);
  const observedAt = price['observedAt'] === null
    ? null
    : toUnixMs(requireBoundaryInteger(price['observedAt'], `MARKET_CAP_${shareClass}_TIME_INVALID`, 0));
  if (!Array.isArray(price['sourceHubEntityIds'])) throw new Error(`MARKET_CAP_${shareClass}_SOURCES_INVALID`);
  const sourceHubEntityIds = price['sourceHubEntityIds'].map(value => toEntityId(requireString(value, `MARKET_CAP_${shareClass}_SOURCE_INVALID`)));
  if ((priceTicks === null) !== (observedAt === null)) throw new Error(`MARKET_CAP_${shareClass}_OBSERVATION_INVALID`);
  return { shareClass, pairId, priceTicks, observedAt, sourceHubEntityIds };
};

const decodeMarketCapEntry = (value: unknown): EntityMarketCapEntry => {
  const entry = requireBoundaryRecord(value, 'MARKET_CAP_ENTRY_INVALID');
  requireExactBoundaryKeys(entry, [
    'entityId', 'entityNumber', 'name', 'isHub', 'entityKind', 'sectors', 'online', 'jurisdictionRef', 'status',
    'control', 'dividend', 'marketCapUsdTicks', 'lastTradeObservedAt',
  ], [], 'MARKET_CAP_ENTRY_FIELDS_INVALID');
  const status = requireString(entry['status'], 'MARKET_CAP_ENTRY_STATUS_INVALID');
  if (!['fresh', 'stale', 'no-price'].includes(status)) throw new Error('MARKET_CAP_ENTRY_STATUS_INVALID');
  if (typeof entry['isHub'] !== 'boolean' || typeof entry['online'] !== 'boolean') throw new Error('MARKET_CAP_ENTRY_FLAGS_INVALID');
  const entityKindRaw = entry['entityKind'];
  if (entityKindRaw !== null && (typeof entityKindRaw !== 'string' || !PROFILE_ENTITY_KINDS.includes(entityKindRaw as ProfileEntityKind))) {
    throw new Error('MARKET_CAP_ENTRY_KIND_INVALID');
  }
  if (!Array.isArray(entry['sectors'])) throw new Error('MARKET_CAP_ENTRY_SECTORS_INVALID');
  const sectors = entry['sectors'].map(value => {
    if (typeof value !== 'string' || !PROFILE_ENTITY_SECTORS.includes(value as ProfileEntitySector)) {
      throw new Error('MARKET_CAP_ENTRY_SECTOR_INVALID');
    }
    return value as ProfileEntitySector;
  });
  if (new Set(sectors).size !== sectors.length || [...sectors].sort(compareStableText).some((value, index) => value !== sectors[index])) {
    throw new Error('MARKET_CAP_ENTRY_SECTORS_NONCANONICAL');
  }
  const control = decodeMarketPrice(entry['control'], 'CONTROL');
  const dividend = decodeMarketPrice(entry['dividend'], 'DIVIDEND');
  const cap = entry['marketCapUsdTicks'] === null ? null : requireDecimal(entry['marketCapUsdTicks'], 'MARKET_CAP_ENTRY_CAP_INVALID');
  const lastTradeObservedAt = entry['lastTradeObservedAt'] === null
    ? null
    : toUnixMs(requireBoundaryInteger(entry['lastTradeObservedAt'], 'MARKET_CAP_ENTRY_TIME_INVALID', 0));
  if ((status === 'no-price') !== (cap === null)) throw new Error('MARKET_CAP_ENTRY_CAP_STATUS_INVALID');
  if (control.priceTicks !== null && dividend.priceTicks !== null) {
    const expectedCap = ENTITY_SHARE_SUPPLY * (BigInt(control.priceTicks) + BigInt(dividend.priceTicks));
    if (cap !== expectedCap.toString()) throw new Error('MARKET_CAP_ENTRY_CAP_VALUE_INVALID');
  }
  const expectedLastTrade = control.observedAt !== null && dividend.observedAt !== null
    ? control.observedAt > dividend.observedAt ? control.observedAt : dividend.observedAt
    : null;
  if (lastTradeObservedAt !== expectedLastTrade) throw new Error('MARKET_CAP_ENTRY_LAST_TRADE_INVALID');
  const entityId = toEntityId(requireString(entry['entityId'], 'MARKET_CAP_ENTRY_ENTITY_INVALID'));
  const entityNumber = requireDecimal(entry['entityNumber'], 'MARKET_CAP_ENTRY_NUMBER_INVALID');
  if (BigInt(entityId) !== BigInt(entityNumber)) throw new Error('MARKET_CAP_ENTRY_NUMBER_MISMATCH');
  const jurisdictionRef = requireString(entry['jurisdictionRef'], 'MARKET_CAP_ENTRY_JURISDICTION_INVALID');
  if (!isJurisdictionStackRef(jurisdictionRef) || jurisdictionRef.toLowerCase() !== jurisdictionRef) {
    throw new Error('MARKET_CAP_ENTRY_JURISDICTION_INVALID');
  }
  return {
    entityId,
    entityNumber,
    name: requireString(entry['name'], 'MARKET_CAP_ENTRY_NAME_INVALID'),
    isHub: entry['isHub'],
    entityKind: entityKindRaw as ProfileEntityKind | null,
    sectors,
    online: entry['online'],
    jurisdictionRef,
    status: status as EntityMarketCapStatus,
    control,
    dividend,
    marketCapUsdTicks: cap,
    lastTradeObservedAt,
  };
};

export const decodeMarketCapPublicResponse = (value: unknown): MarketCapPublicResponse => {
  const response = requireBoundaryRecord(value, 'MARKET_CAP_RESPONSE_INVALID');
  requireExactBoundaryKeys(response, [
    'format', 'generatedAt', 'staleAfterMs', 'connectedHubCount', 'numberedEntityCount',
    'freshCount', 'staleCount', 'noPriceCount', 'facets', 'jurisdictionLeaders', 'returned', 'entries',
  ], [], 'MARKET_CAP_RESPONSE_FIELDS_INVALID');
  if (response['format'] !== 'entity-market-cap') throw new Error('MARKET_CAP_RESPONSE_FORMAT_INVALID');
  for (const key of [
    'generatedAt', 'connectedHubCount', 'numberedEntityCount', 'freshCount', 'staleCount', 'noPriceCount', 'returned',
  ] as const) requireBoundaryInteger(response[key], `MARKET_CAP_RESPONSE_${key}_INVALID`, 0);
  if (response['staleAfterMs'] !== MARKET_CAP_STALE_AFTER_MS) throw new Error('MARKET_CAP_RESPONSE_STALE_WINDOW_INVALID');
  if (!Array.isArray(response['entries']) || response['entries'].length !== response['returned']) {
    throw new Error('MARKET_CAP_RESPONSE_ENTRIES_INVALID');
  }
  const entries = response['entries'].map(decodeMarketCapEntry);
  const facetsRaw = requireBoundaryRecord(response['facets'], 'MARKET_CAP_RESPONSE_FACETS_INVALID');
  requireExactBoundaryKeys(facetsRaw, ['jurisdictionRefs', 'entityKinds', 'sectors'], [], 'MARKET_CAP_RESPONSE_FACETS_FIELDS_INVALID');
  if (!Array.isArray(facetsRaw['jurisdictionRefs']) || !Array.isArray(facetsRaw['entityKinds']) || !Array.isArray(facetsRaw['sectors'])) {
    throw new Error('MARKET_CAP_RESPONSE_FACETS_LIST_INVALID');
  }
  const jurisdictionRefs = facetsRaw['jurisdictionRefs'].map(value => {
    const ref = requireString(value, 'MARKET_CAP_RESPONSE_FACET_JURISDICTION_INVALID');
    if (!isJurisdictionStackRef(ref) || ref.toLowerCase() !== ref) throw new Error('MARKET_CAP_RESPONSE_FACET_JURISDICTION_INVALID');
    return ref;
  });
  const entityKinds = facetsRaw['entityKinds'].map(value => {
    if (typeof value !== 'string' || !PROFILE_ENTITY_KINDS.includes(value as ProfileEntityKind)) {
      throw new Error('MARKET_CAP_RESPONSE_FACET_KIND_INVALID');
    }
    return value as ProfileEntityKind;
  });
  const sectors = facetsRaw['sectors'].map(value => {
    if (typeof value !== 'string' || !PROFILE_ENTITY_SECTORS.includes(value as ProfileEntitySector)) {
      throw new Error('MARKET_CAP_RESPONSE_FACET_SECTOR_INVALID');
    }
    return value as ProfileEntitySector;
  });
  for (const list of [jurisdictionRefs, entityKinds, sectors]) {
    if (new Set(list).size !== list.length || [...list].sort(compareStableText).some((item, index) => item !== list[index])) {
      throw new Error('MARKET_CAP_RESPONSE_FACETS_NONCANONICAL');
    }
  }
  if (!Array.isArray(response['jurisdictionLeaders'])) throw new Error('MARKET_CAP_RESPONSE_JURISDICTIONS_INVALID');
  const jurisdictionLeaders = response['jurisdictionLeaders'].map((value, index) => {
    const rank = requireBoundaryRecord(value, `MARKET_CAP_RESPONSE_JURISDICTION_INVALID:${index}`);
    requireExactBoundaryKeys(rank, [
      'jurisdictionRef', 'entityCount', 'pricedEntityCount', 'freshEntityCount', 'marketCapUsdTicks',
    ], [], `MARKET_CAP_RESPONSE_JURISDICTION_FIELDS_INVALID:${index}`);
    const jurisdictionRef = requireString(rank['jurisdictionRef'], `MARKET_CAP_RESPONSE_JURISDICTION_REF_INVALID:${index}`);
    if (!isJurisdictionStackRef(jurisdictionRef) || jurisdictionRef.toLowerCase() !== jurisdictionRef) {
      throw new Error(`MARKET_CAP_RESPONSE_JURISDICTION_REF_INVALID:${index}`);
    }
    const entityCount = requireBoundaryInteger(rank['entityCount'], `MARKET_CAP_RESPONSE_JURISDICTION_ENTITY_COUNT_INVALID:${index}`, 0);
    const pricedEntityCount = requireBoundaryInteger(rank['pricedEntityCount'], `MARKET_CAP_RESPONSE_JURISDICTION_PRICED_COUNT_INVALID:${index}`, 0);
    const freshEntityCount = requireBoundaryInteger(rank['freshEntityCount'], `MARKET_CAP_RESPONSE_JURISDICTION_FRESH_COUNT_INVALID:${index}`, 0);
    if (pricedEntityCount > entityCount || freshEntityCount > pricedEntityCount) {
      throw new Error(`MARKET_CAP_RESPONSE_JURISDICTION_COUNTS_INVALID:${index}`);
    }
    return {
      jurisdictionRef,
      entityCount,
      pricedEntityCount,
      freshEntityCount,
      marketCapUsdTicks: requireDecimal(rank['marketCapUsdTicks'], `MARKET_CAP_RESPONSE_JURISDICTION_CAP_INVALID:${index}`),
    };
  });
  for (let index = 1; index < jurisdictionLeaders.length; index += 1) {
    const previous = jurisdictionLeaders[index - 1];
    const current = jurisdictionLeaders[index];
    if (!previous || !current) throw new Error('MARKET_CAP_RESPONSE_JURISDICTIONS_INVALID');
    if (BigInt(previous.marketCapUsdTicks) < BigInt(current.marketCapUsdTicks)) {
      throw new Error('MARKET_CAP_RESPONSE_JURISDICTIONS_NONCANONICAL');
    }
  }
  const generatedAt = Number(response['generatedAt']);
  for (const entry of entries) {
    const hasBoth = entry.control.observedAt !== null && entry.dividend.observedAt !== null;
    const stale = hasBoth && (
      entry.control.observedAt > generatedAt
      || entry.dividend.observedAt > generatedAt
      || generatedAt - entry.control.observedAt > MARKET_CAP_STALE_AFTER_MS
      || generatedAt - entry.dividend.observedAt > MARKET_CAP_STALE_AFTER_MS
    );
    const expectedStatus: EntityMarketCapStatus = !hasBoth ? 'no-price' : stale ? 'stale' : 'fresh';
    if (entry.status !== expectedStatus) throw new Error('MARKET_CAP_RESPONSE_ENTRY_STATUS_INVALID');
  }
  if (
    Number(response['freshCount']) + Number(response['staleCount']) + Number(response['noPriceCount'])
    !== Number(response['numberedEntityCount'])
  ) throw new Error('MARKET_CAP_RESPONSE_COUNTS_INVALID');
  return {
    ...response,
    facets: { jurisdictionRefs, entityKinds, sectors },
    jurisdictionLeaders,
    entries,
  } as MarketCapPublicResponse;
};
