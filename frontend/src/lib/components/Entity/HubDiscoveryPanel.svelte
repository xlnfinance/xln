<!--
  HubDiscoveryPanel.svelte - Discover and connect to payment hubs
  Compact sortable list with expandable details.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { xlnFunctions, xlnEnvironment, getXLN, processWithDelay } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { RefreshCw, ChevronDown, ChevronUp, Plus, Check, AlertTriangle, ArrowUpDown } from 'lucide-svelte';

  export let entityId: string = '';

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextEnv = entityEnv?.env;
  const contextXlnFunctions = entityEnv?.xlnFunctions;

  // Reactive stores
  $: env = contextEnv ? $contextEnv : $xlnEnvironment;
  $: activeFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // State
  let loading = false;
  let error = '';
  let connecting: string | null = null;
  let expandedHub: string | null = null;
  let sortKey: 'name' | 'fee' | 'capacity' | 'uptime' | 'region' = 'fee';
  let sortAsc = true;

  const RELAY_OPTIONS_ALL = [
    { label: 'Prod (xln.finance)', url: 'wss://xln.finance/relay' },
    { label: 'Local (localhost:9000)', url: 'ws://localhost:9000' },
  ];
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
  const isLocalHost = typeof window !== 'undefined' && LOCAL_HOSTS.has(window.location.hostname);
  const RELAY_OPTIONS = isLocalHost ? RELAY_OPTIONS_ALL : RELAY_OPTIONS_ALL.filter((o) => !o.url.includes('localhost'));
  const FALLBACK_RELAY = 'wss://xln.finance/relay';

  let relaySelection = $settings.relayUrl;

  // Hub data structure
  interface Hub {
    profile: any;
    entityId: string;
    name: string;
    metadata: {
      description?: string;
      website?: string;
      fee?: number;
      capacity?: bigint;
      uptime?: number;
    };
    runtimeId?: string;
    endpoints?: string[];
    capabilities?: string[];
    jurisdiction: string;
    isConnected: boolean;
    lastSeen: number;
    raw: string;
    identicon: string;
  }

  let hubs: Hub[] = [];

  // Generate identicon SVG for entity address
  function generateIdenticon(address: string, size = 8): string {
    const seed = address.toLowerCase().replace('0x', '');
    let seedInt = 0;
    for (let i = 0; i < seed.length; i++) {
      seedInt = ((seedInt << 5) - seedInt + seed.charCodeAt(i)) | 0;
    }

    const rand = () => {
      const x = Math.sin(seedInt++) * 10000;
      return x - Math.floor(x);
    };

    const hue = Math.floor(rand() * 360);
    const sat = 50 + Math.floor(rand() * 30);
    const colors = [
      `hsl(${hue}, ${sat}%, 65%)`,
      `hsl(${(hue + 120) % 360}, ${sat}%, 35%)`,
      `hsl(${(hue + 240) % 360}, ${sat}%, 50%)`
    ];

    const pattern: number[][] = [];
    for (let y = 0; y < size; y++) {
      const row: number[] = [];
      pattern[y] = row;
      for (let x = 0; x < Math.ceil(size / 2); x++) {
        const v = Math.floor(rand() * 3);
        row[x] = v;
        row[size - 1 - x] = v;
      }
    }

    const cellSize = 10;
    let svg = `<svg width="${size * cellSize}" height="${size * cellSize}" viewBox="0 0 ${size * cellSize} ${size * cellSize}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<rect width="100%" height="100%" fill="${colors[0]}"/>`;
    for (let y = 0; y < size; y++) {
      const row = pattern[y];
      if (!row) continue;
      for (let x = 0; x < size; x++) {
        const val = row[x] ?? 0;
        if (val > 0) {
          svg += `<rect x="${x * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="${colors[val]}"/>`;
        }
      }
    }
    svg += '</svg>';
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  // Sorted hubs
  $: sortedHubs = [...hubs].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'fee':
        cmp = (a.metadata.fee || 0) - (b.metadata.fee || 0);
        break;
      case 'capacity':
        cmp = Number((a.metadata.capacity || 0n) - (b.metadata.capacity || 0n));
        break;
      case 'uptime':
        cmp = (a.metadata.uptime || 0) - (b.metadata.uptime || 0);
        break;
      case 'region':
        cmp = a.jurisdiction.localeCompare(b.jurisdiction);
        break;
    }
    return sortAsc ? cmp : -cmp;
  });

  // Format functions
  function formatCapacity(cap?: bigint): string {
    if (!cap) return '-';
    const num = Number(cap) / 1e18;
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(2);
  }

  function formatFee(ppm?: number): string {
    if (!ppm && ppm !== 0) return '-';
    return (ppm / 100).toFixed(2) + ' bps';
  }

  const parseCapacity = (value: unknown): bigint | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
    if (typeof value === 'string' && value.trim() !== '') {
      try {
        const match = value.match(/^BigInt\(([-\d]+)\)$/);
        const raw = match ? match[1] : value;
        return BigInt(raw);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const formatRawProfile = (profile: any): string => {
    if (activeFunctions?.safeStringify) {
      return activeFunctions.safeStringify(profile, 2);
    }
    try {
      return JSON.stringify(profile, null, 2);
    } catch {
      return '[unserializable profile]';
    }
  };

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = true;
    }
  }

  function toggleExpand(hubId: string) {
    expandedHub = expandedHub === hubId ? null : hubId;
  }

  // Discover hubs from gossip network
  async function discoverHubs(refreshGossip: boolean = false) {
    loading = true;
    error = '';

    try {
      if (refreshGossip) {
        const xln = await getXLN();
        if (env) xln.refreshGossip?.(env);
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      const currentEnv = env;
      if (!currentEnv) throw new Error('Environment not ready');

      const discovered: Hub[] = [];

      // Primary source: gossip layer getHubs()
      if (currentEnv.gossip?.getHubs) {
        const gossipHubs = currentEnv.gossip.getHubs();

        for (const profile of gossipHubs) {
          if (profile.entityId === entityId) continue; // Skip self

          // Check if we're already connected
          let isConnected = false;
          if (currentEnv.eReplicas instanceof Map) {
            const myReplica = (currentEnv.eReplicas as Map<string, any>).get(`${entityId}:1`);
            isConnected = myReplica?.state?.accounts?.has(profile.entityId) || false;
          }

          const capacity = parseCapacity(profile.metadata?.capacity);
          const fullEntityId = profile.entityId.startsWith('0x') ? profile.entityId : `0x${profile.entityId}`;

          discovered.push({
            profile,
            entityId: profile.entityId,
            name: profile.metadata?.name || `Hub ${profile.entityId.slice(0, 8)}`,
            metadata: {
              description: profile.metadata?.bio || 'Payment hub',
              website: profile.metadata?.website,
              fee: profile.metadata?.routingFeePPM || 100,
              capacity: capacity ?? 0n,
              uptime: profile.metadata?.uptime ? parseFloat(profile.metadata.uptime) : 99.9,
            },
            runtimeId: profile.runtimeId,
            endpoints: profile.endpoints || [],
            capabilities: profile.capabilities || [],
            jurisdiction: profile.metadata?.region || 'global',
            isConnected,
            lastSeen: profile.metadata?.lastUpdated || Date.now(),
            raw: formatRawProfile(profile),
            identicon: generateIdenticon(fullEntityId),
          });
        }
      }

      // Fallback 1: relay directory (single source from server gossip cache)
      if (discovered.length === 0) {
        try {
          const res = await fetch('/api/debug/entities?limit=5000');
          if (res.ok) {
            const body = await res.json() as { entities?: Array<{
              entityId: string;
              runtimeId?: string;
              name?: string;
              isHub?: boolean;
              metadata?: Record<string, unknown>;
              capabilities?: string[];
              lastUpdated?: number;
            }> };
            const fromRelay = Array.isArray(body.entities) ? body.entities : [];
            for (const entry of fromRelay) {
              if (!entry.entityId || entry.entityId === entityId) continue;
              if (!entry.isHub) continue;
              if (discovered.some((h) => h.entityId === entry.entityId)) continue;

              const myReplica = (currentEnv.eReplicas as Map<string, any>)?.get?.(`${entityId}:1`);
              const isConnected = myReplica?.state?.accounts?.has(entry.entityId) || false;
              const fullEntityId = entry.entityId.startsWith('0x') ? entry.entityId : `0x${entry.entityId}`;
              const metadata = (entry.metadata || {}) as Record<string, unknown>;
              const capacity = parseCapacity(metadata.capacity);

              discovered.push({
                profile: { entityId: entry.entityId, metadata, capabilities: entry.capabilities || [] },
                entityId: entry.entityId,
                name: entry.name || String(metadata.name || `Hub ${entry.entityId.slice(0, 8)}`),
                metadata: {
                  description: String(metadata.bio || 'Payment hub'),
                  website: typeof metadata.website === 'string' ? metadata.website : undefined,
                  fee: typeof metadata.routingFeePPM === 'number' ? metadata.routingFeePPM : 100,
                  capacity: capacity ?? 0n,
                  uptime: typeof metadata.uptime === 'number' ? metadata.uptime : 99.9,
                },
                runtimeId: entry.runtimeId,
                endpoints: [],
                capabilities: entry.capabilities || [],
                jurisdiction: typeof metadata.region === 'string' ? metadata.region : 'global',
                isConnected,
                lastSeen: entry.lastUpdated || Date.now(),
                raw: JSON.stringify(entry, null, 2),
                identicon: generateIdenticon(fullEntityId),
              });
            }
          }
        } catch {
          // Best effort fallback only
        }
      }

      // Fallback 2: scan eReplicas for entities with hub metadata (legacy)
      if (discovered.length === 0 && currentEnv.eReplicas instanceof Map) {
        for (const [key, replica] of currentEnv.eReplicas.entries()) {
          const [hubEntityId] = key.split(':');
          if (!hubEntityId || hubEntityId === entityId) continue;

          const state = replica?.state as any;
          if (!state) continue;

          const hubMeta = state.hubAnnouncement || state.profile?.hub;
          if (hubMeta || state.accounts?.size > 2) {
            const myReplica = (currentEnv.eReplicas as Map<string, any>).get(`${entityId}:1`);
            const isConnected = myReplica?.state?.accounts?.has(hubEntityId) || false;
            const fullEntityId = hubEntityId.startsWith('0x') ? hubEntityId : `0x${hubEntityId}`;

            const profile = {
              entityId: hubEntityId,
              metadata: hubMeta || {},
              accounts: [],
            };
            discovered.push({
              profile,
              entityId: hubEntityId,
              name: state.config?.name || hubMeta?.name || `Hub ${hubEntityId.slice(0, 8)}`,
              metadata: {
                description: hubMeta?.description || 'Payment hub',
                website: hubMeta?.website,
                fee: hubMeta?.feePPM || 100,
                capacity: state.reserves?.get?.('1') || 0n,
                uptime: hubMeta?.uptime || 99.9,
              },
              runtimeId: undefined,
              endpoints: [],
              capabilities: [],
              jurisdiction: state.config?.jurisdiction?.name || 'Unknown',
              isConnected,
              lastSeen: Date.now(),
              raw: formatRawProfile(profile),
              identicon: generateIdenticon(fullEntityId),
            });
          }
        }
      }

      hubs = discovered;

    } catch (err) {
      console.error('[HubDiscovery] Failed:', err);
      error = (err as Error)?.message || 'Discovery failed';
    } finally {
      loading = false;
    }
  }

  // Connect to hub (open account + extend credit in same frame)
  async function connectToHub(hub: Hub) {
    if (!entityId || connecting) return;

    connecting = hub.entityId;
    error = '';

    try {
      const xln = await getXLN();
      if (!xln) throw new Error('XLN not initialized');

      const currentEnv = env;
      if (!currentEnv) throw new Error('Environment not ready');

      // Find signer for our entity
      let signerId = '1';
      if (currentEnv.eReplicas instanceof Map) {
        for (const key of currentEnv.eReplicas.keys()) {
          if (key.startsWith(entityId + ':')) {
            signerId = key.split(':')[1] || '1';
            break;
          }
        }
      }

      // Default credit amount: 10,000 tokens (with 18 decimals)
      const creditAmount = 10_000n * 10n ** 18n;

      // Open account WITH credit extension (both in same frame)
      // Frame #1 will have: [add_delta, set_credit_limit] - order matters!
      console.log('[HubDiscovery] Opening account + extending credit to', hub.entityId);
      await processWithDelay(currentEnv as any, [{
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'openAccount' as const,
            data: {
              targetEntityId: hub.entityId,
              creditAmount,    // Both txs go in same frame
              tokenId: 1,      // USDC
            }
          }
        ]
      }]);

      // Update hub status
      hubs = hubs.map(h =>
        h.entityId === hub.entityId ? { ...h, isConnected: true } : h
      );

    } catch (err) {
      console.error('[HubDiscovery] Connect failed:', err);
      error = (err as Error)?.message || 'Connection failed';
    } finally {
      connecting = null;
    }
  }

  async function updateRelay(url: string) {
    if (!isLocalHost && url.includes('localhost')) {
      relaySelection = FALLBACK_RELAY;
      settingsOperations.setRelayUrl(FALLBACK_RELAY);
      error = 'Local relay is disabled on non-localhost environments.';
      return;
    }
    settingsOperations.setRelayUrl(url);
    const currentEnv = env;
    if (!currentEnv) return;
    const xln = await getXLN();
    const p2p = xln.getP2P?.(currentEnv as any) as { updateConfig?: (cfg: any) => void } | null | undefined;
    if (p2p?.updateConfig) {
      // Runtime must keep a single P2P instance; relay changes are config updates only.
      p2p.updateConfig({ relayUrls: [url] });
    } else {
      error = 'P2P is not running for this runtime yet. Create or restore the runtime first.';
    }
  }

  // Track if we've already discovered (prevent infinite loop)
  let hasDiscoveredOnce = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  const MAX_RETRIES = 5;

  // Auto-load on mount with retry for WS connection timing
  onMount(() => {
    if (!isLocalHost && relaySelection.includes('localhost')) {
      relaySelection = FALLBACK_RELAY;
      settingsOperations.setRelayUrl(FALLBACK_RELAY);
    }
    if (env) {
      hasDiscoveredOnce = true;
      discoverHubs(true).then(() => {
        // If 0 hubs found, schedule retries (WS may not be connected yet)
        if (hubs.length === 0) scheduleRetry();
      });
    }
    return () => { if (retryTimer) clearTimeout(retryTimer); };
  });

  function scheduleRetry() {
    if (retryCount >= MAX_RETRIES) return;
    retryCount++;
    const delay = retryCount * 500; // 500, 1000, 1500, 2000, 2500ms
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      await discoverHubs(true);
      if (hubs.length === 0) scheduleRetry();
    }, delay);
  }

  // Also refresh when env becomes available (only once)
  $: if (env && hubs.length === 0 && !loading && !hasDiscoveredOnce) {
    hasDiscoveredOnce = true;
    discoverHubs(true);
  }
