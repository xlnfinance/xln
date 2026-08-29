import {
  isProfileEntityKind,
  isProfileEntitySector,
  type ProfileEntityKind,
  type ProfileEntitySector,
} from '@xln/core/entity/profile';
import {
  ENTITY_SHARE_SUPPLY,
  type EntityMarketCapEntry,
  type EntityMarketCapStatus,
} from '@xln/core/network/relay/market/cap/market-cap';
import {
  decodeMarketCapPublicResponse,
  type MarketCapDirection,
  type MarketCapPublicResponse,
  type MarketCapRole,
  type MarketCapSort,
  type MarketCapTaxonomyFilter,
} from '@xln/core/network/relay/market/cap/market-cap-wire';
import { readJsonUnknown } from '$lib/utils/boundary';

export type MarketCapRanking = 'overall' | 'hubs' | 'control' | 'dividend' | 'jurisdictions';

export type MarketCapControls = Readonly<{
  status: EntityMarketCapStatus | 'all';
  role: MarketCapRole;
  jurisdiction: string | 'all';
  entityKind: MarketCapTaxonomyFilter<ProfileEntityKind>;
  sector: MarketCapTaxonomyFilter<ProfileEntitySector>;
  sort: MarketCapSort;
  direction: MarketCapDirection;
}>;

export type MarketCapRequest = MarketCapControls & Readonly<{ query: string }>;
export type MarketCapControlKey = keyof MarketCapControls;
export type MarketCapFetcher = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_MARKET_CAP_CONTROLS: MarketCapControls = {
  status: 'all',
  role: 'all',
  jurisdiction: 'all',
  entityKind: 'all',
  sector: 'all',
  sort: 'valuation',
  direction: 'desc',
};

export const MARKET_CAP_RANKINGS = [
  { id: 'overall', label: 'Top Entities' },
  { id: 'hubs', label: 'Top Hubs' },
  { id: 'control', label: 'Top CONTROL' },
  { id: 'dividend', label: 'Top DIVIDEND' },
  { id: 'jurisdictions', label: 'Top Jurisdictions' },
] as const satisfies readonly Readonly<{ id: MarketCapRanking; label: string }>[];

const requireChoice = <T extends string>(value: string, choices: readonly T[], code: string): T => {
  const selected = choices.find((choice) => choice === value);
  if (!selected) throw new Error(`${code}:${value}`);
  return selected;
};

export const updateMarketCapControl = (
  controls: MarketCapControls,
  key: MarketCapControlKey,
  value: string,
  jurisdictionRefs: readonly string[],
): MarketCapControls => {
  if (key === 'status') return { ...controls, status: requireChoice(value, ['all', 'fresh', 'stale', 'no-price'], 'MARKET_CAP_STATUS_FILTER_INVALID') };
  if (key === 'role') return { ...controls, role: requireChoice(value, ['all', 'hub', 'non-hub'], 'MARKET_CAP_ROLE_FILTER_INVALID') };
  if (key === 'jurisdiction') return { ...controls, jurisdiction: requireChoice(value, ['all', ...jurisdictionRefs], 'MARKET_CAP_JURISDICTION_FILTER_INVALID') };
  if (key === 'entityKind') {
    if (value !== 'all' && value !== 'unclassified' && !isProfileEntityKind(value)) throw new Error(`MARKET_CAP_KIND_FILTER_INVALID:${value}`);
    return { ...controls, entityKind: value };
  }
  if (key === 'sector') {
    if (value !== 'all' && value !== 'unclassified' && !isProfileEntitySector(value)) throw new Error(`MARKET_CAP_SECTOR_FILTER_INVALID:${value}`);
    return { ...controls, sector: value };
  }
  if (key === 'sort') return { ...controls, sort: requireChoice(value, ['valuation', 'control', 'dividend', 'number', 'name', 'recent'], 'MARKET_CAP_SORT_FILTER_INVALID') };
  return { ...controls, direction: requireChoice(value, ['asc', 'desc'], 'MARKET_CAP_DIRECTION_FILTER_INVALID') };
};

