<script lang="ts">
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';
  import {
    emptyGossipDirectoryView,
    type GossipDirectoryProfile,
    type GossipDirectoryView,
  } from './gossip-directory-view';

  export let gossipDirectoryView: GossipDirectoryView = emptyGossipDirectoryView();
  let search = '';

  $: normalizedSearch = search.trim().toLowerCase();
  $: filtered = gossipDirectoryView.profiles.filter((p) => {
    if (!normalizedSearch) return true;
    return p.name.toLowerCase().includes(normalizedSearch)
      || p.entityId.toLowerCase().includes(normalizedSearch)
      || p.runtimeId.toLowerCase().includes(normalizedSearch);
  });
  $: hubCount = gossipDirectoryView.hubCount;
  $: lastRefreshAt = gossipDirectoryView.lastRefreshAt;

  function isHub(profile: GossipDirectoryProfile): boolean {
    return profile.isHub;
  }

  function profileName(profile: GossipDirectoryProfile): string {
    return profile.name;
  }

  function formatTs(ts?: number): string {
    if (!ts) return '-';
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return '-';
    }
  }
</script>

<div class="gossip-wrap">
  <div class="gossip-head">
    <div>
      <h4 class="section-head">Gossip Directory</h4>
      <p class="muted">{gossipDirectoryView.profileCount} profiles ({hubCount} hubs)</p>
      {#if lastRefreshAt > 0}
        <p class="muted tiny">Latest profile update: {formatTs(lastRefreshAt)}</p>
      {/if}
    </div>
  </div>

  <div class="search-row">
    <input type="text" placeholder="Search by name, entity, runtime" bind:value={search} />
  </div>

  {#if filtered.length === 0}
    <p class="muted">No gossip profiles found.</p>
  {:else}
    <div class="list">
      {#each filtered as profile (profile.entityId)}
        <div class="row" class:hub={isHub(profile)}>
          <EntityIdentity
            entityId={profile.entityId}
            name={profileName(profile)}
            showAddress={true}
            copyable={true}
            clickable={true}
          />
          <div class="meta">
            {#if isHub(profile)}<span class="chip">hub</span>{/if}
            <span class="chip">runtime {profile.runtimeId.slice(0, 10) || 'unknown'}</span>
            <span class="chip">{formatTs(profile.lastUpdated)}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .gossip-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .gossip-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }

  .search-row input {
    width: 100%;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent);
    color: var(--theme-text-primary, #e4e4e7);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 76%, transparent);
    border-radius: 8px;
    height: 34px;
    padding: 0 10px;
    outline: none;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 420px;
    overflow: auto;
    padding-right: 2px;
  }

  .row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 68%, transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 86%, transparent);
    border-radius: 10px;
    padding: 10px;
  }

  .row.hub {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 40%, transparent);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-accent, #fbbf24) 10%, var(--theme-surface, #18181b)) 0%,
      color-mix(in srgb, var(--theme-surface, #18181b) 92%, transparent) 100%
    );
  }

  .meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .chip {
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 72%, transparent);
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 76%, transparent);
    color: var(--theme-text-secondary, #a1a1aa);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
    white-space: nowrap;
  }

  .tiny {
    font-size: 11px;
  }

  @media (max-width: 900px) {
    .list {
      max-height: none;
      overflow: visible;
      padding-right: 0;
    }

    .row {
      flex-direction: column;
      align-items: flex-start;
    }

    .meta {
      justify-content: flex-start;
    }
  }
</style>