</script>

<div class="hub-panel">
  <header class="panel-header">
    <h3>Hubs</h3>
    <div class="header-controls">
      <select class="relay-select" bind:value={relaySelection} on:change={(e) => updateRelay((e.currentTarget as HTMLSelectElement).value)}>
        {#each RELAY_OPTIONS as option}
          <option value={option.url}>{option.label}</option>
        {/each}
        {#if !RELAY_OPTIONS.some(o => o.url === relaySelection)}
          <option value={relaySelection}>Custom</option>
        {/if}
      </select>
      <button class="refresh-btn" on:click={() => discoverHubs(true)} disabled={loading}>
        <span class:spinning={loading}><RefreshCw size={14} /></span>
        Refresh
      </button>
    </div>
  </header>

  {#if !entityId}
    <div class="warning-banner">
      <AlertTriangle size={14} />
      <span>Select an entity to connect to hubs</span>
    </div>
  {/if}

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  {#if loading && hubs.length === 0}
    <div class="loading-state">
      <span class="pulse"><RefreshCw size={20} /></span>
      <span>Scanning network...</span>
    </div>
  {:else if hubs.length === 0}
    <div class="empty-state">
      <span>No hubs found</span>
    </div>
  {:else}
    <div class="hub-table">
      <div class="table-header">
        <button class="col col-name" on:click={() => toggleSort('name')}>
          Name {#if sortKey === 'name'}<ArrowUpDown size={10} />{/if}
        </button>
        <button class="col col-fee" on:click={() => toggleSort('fee')}>
          Fee {#if sortKey === 'fee'}<ArrowUpDown size={10} />{/if}
        </button>
        <button class="col col-capacity" on:click={() => toggleSort('capacity')}>
          Capacity {#if sortKey === 'capacity'}<ArrowUpDown size={10} />{/if}
        </button>
        <button class="col col-uptime" on:click={() => toggleSort('uptime')}>
          Uptime {#if sortKey === 'uptime'}<ArrowUpDown size={10} />{/if}
        </button>
        <button class="col col-region" on:click={() => toggleSort('region')}>
          Region {#if sortKey === 'region'}<ArrowUpDown size={10} />{/if}
        </button>
        <div class="col col-action"></div>
      </div>

      {#each sortedHubs as hub (hub.entityId)}
        <div class="hub-row" class:connected={hub.isConnected} class:expanded={expandedHub === hub.entityId}>
          <div class="row-main" on:click={() => toggleExpand(hub.entityId)}>
            <div class="col col-name">
              <span class="expand-icon">
                {#if expandedHub === hub.entityId}
                  <ChevronUp size={12} />
                {:else}
                  <ChevronDown size={12} />
                {/if}
              </span>
              <img src={hub.identicon} alt="" class="hub-identicon" />
              <span class="hub-name">{hub.name}</span>
              {#if hub.isConnected}
                <span class="connected-dot" title="Connected"></span>
              {/if}
            </div>
            <div class="col col-fee">{formatFee(hub.metadata.fee)}</div>
            <div class="col col-capacity">{formatCapacity(hub.metadata.capacity)}</div>
            <div class="col col-uptime">{hub.metadata.uptime?.toFixed(1) || '-'}%</div>
            <div class="col col-region">{hub.jurisdiction}</div>
            <div class="col col-action" on:click|stopPropagation>
              {#if hub.isConnected}
                <span class="status-connected"><Check size={12} /> Open</span>
              {:else if entityId}
                <button
                  class="btn-connect"
                  on:click={() => connectToHub(hub)}
                  disabled={connecting === hub.entityId}
                >
                  {#if connecting === hub.entityId}
                    ...
                  {:else}
                    <Plus size={12} /> Connect
                  {/if}
                </button>
              {/if}
            </div>
          </div>

          {#if expandedHub === hub.entityId}
            <div class="row-details">
              <div class="detail-grid">
                <div class="detail">
                  <span class="label">Entity ID</span>
                  <span class="value mono">{hub.entityId}</span>
                </div>
                <div class="detail">
                  <span class="label">Runtime ID</span>
                  <span class="value mono">{hub.runtimeId || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Description</span>
                  <span class="value">{hub.metadata.description || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Website</span>
                  <span class="value">{hub.metadata.website || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Endpoints</span>
                  <span class="value mono">{hub.endpoints?.join(', ') || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Capabilities</span>
                  <span class="value">{hub.capabilities?.join(', ') || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Last Seen</span>
                  <span class="value">{new Date(hub.lastSeen).toLocaleString()}</span>
                </div>
              </div>
              <details class="raw-details">
                <summary>Raw Profile</summary>
                <pre>{hub.raw}</pre>
              </details>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .hub-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #e7e5e4;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .relay-select {
    background: #1c1917;
    border: 1px solid #292524;
    color: #a8a29e;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 11px;
  }

  .refresh-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .refresh-btn:hover:not(:disabled) {
    border-color: #3b82f6;
    color: #3b82f6;
  }

  .refresh-btn:disabled {
    opacity: 0.5;
  }

  .spinning {
    display: flex;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .warning-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.15);
    border-radius: 6px;
    color: #d97706;
    font-size: 12px;
  }

  .error-banner {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #ef4444;
    font-size: 12px;
  }

  .loading-state, .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: #57534e;
    font-size: 12px;
  }

  .pulse {
    display: flex;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* Table styles */
  .hub-table {
    border: 1px solid #292524;
    border-radius: 8px;
    overflow: hidden;
  }

  .table-header {
    display: flex;
    background: #1c1917;
    border-bottom: 1px solid #292524;
  }

  .table-header button {
    background: none;
    border: none;
    color: #666;
    font-size: 11px;
    font-weight: 500;
    padding: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .table-header button:hover {
    color: #a8a29e;
  }

  .col {
    padding: 8px;
    font-size: 12px;
  }

  .col-name { flex: 2; min-width: 140px; }
  .col-fee { flex: 1; min-width: 70px; text-align: right; }
  .col-capacity { flex: 1; min-width: 70px; text-align: right; }
  .col-uptime { flex: 1; min-width: 60px; text-align: right; }
  .col-region { flex: 1; min-width: 60px; }
  .col-action { width: 90px; text-align: right; }

  .hub-row {
    border-bottom: 1px solid #292524;
  }

  .hub-row:last-child {
    border-bottom: none;
  }

  .hub-row.connected {
    background: rgba(34, 197, 94, 0.03);
  }

  .row-main {
    display: flex;
    align-items: center;
    cursor: pointer;
    transition: background 0.1s;
  }

  .row-main:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .row-main .col {
    color: #a8a29e;
  }

  .row-main .col-name {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #e7e5e4;
  }

  .expand-icon {
    display: flex;
    color: #57534e;
  }

  .hub-identicon {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .hub-name {
    font-weight: 500;
  }

  .connected-dot {
    width: 6px;
    height: 6px;
    background: #22c55e;
    border-radius: 50%;
  }

  .status-connected {
    display: flex;
    align-items: center;
    gap: 4px;
    color: #22c55e;
    font-size: 11px;
  }

  .btn-connect {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    background: #3b82f6;
    border: none;
    border-radius: 4px;
    color: #fff;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .btn-connect:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-connect:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Expanded details */
  .row-details {
    padding: 12px 16px;
    background: #0c0a09;
    border-top: 1px solid #292524;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px 16px;
    margin-bottom: 12px;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail .label {
    font-size: 10px;
    color: #57534e;
  }

  .detail .value {
    font-size: 11px;
    color: #a8a29e;
    word-break: break-all;
  }

  .detail .value.mono {
    font-family: 'JetBrains Mono', monospace;
  }

  .raw-details {
    margin-top: 8px;
  }

  .raw-details summary {
    cursor: pointer;
    font-size: 11px;
    color: #78716c;
    padding: 4px 0;
  }

  .raw-details pre {
    margin: 8px 0 0;
    padding: 8px;
    background: #171717;
    border: 1px solid #292524;
    border-radius: 4px;
    font-size: 10px;
    color: #d6d3d1;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
