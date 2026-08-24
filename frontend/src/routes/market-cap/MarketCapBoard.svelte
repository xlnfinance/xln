<script lang="ts">
  import type { ProfileEntityKind, ProfileEntitySector } from '@xln/core/entity/profile';
  import type { EntityMarketCapStatus } from '@xln/core/network/relay/market/cap/market-cap';
  import type {
    MarketCapDirection,
    MarketCapPublicResponse,
    MarketCapRole,
    MarketCapSort,
    MarketCapTaxonomyFilter,
  } from '@xln/core/network/relay/market/cap/market-cap-wire';
  import {
    formatMarketCapPrice,
    formatMarketCapUsd,
    marketCapAgeLabel,
    marketCapJurisdictionLabel,
    marketCapStatusLabel,
    titleCaseMarketCapValue,
  } from '$lib/market-cap/market-cap-page-model';

  export let data: MarketCapPublicResponse | null;
  export let loading: boolean;
  export let error: string;
  export let status: EntityMarketCapStatus | 'all';
  export let role: MarketCapRole;
  export let jurisdiction: string | 'all';
  export let entityKind: MarketCapTaxonomyFilter<ProfileEntityKind>;
  export let sector: MarketCapTaxonomyFilter<ProfileEntitySector>;
  export let sort: MarketCapSort;
  export let direction: MarketCapDirection;
  export let query: string;
  export let reload: () => void;
  export let queueSearch: () => void;
  export let reverseDirection: () => void;

</script>

