<script lang="ts">
  import { page } from '$app/stores';
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';

  type DebugEntity = {
    entityId: string;
    runtimeId?: string;
    name: string;
    isHub: boolean;
    online: boolean;
    lastUpdated: number;
    capabilities: string[];
    metadata: Record<string, unknown>;
  };

  type RelayDebugEvent = {
    id: number;
    ts: number;
    event: string;
    runtimeId?: string;
    from?: string;
    to?: string;
    msgType?: string;
    status?: string;
    reason?: string;
    details?: unknown;
  };

  let loading = true;
  let error: string | null = null;
  let entity: DebugEntity | null = null;
  let events: RelayDebugEvent[] = [];
  let lastLoadedEntityId = '';

  $: entityId = decodeURIComponent($page.params.entityId || '').trim();
  $: normalized = entityId.toLowerCase();
  $: validEntityId = /^0x[0-9a-f]{64}$/.test(normalized);

  function matchesEntity(event: RelayDebugEvent, id: string): boolean {
    const blob = JSON.stringify(event).toLowerCase();
    return blob.includes(id);
  }

  async function fetchExplorer(): Promise<void> {
    if (!validEntityId) {
      loading = false;
      error = 'Invalid entity id format. Expected 0x + 64 hex chars.';
      return;
    }
    loading = true;
    error = null;
    try {
      const [entitiesRes, eventsRes] = await Promise.all([
        fetch('/api/debug/entities?limit=1000'),
        fetch('/api/debug/events?last=1000'),
      ]);
      if (!entitiesRes.ok) throw new Error(`entities HTTP ${entitiesRes.status}`);
      if (!eventsRes.ok) throw new Error(`events HTTP ${eventsRes.status}`);

      const entitiesData = await entitiesRes.json() as { entities?: DebugEntity[] };
      const eventsData = await eventsRes.json() as { events?: RelayDebugEvent[] };
      const allEntities = Array.isArray(entitiesData.entities) ? entitiesData.entities : [];
      const allEvents = Array.isArray(eventsData.events) ? eventsData.events : [];
      entity = allEntities.find((e) => e.entityId.toLowerCase() === normalized) || null;
      events = allEvents.filter((e) => matchesEntity(e, normalized)).slice(-300).reverse();
      if (!entity) error = 'Entity not found in registered gossip profiles.';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load entity explorer';
    } finally {
      loading = false;
    }
  }

  $: if (entityId && entityId !== lastLoadedEntityId) {
    lastLoadedEntityId = entityId;
    fetchExplorer();
  }
</script>

<svelte:head>
  <title>XLN Entity Explorer</title>
</svelte:head>

<div class="page">
  <header class="top">
    <h1>Entity Explorer</h1>
    <a href="/health">Back to Health</a>
  </header>

  {#if loading}
    <div class="panel">Loading explorer...</div>
  {:else if error}
    <div class="panel error">{error}</div>
  {/if}

  {#if entity}
    <section class="panel">
      <EntityIdentity entityId={entity.entityId} name={entity.name} size={40} />
      <div class="meta">
        <span class="chip" class:ok={entity.online} class:bad={!entity.online}>{entity.online ? 'online' : 'offline'}</span>
        {#if entity.isHub}<span class="chip">hub</span>{/if}
        {#if entity.runtimeId}<span class="chip">runtime: {entity.runtimeId.slice(0, 14)}...</span>{/if}
        <span class="chip">updated: {entity.lastUpdated ? new Date(entity.lastUpdated).toLocaleString() : 'n/a'}</span>
      </div>
      <div class="caps">
        {#if entity.capabilities?.length}
          {#each entity.capabilities as cap}
            <span class="chip">{cap}</span>
          {/each}
        {:else}
          <span class="muted">No capabilities declared</span>
        {/if}
      </div>
      <pre>{JSON.stringify(entity.metadata || {}, null, 2)}</pre>
    </section>
  {/if}

  <section class="panel">
    <h2>Recent Related Relay Events</h2>
    <p class="muted">{events.length} events</p>
    <div class="event-list">
      {#if events.length === 0}
        <div class="muted">No related events in latest relay window.</div>
      {:else}
        {#each events as e}
          <article class="evt">
            <div class="head">
              <span>{new Date(e.ts).toLocaleString()}</span>
              <span class="chip">{e.event}</span>
              {#if e.msgType}<span class="chip">{e.msgType}</span>{/if}
              {#if e.status}<span class="chip">{e.status}</span>{/if}
            </div>
            <pre>{JSON.stringify({ from: e.from, to: e.to, runtimeId: e.runtimeId, reason: e.reason, details: e.details }, null, 2)}</pre>
          </article>
        {/each}
      {/if}
    </div>
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
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .top h1 { margin: 0; color: #e2e8f2; }
  .top a { color: #92a5bc; text-decoration: none; }
  .panel {
    background: linear-gradient(180deg, #0e141f, #0a1119);
    border: 1px solid #1f2b3a;
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .error { border-color: #6a2435; color: #ff9db0; }
  .meta, .caps { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .chip {
    border: 1px solid #324154;
    border-radius: 999px;
    padding: 2px 8px;
    background: #0f1724;
    color: #9fb0c8;
    font-size: 11px;
  }
  .ok { color: #00d26a; }
  .bad { color: #ff5b73; }
  h2 { margin: 0 0 6px 0; }
  .muted { color: #7f8fa7; font-size: 12px; }
  .event-list { max-height: 60vh; overflow: auto; }
  .evt {
    border: 1px solid #1f2c3a;
    border-radius: 9px;
    background: #0b121b;
    padding: 9px 10px;
    margin-bottom: 8px;
  }
  .head { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; font-size: 11px; color: #7f8fa7; }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    color: #a7b5c8;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
</style>
