<script lang="ts">
  import { onMount } from 'svelte';
  import type { ProfileEntityKind, ProfileEntitySector } from '@xln/core/entity/profile';
  import {
    type MarketCapDirection,
    type MarketCapPublicResponse,
    type MarketCapRole,
    type MarketCapSort,
    type MarketCapTaxonomyFilter,
  } from '@xln/core/network/relay/market/cap/market-cap-wire';
  import type { EntityMarketCapStatus } from '@xln/core/network/relay/market/cap/market-cap';
  import {
    controlsForMarketCapRanking,
    DEFAULT_MARKET_CAP_CONTROLS,
    fetchMarketCapResponse,
    formatMarketCapUsd,
    MARKET_CAP_RANKINGS,
    marketCapJurisdictionLabel,
    marketCapRankingLabel,
    marketCapRankingValue,
    type MarketCapRanking,
  } from '$lib/market-cap/market-cap-page-model';
  import MarketCapBoard from './MarketCapBoard.svelte';

  let data: MarketCapPublicResponse | null = null;
  let loading = true;
  let error = '';
  let status: EntityMarketCapStatus | 'all' = DEFAULT_MARKET_CAP_CONTROLS.status;
  let role: MarketCapRole = DEFAULT_MARKET_CAP_CONTROLS.role;
  let jurisdiction = DEFAULT_MARKET_CAP_CONTROLS.jurisdiction;
  let entityKind: MarketCapTaxonomyFilter<ProfileEntityKind> = DEFAULT_MARKET_CAP_CONTROLS.entityKind;
  let sector: MarketCapTaxonomyFilter<ProfileEntitySector> = DEFAULT_MARKET_CAP_CONTROLS.sector;
  let sort: MarketCapSort = DEFAULT_MARKET_CAP_CONTROLS.sort;
  let direction: MarketCapDirection = DEFAULT_MARKET_CAP_CONTROLS.direction;
  let query = '';
  let queryTimer: ReturnType<typeof setTimeout> | null = null;
  let loadSequence = 0;
  let ranking: MarketCapRanking = 'overall';

  async function load(): Promise<void> {
    const sequence = ++loadSequence;
    loading = true;
    error = '';
    try {
      const decoded = await fetchMarketCapResponse({ status, role, jurisdiction, entityKind, sector, sort, direction, query });
      if (sequence !== loadSequence) return;
      data = decoded;
    } catch (cause) {
      if (sequence !== loadSequence) return;
      data = null;
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (sequence === loadSequence) loading = false;
    }
  }

  function queueSearch(): void {
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(() => void load(), 250);
  }

  function reverseDirection(): void {
    direction = direction === 'desc' ? 'asc' : 'desc';
    void load();
  }

  function selectRanking(next: MarketCapRanking): void {
    ranking = next;
    const controls = controlsForMarketCapRanking(next);
    if (!controls) return;
    ({ status, role, jurisdiction, entityKind, sector, sort, direction } = controls);
    query = '';
    void load();
  }

  onMount(() => {
    void load();
    return () => {
      if (queryTimer) clearTimeout(queryTimer);
    };
  });
</script>

<svelte:head>
  <title>xln Market Cap</title>
  <meta name="description" content="Live Entity valuations from verified xln relay markets." />
</svelte:head>

