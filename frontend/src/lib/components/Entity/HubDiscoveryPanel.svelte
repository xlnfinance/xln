<!--
  HubDiscoveryPanel.svelte - Discover and connect to payment hubs

  Browse gossip-advertised hubs and open accounts with them.
-->
<script lang="ts">
  import { xlnFunctions, xlnEnvironment, getXLN, processWithDelay } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { Radio, Globe, Zap, Users, Shield, RefreshCw, Plus, Check, AlertTriangle } from 'lucide-svelte';

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
  const CREDIT_TOKEN_ID = 1;
  let relaySelection = '';
  let gossipStatus: { lastRefreshAt: number; received: number; total: number; relay: string } | null = null;

  const RELAY_OPTIONS = [
    { label: 'Prod (xln.finance)', url: 'wss://xln.finance/relay' },
    { label: 'Local (localhost:8080)', url: 'ws://localhost:8080/relay' },
  ];

  $: relaySelection = $settings.relayUrl;

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
    relays?: string[];
    capabilities?: string[];
    jurisdiction: string;
    isConnected: boolean;
    lastSeen: number;
    raw: string;
  }

  let hubs: Hub[] = [];

  // Format functions
  function formatShortId(id: string): string {
    return id || '';
  }

  function formatCapacity(cap?: bigint): string {
    if (!cap) return 'Unknown';
    const num = Number(cap) / 1e18;
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(2);
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

  // Discover hubs from gossip network
  async function discoverHubs(refreshGossip: boolean = false) {
    loading = true;
    error = '';

    try {
      if (refreshGossip) {
        const xln = await getXLN();
        const beforeCount = env?.gossip?.getProfiles?.()?.length || 0;
        xln.refreshGossip?.();
        await new Promise(resolve => setTimeout(resolve, 250));
        const afterCount = env?.gossip?.getProfiles?.()?.length || 0;
        gossipStatus = {
          lastRefreshAt: Date.now(),
          received: Math.max(0, afterCount - beforeCount),
          total: afterCount,
          relay: $settings.relayUrl
        };
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
          discovered.push({
            profile,
            entityId: profile.entityId,
            name: profile.metadata?.name || `Hub ${formatShortId(profile.entityId)}`,
            metadata: {
              description: profile.metadata?.bio || 'Payment hub',
              website: profile.metadata?.website,
              fee: profile.metadata?.routingFeePPM || 100, // Default 0.01%
              capacity: capacity ?? 0n,
              uptime: profile.metadata?.uptime ? parseFloat(profile.metadata.uptime) : 99.9,
            },
            runtimeId: profile.runtimeId,
            endpoints: profile.endpoints || [],
            relays: profile.relays || [],
            capabilities: profile.capabilities || [],
            jurisdiction: profile.metadata?.region || 'global',
            isConnected,
            lastSeen: profile.metadata?.lastUpdated || Date.now(),
            raw: formatRawProfile(profile),
          });
        }
      }

      // Fallback: scan eReplicas for entities with hub metadata (legacy)
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

            const profile = {
              entityId: hubEntityId,
              metadata: hubMeta || {},
              accounts: [],
            };
            discovered.push({
              profile,
              entityId: hubEntityId,
              name: state.config?.name || hubMeta?.name || `Hub ${formatShortId(hubEntityId)}`,
              metadata: {
                description: hubMeta?.description || 'Payment hub',
                website: hubMeta?.website,
                fee: hubMeta?.feePPM || 100,
                capacity: state.reserves?.get?.('1') || 0n,
                uptime: hubMeta?.uptime || 99.9,
              },
              runtimeId: undefined,
              endpoints: [],
              relays: [],
              capabilities: [],
              jurisdiction: state.config?.jurisdiction?.name || 'Unknown',
              isConnected,
              lastSeen: Date.now(),
              raw: formatRawProfile(profile),
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

  // Connect to hub (open account)
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

      const tokenInfo = activeFunctions?.getTokenInfo?.(CREDIT_TOKEN_ID) || { decimals: 18 };
      const creditAmount = 10_000n * 10n ** BigInt(tokenInfo.decimals ?? 18);

      // Open account with hub + extend credit
      await processWithDelay(currentEnv as any, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'openAccount' as const,
          data: {
            targetEntityId: hub.entityId,
          }
        }, {
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId: hub.entityId,
            tokenId: CREDIT_TOKEN_ID,
            amount: creditAmount,
          }
        }]
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
    settingsOperations.setRelayUrl(url);
    const currentEnv = env;
    if (!currentEnv) return;
    const xln = await getXLN();
    if (xln.startP2P) {
      xln.startP2P(currentEnv as any, { relayUrls: [url], gossipPollMs: 0 });
    }
  }

</script>

<div class="hub-panel">
  <header class="panel-header">
    <h3>Discover Hubs</h3>
    <div class="header-controls">
      <div class="relay-select">
        <label>Relay</label>
        <select bind:value={relaySelection} on:change={(e) => updateRelay((e.currentTarget as HTMLSelectElement).value)}>
          {#each RELAY_OPTIONS as option}
            <option value={option.url}>{option.label}</option>
          {/each}
          {#if !RELAY_OPTIONS.some(o => o.url === relaySelection)}
            <option value={relaySelection}>Custom ({relaySelection})</option>
          {/if}
        </select>
      </div>
      <button class="refresh-btn" on:click={() => discoverHubs(true)} disabled={loading}>
        <span class:spinning={loading}><RefreshCw size={14} /></span>
      </button>
    </div>
  </header>

  {#if gossipStatus}
    <div class="gossip-status">
      Gossip refresh: +{gossipStatus.received} / {gossipStatus.total} profiles • {new Date(gossipStatus.lastRefreshAt).toLocaleTimeString()} • {gossipStatus.relay}
    </div>
  {/if}

  {#if !entityId}
    <div class="warning-banner">
      <AlertTriangle size={14} />
      <span>Select an entity to connect to hubs</span>
    </div>
  {/if}

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  {#if loading}
    <div class="loading-state">
      <span class="pulse"><Radio size={24} /></span>
      <p>Scanning network for hubs...</p>
    </div>
  {:else if hubs.length === 0}
    <div class="empty-state">
      <Globe size={40} />
      <p>No hubs discovered yet</p>
      <button class="btn-scan" on:click={() => discoverHubs(true)}>
        <Radio size={14} /> Scan Network
      </button>
    </div>
  {:else}
    <div class="hub-list">
      {#each hubs as hub}
        <div class="hub-card" class:connected={hub.isConnected}>
          <div class="hub-header">
            <div class="hub-identity">
              <span class="hub-name">{hub.name}</span>
              <span class="hub-id">{formatShortId(hub.entityId)}</span>
            </div>
            {#if hub.isConnected}
              <span class="connected-badge">
                <Check size={10} /> Connected
              </span>
            {/if}
          </div>

          <p class="hub-description">{hub.metadata.description || 'No description'}</p>

          <div class="hub-stats">
            <div class="stat">
              <Zap size={12} />
              <span class="stat-label">Capacity</span>
              <span class="stat-value">{formatCapacity(hub.metadata.capacity)}</span>
            </div>
            <div class="stat">
              <Shield size={12} />
              <span class="stat-label">Fee</span>
              <span class="stat-value">{(hub.metadata.fee || 0) / 10000}%</span>
            </div>
            <div class="stat">
              <Users size={12} />
              <span class="stat-label">Uptime</span>
              <span class="stat-value">{hub.metadata.uptime?.toFixed(1) || '?'}%</span>
            </div>
          </div>

          <div class="hub-fields">
            <div class="field">
              <span class="field-label">Runtime</span>
              <span class="field-value">{hub.runtimeId || 'unknown'}</span>
            </div>
            <div class="field">
              <span class="field-label">Relays</span>
              <span class="field-value">{hub.relays?.length ? hub.relays.join(', ') : 'none'}</span>
            </div>
            <div class="field">
              <span class="field-label">Endpoints</span>
              <span class="field-value">{hub.endpoints?.length ? hub.endpoints.join(', ') : 'none'}</span>
            </div>
            <div class="field">
              <span class="field-label">Capabilities</span>
              <span class="field-value">{hub.capabilities?.length ? hub.capabilities.join(', ') : 'none'}</span>
            </div>
            <div class="field">
              <span class="field-label">Updated</span>
              <span class="field-value">{new Date(hub.lastSeen).toISOString()}</span>
            </div>
          </div>

          <details class="hub-raw">
            <summary>Raw profile</summary>
            <pre>{hub.raw}</pre>
          </details>

          <div class="hub-footer">
            <span class="jurisdiction">{hub.jurisdiction}</span>
            {#if !hub.isConnected && entityId}
              <button
                class="btn-connect"
                on:click={() => connectToHub(hub)}
                disabled={connecting === hub.entityId}
              >
                {#if connecting === hub.entityId}
                  Connecting...
                {:else}
                  <Plus size={12} /> Connect
                {/if}
              </button>
            {:else if hub.isConnected}
              <span class="connected-status">Account Open</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Info Section -->
  <div class="info-section">
    <h4>What are Hubs?</h4>
    <p>
      Payment hubs are well-connected entities that provide liquidity and routing.
      Connecting to a hub allows you to send payments to anyone in the network
      through them, even if you don't have a direct account.
    </p>
  </div>
</div>

<style>
  .hub-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .relay-select {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #a8a29e;
    font-size: 12px;
  }

  .relay-select select {
    background: #1c1917;
    border: 1px solid #292524;
    color: #e7e5e4;
    padding: 4px 6px;
    border-radius: 6px;
    font-size: 12px;
  }

  .panel-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #e7e5e4;
  }

  .refresh-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #78716c;
    cursor: pointer;
  }

  .gossip-status {
    font-size: 12px;
    color: #a8a29e;
    padding: 6px 8px;
    border: 1px solid #292524;
    border-radius: 6px;
    background: #171717;
  }

  .refresh-btn:hover:not(:disabled) {
    border-color: #fbbf24;
    color: #fbbf24;
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
    padding: 10px 12px;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.2);
    border-radius: 6px;
    color: #fbbf24;
    font-size: 12px;
  }

  .error-banner {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #ef4444;
    font-size: 12px;
  }

  .loading-state, .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
    color: #57534e;
    gap: 12px;
  }

  .loading-state p, .empty-state p {
    margin: 0;
    font-size: 13px;
  }

  .pulse {
    display: flex;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .btn-scan {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    background: #422006;
    border: 1px solid #713f12;
    border-radius: 6px;
    color: #fbbf24;
    font-size: 12px;
    cursor: pointer;
  }

  .hub-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .hub-card {
    padding: 14px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 10px;
    transition: all 0.15s;
  }

  .hub-card:hover {
    border-color: #44403c;
  }

  .hub-card.connected {
    border-color: rgba(34, 197, 94, 0.3);
    background: rgba(34, 197, 94, 0.05);
  }

  .hub-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .hub-identity {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hub-name {
    font-size: 14px;
    font-weight: 600;
    color: #e7e5e4;
  }

  .hub-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #78716c;
  }

  .connected-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: rgba(34, 197, 94, 0.15);
    border-radius: 4px;
    color: #22c55e;
    font-size: 10px;
    font-weight: 500;
  }

  .hub-description {
    margin: 0 0 12px;
    font-size: 12px;
    color: #78716c;
    line-height: 1.4;
  }

  .hub-stats {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
  }

  .stat {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #57534e;
  }

  .stat-label {
    color: #57534e;
  }

  .stat-value {
    color: #a8a29e;
    font-weight: 500;
  }

  .hub-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid #292524;
  }

  .hub-fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
    font-size: 11px;
    color: #78716c;
  }

  .field {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .field-label {
    color: #57534e;
  }

  .field-value {
    color: #a8a29e;
    font-family: 'JetBrains Mono', monospace;
    text-align: right;
    word-break: break-all;
  }

  .hub-raw {
    margin: 10px 0 0;
    background: #0c0a09;
    border: 1px solid #292524;
    border-radius: 8px;
    padding: 8px;
  }

  .hub-raw summary {
    cursor: pointer;
    font-size: 11px;
    color: #a8a29e;
  }

  .hub-raw pre {
    margin: 8px 0 0;
    font-size: 10px;
    color: #d6d3d1;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .jurisdiction {
    font-size: 10px;
    color: #57534e;
    text-transform: uppercase;
  }

  .btn-connect {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: linear-gradient(135deg, #15803d, #166534);
    border: none;
    border-radius: 4px;
    color: #dcfce7;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-connect:hover:not(:disabled) {
    background: linear-gradient(135deg, #16a34a, #15803d);
  }

  .btn-connect:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .connected-status {
    font-size: 11px;
    color: #22c55e;
  }

  .info-section {
    padding: 14px;
    background: rgba(251, 191, 36, 0.03);
    border: 1px solid rgba(251, 191, 36, 0.08);
    border-radius: 8px;
  }

  .info-section h4 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: #a8a29e;
  }

  .info-section p {
    margin: 0;
    font-size: 11px;
    color: #78716c;
    line-height: 1.5;
  }
</style>
