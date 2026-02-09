<script lang="ts">
  import { onMount } from 'svelte';
  import { getXLN, xlnEnvironment } from '$lib/stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';

  export let entityId: string = '';

  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextEnv = entityEnv?.env;

  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;

  type GossipProfile = {
    entityId: string;
    runtimeId?: string;
    capabilities?: string[];
    metadata?: {
      name?: string;
      isHub?: boolean;
      region?: string;
      lastUpdated?: number;
      [k: string]: unknown;
    };
  };

  let loading = false;
  let error = '';
  let search = '';
  let profiles: GossipProfile[] = [];
  let lastRefreshAt = 0;

  function isRuntimeEnv(value: unknown): value is { gossip?: { getProfiles?: () => GossipProfile[] } } {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  $: normalizedSearch = search.trim().toLowerCase();
  $: filtered = profiles.filter((p) => {
    if (!normalizedSearch) return true;
    const name = String(p.metadata?.name || '').toLowerCase();
    const id = String(p.entityId || '').toLowerCase();
    const runtimeId = String(p.runtimeId || '').toLowerCase();
    return name.includes(normalizedSearch) || id.includes(normalizedSearch) || runtimeId.includes(normalizedSearch);
  });

  $: sortedProfiles = [...filtered].sort((a, b) => {
    const aHub = isHub(a);
    const bHub = isHub(b);
    if (aHub !== bHub) return aHub ? -1 : 1;
    const aName = String(a.metadata?.name || '').toLowerCase();
    const bName = String(b.metadata?.name || '').toLowerCase();
    if (aName && bName && aName !== bName) return aName.localeCompare(bName);
    return String(a.entityId).localeCompare(String(b.entityId));
  });

  $: hubCount = profiles.filter(isHub).length;

  function isHub(profile: GossipProfile): boolean {
    return profile.metadata?.isHub === true || profile.capabilities?.includes('hub') === true;
  }

  function profileName(profile: GossipProfile): string {
    return String(profile.metadata?.name || '').trim() || 'Unnamed entity';
  }

  function formatTs(ts?: number): string {
    if (!ts) return '-';
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return '-';
    }
  }

  function pullProfilesFromEnv() {
    const gossip = activeEnv?.gossip;
    if (!gossip?.getProfiles) {
      profiles = [];
      return;
    }
    const all = gossip.getProfiles() as GossipProfile[];
    profiles = Array.isArray(all) ? all : [];
    lastRefreshAt = Date.now();
  }

  async function refreshAll() {
    loading = true;
    error = '';
    try {
      const env = activeEnv;
      if (!isRuntimeEnv(env)) throw new Error('Environment not ready');
      const xln = await getXLN();
      xln.refreshGossip?.(env as any);
      await new Promise(resolve => setTimeout(resolve, 250));
      pullProfilesFromEnv();
    } catch (err) {
      error = (err as Error).message || 'Failed to refresh gossip';
    } finally {
      loading = false;
    }
  }

  async function clearAll() {
    loading = true;
    error = '';
    try {
      const env = activeEnv;
      if (!isRuntimeEnv(env)) throw new Error('Environment not ready');
      const xln = await getXLN();
      xln.clearGossip?.(env as any);
      pullProfilesFromEnv();
    } catch (err) {
      error = (err as Error).message || 'Failed to clear gossip';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    pullProfilesFromEnv();
  });

  $: if (activeEnv) {
    pullProfilesFromEnv();
  }
</script>

<div class="gossip-wrap">
  <div class="gossip-head">
    <div>
      <h4 class="section-head">Gossip Directory</h4>
      <p class="muted">{profiles.length} profiles ({hubCount} hubs)</p>
      {#if lastRefreshAt > 0}
        <p class="muted tiny">Last refresh: {formatTs(lastRefreshAt)}</p>
      {/if}
    </div>
    <div class="actions">
      <button class="btn-refresh-small" on:click={refreshAll} disabled={loading}>Refresh All</button>
      <button class="btn-clear" on:click={clearAll} disabled={loading}>Clear All</button>
    </div>
  </div>

  <div class="search-row">
    <input type="text" placeholder="Search by name, entity, runtime" bind:value={search} />
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if sortedProfiles.length === 0}
    <p class="muted">No gossip profiles found.</p>
  {:else}
    <div class="list">
      {#each sortedProfiles as profile (profile.entityId)}
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
            <span class="chip">runtime {profile.runtimeId ? profile.runtimeId.slice(0, 10) : '-'}</span>
            <span class="chip">{profile.metadata?.region || 'global'}</span>
            <span class="chip">{formatTs(profile.metadata?.lastUpdated)}</span>
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

  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn-clear {
    border: 1px solid #3a2b2c;
    background: #1d1213;
    color: #d7a8ac;
    padding: 7px 10px;
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
  }

  .btn-clear:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .search-row input {
    width: 100%;
    background: #0f141c;
    color: #d7dce6;
    border: 1px solid #262f3d;
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
    border: 1px solid #1d2734;
    background: #0b1118;
    border-radius: 10px;
    padding: 10px;
  }

  .row.hub {
    border-color: #4f3b20;
    background: linear-gradient(180deg, #161109 0%, #0d1118 100%);
  }

  .meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .chip {
    border: 1px solid #273242;
    background: #111925;
    color: #8ea1b9;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
    white-space: nowrap;
  }

  .error {
    border: 1px solid #5a2c32;
    background: #221116;
    color: #ffb6bf;
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
  }

  .tiny {
    font-size: 11px;
  }

  @media (max-width: 900px) {
    .row {
      flex-direction: column;
      align-items: flex-start;
    }

    .meta {
      justify-content: flex-start;
    }
  }
</style>
