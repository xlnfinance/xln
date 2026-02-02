<script lang="ts">
  import { onMount } from 'svelte';

  interface HealthData {
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
      status: 'healthy' | 'degraded' | 'down';
      reserves?: Record<string, string>;
      accounts?: number;
      error?: string;
    }>;
    system: {
      runtime: boolean;
      p2p: boolean;
      database: boolean;
      relay: boolean;
    };
  }

  let health: HealthData | null = $state(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let autoRefresh = $state(true);

  async function fetchHealth() {
    try {
      const response = await fetch('https://xln.finance/api/health');
      health = await response.json();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch health';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    fetchHealth();
    const interval = setInterval(() => {
      if (autoRefresh) fetchHealth();
    }, 5000);
    return () => clearInterval(interval);
  });

  function formatUptime(ms: number | null): string {
    if (!ms) return 'N/A';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function formatResponseTime(ms: number | undefined): string {
    if (!ms) return 'N/A';
    return `${ms}ms`;
  }
</script>

<svelte:head>
  <title>XLN Health Status</title>
</svelte:head>

<div class="health-page">
  <header>
    <h1>🏥 XLN Network Health</h1>
    <div class="controls">
      <label>
        <input type="checkbox" bind:checked={autoRefresh} />
        Auto-refresh (5s)
      </label>
      <button onclick={() => fetchHealth()}>🔄 Refresh Now</button>
    </div>
  </header>

  {#if loading && !health}
    <div class="loading">Loading health data...</div>
  {:else if error}
    <div class="error">❌ {error}</div>
  {:else if health}
    <!-- System Overview -->
    <section class="system-overview">
      <h2>System Status</h2>
      <div class="status-grid">
        <div class="status-card" class:healthy={health.system?.runtime} class:down={!health.system?.runtime}>
          <div class="status-icon">{health.system?.runtime ? '✅' : '❌'}</div>
          <div class="status-label">Runtime</div>
        </div>
        <div class="status-card" class:healthy={health.system?.p2p} class:down={!health.system?.p2p}>
          <div class="status-icon">{health.system?.p2p ? '✅' : '❌'}</div>
          <div class="status-label">P2P</div>
        </div>
        <div class="status-card" class:healthy={health.system?.database} class:down={!health.system?.database}>
          <div class="status-icon">{health.system?.database ? '✅' : '❌'}</div>
          <div class="status-label">Database</div>
        </div>
        <div class="status-card" class:healthy={health.system?.relay} class:down={!health.system?.relay}>
          <div class="status-icon">{health.system?.relay ? '✅' : '❌'}</div>
          <div class="status-label">Relay</div>
        </div>
      </div>
      <div class="uptime">Uptime: {formatUptime(health.uptime)}</div>
    </section>

    <!-- J-Machines -->
    <section class="j-machines">
      <h2>Jurisdictions ({health.jMachines?.length || 0})</h2>
      {#if !health.jMachines || health.jMachines.length === 0}
        <div class="empty">No J-machines connected</div>
      {:else}
        <div class="j-machine-list">
          {#each health.jMachines as jm}
            <div class="j-machine-card" class:healthy={jm.status === 'healthy'} class:degraded={jm.status === 'degraded'} class:down={jm.status === 'down'}>
              <div class="j-machine-header">
                <h3>{jm.name}</h3>
                <span class="status-badge {jm.status}">{jm.status}</span>
              </div>
              <div class="j-machine-info">
                <div class="info-row">
                  <span class="label">Chain ID:</span>
                  <span class="value">{jm.chainId}</span>
                </div>
                {#if jm.lastBlock !== undefined}
                  <div class="info-row">
                    <span class="label">Block:</span>
                    <span class="value">#{jm.lastBlock}</span>
                  </div>
                {/if}
                {#if jm.responseTime}
                  <div class="info-row">
                    <span class="label">Latency:</span>
                    <span class="value">{formatResponseTime(jm.responseTime)}</span>
                  </div>
                {/if}
                {#if jm.rpc.length > 0}
                  <div class="info-row">
                    <span class="label">RPC:</span>
                    <span class="value rpc">{jm.rpc[0]}</span>
                  </div>
                {/if}
                {#if jm.error}
                  <div class="error-msg">⚠️ {jm.error}</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Hubs -->
    <section class="hubs">
      <h2>Active Hubs ({health.hubs?.length || 0})</h2>
      {#if !health.hubs || health.hubs.length === 0}
        <div class="empty">No hubs online</div>
      {:else}
        <div class="hub-list">
          {#each health.hubs as hub}
            <div class="hub-card">
              <div class="hub-header">
                <h3>{hub.name}</h3>
                <span class="status-badge {hub.status}">{hub.status}</span>
              </div>
              <div class="hub-info">
                <div class="info-row">
                  <span class="label">Entity ID:</span>
                  <span class="value mono">{hub.entityId.slice(0, 20)}...</span>
                </div>
                {#if hub.region}
                  <div class="info-row">
                    <span class="label">Region:</span>
                    <span class="value">{hub.region}</span>
                  </div>
                {/if}
                {#if hub.accounts}
                  <div class="info-row">
                    <span class="label">Accounts:</span>
                    <span class="value">{hub.accounts}</span>
                  </div>
                {/if}
                {#if hub.relayUrl}
                  <div class="info-row">
                    <span class="label">Relay:</span>
                    <span class="value">{hub.relayUrl}</span>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <footer>
      <div class="last-updated">Last updated: {new Date(health.timestamp).toLocaleString()}</div>
    </footer>
  {/if}
</div>

<style>
  .health-page {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
    font-family: system-ui, -apple-system, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
    color: white;
  }

  h1 {
    font-size: 2rem;
    margin: 0;
  }

  .controls {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .controls label {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    cursor: pointer;
  }

  .controls button {
    background: white;
    color: #667eea;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-weight: 600;
    transition: transform 0.2s;
  }

  .controls button:hover {
    transform: scale(1.05);
  }

  section {
    background: white;
    border-radius: 1rem;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  }

  h2 {
    margin-top: 0;
    color: #667eea;
    font-size: 1.5rem;
  }

  .status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
    margin: 1rem 0;
  }

  .status-card {
    text-align: center;
    padding: 1.5rem;
    border-radius: 0.75rem;
    border: 2px solid #e5e7eb;
    transition: all 0.2s;
  }

  .status-card.healthy {
    background: #ecfdf5;
    border-color: #10b981;
  }

  .status-card.down {
    background: #fef2f2;
    border-color: #ef4444;
  }

  .status-icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
  }

  .status-label {
    font-weight: 600;
    color: #374151;
  }

  .uptime {
    text-align: center;
    margin-top: 1rem;
    color: #6b7280;
    font-size: 0.9rem;
  }

  .j-machine-list, .hub-list {
    display: grid;
    gap: 1rem;
  }

  .j-machine-card, .hub-card {
    border: 2px solid #e5e7eb;
    border-radius: 0.75rem;
    padding: 1rem;
    transition: all 0.2s;
  }

  .j-machine-card:hover, .hub-card:hover {
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
    transform: translateY(-2px);
  }

  .j-machine-card.healthy {
    border-color: #10b981;
    background: #f0fdf4;
  }

  .j-machine-card.degraded {
    border-color: #f59e0b;
    background: #fffbeb;
  }

  .j-machine-card.down {
    border-color: #ef4444;
    background: #fef2f2;
  }

  .j-machine-header, .hub-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .j-machine-header h3, .hub-header h3 {
    margin: 0;
    font-size: 1.125rem;
  }

  .status-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .status-badge.healthy {
    background: #10b981;
    color: white;
  }

  .status-badge.degraded {
    background: #f59e0b;
    color: white;
  }

  .status-badge.down {
    background: #ef4444;
    color: white;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid #f3f4f6;
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .label {
    color: #6b7280;
    font-size: 0.875rem;
  }

  .value {
    font-weight: 600;
    color: #111827;
    font-size: 0.875rem;
  }

  .value.mono {
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .value.rpc {
    font-size: 0.75rem;
    color: #667eea;
  }

  .error-msg {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: #fef2f2;
    border-left: 3px solid #ef4444;
    font-size: 0.875rem;
    color: #dc2626;
  }

  .empty {
    text-align: center;
    padding: 2rem;
    color: #9ca3af;
    font-style: italic;
  }

  .loading, .error {
    text-align: center;
    padding: 3rem;
    font-size: 1.25rem;
  }

  .error {
    color: #ef4444;
  }

  footer {
    text-align: center;
    color: white;
    margin-top: 2rem;
    opacity: 0.8;
  }

  .last-updated {
    font-size: 0.875rem;
  }
</style>
