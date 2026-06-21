<script lang="ts">
  import { onMount } from 'svelte';
  import { Activity, Camera, Database, Network, RefreshCw, ShieldCheck, Siren, Zap } from 'lucide-svelte';
  import BootstrapLive from '$lib/components/Health/BootstrapLive.svelte';
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';

  type HealthData = {
    timestamp: number;
    coreOk?: boolean | undefined;
    systemOk?: boolean | undefined;
    degraded?: string[];
    uptime?: number | null;
    reset?: {
      inProgress?: boolean;
      startedAt?: number | null;
      completedAt?: number | null;
      failedAt?: number | null;
      resolvedAt?: number | null;
      lastError?: string | null;
      hasError?: boolean;
    };
    boot?: {
      phase?: string | null;
      startedAt?: number | null;
      completedAt?: number | null;
      error?: string | null;
    };
    jMachines?: Array<{
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
      clientCount?: number;
      profileCount?: number;
      clientsDetailed?: Array<{
        runtimeId: string;
        lastSeen: number;
        ageMs: number;
        topics?: string[];
      }>;
    };
    system: {
      runtime: boolean;
      p2p?: boolean;
      relay: boolean;
    };
    process?: {
      uptimeSec?: number;
      rssBytes?: number;
      heapUsedBytes?: number;
      memory?: {
        freeBytes?: number;
        totalBytes?: number;
        freePct?: number;
      };
      children?: Array<{
        role?: string;
        name: string;
        online: boolean;
        restartCount?: number;
        apiPort?: number;
        lastErrorLine?: string | null;
        recentStdout?: string[];
        recentStderr?: string[];
      }>;
    };
    disk?: {
      ok?: boolean;
      freeBytes?: number;
      usedBytes?: number;
      totalBytes?: number;
      freeGiB?: number;
      usedPct?: number;
    };
    storage?: {
      ok?: boolean;
      tracked?: Array<{
        name: string;
        kind: string;
        currentBytes: number;
        bytesPerHour: number;
        scanTruncated: boolean;
      }>;
    };
    hubMesh?: {
      ok?: boolean;
      direct?: {
        openLinkCount?: number;
      };
      pairs?: Array<{ left: string; right: string; ok: boolean }>;
    };
    marketMaker?: {
      enabled?: boolean;
      ok?: boolean;
      entityId?: string | null;
      startupPhase?: string | null;
      expectedOffersPerHub?: number;
      expectedOffersPerPair?: number;
      hubCount?: number;
      cross?: {
        applicable?: boolean;
        ok?: boolean;
        expectedRoutes?: number;
        expectedOffersPerRoute?: number;
        expectedOffersPerPair?: number;
        routeCount?: number;
        expectedPairs?: number;
        routes?: Array<{
          sourceJurisdiction?: string;
          targetJurisdiction?: string;
          sourceHubEntityId?: string;
          targetHubEntityId?: string;
          offers?: number;
          ready?: boolean;
          depthReady?: boolean;
          expectedOffers?: number;
          pairs?: Array<{
            pairId?: string;
            offers?: number;
            ready?: boolean;
            depthReady?: boolean;
            expectedOffers?: number;
            sourceTokenIds?: number[];
            targetTokenIds?: number[];
          }>;
        }>;
      };
      hubs?: Array<{
        hubEntityId: string;
        offers: number;
        ready: boolean;
        depthReady?: boolean;
        pairs?: Array<{
          pairId: string;
          offers: number;
          ready: boolean;
          depthReady?: boolean;
          expectedOffers?: number;
        }>;
      }>;
    };
    custody?: {
      enabled?: boolean;
      ok?: boolean;
      entityId?: string | null;
    };
    bootstrapReserves?: {
      ok?: boolean;
      targetMet?: boolean;
      requiredTokenCount?: number;
      entityCount?: number;
      entities?: Array<{
        entityId: string;
        role?: 'hub' | 'market-maker';
        ready: boolean;
        targetMet: boolean;
        tokens: Array<{
          tokenId: number;
          symbol: string;
          decimals?: number;
          current?: string;
          expectedMin?: string;
          ready: boolean;
          operational?: boolean;
          targetMet?: boolean;
        }>;
      }>;
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

  type QaStoryScreenshot = {
    id: string;
    source: 'e2e-screenshots' | 'qa-run';
    title: string;
    group: string;
    name: string;
    relativePath: string;
    sizeBytes: number;
    updatedAt: number;
    url: string;
    runId?: string;
    shard?: number;
    status?: 'passed' | 'failed' | 'unknown';
  };

  type TestnetGate = {
    label: string;
    value: string;
    detail: string;
    ok: boolean | null;
  };

  type FlowEdge = {
    key: string;
    from: string;
    to: string;
    count: number;
    critical: number;
    lastTs: number;
  };

  let health = $state<HealthData | null>(null);
  let events = $state<RelayDebugEvent[]>([]);
  let entities = $state<DebugEntity[]>([]);
  let stories = $state<QaStoryScreenshot[]>([]);
  let filteredEvents = $state<RelayDebugEvent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let storyError = $state<string | null>(null);
  let autoRefresh = $state(true);
  let activeSection = $state('bootstrap');
  let storyGroupFilter = $state('all');
  let selectedStoryId = $state('');

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

  let eventOptions = $state<string[]>([]);
  let msgTypeOptions = $state<string[]>([]);
  let statusOptions = $state<string[]>([]);

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

  function normalizeHealthData(raw: unknown): HealthData {
    const input = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const rawSystem = (input['system'] && typeof input['system'] === 'object') ? input['system'] as Record<string, unknown> : {};
    const rawHubs = Array.isArray(input['hubs']) ? input['hubs'] as HealthData['hubs'] : [];
    const activeClientIds = Array.from(new Set(
      rawHubs.flatMap((hub) => Array.isArray(hub?.activeClients) ? hub.activeClients : [])
    ));
    const relay = (input['relay'] && typeof input['relay'] === 'object') ? input['relay'] as HealthData['relay'] : undefined;
    const hubMesh = (input['hubMesh'] && typeof input['hubMesh'] === 'object') ? input['hubMesh'] as HealthData['hubMesh'] : undefined;
    const processHealth = (input['process'] && typeof input['process'] === 'object') ? input['process'] as HealthData['process'] : undefined;
    const disk = (input['disk'] && typeof input['disk'] === 'object') ? input['disk'] as HealthData['disk'] : undefined;
    const storage = (input['storage'] && typeof input['storage'] === 'object') ? input['storage'] as HealthData['storage'] : undefined;
    const marketMaker = (input['marketMaker'] && typeof input['marketMaker'] === 'object') ? input['marketMaker'] as HealthData['marketMaker'] : undefined;
    const bootstrapReserves = (input['bootstrapReserves'] && typeof input['bootstrapReserves'] === 'object')
      ? input['bootstrapReserves'] as HealthData['bootstrapReserves']
      : undefined;
    const custody = (input['custody'] && typeof input['custody'] === 'object') ? input['custody'] as HealthData['custody'] : undefined;
    const reset = (input['reset'] && typeof input['reset'] === 'object') ? input['reset'] as HealthData['reset'] : undefined;

    const normalizedRelay: NonNullable<HealthData['relay']> = {
      activeClients: relay?.activeClients ?? activeClientIds,
      activeClientCount: typeof relay?.activeClientCount === 'number'
        ? relay.activeClientCount
        : typeof relay?.clientCount === 'number'
          ? relay.clientCount
          : activeClientIds.length,
      clientsDetailed: relay?.clientsDetailed ?? [],
    };
    if (typeof relay?.clientCount === 'number') normalizedRelay.clientCount = relay.clientCount;

    const normalized: HealthData = {
      timestamp: typeof input['timestamp'] === 'number' ? input['timestamp'] : Date.now(),
      coreOk: typeof input['coreOk'] === 'boolean' ? input['coreOk'] : undefined,
      systemOk: typeof input['systemOk'] === 'boolean' ? input['systemOk'] : undefined,
      degraded: Array.isArray(input['degraded']) ? input['degraded'].map(String) : [],
      uptime: typeof input['uptime'] === 'number'
        ? input['uptime']
        : typeof processHealth?.uptimeSec === 'number'
          ? processHealth.uptimeSec * 1000
          : null,
      jMachines: (Array.isArray(input['jMachines']) ? input['jMachines'] : []) as NonNullable<HealthData['jMachines']>,
      hubs: rawHubs,
      relay: normalizedRelay,
      system: {
        runtime: Boolean(rawSystem['runtime']),
        relay: Boolean(rawSystem['relay']),
        p2p: typeof rawSystem['p2p'] === 'boolean' ? rawSystem['p2p'] : Boolean(hubMesh?.ok),
      },
    };
    if (reset) normalized.reset = reset;
    if (processHealth) normalized.process = processHealth;
    if (disk) normalized.disk = disk;
    if (storage) normalized.storage = storage;
    if (marketMaker) normalized.marketMaker = marketMaker;
    if (hubMesh) normalized.hubMesh = hubMesh;
    if (custody) normalized.custody = custody;
    if (bootstrapReserves) normalized.bootstrapReserves = bootstrapReserves;
    return normalized;
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

  const onlineHubs = $derived(health?.hubs?.filter((hub) => hub.online).length ?? 0);
  const totalHubs = $derived(health?.hubs?.length ?? 0);
  const directOpenLinks = $derived(health?.hubMesh?.direct?.openLinkCount ?? 0);
  const storageTracked = $derived((health?.storage?.tracked ?? []).slice(0, 6));
  const childProcesses = $derived(health?.process?.children ?? []);
  const storyGroups = $derived(['all', ...Array.from(new Set(stories.map((story) => story.group))).sort()]);
  const filteredStories = $derived.by(() => {
    const selected = storyGroupFilter;
    return stories.filter((story) => selected === 'all' || story.group === selected).slice(0, 80);
  });
  const selectedStory = $derived.by(() =>
    filteredStories.find((story) => story.id === selectedStoryId) ?? filteredStories[0] ?? null
  );
  const flowEdges = $derived.by(() => buildFlowEdges(events).slice(0, 12));
  const testnetGates = $derived.by<TestnetGate[]>(() => buildTestnetGates(health, rpcOk));
  const overallOk = $derived(
    (health?.systemOk ?? health?.coreOk ?? false) && rpcOk !== false && criticalSignals.length === 0
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
        console.error(
          '%c[RPC FAIL-FAST] /rpc health check failed',
          'background:#3b0000;color:#ff4d4f;font-weight:800;padding:2px 6px;border-radius:4px;',
          { status: resp.status }
        );
        return;
      }

      const body = (await resp.json()) as { result?: string; error?: unknown };
      if (!body.result) {
        rpcOk = false;
        rpcError = body.error ? JSON.stringify(body.error) : 'No chainId result';
        console.error(
          '%c[RPC FAIL-FAST] /rpc malformed health response',
          'background:#3b0000;color:#ff4d4f;font-weight:800;padding:2px 6px;border-radius:4px;',
          { body }
        );
        return;
      }
      rpcOk = true;
      rpcError = null;
    } catch (err) {
      rpcOk = false;
      rpcLatencyMs = null;
      rpcError = err instanceof Error ? err.message : String(err);
      console.error(
        '%c[RPC FAIL-FAST] /rpc health request threw',
        'background:#3b0000;color:#ff4d4f;font-weight:800;padding:2px 6px;border-radius:4px;',
        { error: rpcError }
      );
    }
  }

  function formatBytes(bytes: number | null | undefined): string {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
    const value = Number(bytes);
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${value} B`;
  }

  function formatCount(value: number | null | undefined): string {
    if (!Number.isFinite(Number(value))) return '0';
    return new Intl.NumberFormat('en-US').format(Number(value));
  }

  function endpointLabel(value?: string): string {
    if (!value) return 'local';
    if (value.length <= 14) return value;
    return `${value.slice(0, 8)}...${value.slice(-4)}`;
  }

  function buildFlowEdges(input: RelayDebugEvent[]): FlowEdge[] {
    const edges = new Map<string, FlowEdge>();
    for (const event of input) {
      const from = endpointLabel(event.from || event.runtimeId || 'runtime');
      const to = endpointLabel(event.to || event.msgType || event.event || 'sink');
      const key = `${from}->${to}`;
      const existing = edges.get(key) ?? { key, from, to, count: 0, critical: 0, lastTs: 0 };
      existing.count += 1;
      existing.lastTs = Math.max(existing.lastTs, event.ts || 0);
      if (isCriticalEvent(event)) existing.critical += 1;
      edges.set(key, existing);
    }
    return Array.from(edges.values()).sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  }

  function buildTestnetGates(data: HealthData | null, rpcHealthy: boolean | null): TestnetGate[] {
    if (!data) return [];
    const marketMakerEnabled = data.marketMaker?.enabled === true;
    const custodyEnabled = data.custody?.enabled === true;
    const crossApplicable = data.marketMaker?.cross?.applicable !== false;
    return [
      {
        label: 'Core',
        value: data.coreOk === false ? 'down' : 'ready',
        detail: `${onlineHubs}/${totalHubs} hubs online`,
        ok: data.coreOk ?? null,
      },
      {
        label: 'System',
        value: data.systemOk === false ? 'degraded' : 'ready',
        detail: (data.degraded ?? []).length > 0 ? (data.degraded ?? []).join(', ') : 'no fatal degraded gates',
        ok: data.systemOk ?? null,
      },
      {
        label: 'RPC',
        value: rpcHealthy === null ? 'checking' : rpcHealthy ? formatLatency(rpcLatencyMs ?? undefined) : 'down',
        detail: rpcError || 'eth_chainId reachable through /rpc',
        ok: rpcHealthy,
      },
      {
        label: 'Direct Mesh',
        value: `${directOpenLinks} links`,
        detail: `${data.hubMesh?.pairs?.filter((pair) => pair.ok).length ?? 0}/${data.hubMesh?.pairs?.length ?? 0} hub pairs`,
        ok: data.hubMesh?.ok ?? null,
      },
      {
        label: 'Market Maker',
        value: marketMakerEnabled ? (data.marketMaker?.startupPhase || 'enabled') : 'disabled',
        detail: marketMakerEnabled ? `${data.marketMaker?.hubs?.filter((hub) => hub.ready).length ?? 0}/${data.marketMaker?.hubs?.length ?? 0} hubs ready` : 'not required',
        ok: marketMakerEnabled ? data.marketMaker?.ok ?? null : true,
      },
      {
        label: 'Cross-J Routes',
        value: `${formatCount(data.marketMaker?.cross?.expectedRoutes ?? 0)} expected`,
        detail: `${formatCount(data.marketMaker?.cross?.expectedPairs ?? 0)} pairs`,
        ok: marketMakerEnabled && crossApplicable ? data.marketMaker?.cross?.ok ?? null : true,
      },
      {
        label: 'Custody',
        value: custodyEnabled ? (data.custody?.ok ? 'ready' : 'down') : 'disabled',
        detail: custodyEnabled ? 'daemon + service health' : 'not required',
        ok: custodyEnabled ? data.custody?.ok ?? null : true,
      },
      {
        label: 'Bootstrap Reserves',
        value: `${formatCount(data.bootstrapReserves?.entityCount ?? 0)} entities`,
        detail: `${formatCount(data.bootstrapReserves?.requiredTokenCount ?? 0)} token targets`,
        ok: (data.bootstrapReserves?.ok ?? false) && (data.bootstrapReserves?.targetMet ?? false),
      },
      {
        label: 'Storage',
        value: data.disk?.freeGiB !== undefined ? `${data.disk.freeGiB.toFixed(1)} GiB free` : formatBytes(data.disk?.freeBytes),
        detail: `${data.disk?.usedPct ?? 0}% disk used`,
        ok: data.storage?.ok ?? data.disk?.ok ?? null,
      },
    ];
  }

  function jumpTo(section: string): void {
    activeSection = section;
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function fetchHealth(): Promise<void> {
    try {
      const [hRes, dRes, eRes, sRes] = await Promise.all([
        fetch('/api/health'),
        fetch('/api/debug/events?last=1000'),
        fetch('/api/debug/entities?limit=1000'),
        fetch('/api/qa/stories?limit=160'),
      ]);

      if (!hRes.ok) throw new Error(`health HTTP ${hRes.status}`);
      if (!dRes.ok) throw new Error(`debug HTTP ${dRes.status}`);
      if (!eRes.ok) throw new Error(`entities HTTP ${eRes.status}`);
      if (!sRes.ok) throw new Error(`stories HTTP ${sRes.status}`);

      health = normalizeHealthData(await hRes.json());
      const debugData = (await dRes.json()) as DebugResponse;
      const entitiesData = (await eRes.json()) as DebugEntitiesResponse;
      const storiesData = (await sRes.json()) as { ok?: boolean; stories?: QaStoryScreenshot[]; error?: string };
      events = Array.isArray(debugData.events) ? debugData.events : [];
      entities = Array.isArray(entitiesData.entities) ? entitiesData.entities : [];
      if (!storiesData.ok || !Array.isArray(storiesData.stories)) {
        throw new Error(storiesData.error || 'stories payload malformed');
      }
      stories = storiesData.stories;
      storyError = null;

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
  <title>xln Health Admin</title>
</svelte:head>

<div class="health-page">
  <header class="top">
    <div>
      <div class="eyebrow">operator cockpit</div>
      <h1>xln health admin</h1>
      <p>Runtime, mesh, market maker, QA evidence, screenshots.</p>
    </div>
    <div class="actions">
      <label class="switch">
        <input type="checkbox" bind:checked={autoRefresh} />
        Auto (4s)
      </label>
      <button class="icon-button" onclick={fetchHealth} title="Refresh health data" aria-label="Refresh health data">
        <RefreshCw size={16} />
        Refresh
      </button>
    </div>
  </header>

  <nav class="section-tabs" aria-label="Health admin sections">
    <button class:active={activeSection === 'bootstrap'} onclick={() => jumpTo('bootstrap')}>
      <Zap size={15} /> Bootstrap
    </button>
    <button class:active={activeSection === 'overview'} onclick={() => jumpTo('overview')}>
      <Activity size={15} /> Overview
    </button>
    <button class:active={activeSection === 'topology'} onclick={() => jumpTo('topology')}>
      <Network size={15} /> Topology
    </button>
    <button class:active={activeSection === 'testset'} onclick={() => jumpTo('testset')}>
      <ShieldCheck size={15} /> Test Set
    </button>
    <button class:active={activeSection === 'stories'} onclick={() => jumpTo('stories')}>
      <Camera size={15} /> Stories
    </button>
    <button class:active={activeSection === 'events'} onclick={() => jumpTo('events')}>
      <Siren size={15} /> Events
    </button>
  </nav>

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
    <BootstrapLive
      {health}
      {rpcOk}
      {rpcLatencyMs}
      criticalCount={criticalSignals.length}
    />

    <section id="overview" class="hero-console">
      <div class="readiness-tile" class:ready={overallOk} class:failed={!overallOk}>
        <span class="pulse"></span>
        <div>
          <div class="eyebrow">readiness</div>
          <strong>{overallOk ? 'green' : 'attention'}</strong>
          <p>{(health.degraded ?? []).length > 0 ? (health.degraded ?? []).join(', ') : 'core gates clear'}</p>
        </div>
      </div>

      <div class="architecture-strip" aria-label="Runtime architecture map">
        <article class="arch-node" class:ok={health.system.runtime} class:bad={!health.system.runtime}>
          <span>J</span>
          <strong>J-machine</strong>
          <small>block #{health.jMachines?.[0]?.lastBlock ?? '-'}</small>
        </article>
        <div class="arch-link"></div>
        <article class="arch-node" class:ok={onlineHubs === totalHubs && totalHubs > 0} class:bad={onlineHubs !== totalHubs}>
          <span>E</span>
          <strong>Hub entities</strong>
          <small>{onlineHubs}/{totalHubs} online</small>
        </article>
        <div class="arch-link"></div>
        <article class="arch-node" class:ok={health.hubMesh?.ok === true} class:bad={health.hubMesh?.ok === false}>
          <span>A</span>
          <strong>Direct mesh</strong>
          <small>{directOpenLinks} links</small>
        </article>
        <div class="arch-link"></div>
        <article class="arch-node" class:ok={health.system.relay} class:bad={!health.system.relay}>
          <span>R</span>
          <strong>Relay</strong>
          <small>{health.relay?.activeClientCount ?? health.relay?.clientCount ?? 0} clients</small>
        </article>
        <div class="arch-link"></div>
        <article class="arch-node" class:ok={health.marketMaker?.ok !== false} class:bad={health.marketMaker?.ok === false}>
          <span>MM</span>
          <strong>Market maker</strong>
          <small>{health.marketMaker?.enabled ? health.marketMaker?.startupPhase ?? 'enabled' : 'disabled'}</small>
        </article>
      </div>
    </section>

    <section class="metrics-grid">
      <article class="metric"><div class="k">Core</div><div class="v" class:ok={health.coreOk !== false} class:bad={health.coreOk === false}>{health.coreOk === false ? 'down' : 'ready'}</div></article>
      <article class="metric"><div class="k">System</div><div class="v" class:ok={health.systemOk !== false} class:bad={health.systemOk === false}>{health.systemOk === false ? 'degraded' : 'ready'}</div></article>
      <article class="metric"><div class="k">Runtime</div><div class="v" class:ok={health.system.runtime} class:bad={!health.system.runtime}>{health.system.runtime ? 'healthy' : 'down'}</div></article>
      <article class="metric"><div class="k">P2P</div><div class="v" class:ok={health.system.p2p} class:bad={!health.system.p2p}>{health.system.p2p ? 'healthy' : 'down'}</div></article>
      <article class="metric"><div class="k">Relay</div><div class="v" class:ok={health.system.relay} class:bad={!health.system.relay}>{health.system.relay ? 'healthy' : 'down'}</div></article>
      <article class="metric"><div class="k">RPC</div><div class="v" class:ok={rpcOk === true} class:bad={rpcOk === false}>{rpcOk === null ? 'checking' : rpcOk ? `ok (${formatLatency(rpcLatencyMs ?? undefined)})` : 'down'}</div></article>
      <article class="metric"><div class="k">Uptime</div><div class="v">{formatUptime(health.uptime ?? null)}</div></article>
      <article class="metric"><div class="k">J Block</div><div class="v">#{health.jMachines?.[0]?.lastBlock ?? '-'}</div></article>
      <article class="metric"><div class="k">Direct Links</div><div class="v">{directOpenLinks}</div></article>
      <article class="metric"><div class="k">Disk Free</div><div class="v" class:ok={health.disk?.ok !== false} class:bad={health.disk?.ok === false}>{health.disk?.freeGiB !== undefined ? `${health.disk.freeGiB.toFixed(1)} GiB` : formatBytes(health.disk?.freeBytes)}</div></article>
      <article class="metric"><div class="k">Debug Events</div><div class="v">{events.length}</div></article>
      <article class="metric"><div class="k">Relay Clients</div><div class="v">{health.relay?.activeClientCount ?? 0}</div></article>
    </section>

    <section id="testset" class="panel">
      <div class="panel-head">
        <div>
          <h2>Top Testnet Gates</h2>
          <p class="sub">Capped-testnet acceptance surface</p>
        </div>
        <a class="panel-link" href="/qa">QA cockpit</a>
      </div>
      <div class="gate-grid">
        {#each testnetGates as gate}
          <article class="gate" class:ok={gate.ok === true} class:bad={gate.ok === false}>
            <div class="gate-status"></div>
            <div>
              <strong>{gate.label}</strong>
              <span>{gate.value}</span>
              <small>{gate.detail}</small>
            </div>
          </article>
        {/each}
      </div>
      <div class="command-strip">
        <code>bun test runtime/__tests__/qa-story-report.test.ts</code>
        <code>bun run prod:health:capped-testnet</code>
        <code>bun run gate:capped-testnet</code>
      </div>
    </section>

    <section id="topology" class="panel split topology-split">
      <div>
        <div class="panel-head">
          <div>
            <h2>Process Health</h2>
            <p class="sub">Managed runtimes and restart pressure</p>
          </div>
          <Database size={17} />
        </div>
        <div class="process-grid">
          {#if childProcesses.length === 0}
            <div class="empty">No child process health in payload.</div>
          {:else}
            {#each childProcesses as child}
              <article class="process-row" class:ok={child.online} class:bad={!child.online}>
                <div>
                  <strong>{child.name}</strong>
                  <span>{child.role ?? 'runtime'} · :{child.apiPort ?? '-'}</span>
                </div>
                <div>
                  <span>{child.online ? 'online' : 'down'}</span>
                  <small>restarts {child.restartCount ?? 0}</small>
                </div>
                {#if child.lastErrorLine}
                  <pre>{child.lastErrorLine}</pre>
                {/if}
              </article>
            {/each}
          {/if}
        </div>
      </div>

      <div>
        <div class="panel-head">
          <div>
            <h2>Storage Pressure</h2>
            <p class="sub">Tracked db/log growth</p>
          </div>
          <span class="chip" class:ok={health.storage?.ok === true} class:bad={health.storage?.ok === false}>{health.storage?.ok === false ? 'bad' : 'ok'}</span>
        </div>
        <div class="storage-list">
          {#if storageTracked.length === 0}
            <div class="empty">No storage tracks in payload.</div>
          {:else}
            {#each storageTracked as track}
              <article class="storage-row" class:bad={track.scanTruncated}>
                <span>{track.name}</span>
                <strong>{formatBytes(track.currentBytes)}</strong>
                <small>{formatBytes(track.bytesPerHour)}/h {track.scanTruncated ? 'truncated' : track.kind}</small>
              </article>
            {/each}
          {/if}
        </div>
      </div>
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

    <section id="stories" class="panel story-panel">
      <div class="panel-head">
        <div>
          <h2>User Story Screenshots</h2>
          <p class="sub">{stories.length} real image artifacts from disk</p>
        </div>
        <div class="story-controls">
          <select bind:value={storyGroupFilter}>
            {#each storyGroups as group}
              <option value={group}>{group}</option>
            {/each}
          </select>
          <a class="panel-link" href="/qa">Run history</a>
        </div>
      </div>

      {#if storyError}
        <div class="panel error">{storyError}</div>
      {:else if filteredStories.length === 0}
        <div class="empty">No screenshots found in story catalog.</div>
      {:else}
        <div class="story-layout">
          <div class="story-stage">
            {#if selectedStory}
              <a href={selectedStory.url} target="_blank" rel="noreferrer">
                <img src={selectedStory.url} alt={selectedStory.title} loading="eager" />
              </a>
              <div class="story-caption">
                <div>
                  <strong>{selectedStory.title}</strong>
                  <span>{selectedStory.group} · {selectedStory.source}{selectedStory.runId ? ` · ${selectedStory.runId}` : ''}</span>
                </div>
                <span>{formatBytes(selectedStory.sizeBytes)}</span>
              </div>
            {/if}
          </div>

          <div class="story-grid">
            {#each filteredStories as story}
              <button
                class="story-thumb"
                class:selected={selectedStory?.id === story.id}
                onclick={() => (selectedStoryId = story.id)}
                title={story.title}
              >
                <img src={story.url} alt={story.title} loading="lazy" />
                <span>{story.title}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </section>

    <section id="events" class="panel">
      <div class="panel-head">
        <div>
          <h2>Event Flow</h2>
          <p class="sub">Top routes in latest relay timeline window</p>
        </div>
        <span class="chip">{flowEdges.length} edges</span>
      </div>
      <div class="flow-grid">
        {#if flowEdges.length === 0}
          <div class="empty">No relay edges in current window.</div>
        {:else}
          {#each flowEdges as edge}
            <article class="flow-edge" class:bad={edge.critical > 0}>
              <span>{edge.from}</span>
              <div class="flow-line"><i style={`width:${Math.min(100, 18 + edge.count * 4)}%`}></i></div>
              <span>{edge.to}</span>
              <strong>{edge.count}</strong>
              {#if edge.critical > 0}<small>{edge.critical} critical</small>{/if}
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
    background:
      linear-gradient(180deg, rgba(29, 35, 43, 0.96), rgba(8, 9, 11, 0.98) 42%, #060708),
      #08090b;
    color: #c7c4ba;
    font-family: 'Space Grotesk', 'IBM Plex Sans', 'SF Pro Text', 'Segoe UI', sans-serif;
  }

  .health-page {
    max-width: 1680px;
    margin: 0 auto;
    padding: 24px 20px 18px;
    overflow-x: clip;
  }

  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    min-width: 0;
  }

  h1 {
    margin: 0;
    font-size: clamp(28px, 3vw, 40px);
    letter-spacing: 0.2px;
    color: #f2eee3;
  }

  h2 {
    margin: 0 0 6px 0;
    font-size: 16px;
    letter-spacing: 0.2px;
  }

  .top p,
  .sub {
    margin: 4px 0 0 0;
    color: #8e8a80;
    font-size: 12px;
  }

  .eyebrow {
    color: #caa55a;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
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
    border: 1px solid #38362f;
    background: #171715;
    color: #efe8d8;
    padding: 0 12px;
    font-weight: 600;
    cursor: pointer;
  }

  button:hover,
  .panel-link:hover {
    border-color: #9a7940;
    color: #fff4d8;
  }

  .icon-button,
  .section-tabs button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
  }

  .section-tabs {
    position: sticky;
    top: 8px;
    z-index: 6;
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px;
    margin-bottom: 12px;
    border: 1px solid rgba(202, 165, 90, 0.16);
    border-radius: 10px;
    background: rgba(10, 10, 9, 0.84);
    backdrop-filter: blur(16px);
    max-width: 100%;
    min-width: 0;
  }

  .section-tabs button {
    min-width: 118px;
    flex: 0 0 auto;
    color: #a8a294;
    background: #10100f;
  }

  .section-tabs button.active {
    color: #16120a;
    background: #d9ad58;
    border-color: #efc76f;
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
    background: linear-gradient(180deg, #121312, #0c0d0d);
    border: 1px solid #2c2a25;
    border-radius: 12px;
    padding: 13px;
    margin-bottom: 12px;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .panel-link {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #38362f;
    border-radius: 8px;
    padding: 0 11px;
    color: #efe8d8;
    text-decoration: none;
    font-size: 12px;
    font-weight: 700;
    background: #171715;
  }

  .hero-console {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 12px;
    margin-bottom: 12px;
  }

  .readiness-tile {
    min-height: 156px;
    display: flex;
    align-items: center;
    gap: 14px;
    border: 1px solid #3a352a;
    border-radius: 12px;
    padding: 16px;
    background: linear-gradient(160deg, #171510, #0d0e0d);
  }

  .readiness-tile.ready {
    border-color: rgba(27, 185, 117, 0.42);
  }

  .readiness-tile.failed {
    border-color: rgba(255, 91, 115, 0.46);
  }

  .readiness-tile strong {
    display: block;
    margin-top: 4px;
    color: #f4f0e8;
    font-size: 28px;
  }

  .readiness-tile p {
    margin: 5px 0 0;
    color: #9d9689;
    font-size: 12px;
  }

  .pulse {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: #1bb975;
    box-shadow: 0 0 0 8px rgba(27, 185, 117, 0.12);
    flex: 0 0 auto;
  }

  .readiness-tile.failed .pulse {
    background: #ff5b73;
    box-shadow: 0 0 0 8px rgba(255, 91, 115, 0.12);
  }

  .architecture-strip {
    min-height: 156px;
    display: grid;
    grid-template-columns: repeat(5, minmax(120px, 1fr));
    align-items: stretch;
    gap: 10px;
    border: 1px solid #2c2a25;
    border-radius: 12px;
    padding: 12px;
    background: #0d0e0d;
    overflow-x: auto;
  }

  .arch-link {
    display: none;
  }

  .arch-node {
    min-width: 120px;
    min-height: 132px;
    display: grid;
    grid-template-rows: 36px auto auto;
    align-content: center;
    gap: 8px;
    border: 1px solid #38362f;
    border-radius: 10px;
    padding: 12px;
    background: #151512;
  }

  .arch-node > span {
    width: 36px;
    height: 36px;
    display: inline-grid;
    place-items: center;
    border-radius: 8px;
    background: #282319;
    color: #efc76f;
    font-size: 12px;
    font-weight: 900;
  }

  .arch-node strong {
    color: #eee8dc;
    font-size: 13px;
  }

  .arch-node small {
    color: #948d7f;
    font-size: 11px;
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
    background: linear-gradient(180deg, #111210, #0b0c0c);
    border: 1px solid #2c2a25;
    border-radius: 12px;
    padding: 12px;
    min-height: 76px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .k {
    color: #8e8a80;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 10px;
  }

  .v {
    margin-top: 5px;
    font-weight: 700;
    font-size: 20px;
    color: #efe8d8;
  }

  .ok { color: #1bd985; }
  .bad { color: #ff5b73; }

  .gate-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }

  .gate {
    min-height: 88px;
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    border: 1px solid #38362f;
    border-radius: 10px;
    padding: 12px;
    background: #10110f;
  }

  .gate-status {
    width: 10px;
    height: 10px;
    margin-top: 4px;
    border-radius: 50%;
    background: #a0998c;
  }

  .gate.ok .gate-status {
    background: #1bd985;
  }

  .gate.bad .gate-status {
    background: #ff5b73;
  }

  .gate strong,
  .gate span,
  .gate small {
    display: block;
    min-width: 0;
  }

  .gate strong {
    color: #eee8dc;
    font-size: 13px;
  }

  .gate span {
    margin-top: 4px;
    color: #d9ad58;
    font-weight: 800;
  }

  .gate small {
    margin-top: 4px;
    color: #958e80;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .command-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .command-strip code {
    border: 1px solid #38362f;
    border-radius: 8px;
    padding: 8px 10px;
    color: #d8d2c3;
    background: #090a09;
    font-size: 11px;
  }

  .topology-split {
    grid-template-columns: minmax(0, 1.1fr) minmax(340px, 0.9fr);
  }

  .process-grid,
  .storage-list,
  .flow-grid {
    display: grid;
    gap: 8px;
  }

  .process-row,
  .storage-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    border: 1px solid #38362f;
    border-radius: 9px;
    padding: 10px;
    background: #0d0e0d;
  }

  .process-row pre {
    grid-column: 1 / -1;
    max-height: 80px;
    overflow: auto;
  }

  .process-row strong,
  .storage-row span {
    color: #eee8dc;
  }

  .process-row span,
  .storage-row small {
    display: block;
    color: #918a7e;
    font-size: 11px;
  }

  .storage-row {
    grid-template-columns: minmax(0, 1fr) auto minmax(110px, auto);
    align-items: center;
  }

  .storage-row strong {
    color: #d9ad58;
    font-size: 13px;
  }

  .story-panel {
    overflow: hidden;
  }

  .story-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .story-controls select {
    height: 34px;
    max-width: 180px;
    border: 1px solid #38362f;
    border-radius: 8px;
    background: #10100f;
    color: #efe8d8;
    padding: 0 10px;
  }

  .story-layout {
    display: grid;
    grid-template-columns: minmax(420px, 1.05fr) minmax(0, 1fr);
    gap: 12px;
  }

  .story-stage {
    min-height: 430px;
    border: 1px solid #38362f;
    border-radius: 10px;
    background: #080908;
    overflow: hidden;
  }

  .story-stage a {
    display: block;
    height: 376px;
    background: #050605;
  }

  .story-stage img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .story-caption {
    min-height: 54px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-top: 1px solid #2c2a25;
  }

  .story-caption strong,
  .story-caption span {
    display: block;
  }

  .story-caption strong {
    color: #eee8dc;
  }

  .story-caption span {
    color: #958e80;
    font-size: 11px;
  }

  .story-grid {
    max-height: 430px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 8px;
    overflow: auto;
    padding-right: 4px;
  }

  .story-thumb {
    height: 118px;
    display: grid;
    grid-template-rows: 84px 1fr;
    gap: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid #38362f;
    background: #0b0c0b;
    text-align: left;
  }

  .story-thumb.selected {
    border-color: #d9ad58;
    box-shadow: inset 0 0 0 1px rgba(217, 173, 88, 0.35);
  }

  .story-thumb img {
    width: 100%;
    height: 84px;
    object-fit: cover;
    display: block;
    background: #050605;
  }

  .story-thumb span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 7px 8px;
    color: #cfc8b8;
    font-size: 11px;
  }

  .flow-edge {
    min-height: 42px;
    display: grid;
    grid-template-columns: minmax(90px, 1fr) minmax(120px, 2fr) minmax(90px, 1fr) 54px auto;
    align-items: center;
    gap: 8px;
    border: 1px solid #38362f;
    border-radius: 9px;
    padding: 8px 10px;
    background: #0d0e0d;
  }

  .flow-edge > span {
    color: #d8d2c3;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .flow-edge strong {
    color: #d9ad58;
    text-align: right;
  }

  .flow-edge small {
    color: #ff9db0;
    font-size: 11px;
  }

  .flow-line {
    height: 8px;
    border-radius: 999px;
    background: #22211d;
    overflow: hidden;
  }

  .flow-line i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #1bd985, #d9ad58);
  }

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
    max-width: 100%;
    min-width: 0;
  }

  .entity-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
    padding: 8px;
    border: 1px solid #1f2c3a;
    border-radius: 9px;
    background: #0b121b;
    margin-bottom: 8px;
  }

  .entity-row :global(.entity-identity) {
    min-width: 0;
    flex: 1 1 230px;
  }

  .entity-row :global(.entity-identity .text),
  .entity-row :global(.entity-identity .address-wrap) {
    min-width: 0;
    max-width: 100%;
  }

  .entity-row :global(.entity-identity .address) {
    min-width: 0;
  }

  .entity-offline {
    opacity: 0.8;
  }

  .entity-tags {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    min-width: 0;
    justify-content: flex-end;
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
