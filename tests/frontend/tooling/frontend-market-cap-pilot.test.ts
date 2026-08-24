import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  controlsForMarketCapRanking,
  createMarketCapRequestUrl,
  DEFAULT_MARKET_CAP_CONTROLS,
  fetchMarketCapResponse,
  formatMarketCapPrice,
  formatMarketCapUsd,
  marketCapAgeLabel,
  marketCapRankingValue,
  updateMarketCapControl,
  type MarketCapFetcher,
  type MarketCapRequest,
} from '../../../frontend/src/lib/market-cap/market-cap-page-model';

const ROOT = resolve(import.meta.dir, '../../..');
const GENERATED_AT = 1_800_000_000_000;
const JURISDICTION = `stack:31337:0x${'c'.repeat(40)}`;

const PAYLOAD = {
  format: 'entity-market-cap',
  generatedAt: GENERATED_AT,
  staleAfterMs: 300_000,
  connectedHubCount: 2,
  numberedEntityCount: 1,
  freshCount: 1,
  staleCount: 0,
  noPriceCount: 0,
  facets: { jurisdictionRefs: [JURISDICTION], entityKinds: ['company'], sectors: ['finance', 'technology'] },
  jurisdictionLeaders: [{ jurisdictionRef: JURISDICTION, entityCount: 1, pricedEntityCount: 1, freshEntityCount: 1, marketCapUsdTicks: '1000000000000000' }],
  returned: 1,
  entries: [{
    entityId: `0x${'0'.repeat(63)}7`,
    entityNumber: '7',
    name: 'Northstar Exchange',
    isHub: true,
    entityKind: 'company',
    sectors: ['finance', 'technology'],
    online: true,
    jurisdictionRef: JURISDICTION,
    status: 'fresh',
    control: { shareClass: 'CONTROL', pairId: '1/2', priceTicks: '7300', observedAt: GENERATED_AT - 22_000, sourceHubEntityIds: [`0x${'a'.repeat(64)}`] },
    dividend: { shareClass: 'DIVIDEND', pairId: '1/3', priceTicks: '2700', observedAt: GENERATED_AT - 36_000, sourceHubEntityIds: [`0x${'a'.repeat(64)}`] },
    marketCapUsdTicks: '1000000000000000',
    lastTradeObservedAt: GENERATED_AT - 22_000,
  }],
};

const REQUEST: MarketCapRequest = { ...DEFAULT_MARKET_CAP_CONTROLS, query: '' };

describe('React market-cap pilot', () => {
  test('builds the canonical query and validates every interactive filter', () => {
    const hubs = controlsForMarketCapRanking('hubs');
    expect(hubs).toEqual({ ...DEFAULT_MARKET_CAP_CONTROLS, role: 'hub' });
    expect(controlsForMarketCapRanking('control')?.sort).toBe('control');
    expect(controlsForMarketCapRanking('dividend')?.sort).toBe('dividend');
    expect(controlsForMarketCapRanking('jurisdictions')).toBeNull();
    expect(updateMarketCapControl(DEFAULT_MARKET_CAP_CONTROLS, 'jurisdiction', JURISDICTION, [JURISDICTION]).jurisdiction).toBe(JURISDICTION);
    expect(() => updateMarketCapControl(DEFAULT_MARKET_CAP_CONTROLS, 'role', 'validator', [])).toThrow('MARKET_CAP_ROLE_FILTER_INVALID:validator');
    expect(createMarketCapRequestUrl({ ...REQUEST, role: 'hub', query: ' Atlas ' })).toBe('/api/market-cap?status=all&role=hub&jurisdiction=all&kind=all&sector=all&sort=valuation&direction=desc&limit=100&q=Atlas');
  });

  test('keeps valuation formatting and age math on verified integer ticks', async () => {
    let requestedUrl = '';
    let requestInit: RequestInit | null = null;
    const fetcher: MarketCapFetcher = (input, init) => {
      requestedUrl = input;
      requestInit = init;
      return Promise.resolve(Response.json(PAYLOAD));
    };
    const decoded = await fetchMarketCapResponse(REQUEST, { fetcher });
    const first = decoded.entries[0];
    if (!first) throw new Error('MARKET_CAP_TEST_ENTRY_MISSING');
    expect(requestedUrl).toBe(createMarketCapRequestUrl(REQUEST));
    expect(requestInit?.cache).toBe('no-store');
    expect(formatMarketCapPrice(first.control.priceTicks)).toBe('$0.7300');
    expect(formatMarketCapUsd(first.marketCapUsdTicks)).toBe('$100.0B');
    expect(formatMarketCapUsd(marketCapRankingValue(first, 'control'))).toBe('$73.0B');
    expect(marketCapAgeLabel(first, decoded.generatedAt)).toBe('Oldest price · 36s');
  });

  test('rejects malformed relay data before rendering and shares one frontend boundary', async () => {
    const fetcher: MarketCapFetcher = (_input, _init) => Promise.resolve(Response.json({ ...PAYLOAD, staleAfterMs: 1 }));
    await expect(fetchMarketCapResponse(REQUEST, { fetcher })).rejects.toThrow('MARKET_CAP_RESPONSE_STALE_WINDOW_INVALID');
    const reactSource = readFileSync(resolve(ROOT, 'frontend/apps/site/src/market-cap-page.tsx'), 'utf8');
    const svelteSource = readFileSync(resolve(ROOT, 'frontend/src/routes/market-cap/+page.svelte'), 'utf8');
    expect(reactSource).toContain("from '$lib/market-cap/market-cap-page-model'");
    expect(reactSource).toContain('AbortController');
    expect(svelteSource).toContain('fetchMarketCapResponse');
    expect(svelteSource).not.toContain('decodeMarketCapPublicResponse');
  });
});