export const controlsForMarketCapRanking = (ranking: MarketCapRanking): MarketCapControls | null => {
  if (ranking === 'jurisdictions') return null;
  return {
    ...DEFAULT_MARKET_CAP_CONTROLS,
    role: ranking === 'hubs' ? 'hub' : 'all',
    sort: ranking === 'control' ? 'control' : ranking === 'dividend' ? 'dividend' : 'valuation',
  };
};

export const createMarketCapRequestUrl = (request: MarketCapRequest): string => {
  const params = new URLSearchParams({
    status: request.status,
    role: request.role,
    jurisdiction: request.jurisdiction,
    kind: request.entityKind,
    sector: request.sector,
    sort: request.sort,
    direction: request.direction,
    limit: '100',
  });
  if (request.query.trim()) params.set('q', request.query.trim());
  return `/api/market-cap?${params.toString()}`;
};

const defaultFetcher: MarketCapFetcher = (input, init) => fetch(input, init);

export const fetchMarketCapResponse = async (
  request: MarketCapRequest,
  options: Readonly<{ fetcher?: MarketCapFetcher; signal?: AbortSignal }> = {},
): Promise<MarketCapPublicResponse> => {
  const fetcher = options.fetcher ?? defaultFetcher;
  const init: RequestInit = options.signal ? { cache: 'no-store', signal: options.signal } : { cache: 'no-store' };
  const response = await fetcher(createMarketCapRequestUrl(request), init);
  const payload = await readJsonUnknown(response);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return decodeMarketCapPublicResponse(payload);
};

export const marketCapStatusLabel = (value: EntityMarketCapStatus): string =>
  value === 'fresh' ? 'Live' : value === 'stale' ? 'Stale' : 'No price';

export const titleCaseMarketCapValue = (value: string): string =>
  value.split('-').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');

export const marketCapJurisdictionLabel = (value: string): string => {
  const [, chainId, address] = value.split(':');
  return `Chain ${chainId} · ${address?.slice(0, 6)}…${address?.slice(-4)}`;
};

export const formatMarketCapUsd = (value: string | null): string => {
  if (value === null) return '—';
  const dollars = BigInt(value) / 10_000n;
  const units = [
    { threshold: 1_000_000_000_000n, divisor: 1_000_000_000_000n, suffix: 'T' },
    { threshold: 1_000_000_000n, divisor: 1_000_000_000n, suffix: 'B' },
    { threshold: 1_000_000n, divisor: 1_000_000n, suffix: 'M' },
    { threshold: 1_000n, divisor: 1_000n, suffix: 'K' },
  ];
  const unit = units.find((candidate) => dollars >= candidate.threshold);
  if (!unit) return `$${dollars.toString()}`;
  const tenths = (dollars * 10n) / unit.divisor;
  return `$${tenths / 10n}.${tenths % 10n}${unit.suffix}`;
};

export const formatMarketCapPrice = (value: string | null): string => value === null
  ? 'No trade'
  : `$${BigInt(value) / 10_000n}.${(BigInt(value) % 10_000n).toString().padStart(4, '0')}`;

export const marketCapAgeLabel = (entry: EntityMarketCapEntry, generatedAt: number): string => {
  if (entry.control.observedAt === null || entry.dividend.observedAt === null) return 'Awaiting both trades';
  const seconds = Math.max(0, Math.floor((generatedAt - Math.min(entry.control.observedAt, entry.dividend.observedAt)) / 1_000));
  return seconds < 60 ? `Oldest price · ${seconds}s` : `Oldest price · ${Math.floor(seconds / 60)}m`;
};

export const marketCapRankingValue = (entry: EntityMarketCapEntry, sort: MarketCapSort): string | null => {
  if (sort === 'control') return entry.control.priceTicks === null ? null : (ENTITY_SHARE_SUPPLY * BigInt(entry.control.priceTicks)).toString();
  if (sort === 'dividend') return entry.dividend.priceTicks === null ? null : (ENTITY_SHARE_SUPPLY * BigInt(entry.dividend.priceTicks)).toString();
  return entry.marketCapUsdTicks;
};

export const marketCapRankingLabel = (entry: EntityMarketCapEntry, sort: MarketCapSort): string =>
  `${sort === 'control' ? 'CONTROL cap · ' : sort === 'dividend' ? 'DIVIDEND cap · ' : ''}${marketCapStatusLabel(entry.status)}`;