<div class="market-page">
  <div class="glow glow-one"></div>
  <div class="glow glow-two"></div>

  <header class="hero">
    <div>
      <div class="eyebrow"><span></span> Verified relay markets</div>
      <h1>xln Market Cap</h1>
      <p>Numbered Entities ranked by combined <strong>CONTROL</strong> + <strong>DIVIDEND</strong> market value.</p>
    </div>
    <div class="supply-note">
      <span>VALUATION BASIS</span>
      <strong>100B + 100B shares</strong>
      <small>Latest verified USDT trades · stale after 5 minutes</small>
    </div>
  </header>

  <section class="metrics" aria-label="Market summary">
    <article>
      <span>Numbered Entities</span>
      <strong>{data?.numberedEntityCount ?? '—'}</strong>
      <small>from verified gossip profiles</small>
    </article>
    <article class="live-metric">
      <span>Live valuations</span>
      <strong>{data?.freshCount ?? '—'}</strong>
      <small><i></i> both prices under 5m</small>
    </article>
    <article>
      <span>Waiting for price</span>
      <strong>{data?.noPriceCount ?? '—'}</strong>
      <small>no estimated price is used</small>
    </article>
    <article>
      <span>Connected Hubs</span>
      <strong>{data?.connectedHubCount ?? '—'}</strong>
      <small>aggregated by this relay</small>
    </article>
  </section>

  <nav class="rankings" aria-label="Market cap rankings">
    {#each MARKET_CAP_RANKINGS as item}
      <button class:active={ranking === item.id} on:click={() => selectRanking(item.id)}>{item.label}</button>
    {/each}
  </nav>

  {#if ranking === 'jurisdictions' && data}
    <section class="jurisdictions" aria-label="Jurisdiction leaders">
      <div class="jurisdiction-heading"><span class="section-label">JURISDICTION RANKING</span><h2>Top Jurisdictions</h2><p>Combined priced Entity valuations; stale prices remain explicitly counted.</p></div>
      {#each data.jurisdictionLeaders as item, index}
        <article><b>{index + 1}</b><div><strong>{marketCapJurisdictionLabel(item.jurisdictionRef)}</strong><span>{item.entityCount} Entities · {item.pricedEntityCount} priced · {item.freshEntityCount} live</span></div><em>{formatMarketCapUsd(item.marketCapUsdTicks)}</em></article>
      {/each}
    </section>
  {:else if data && data.entries.length > 0 && direction === 'desc' && status === 'all' && !query}
    <section class="leaders" aria-label="Valuation leaders">
      {#each data.entries.slice(0, 3) as entry, index}
        <article class:leader-first={index === 0}>
          <div class="leader-rank">{index + 1}</div>
          <div class="entity-mark">{entry.entityNumber.slice(-2)}</div>
          <div class="leader-copy">
            <span>Entity #{entry.entityNumber}</span>
            <strong>{entry.name}</strong>
            <small class:online={entry.online}>{entry.online ? 'Online' : 'Offline'}{entry.isHub ? ' · Hub' : ''}</small>
          </div>
          <div class="leader-value">
            <strong>{formatMarketCapUsd(marketCapRankingValue(entry, sort))}</strong>
            <span class:status-fresh={entry.status === 'fresh'} class:status-stale={entry.status === 'stale'}>{marketCapRankingLabel(entry, sort)}</span>
          </div>
        </article>
      {/each}
    </section>
  {/if}

  {#if ranking !== 'jurisdictions'}
    <MarketCapBoard {data} {loading} {error} bind:status bind:role bind:jurisdiction bind:entityKind bind:sector bind:sort bind:direction bind:query reload={() => void load()} {queueSearch} {reverseDirection} />
  {/if}

  <footer>Canonical prices only · No estimated data · Updated {data ? new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</footer>
</div>

<style>
  :global(body) { background: #06080a !important; }
  .market-page { --green: #55e59d; --amber: #ffbf69; position: relative; min-height: calc(100dvh - 56px); overflow: hidden; padding: 64px max(24px, calc((100vw - 1440px) / 2)) 40px; background: linear-gradient(180deg, #080b0e 0%, #06080a 55%, #080a0c 100%); color: #f5f7f6; box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .glow { position: absolute; width: 520px; height: 520px; border-radius: 50%; filter: blur(120px); pointer-events: none; opacity: .12; }
  .glow-one { background: #20d67c; top: -300px; left: 10%; } .glow-two { background: #3b82f6; top: 160px; right: -350px; opacity: .07; }
  .hero, .metrics, .leaders, .rankings, .jurisdictions, footer { position: relative; z-index: 1; }
  .hero { display: flex; justify-content: space-between; align-items: end; gap: 40px; margin-bottom: 44px; }
  .eyebrow, .section-label { color: #8d9791; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  .eyebrow span { display: inline-block; width: 6px; height: 6px; margin: 0 9px 1px 0; border-radius: 50%; background: var(--green); box-shadow: 0 0 12px var(--green); }
  h1 { margin: 12px 0 12px; font-size: clamp(42px, 6vw, 78px); line-height: .96; letter-spacing: -.065em; font-weight: 650; }
  .hero p { max-width: 690px; margin: 0; color: #9da6a1; font-size: 16px; line-height: 1.6; }
  .hero p strong { color: #dfe7e2; font-weight: 600; }
  .supply-note { min-width: 275px; padding: 18px 20px; border: 1px solid #202622; border-radius: 14px; background: rgba(15, 19, 17, .72); }
  .supply-note span, .supply-note small { display: block; color: #77817b; font-size: 10px; letter-spacing: .1em; }
  .supply-note strong { display: block; margin: 7px 0 5px; font-size: 18px; }
  .supply-note small { letter-spacing: 0; line-height: 1.4; }
  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #1d2320; border-radius: 16px; background: rgba(11, 14, 13, .78); overflow: hidden; }
  .metrics article { min-height: 112px; padding: 20px 24px; border-right: 1px solid #1d2320; box-sizing: border-box; }
  .metrics article:last-child { border: 0; } .metrics span, .metrics small { display: block; color: #79827d; font-size: 11px; }
  .metrics strong { display: block; margin: 9px 0 7px; font: 500 28px/1 ui-monospace, SFMono-Regular, monospace; }
  .metrics i { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
  .leaders { display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 12px; margin-top: 16px; }
  .leaders article { display: flex; align-items: center; min-width: 0; padding: 18px; border: 1px solid #1d2320; border-radius: 14px; background: #0c100e; }
  .leaders article.leader-first { border-color: rgba(85,229,157,.32); background: linear-gradient(135deg, rgba(85,229,157,.09), #0c100e 52%); }
  .leader-rank { align-self: start; width: 22px; color: #657069; font: 12px ui-monospace, monospace; }
  .entity-mark { display: grid; place-items: center; flex: 0 0 auto; width: 42px; height: 42px; border: 1px solid #2e3933; border-radius: 11px; background: linear-gradient(145deg, #18211c, #0b0e0c); color: var(--green); font: 600 12px ui-monospace, monospace; }
  .leader-copy { min-width: 0; margin-left: 12px; } .leader-copy span, .leader-copy small { display: block; color: #77817b; font-size: 10px; }
  .leader-copy strong { display: block; overflow: hidden; margin: 3px 0 5px; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .leader-copy small.online { color: var(--green); }
  .leader-value { margin-left: auto; text-align: right; } .leader-value strong { display: block; font: 600 18px ui-monospace, monospace; }
  .leader-value span { color: #7f8983; font-size: 10px; } .leader-value span.status-fresh { color: var(--green); } .leader-value span.status-stale { color: var(--amber); }
  h2 { margin: 5px 0 0; font-size: 25px; letter-spacing: -.03em; }
  button { color: inherit; cursor: pointer; font: inherit; }
  .rankings { display: flex; gap: 8px; margin-top: 18px; overflow-x: auto; }
  .rankings button { flex: 0 0 auto; padding: 10px 14px; border: 1px solid #252c28; border-radius: 999px; background: #0c100e; color: #89938d; font-size: 11px; }
  .rankings button.active { border-color: #55e59d66; background: #55e59d12; color: var(--green); }
  .jurisdictions { margin-top: 16px; padding: 26px; border: 1px solid #1d2320; border-radius: 18px; background: #0a0d0ce6; }
  .jurisdiction-heading p { margin: 7px 0 22px; color: #77817b; font-size: 11px; }
  .jurisdictions article { display: grid; grid-template-columns: 30px 1fr auto; align-items: center; padding: 16px 4px; border-top: 1px solid #1d2320; }
  .jurisdictions article b { color: #66706a; font: 11px ui-monospace, monospace; }
  .jurisdictions article strong, .jurisdictions article span { display: block; }
  .jurisdictions article span { margin-top: 4px; color: #68716c; font-size: 10px; }
  .jurisdictions article em { color: #f4f7f5; font: 600 15px ui-monospace, monospace; font-style: normal; }
  footer { padding: 20px 4px 0; color: #525a55; font-size: 10px; letter-spacing: .04em; text-align: center; }
  @media (max-width: 900px) { .market-page { padding-top: 42px; } .hero { align-items: start; flex-direction: column; } .supply-note { width: 100%; box-sizing: border-box; } .metrics { grid-template-columns: repeat(2, 1fr); } .metrics article:nth-child(2) { border-right: 0; } .metrics article:nth-child(-n+2) { border-bottom: 1px solid #1d2320; } .leaders { grid-template-columns: 1fr; } }
  @media (max-width: 560px) { .market-page { padding: 32px 14px 28px; } h1 { font-size: 44px; } .hero { gap: 24px; margin-bottom: 28px; } .hero p { font-size: 14px; } .metrics article { min-height: 96px; padding: 16px; } .metrics strong { font-size: 23px; } .leaders article { padding: 14px; } .jurisdictions { padding: 18px 14px; } .jurisdictions article { grid-template-columns: 24px 1fr; } .jurisdictions article em { grid-column: 2; margin-top: 8px; } }
</style>
