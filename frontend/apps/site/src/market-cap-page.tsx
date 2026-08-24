import { startTransition, useEffect, useMemo, useState } from 'react';
import type { MarketCapPublicResponse } from '@xln/core/network/relay/market/cap/market-cap-wire';

import {
  controlsForMarketCapRanking,
  DEFAULT_MARKET_CAP_CONTROLS,
  fetchMarketCapResponse,
  formatMarketCapUsd,
  MARKET_CAP_RANKINGS,
  marketCapJurisdictionLabel,
  marketCapRankingLabel,
  marketCapRankingValue,
  updateMarketCapControl,
  type MarketCapControlKey,
  type MarketCapControls,
  type MarketCapRanking,
  type MarketCapRequest,
} from '$lib/market-cap/market-cap-page-model';
import { MarketCapBoard } from './market-cap-board';
import { SiteFooter, SiteShell } from './site-shell';

type MarketFeedState = Readonly<{
  data: MarketCapPublicResponse | null;
  loading: boolean;
  error: string;
}>;

function useMarketCapFeed(request: MarketCapRequest, refreshToken: number): MarketFeedState {
  const [state, setState] = useState<MarketFeedState>({ data: null, loading: true, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    void fetchMarketCapResponse(request, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) startTransition(() => setState({ data, loading: false, error: '' }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setState({ data: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => controller.abort();
  }, [request, refreshToken]);
  return state;
}

function MarketHero({ loading }: Readonly<{ loading: boolean }>) {
  return (
    <header className="market-hero">
      <div><p className="market-eyebrow"><i /> Verified relay markets <span>{loading ? 'Synchronizing' : 'Feed verified'}</span></p><h1>xln Market Cap</h1><p>Numbered Entities ranked by combined <strong>CONTROL</strong> + <strong>DIVIDEND</strong> market value.</p></div>
      <aside><span>Valuation basis</span><strong>100B <i>+</i> 100B</strong><small>Latest verified USDT trades<br />Stale after 5 minutes</small></aside>
    </header>
  );
}

function MarketMetrics({ data }: Readonly<{ data: MarketCapPublicResponse | null }>) {
  const metrics = [
    { label: 'Numbered Entities', value: data?.numberedEntityCount ?? '—', detail: 'verified gossip profiles' },
    { label: 'Live valuations', value: data?.freshCount ?? '—', detail: 'both prices under 5m', live: true },
    { label: 'Waiting for price', value: data?.noPriceCount ?? '—', detail: 'no estimated price' },
    { label: 'Connected Hubs', value: data?.connectedHubCount ?? '—', detail: 'aggregated by this relay' },
  ];
  return <section className="market-metrics" aria-label="Market summary">{metrics.map((metric, index) => <article key={metric.label}><span>{String(index + 1).padStart(2, '0')} · {metric.label}</span><strong>{metric.value}</strong><small>{metric.live ? <i /> : null}{metric.detail}</small></article>)}</section>;
}

function MarketRankingNav({ ranking, onSelect }: Readonly<{ ranking: MarketCapRanking; onSelect: (ranking: MarketCapRanking) => void }>) {
  return <nav className="market-rankings" aria-label="Market cap rankings">{MARKET_CAP_RANKINGS.map((item, index) => <button type="button" key={item.id} className={ranking === item.id ? 'is-active' : undefined} aria-pressed={ranking === item.id} onClick={() => onSelect(item.id)}><span>{String(index + 1).padStart(2, '0')}</span>{item.label}</button>)}</nav>;
}

function MarketLeaders({ data, controls }: Readonly<{ data: MarketCapPublicResponse; controls: MarketCapControls }>) {
  return (
    <section className="market-leaders" aria-label="Valuation leaders">
      {data.entries.slice(0, 3).map((entry, index) => <article key={entry.entityId}><span className="market-leader-rank">{String(index + 1).padStart(2, '0')}</span><div className="market-entity-mark">{entry.entityNumber.slice(-2).padStart(2, '0')}</div><div className="market-leader-copy"><span>Entity #{entry.entityNumber}</span><strong>{entry.name}</strong><small className={entry.online ? 'is-online' : undefined}>{entry.online ? 'Online' : 'Offline'}{entry.isHub ? ' · Hub' : ''}</small></div><div className="market-leader-value"><strong>{formatMarketCapUsd(marketCapRankingValue(entry, controls.sort))}</strong><span className={`is-${entry.status}`}>{marketCapRankingLabel(entry, controls.sort)}</span></div></article>)}
    </section>
  );
}

function MarketJurisdictions({ state, onReload }: Readonly<{ state: MarketFeedState; onReload: () => void }>) {
  if (state.loading && !state.data) return <section className="market-jurisdictions"><div className="market-state"><div className="market-loader" /><strong>Reading jurisdiction totals</strong><span>Combining priced Entity valuations from the verified relay feed.</span></div></section>;
  if (state.error) return <section className="market-jurisdictions"><div className="market-state is-error" role="alert"><b>!</b><strong>Jurisdiction ranking is unavailable</strong><span>{state.error}</span><button type="button" onClick={onReload}>Try again</button></div></section>;
  if (!state.data) return null;
  return (
    <section className="market-jurisdictions" aria-label="Jurisdiction leaders">
      <header><span>Jurisdiction ranking</span><h2>Top Jurisdictions</h2><p>Combined priced Entity valuations; stale prices remain explicitly counted.</p></header>
      <div>{state.data.jurisdictionLeaders.map((item, index) => <article key={item.jurisdictionRef}><b>{String(index + 1).padStart(2, '0')}</b><div><strong>{marketCapJurisdictionLabel(item.jurisdictionRef)}</strong><span>{item.entityCount} Entities · {item.pricedEntityCount} priced · {item.freshEntityCount} live</span></div><em>{formatMarketCapUsd(item.marketCapUsdTicks)}</em></article>)}</div>
    </section>
  );
}

export function MarketCapPage() {
  const [controls, setControls] = useState<MarketCapControls>(DEFAULT_MARKET_CAP_CONTROLS);
  const [query, setQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [ranking, setRanking] = useState<MarketCapRanking>('overall');
  const [refreshToken, setRefreshToken] = useState(0);
  const request = useMemo<MarketCapRequest>(() => ({ ...controls, query: committedQuery }), [controls, committedQuery]);
  const state = useMarketCapFeed(request, refreshToken);

  useEffect(() => {
    if (query === committedQuery) return undefined;
    const timer = window.setTimeout(() => setCommittedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query, committedQuery]);

  const commitAndRefresh = (): void => {
    setCommittedQuery(query);
    setRefreshToken((current) => current + 1);
  };
  const changeControl = (key: MarketCapControlKey, value: string): void => {
    setCommittedQuery(query);
    setControls((current) => updateMarketCapControl(current, key, value, state.data?.facets.jurisdictionRefs ?? []));
  };
  const reverseDirection = (): void => {
    setCommittedQuery(query);
    setControls((current) => ({ ...current, direction: current.direction === 'desc' ? 'asc' : 'desc' }));
  };
  const selectRanking = (next: MarketCapRanking): void => {
    setRanking(next);
    const preset = controlsForMarketCapRanking(next);
    if (!preset) return;
    setControls(preset);
    setQuery('');
    setCommittedQuery('');
    setRefreshToken((current) => current + 1);
  };
  const showLeaders = ranking !== 'jurisdictions' && Boolean(state.data?.entries.length) && controls.direction === 'desc' && controls.status === 'all' && !query;

  return (
    <SiteShell activeRoute="/market-cap">
      <main className="market-page">
        <MarketHero loading={state.loading} />
        <MarketMetrics data={state.data} />
        <MarketRankingNav ranking={ranking} onSelect={selectRanking} />
        {showLeaders && state.data ? <MarketLeaders data={state.data} controls={controls} /> : null}
        {ranking === 'jurisdictions' ? <MarketJurisdictions state={state} onReload={commitAndRefresh} /> : <MarketCapBoard data={state.data} loading={state.loading} error={state.error} controls={controls} query={query} onQueryChange={setQuery} onControlChange={changeControl} onReverseDirection={reverseDirection} onReload={commitAndRefresh} />}
        <p className="market-updated">Canonical prices only · No estimated data · Updated {state.data ? new Date(state.data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</p>
      </main>
      <SiteFooter />
    </SiteShell>
  );
}
