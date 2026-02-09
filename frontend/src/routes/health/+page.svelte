<script lang="ts">
  import { onMount } from 'svelte';
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';

  type HealthData = {
    timestamp: number;
    uptime: number;
    jMachines: Array<{
      name: string;
      chainId: number;
      rpc: string[];
      status: 'healthy' | 'degraded' | 'down';
      lastBlock?: number;
      responseTime?: number;
      error?: string;
    }>;
    hubs: Array<{
      entityId: string;
      name: string;
      region?: string;
      relayUrl?: string;
      runtimeId?: string;
      online?: boolean;
      activeClients?: string[];
      status: 'healthy' | 'degraded' | 'down';
      reserves?: Record<string, string>;
      accounts?: number;
      error?: string;
    }>;
    relay?: {
      activeClients?: string[];
      activeClientCount?: number;
      clientsDetailed?: Array<{
        runtimeId: string;
        lastSeen: number;
        ageMs: number;
        topics?: string[];
      }>;
    };
    system: {
      runtime: boolean;
      p2p: boolean;
      database: boolean;
      relay: boolean;
    };
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
    encrypted?: boolean;
    size?: number;
    queueSize?: number;
    details?: unknown;
  };

  type DebugResponse = {
    ok: boolean;
    total: number;
    returned: number;
    serverTime: number;
    events: RelayDebugEvent[];
  };

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

  type DebugEntitiesResponse = {
    ok: boolean;
    totalRegistered: number;
    returned: number;
    serverTime: number;
    entities: DebugEntity[];
  };

  let health: HealthData | null = $state(null);
  let events: RelayDebugEvent[] = $state([]);
  let entities: DebugEntity[] = $state([]);
  let filteredEvents: RelayDebugEvent[] = $state([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let autoRefresh = $state(true);

  let rpcOk = $state<boolean | null>(null);
  let rpcLatencyMs = $state<number | null>(null);
  let rpcError = $state<string | null>(null);

  let search = $state('');
  let filterEvent = $state('');
  let filterMsgType = $state('');
  let filterStatus = $state('');
  let filterRuntime = $state('');
  let filterFrom = $state('');
  let filterTo = $state('');
  let onlyCritical = $state(false);

  let eventOptions: string[] = $state([]);
  let msgTypeOptions: string[] = $state([]);
  let statusOptions: string[] = $state([]);

  const BUG_PATTERNS = [
    'jsonrpcprovider failed to detect network',
    'testnet j-machine not found',
    'server_error',
    'requesturl',
    '/rpc',
    'ws_client_error',
    'envelope_decrypt_fail',
    'frame_consensus_failed',
    'route-defer',
    'deferred',
  ];

  function formatUptime(ms: number | null): string {
    if (ms === null || ms === undefined) return 'N/A';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  function formatLatency(ms?: number): string {
    if (typeof ms !== 'number') return 'N/A';
    return `${ms}ms`;
  }

  function short(id?: string, len = 10): string {
    if (!id) return '-';
    return id.length <= len ? id : `${id.slice(0, len)}...`;
  }

  function eventBlob(e: RelayDebugEvent): string {
    return JSON.stringify(e).toLowerCase();
  }

  function isCriticalEvent(e: RelayDebugEvent): boolean {
    if (e.event === 'error') return true;
    const blob = eventBlob(e);
    return BUG_PATTERNS.some((p) => blob.includes(p));
  }

  const criticalSignals = $derived(
    events.filter(isCriticalEvent).slice(-30).reverse()
  );

  function applyFilters(): void {
    const q = search.trim().toLowerCase();
    const r = filterRuntime.trim().toLowerCase();
    const f = filterFrom.trim().toLowerCase();
    const t = filterTo.trim().toLowerCase();

    filteredEvents = events
      .filter((e) => {
        if (filterEvent && e.event !== filterEvent) return false;
        if (filterMsgType && e.msgType !== filterMsgType) return false;
        if (filterStatus && e.status !== filterStatus) return false;
        if (r) {
          const hit =
            (e.runtimeId || '').toLowerCase().includes(r) ||
            (e.from || '').toLowerCase().includes(r) ||
            (e.to || '').toLowerCase().includes(r);
          if (!hit) return false;
        }
        if (f && !(e.from || '').toLowerCase().includes(f)) return false;
        if (t && !(e.to || '').toLowerCase().includes(t)) return false;
        if (onlyCritical && !isCriticalEvent(e)) return false;
        if (q && !eventBlob(e).includes(q)) return false;
        return true;
      })
      .reverse();
  }

  function clearFilters(): void {
    search = '';
    filterEvent = '';
    filterMsgType = '';
    filterStatus = '';
    filterRuntime = '';
    filterFrom = '';
    filterTo = '';
    onlyCritical = false;
    applyFilters();
  }

  async function checkRpc(): Promise<void> {
    const started = performance.now();
    try {
      const resp = await fetch('/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_chainId',
          params: [],
        }),
      });
      const ms = Math.round(performance.now() - started);
      rpcLatencyMs = ms;

      if (!resp.ok) {
        rpcOk = false;
        rpcError = `HTTP ${resp.status}`;
        return;
      }

      const body = (await resp.json()) as { result?: string; error?: unknown };
      if (!body.result) {
        rpcOk = false;
        rpcError = body.error ? JSON.stringify(body.error) : 'No chainId result';
        return;
      }
      rpcOk = true;
      rpcError = null;
    } catch (err) {
      rpcOk = false;
      rpcLatencyMs = null;
      rpcError = err instanceof Error ? err.message : String(err);
    }
  }

  async function fetchHealth(): Promise<void> {
    try {
      const [hRes, dRes, eRes] = await Promise.all([
        fetch('/api/health'),
        fetch('/api/debug/events?last=1000'),
        fetch('/api/debug/entities?limit=1000'),
      ]);

      if (!hRes.ok) throw new Error(`health HTTP ${hRes.status}`);
      if (!dRes.ok) throw new Error(`debug HTTP ${dRes.status}`);
      if (!eRes.ok) throw new Error(`entities HTTP ${eRes.status}`);

      health = (await hRes.json()) as HealthData;
      const debugData = (await dRes.json()) as DebugResponse;
      const entitiesData = (await eRes.json()) as DebugEntitiesResponse;
      events = Array.isArray(debugData.events) ? debugData.events : [];
      entities = Array.isArray(entitiesData.entities) ? entitiesData.entities : [];

      eventOptions = [...new Set(events.map((e) => e.event).filter(Boolean))].sort();
      msgTypeOptions = [...new Set(events.map((e) => e.msgType).filter(Boolean) as string[])].sort();
      statusOptions = [...new Set(events.map((e) => e.status).filter(Boolean) as string[])].sort();

      await checkRpc();
      applyFilters();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch health/debug data';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    document.body.classList.add('health-console');
    fetchHealth();
    const t = setInterval(() => {
      if (autoRefresh) fetchHealth();
    }, 4000);
    return () => {
      clearInterval(t);
      document.body.classList.remove('health-console');
    };
  });