<section class="board">
  <div class="heading"><div><span>ENTITY RANKING</span><h2>Top 100</h2></div><button on:click={reload} disabled={loading}>↻ Refresh</button></div>
  <div class="filters">
    <label class="search"><span>Search</span><input bind:value={query} on:input={queueSearch} placeholder="Entity name or number" aria-label="Search Entities" /></label>
    <label><span>Role</span><select bind:value={role} on:change={reload} aria-label="Role"><option value="all">All Entities</option><option value="hub">Hubs only</option><option value="non-hub">Non-hubs</option></select></label>
    <label><span>Jurisdiction</span><select bind:value={jurisdiction} on:change={reload} aria-label="Jurisdiction"><option value="all">All jurisdictions</option>{#each data?.facets.jurisdictionRefs ?? [] as ref}<option value={ref}>{marketCapJurisdictionLabel(ref)}</option>{/each}</select></label>
    <label><span>Kind</span><select bind:value={entityKind} on:change={reload} aria-label="Entity kind"><option value="all">All kinds</option><option value="unclassified">Unclassified</option>{#each data?.facets.entityKinds ?? [] as kind}<option value={kind}>{titleCaseMarketCapValue(kind)}</option>{/each}</select></label>
    <label><span>Sector</span><select bind:value={sector} on:change={reload} aria-label="Sector"><option value="all">All sectors</option><option value="unclassified">Unclassified</option>{#each data?.facets.sectors ?? [] as item}<option value={item}>{titleCaseMarketCapValue(item)}</option>{/each}</select></label>
    <label><span>Status</span><select bind:value={status} on:change={reload} aria-label="Status"><option value="all">All states</option><option value="fresh">Live</option><option value="stale">Stale</option><option value="no-price">No price</option></select></label>
    <label><span>Sort by</span><select bind:value={sort} on:change={reload} aria-label="Sort by"><option value="valuation">Combined cap</option><option value="control">CONTROL cap</option><option value="dividend">DIVIDEND cap</option><option value="number">Entity number</option><option value="name">Name</option><option value="recent">Last trade</option></select></label>
    <button class="direction" on:click={reverseDirection} aria-label="Reverse sort direction">{direction === 'desc' ? '↓ High to low' : '↑ Low to high'}</button>
  </div>

  {#if loading && !data}
    <div class="state"><div class="loader"></div><strong>Reading verified relay markets</strong><span>Combining CONTROL and DIVIDEND across every connected Hub.</span></div>
  {:else if error}
    <div class="state error"><b>!</b><strong>Live valuation is unavailable</strong><span>{error}</span><button on:click={reload}>Try again</button></div>
  {:else if data && data.entries.length === 0}
    <div class="state"><b>○</b><strong>No Entities match this view</strong><span>Change a filter. Missing prices are never replaced with estimates.</span></div>
  {:else if data}
    <div class="table-wrap"><table>
      <thead><tr><th>Rank</th><th>Entity</th><th>CONTROL</th><th>DIVIDEND</th><th>Combined cap</th><th>Price state</th></tr></thead>
      <tbody>{#each data.entries as entry, index}<tr>
        <td class="rank">{index + 1}</td>
        <td><div class="entity"><i class:online={entry.online}></i><div><strong>{entry.name}</strong><span>#{entry.entityNumber}{entry.isHub ? ' · Hub' : ''}{entry.entityKind ? ` · ${titleCaseMarketCapValue(entry.entityKind)}` : ''}</span>{#if entry.sectors.length}<small>{entry.sectors.map(titleCaseMarketCapValue).join(' · ')}</small>{/if}</div></div></td>
        <td><div class="price"><strong>{formatMarketCapPrice(entry.control.priceTicks)}</strong><span>{entry.control.sourceHubEntityIds.length} source Hub</span></div></td>
        <td><div class="price"><strong>{formatMarketCapPrice(entry.dividend.priceTicks)}</strong><span>{entry.dividend.sourceHubEntityIds.length} source Hub</span></div></td>
        <td class="cap"><strong>{formatMarketCapUsd(entry.marketCapUsdTicks)}</strong><span>CONTROL + DIVIDEND</span></td>
        <td><div class="pill" class:fresh={entry.status === 'fresh'} class:stale={entry.status === 'stale'}>{marketCapStatusLabel(entry.status)}</div><small>{marketCapAgeLabel(entry, data.generatedAt)}</small></td>
      </tr>{/each}</tbody>
    </table></div>
  {/if}
</section>

<style>
  .board{margin-top:28px;border:1px solid #1d2320;border-radius:18px;background:#0a0d0ce6;overflow:hidden;box-shadow:0 30px 100px #0004}.heading{display:flex;align-items:center;justify-content:space-between;padding:25px 28px 18px}.heading span,label>span{display:block;color:#727b76;font-size:10px;letter-spacing:.08em;text-transform:uppercase}.heading h2{margin:5px 0 0;font-size:25px}.heading button,.direction,.state button{min-height:38px;padding:0 13px;border:1px solid #29302c;border-radius:9px;background:#111512;color:#aab2ad}.filters{display:grid;grid-template-columns:minmax(210px,1.3fr) repeat(6,minmax(120px,.72fr)) 120px;gap:9px;padding:0 28px 24px;border-bottom:1px solid #1d2320}.filters label>span{margin-bottom:7px}.filters input,.filters select{width:100%;height:40px;box-sizing:border-box;border:1px solid #252c28;border-radius:9px;outline:none;background:#0c100e;color:#dfe4e1;padding:0 11px}.filters input:focus,.filters select:focus{border-color:#55e59d88}.direction{align-self:end;height:40px}.table-wrap{overflow-x:auto}table{width:100%;min-width:960px;border-collapse:collapse}th{padding:13px 18px;background:#0d110f;color:#68716c;font-size:9px;letter-spacing:.11em;text-align:left;text-transform:uppercase}td{padding:16px 18px;border-top:1px solid #181e1b;color:#d9dfdb;font-size:12px}.rank{width:34px;color:#5f6863}.entity{display:flex;align-items:center;min-width:205px}.entity>i{width:7px;height:7px;margin-right:11px;border-radius:50%;background:#343b37}.entity>i.online{background:#55e59d;box-shadow:0 0 7px #55e59d}.entity strong,.entity span,.entity small,.price strong,.price span,.cap strong,.cap span,td>small{display:block}.entity span,.entity small,.price span,.cap span,td>small{margin-top:4px;color:#68716c;font-size:9px}.price strong,.cap strong{font:500 12px ui-monospace,monospace}.cap strong{font-size:14px}.pill{display:inline-flex;padding:5px 8px;border:1px solid #2a312d;border-radius:999px;color:#8c958f;font-size:9px;text-transform:uppercase}.pill.fresh{border-color:#55e59d44;color:#55e59d}.pill.stale{border-color:#ffbf6944;color:#ffbf69}.state{display:flex;min-height:300px;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center}.state strong{margin:14px 0 7px}.state span{max-width:520px;color:#77817b;font-size:12px}.state b{display:grid;place-items:center;width:38px;height:38px;border:1px solid #2b332f;border-radius:50%}.loader{width:24px;height:24px;border:2px solid #26302b;border-top-color:#55e59d;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:1300px){.filters{grid-template-columns:repeat(4,1fr)}.search{grid-column:span 2}}@media(max-width:700px){.heading{padding:20px 16px 15px}.filters{grid-template-columns:1fr 1fr;padding:0 16px 18px}.search{grid-column:1/-1}.table-wrap{overflow:visible}table,tbody{display:block;min-width:0}thead{display:none}tbody{padding:0 14px 14px}tr{display:grid;grid-template-columns:1fr 1fr;gap:14px 10px;margin-top:12px;padding:16px;border:1px solid #1d2320;border-radius:12px;background:#0c100e}td{display:block;padding:0;border:0}.rank{display:none}td:nth-child(2),td:nth-child(5){grid-column:1/-1}.cap{padding-top:12px;border-top:1px solid #1d2320}.cap strong{font-size:18px}}@media(max-width:430px){.filters{grid-template-columns:1fr}.search{grid-column:auto}}
</style>
