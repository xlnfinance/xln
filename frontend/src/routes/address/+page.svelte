<script lang="ts">
  import { onMount } from 'svelte';
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';

  type DebugEntity = {
    entityId: string;
    runtimeId?: string;
    name: string;
    isHub: boolean;
    online: boolean;
    lastUpdated: number;
    capabilities: string[];
  };

  let loading = true;
  let error: string | null = null;
  let entities: DebugEntity[] = [];
  let search = '';

  function sortedEntities(input: DebugEntity[]): DebugEntity[] {
    return [...input].sort((a, b) => {
      if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.lastUpdated || 0) - (a.lastUpdated || 0);
    });
  }

  $: visibleEntities = sortedEntities(entities).filter((e) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const blob = `${e.entityId} ${e.name} ${e.runtimeId || ''} ${(e.capabilities || []).join(' ')}`.toLowerCase();
    return blob.includes(q);
  });

  async function loadDirectory(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/debug/entities?limit=5000');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { entities?: DebugEntity[] };
      entities = Array.isArray(body.entities) ? body.entities : [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load address directory';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadDirectory();
  });
</script>

<svelte:head>
  <title>XLN Address Directory</title>
</svelte:head>

<div class="page">
  <header class="top">
    <div>
      <h1>XLN Address Directory</h1>
      <p>All registered gossip profiles. Hubs first, then users.</p>
    </div>
    <button onclick={loadDirectory}>Refresh</button>
  </header>

  <section class="panel">
    <input class="search" type="text" bind:value={search} placeholder="Search name, entity, runtime, capability" />
  </section>

  <section class="panel">
    {#if loading}
      <div class="empty">Loading profiles...</div>
    {:else if error}
      <div class="empty error">{error}</div>
    {:else if visibleEntities.length === 0}
      <div class="empty">No profiles found.</div>
    {:else}
      <div class="list">
        {#each visibleEntities as entity}
          <article class="row">
            <EntityIdentity entityId={entity.entityId} name={entity.name} size={30} />
            <div class="meta">
              <span class="chip" class:ok={entity.online} class:bad={!entity.online}>{entity.online ? 'online' : 'offline'}</span>
              {#if entity.isHub}<span class="chip hub">hub</span>{/if}
              {#if entity.runtimeId}<span class="chip">rt:{entity.runtimeId.slice(0, 12)}...</span>{/if}
              {#if entity.capabilities?.length}
                <span class="chip">{entity.capabilities[0]}</span>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  :global(body) {
    margin: 0;
    background: radial-gradient(1200px 700px at 5% -10%, #111926 0%, #06080b 55%, #05070a 100%);
    color: #b7c2d3;
    font-family: 'Space Grotesk', 'IBM Plex Sans', 'Segoe UI', sans-serif;
  }

  .page { max-width: 1200px; margin: 0 auto; padding: 20px; }
  .top { display: flex; justify-content: space-between; align-items: end; gap: 12px; margin-bottom: 12px; }
  .top h1 { margin: 0; color: #d9e2ef; }
  .top p { margin: 4px 0 0 0; color: #7f8fa7; font-size: 12px; }

  button {
    height: 36px;
    border-radius: 8px;
    border: 1px solid #2b3746;
    background: #111a28;
    color: #c7d3e4;
    padding: 0 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .panel {
    background: linear-gradient(180deg, #0e141f, #0a1119);
    border: 1px solid #1f2b3a;
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 12px;
  }

  .search {
    width: 100%;
    box-sizing: border-box;
    height: 38px;
    border-radius: 8px;
    border: 1px solid #263240;
    background: #0a0f15;
    color: #b8c3d3;
    padding: 0 12px;
    font-size: 13px;
  }

  .list {
    max-height: calc(100vh - 230px);
    overflow: auto;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    border: 1px solid #1f2c3a;
    border-radius: 10px;
    background: #0b121b;
    padding: 9px 10px;
    margin-bottom: 8px;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .chip {
    border: 1px solid #324154;
    border-radius: 999px;
    padding: 2px 8px;
    background: #0f1724;
    color: #9fb0c8;
    font-size: 11px;
  }

  .hub { color: #f7c25a; }
  .ok { color: #00d26a; }
  .bad { color: #ff5b73; }

  .empty {
    text-align: center;
    color: #8795aa;
    padding: 16px 10px;
  }

  .error { color: #ff9db0; }
</style>