</script>

<svelte:head>
  <title>XLN Health Console</title>
</svelte:head>

<div class="health-page">
  <header class="top">
    <div>
      <h1>XLN Health Console</h1>
      <p>Runtime + Relay diagnostics (single-source event timeline)</p>
    </div>
    <div class="actions">
      <label class="switch">
        <input type="checkbox" bind:checked={autoRefresh} />
        Auto (4s)
      </label>
      <button onclick={fetchHealth}>Refresh</button>
    </div>
  </header>

  {#if rpcOk === false}
    <section class="banner down">
      <strong>RPC DOWN</strong>
      <span>Runtime bootstrap may fail. /rpc check failed: {rpcError || 'unknown'}.</span>
    </section>
  {/if}

  {#if criticalSignals.length > 0}
    <section class="banner warn">
      <strong>Active Critical Signals</strong>
      <span>{criticalSignals.length} recent critical events detected in relay timeline.</span>
    </section>
  {/if}

  {#if loading && !health}
    <div class="panel">Loading health console...</div>
  {:else if error}
    <div class="panel error">{error}</div>
  {:else if health}
    <section class="metrics-grid">
      <article class="metric"><div class="k">Runtime</div><div class="v" class:ok={health.system.runtime} class:bad={!health.system.runtime}>{health.system.runtime ? 'healthy' : 'down'}</div></article>
      <article class="metric"><div class="k">P2P</div><div class="v" class:ok={health.system.p2p} class:bad={!health.system.p2p}>{health.system.p2p ? 'healthy' : 'down'}</div></article>
      <article class="metric"><div class="k">Relay</div><div class="v" class:ok={health.system.relay} class:bad={!health.system.relay}>{health.system.relay ? 'healthy' : 'down'}</div></article>
      <article class="metric"><div class="k">Database</div><div class="v" class:ok={health.system.database} class:bad={!health.system.database}>{health.system.database ? 'healthy' : 'down'}</div></article>
      <article class="metric"><div class="k">RPC</div><div class="v" class:ok={rpcOk === true} class:bad={rpcOk === false}>{rpcOk === null ? 'checking' : rpcOk ? `ok (${formatLatency(rpcLatencyMs || undefined)})` : 'down'}</div></article>
      <article class="metric"><div class="k">Uptime</div><div class="v">{formatUptime(health.uptime)}</div></article>
      <article class="metric"><div class="k">J Block</div><div class="v">#{health.jMachines?.[0]?.lastBlock ?? '-'}</div></article>
      <article class="metric"><div class="k">Debug Events</div><div class="v">{events.length}</div></article>
      <article class="metric"><div class="k">Relay Clients</div><div class="v">{health.relay?.activeClientCount ?? 0}</div></article>
    </section>

    <section class="panel">
      <h2>Hub Sockets</h2>
      <p class="sub">Relay-connected runtime sockets per hub</p>
      <div class="entity-list">
        {#if !health.hubs || health.hubs.length === 0}
          <div class="empty">No hubs found.</div>
        {:else}
          {#each health.hubs as hub}
            <article class="entity-row" class:entity-offline={!hub.online}>
              <EntityIdentity
                entityId={hub.entityId}
                name={hub.name}
                size={28}
                copyable={true}
                clickable={true}
                compact={false}
              />
              <div class="entity-tags">
                <span class="chip" class:ok={hub.online === true} class:bad={hub.online === false}>{hub.online ? 'online' : 'offline'}</span>
                {#if hub.runtimeId}<span class="chip">rt:{short(hub.runtimeId, 12)}</span>{/if}
                {#if hub.activeClients && hub.activeClients.length > 0}
                  {#each hub.activeClients as rt}
                    <span class="chip">ws:{short(rt, 10)}</span>
                  {/each}
                {:else}
                  <span class="chip">ws:none</span>
                {/if}
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>

    <section class="panel">
      <h2>Active Relay Clients</h2>
      <p class="sub">All live websocket clients connected to relay</p>
      <div class="entity-list">
        {#if !health.relay?.clientsDetailed || health.relay.clientsDetailed.length === 0}
          <div class="empty">No active websocket clients.</div>
        {:else}
          {#each health.relay.clientsDetailed as client}
            <article class="entity-row">
              <EntityIdentity
                entityId={client.runtimeId}
                name="runtime"
                size={24}
                copyable={true}
                clickable={false}
                compact={true}
              />
              <div class="entity-tags">
                <span class="chip">age:{Math.round(client.ageMs / 1000)}s</span>
                <span class="chip">last:{new Date(client.lastSeen).toLocaleTimeString()}</span>
                <span class="chip">topics:{client.topics?.length ?? 0}</span>
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>

    <section class="panel">
      <h2>Filters</h2>
      <div class="filters">
        <input placeholder="search" bind:value={search} oninput={applyFilters} />
        <select bind:value={filterEvent} onchange={applyFilters}>
          <option value="">event: all</option>
          {#each eventOptions as opt}<option value={opt}>{opt}</option>{/each}
        </select>
        <select bind:value={filterMsgType} onchange={applyFilters}>
          <option value="">msgType: all</option>
          {#each msgTypeOptions as opt}<option value={opt}>{opt}</option>{/each}
        </select>
        <select bind:value={filterStatus} onchange={applyFilters}>
          <option value="">status: all</option>
          {#each statusOptions as opt}<option value={opt}>{opt}</option>{/each}
        </select>
        <input placeholder="runtimeId" bind:value={filterRuntime} oninput={applyFilters} />
        <input placeholder="from" bind:value={filterFrom} oninput={applyFilters} />
        <input placeholder="to" bind:value={filterTo} oninput={applyFilters} />
        <label class="switch mini"><input type="checkbox" bind:checked={onlyCritical} onchange={applyFilters} />critical only</label>
        <button class="ghost" onclick={clearFilters}>Clear</button>
      </div>
    </section>

    <section class="panel">
      <h2>Registered Gossip Entities</h2>
      <p class="sub">{entities.length} registered in relay gossip cache</p>
      <div class="entity-list">
        {#if entities.length === 0}
          <div class="empty">No registered entities found.</div>
        {:else}
          {#each entities as entity}
            <article class="entity-row" class:entity-offline={!entity.online}>
              <EntityIdentity
                entityId={entity.entityId}
                name={entity.name}
                size={28}
                copyable={true}
                clickable={true}
                compact={false}
              />
              <div class="entity-tags">
                <span class="chip" class:ok={entity.online} class:bad={!entity.online}>{entity.online ? 'online' : 'offline'}</span>
                {#if entity.isHub}<span class="chip">hub</span>{/if}
                {#if entity.runtimeId}<span class="chip">rt:{short(entity.runtimeId, 12)}</span>{/if}
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>

    <section class="panel split">
      <div>
        <h2>Latest 1000 Debug Events</h2>
        <p class="sub">{filteredEvents.length} shown</p>
        <div class="stream">
          {#if filteredEvents.length === 0}
            <div class="empty">No events match filters.</div>
          {:else}
            {#each filteredEvents as e}
              <article class="evt" class:err={e.event === 'error' || e.status === 'rejected' || e.status === 'local-delivery-failed'} class:warn={e.status === 'queued' || e.event === 'debug_event'}>
                <div class="evt-head">
                  <span>{new Date(e.ts).toLocaleString()}</span>
                  <span class="chip">{e.event}</span>
                  {#if e.msgType}<span class="chip">{e.msgType}</span>{/if}
                  {#if e.status}<span class="chip">{e.status}</span>{/if}
                  {#if e.encrypted === true}<span class="chip">enc</span>{/if}
                </div>
                <div class="evt-meta">
                  <span>from: {short(e.from, 14)}</span>
                  <span>to: {short(e.to, 14)}</span>
                  <span>runtime: {short(e.runtimeId, 14)}</span>
                  {#if e.queueSize !== undefined}<span>queue: {e.queueSize}</span>{/if}
                  {#if e.size !== undefined}<span>size: {e.size}</span>{/if}
                </div>
                <pre>{JSON.stringify({ id: e.id, reason: e.reason, details: e.details }, null, 2)}</pre>
              </article>
            {/each}
          {/if}
        </div>
      </div>

      <div>
        <h2>Critical Bug Feed</h2>
        <p class="sub">Visual failures impacting runtime boot, payments, or routing</p>
        <div class="stream small">
          {#if criticalSignals.length === 0}
            <div class="empty">No active critical signals in latest window.</div>
          {:else}
            {#each criticalSignals as e}
              <article class="evt err compact">
                <div class="evt-head">
                  <span>{new Date(e.ts).toLocaleTimeString()}</span>
                  <span class="chip">{e.event}</span>
                  {#if e.msgType}<span class="chip">{e.msgType}</span>{/if}
                </div>
                <div class="evt-meta">
                  <span>{e.reason || 'critical pattern match'}</span>
                </div>
                <pre>{JSON.stringify(e.details ?? e, null, 2)}</pre>
              </article>
            {/each}
          {/if}
        </div>
      </div>
    </section>

    <footer>
      Last updated: {new Date(health.timestamp).toLocaleString()}
    </footer>
  {/if}
</div>

<style>
  :global(body.health-console) {
    margin: 0;
    background: radial-gradient(1200px 700px at 5% -10%, #111926 0%, #06080b 55%, #05070a 100%);
    color: #b7c2d3;
    font-family: 'Space Grotesk', 'IBM Plex Sans', 'SF Pro Text', 'Segoe UI', sans-serif;
  }

  .health-page {
    max-width: 1680px;
    margin: 0 auto;
    padding: 24px 20px 18px;
  }

  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  h1 {
    margin: 0;
    font-size: clamp(28px, 3vw, 40px);
    letter-spacing: 0.2px;
    color: #d6deea;
  }

  h2 {
    margin: 0 0 6px 0;
    font-size: 16px;
    letter-spacing: 0.2px;
  }

  .top p,
  .sub {
    margin: 4px 0 0 0;
    color: #6f7d93;
    font-size: 12px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .switch {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: #94a3b8;
    background: #0b1018;
    border: 1px solid #1e2a38;
    border-radius: 8px;
    padding: 8px 10px;
  }

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

  .banner {
    display: flex;
    gap: 10px;
    align-items: center;
    border-radius: 10px;
    border: 1px solid;
    padding: 10px 12px;
    margin-bottom: 10px;
  }

  .banner.down {
    background: #220f16;
    border-color: #6c2335;
    color: #ff9db0;
  }

  .banner.warn {
    background: #1d160b;
    border-color: #6a5120;
    color: #f4d694;
  }

  .panel {
    background: linear-gradient(180deg, #0e141f, #0a1119);
    border: 1px solid #1f2b3a;
    border-radius: 12px;
    padding: 13px;
    margin-bottom: 12px;
  }

  .panel.error {
    border-color: #6a2435;
    color: #ff9db0;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }

  .metric {
    background: linear-gradient(180deg, #0a1119, #080f16);
    border: 1px solid #1f2b3a;
    border-radius: 12px;
    padding: 12px;
    min-height: 76px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .k {
    color: #6f7d93;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 10px;
  }

  .v {
    margin-top: 5px;
    font-weight: 700;
    font-size: 20px;
    color: #c6d1df;
  }

  .ok { color: #00d26a; }
  .bad { color: #ff5b73; }

  .filters {
    display: grid;
    grid-template-columns: 1.4fr repeat(3, minmax(120px, 0.8fr)) repeat(3, minmax(120px, 1fr)) minmax(160px, 0.9fr) 96px;
    gap: 8px;
  }

  .filters input,
  .filters select {
    height: 36px;
    border: 1px solid #263240;
    border-radius: 8px;
    background: #0a0f15;
    color: #b8c3d3;
    padding: 0 10px;
    font-size: 12px;
    min-width: 0;
  }

  .ghost {
    background: #0d131b;
  }

  .split {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(380px, 1fr);
    gap: 12px;
  }

  .stream {
    border: 1px solid #1c2836;
    border-radius: 10px;
    background: #070c13;
    padding: 10px;
    max-height: calc(100vh - 350px);
    min-height: 500px;
    overflow: auto;
  }

  .entity-list {
    border: 1px solid #1c2836;
    border-radius: 10px;
    background: #070c13;
    max-height: 300px;
    overflow: auto;
    padding: 8px;
  }

  .entity-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border: 1px solid #1f2c3a;
    border-radius: 9px;
    background: #0b121b;
    margin-bottom: 8px;
  }

  .entity-offline {
    opacity: 0.8;
  }

  .entity-tags {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }

  .stream.small {
    max-height: calc(100vh - 350px);
  }

  .evt {
    border: 1px solid #1f2c3a;
    border-radius: 9px;
    background: #0b121b;
    padding: 9px 10px;
    margin-bottom: 8px;
  }

  .evt.warn {
    border-color: #564218;
    background: #161208;
  }

  .evt.err {
    border-color: #5f2031;
    background: #160a10;
  }

  .evt.compact pre {
    max-height: 120px;
  }

  .evt-head,
  .evt-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
    font-size: 11px;
    color: #7f8fa7;
  }

  .chip {
    border: 1px solid #324154;
    border-radius: 999px;
    padding: 1px 7px;
    background: #0f1724;
    color: #9fb0c8;
  }

  pre {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: #9fb0c8;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty {
    color: #8795aa;
    text-align: center;
    padding: 20px 8px;
    font-size: 13px;
  }

  footer {
    color: #8a97aa;
    font-size: 12px;
    text-align: right;
  }

  @media (max-width: 1180px) {
    .metrics-grid { grid-template-columns: repeat(4, minmax(110px, 1fr)); }
    .filters { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    .split { grid-template-columns: 1fr; }
    .stream { max-height: 420px; min-height: 280px; }
  }
</style>
