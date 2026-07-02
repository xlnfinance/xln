<script lang="ts">
  import { onDestroy } from 'svelte';
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';
  import {
    buildGossipDirectoryViewFromRuntimeEntities,
    emptyGossipDirectoryView,
    type GossipDirectoryProfile,
  } from '$lib/components/Entity/gossip-directory-view';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { createRuntimeQueryStore } from '$lib/stores/runtimeQueryClient';

  const frameStore = createRuntimeQueryStore((client) => client.readViewFrame({
    accountsLimit: 1,
    booksLimit: 1,
  }));

  let search = '';

  onDestroy(() => {
    frameStore.destroy();
  });

  $: frameState = $frameStore;
  $: directoryView = frameState.data
    ? buildGossipDirectoryViewFromRuntimeEntities({
      entities: frameState.data.entities,
      runtimeId: $runtimeControllerHandle.id,
    })
    : emptyGossipDirectoryView();
  $: normalizedSearch = search.trim().toLowerCase();
  $: filteredProfiles = directoryView.profiles.filter((profile) => {
    if (!normalizedSearch) return true;
    return profile.name.toLowerCase().includes(normalizedSearch)
      || profile.entityId.toLowerCase().includes(normalizedSearch)
      || profile.runtimeId.toLowerCase().includes(normalizedSearch)
      || String(profile.jurisdictionName || '').toLowerCase().includes(normalizedSearch);
  });

  function displayName(profile: GossipDirectoryProfile): string {
    return profile.name || profile.entityId;
  }
</script>

<div class="gossip-panel" data-testid="runtime-gossip-panel">
  <div class="panel-header">
    <div>
      <h2>Gossip Directory</h2>
      <p>{directoryView.profileCount} profiles · {directoryView.hubCount} hubs</p>
    </div>
    <div class="runtime-pill" title={$runtimeControllerHandle.endpoint}>
      {$runtimeControllerHandle.mode}
      {#if $runtimeControllerHandle.authLevel}
        · {$runtimeControllerHandle.authLevel}
      {/if}
      · h{$runtimeControllerHandle.height}
    </div>
  </div>

  <div class="search-row">
    <input
      type="text"
      bind:value={search}
      placeholder="Search by name, entity, runtime, jurisdiction"
      aria-label="Search gossip directory"
    />
  </div>

  {#if frameState.error}
    <div class="state-card error" data-testid="runtime-gossip-error">{frameState.error}</div>
  {:else if frameState.loading && directoryView.profileCount === 0}
    <div class="state-card" data-testid="runtime-gossip-loading">Loading runtime projection...</div>
  {:else if filteredProfiles.length === 0}
    <div class="state-card" data-testid="runtime-gossip-empty">No profiles in this runtime projection.</div>
  {:else}
    <div class="profiles-container" data-testid="runtime-gossip-profiles">
      {#each filteredProfiles as profile (profile.entityId)}
        <div class="profile-card" class:hub={profile.isHub}>
          <EntityIdentity
            entityId={profile.entityId}
            name={displayName(profile)}
            showAddress={true}
            copyable={true}
            clickable={true}
          />
          <div class="profile-meta">
            {#if profile.isHub}<span class="chip hub-chip">hub</span>{/if}
            {#if profile.jurisdictionName}<span class="chip">{profile.jurisdictionName}</span>{/if}
            {#if profile.height}<span class="chip">h{profile.height}</span>{/if}
            {#if profile.runtimeId}<span class="chip">{profile.runtimeId.slice(0, 18)}</span>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .gossip-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #161616;
    color: rgba(255, 255, 255, 0.9);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 20px;
    background: #202020;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .panel-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .panel-header p {
    margin: 4px 0 0;
    color: rgba(255, 255, 255, 0.56);
    font-size: 12px;
  }

  .runtime-pill,
  .chip {
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.72);
    border-radius: 999px;
    white-space: nowrap;
  }

  .runtime-pill {
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 700;
  }

  .search-row {
    padding: 14px 16px 0;
  }

  .search-row input {
    width: 100%;
    height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.34);
    color: rgba(255, 255, 255, 0.9);
    padding: 0 10px;
    outline: none;
  }

  .profiles-container {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .profile-card,
  .state-card {
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
  }

  .profile-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
  }

  .profile-card.hub {
    border-color: rgba(250, 204, 21, 0.34);
    background: rgba(250, 204, 21, 0.08);
  }

  .profile-meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }

  .chip {
    padding: 2px 8px;
    font-size: 11px;
  }

  .hub-chip {
    color: rgba(250, 204, 21, 0.92);
    border-color: rgba(250, 204, 21, 0.32);
  }

  .state-card {
    margin: 16px;
    padding: 18px;
    color: rgba(255, 255, 255, 0.62);
    text-align: center;
  }

  .state-card.error {
    color: #fecaca;
    border-color: rgba(248, 113, 113, 0.42);
    background: rgba(127, 29, 29, 0.26);
  }

  @media (max-width: 900px) {
    .panel-header,
    .profile-card {
      flex-direction: column;
      align-items: flex-start;
    }

    .profile-meta {
      justify-content: flex-start;
    }
  }
</style>
