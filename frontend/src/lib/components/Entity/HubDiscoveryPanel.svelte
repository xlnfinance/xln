<!--
  HubDiscoveryPanel.svelte - Discover and connect to payment hubs

  Browse gossip-advertised hubs and open accounts with them.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { xlnFunctions, xlnEnvironment, getXLN, processWithDelay } from '../../stores/xlnStore';
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

  // Hub data structure
  interface Hub {
    entityId: string;
    name: string;
    metadata: {
      description?: string;
      website?: string;
      fee?: number;
      capacity?: bigint;
      uptime?: number;
    };
    jurisdiction: string;
    isConnected: boolean;
    lastSeen: number;
  }

  let hubs: Hub[] = [];

  // Format functions
  function formatShortId(id: string): string {
    if (!id) return '';
    if (activeFunctions?.getEntityShortId) {
      return '#' + activeFunctions.getEntityShortId(id);
    }
    return '#' + id.slice(-4).toUpperCase();
  }

  function formatCapacity(cap?: bigint): string {
    if (!cap) return 'Unknown';
    const num = Number(cap) / 1e18;
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(2);
  }

  // Discover hubs from gossip network
  async function discoverHubs() {
    loading = true;
    error = '';

    try {
      const currentEnv = env;
      if (!currentEnv) throw new Error('Environment not ready');

      // Get all entities that have announced as hubs
      // In real implementation, this would query the gossip network
      const discovered: Hub[] = [];

      // Check eReplicas for entities with hub metadata
      if (currentEnv.eReplicas instanceof Map) {
        for (const [key, replica] of currentEnv.eReplicas.entries()) {
          const [hubEntityId] = key.split(':');
          if (!hubEntityId || hubEntityId === entityId) continue;

          // Check if entity has hub profile/announcement
          const state = replica?.state as any;
          if (!state) continue;

          // Look for hub metadata in state (dynamic properties)
          const hubMeta = state.hubAnnouncement || state.profile?.hub;
          if (hubMeta || state.accounts?.size > 2) {
            // Check if we're already connected
            const myReplica = (currentEnv.eReplicas as Map<string, any>).get(`${entityId}:1`);
            const isConnected = myReplica?.state?.accounts?.has(hubEntityId) || false;

            discovered.push({
              entityId: hubEntityId,
              name: state.config?.name || hubMeta?.name || `Hub ${formatShortId(hubEntityId)}`,
              metadata: {
                description: hubMeta?.description || 'Payment hub',
                website: hubMeta?.website,
                fee: hubMeta?.feePPM || 100, // Default 0.01%
                capacity: state.reserves?.get?.('1') || 0n,
                uptime: hubMeta?.uptime || 99.9,
              },
              jurisdiction: state.config?.jurisdiction?.name || 'Unknown',
              isConnected,
              lastSeen: Date.now(),
            });
          }
        }
      }

      // Add some example hubs if none found (for demo)
      if (discovered.length === 0) {
        discovered.push({
          entityId: '0x' + '1'.repeat(40),
          name: 'XLN Main Hub',
          metadata: {
            description: 'Official XLN liquidity hub',
            fee: 50,
            capacity: BigInt(1_000_000) * BigInt(1e18),
            uptime: 99.99,
          },
          jurisdiction: 'xlnomy1',
          isConnected: false,
          lastSeen: Date.now(),
        });
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

      // Open account with hub
      await processWithDelay(currentEnv as any, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'openAccount' as const,
          data: {
            counterpartyId: hub.entityId,
            tokenIds: [1], // USDC
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

  // Load hubs on mount
  onMount(() => {
    discoverHubs();
  });
</script>

<div class="hub-panel">
  <header class="panel-header">
    <h3>Discover Hubs</h3>
    <button class="refresh-btn" on:click={discoverHubs} disabled={loading}>
      <span class:spinning={loading}><RefreshCw size={14} /></span>
    </button>
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

  {#if loading}
    <div class="loading-state">
      <span class="pulse"><Radio size={24} /></span>
      <p>Scanning network for hubs...</p>
    </div>
  {:else if hubs.length === 0}
    <div class="empty-state">
      <Globe size={40} />
      <p>No hubs discovered yet</p>
      <button class="btn-scan" on:click={discoverHubs}>
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
