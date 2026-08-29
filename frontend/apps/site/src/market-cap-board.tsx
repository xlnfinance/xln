import type { MarketCapPublicResponse } from '@xln/core/network/relay/market/cap/market-cap-wire';

import {
  formatMarketCapPrice,
  formatMarketCapUsd,
  marketCapAgeLabel,
  marketCapJurisdictionLabel,
  marketCapStatusLabel,
  titleCaseMarketCapValue,
  type MarketCapControlKey,
  type MarketCapControls,
} from '$lib/market-cap/market-cap-page-model';

type SelectOption = Readonly<{ value: string; label: string }>;

type MarketCapBoardProps = Readonly<{
  data: MarketCapPublicResponse | null;
  loading: boolean;
  error: string;
  controls: MarketCapControls;
  query: string;
  onQueryChange: (value: string) => void;
  onControlChange: (key: MarketCapControlKey, value: string) => void;
  onReverseDirection: () => void;
  onReload: () => void;
}>;

const ROLE_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'All Entities' },
  { value: 'hub', label: 'Hubs only' },
  { value: 'non-hub', label: 'Non-hubs' },
];
const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'All states' },
  { value: 'fresh', label: 'Live' },
  { value: 'stale', label: 'Stale' },
  { value: 'no-price', label: 'No price' },
];
const SORT_OPTIONS: readonly SelectOption[] = [
  { value: 'valuation', label: 'Combined cap' },
  { value: 'control', label: 'CONTROL cap' },
  { value: 'dividend', label: 'DIVIDEND cap' },
  { value: 'number', label: 'Entity number' },
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Last trade' },
];

function SelectFilter({ label, value, options, onChange }: Readonly<{
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
}>) {
  return (
    <label className="market-filter">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function MarketFilters({ data, controls, query, onQueryChange, onControlChange, onReverseDirection }: Omit<MarketCapBoardProps, 'error' | 'loading' | 'onReload'>) {
  const jurisdictions = [
    { value: 'all', label: 'All jurisdictions' },
    ...(data?.facets.jurisdictionRefs ?? []).map((value) => ({ value, label: marketCapJurisdictionLabel(value) })),
  ];
  const kinds = [
    { value: 'all', label: 'All kinds' },
    { value: 'unclassified', label: 'Unclassified' },
    ...(data?.facets.entityKinds ?? []).map((value) => ({ value, label: titleCaseMarketCapValue(value) })),
  ];
  const sectors = [
    { value: 'all', label: 'All sectors' },
    { value: 'unclassified', label: 'Unclassified' },
    ...(data?.facets.sectors ?? []).map((value) => ({ value, label: titleCaseMarketCapValue(value) })),
  ];
  return (
    <div className="market-filters">
      <label className="market-filter market-search"><span>Search</span><input aria-label="Search Entities" placeholder="Entity name or number" value={query} onChange={(event) => onQueryChange(event.currentTarget.value)} /></label>
      <SelectFilter label="Role" value={controls.role} options={ROLE_OPTIONS} onChange={(value) => onControlChange('role', value)} />
      <SelectFilter label="Jurisdiction" value={controls.jurisdiction} options={jurisdictions} onChange={(value) => onControlChange('jurisdiction', value)} />
      <SelectFilter label="Entity kind" value={controls.entityKind} options={kinds} onChange={(value) => onControlChange('entityKind', value)} />
      <SelectFilter label="Sector" value={controls.sector} options={sectors} onChange={(value) => onControlChange('sector', value)} />
      <SelectFilter label="Status" value={controls.status} options={STATUS_OPTIONS} onChange={(value) => onControlChange('status', value)} />
      <SelectFilter label="Sort by" value={controls.sort} options={SORT_OPTIONS} onChange={(value) => onControlChange('sort', value)} />
      <button className="market-direction" type="button" aria-label="Reverse sort direction" onClick={onReverseDirection}>{controls.direction === 'desc' ? '↓ High to low' : '↑ Low to high'}</button>
    </div>
  );
}

function MarketTable({ data }: Readonly<{ data: MarketCapPublicResponse }>) {
  return (
    <div className="market-table-wrap">
      <table>
        <thead><tr><th>Rank</th><th>Entity</th><th>CONTROL</th><th>DIVIDEND</th><th>Combined cap</th><th>Price state</th></tr></thead>
        <tbody>{data.entries.map((entry, index) => (
          <tr key={entry.entityId}>
            <td className="market-rank">{String(index + 1).padStart(2, '0')}</td>
            <td><div className="market-entity"><i className={entry.online ? 'is-online' : undefined} /><div><strong>{entry.name}</strong><span>#{entry.entityNumber}{entry.isHub ? ' · Hub' : ''}{entry.entityKind ? ` · ${titleCaseMarketCapValue(entry.entityKind)}` : ''}</span>{entry.sectors.length ? <small>{entry.sectors.map(titleCaseMarketCapValue).join(' · ')}</small> : null}</div></div></td>
            <td><div className="market-price"><strong>{formatMarketCapPrice(entry.control.priceTicks)}</strong><span>{entry.control.sourceHubEntityIds.length} source Hub</span></div></td>
            <td><div className="market-price"><strong>{formatMarketCapPrice(entry.dividend.priceTicks)}</strong><span>{entry.dividend.sourceHubEntityIds.length} source Hub</span></div></td>
            <td className="market-cap-value"><strong>{formatMarketCapUsd(entry.marketCapUsdTicks)}</strong><span>CONTROL + DIVIDEND</span></td>
            <td><div className={`market-price-status is-${entry.status}`}>{marketCapStatusLabel(entry.status)}</div><small className="market-age">{marketCapAgeLabel(entry, data.generatedAt)}</small></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function MarketResult({ data, loading, error, onReload }: Pick<MarketCapBoardProps, 'data' | 'loading' | 'error' | 'onReload'>) {
  if (loading && !data) return <div className="market-state"><div className="market-loader" /><strong>Reading verified relay markets</strong><span>Combining CONTROL and DIVIDEND across every connected Hub.</span></div>;
  if (error) return <div className="market-state is-error" role="alert"><b>!</b><strong>Live valuation is unavailable</strong><span>{error}</span><button type="button" onClick={onReload}>Try again</button></div>;
  if (data && data.entries.length === 0) return <div className="market-state"><b>○</b><strong>No Entities match this view</strong><span>Change a filter. Missing prices are never replaced with estimates.</span></div>;
  return data ? <MarketTable data={data} /> : null;
}

export function MarketCapBoard(props: MarketCapBoardProps) {
  return (
    <section className="market-board" aria-label="Entity ranking" aria-busy={props.loading}>
      <header className="market-board-heading"><div><span>Entity ranking</span><h2>Top 100</h2></div><button type="button" disabled={props.loading} onClick={props.onReload}>{props.loading ? '↻ Syncing' : '↻ Refresh'}</button></header>
      <MarketFilters data={props.data} controls={props.controls} query={props.query} onQueryChange={props.onQueryChange} onControlChange={props.onControlChange} onReverseDirection={props.onReverseDirection} />
      <MarketResult data={props.data} loading={props.loading} error={props.error} onReload={props.onReload} />
    </section>
  );
}
