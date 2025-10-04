<script lang="ts">
  import { onMount } from 'svelte';
  import { loadJurisdictions } from '../../stores/jurisdictionStore';
  import Button from '../Common/Button.svelte';

  interface JurisdictionInfo {
    rpcUrl: string; // Full RPC URL (not just port)
    name: string;
    icon: string;
    chainId: string;
    blockNumber: number;
    contractAddress: string;
    nextEntityNumber: number;
    status: 'connected' | 'disconnected' | 'checking';
    lastUpdate: string;
    entities: Array<{ id: string; name: string; type: string }>;
  }

  let jurisdictions: JurisdictionInfo[] = [];

  // Load jurisdictions from centralized store (single source of truth)
  async function loadJurisdictionsFromServer() {
    try {
      // Use the centralized jurisdictionStore instead of fetching directly
      const config = await loadJurisdictions();

      jurisdictions = Object.entries(config.jurisdictions).map(([key, data]: [string, any]) => {
        // Expand relative RPC URLs using location.origin (works with any protocol/domain)
        let rpcUrl = data.rpc;
        if (rpcUrl.startsWith(':')) {
          // Use location.origin but strip any existing port (e.g., :8080 → empty, then add :8545)
          rpcUrl = `${window.location.origin.replace(/:\d+$/, '')}${rpcUrl}`;
        }

        return {
          rpcUrl,
          name: data.name,
          icon: key === 'ethereum' ? '🔷' : key === 'polygon' ? '🟣' : '🔵',
          chainId: data.chainId.toString(),
          blockNumber: 0,
          contractAddress: data.contracts.entityProvider,
          nextEntityNumber: 1,
          status: 'checking' as const,
          lastUpdate: '',
          entities: []
        };
      });

      console.log(`✅ Loaded ${jurisdictions.length} jurisdictions from centralized store:`, jurisdictions.map(j => j.name));
    } catch (error) {
      console.error('❌ Failed to load jurisdictions from store:', error);
      // Fallback to empty array - no hardcoding!
      jurisdictions = [];
    }
  }

  async function refreshJurisdiction(jurisdiction: JurisdictionInfo) {
    jurisdiction.status = 'checking';
    jurisdiction.lastUpdate = 'Checking...';

    try {
      // Test blockchain connection using dynamic RPC URL
      const response = await fetch(jurisdiction.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1
        })
      });

      if (!response.ok) throw new Error('Network unavailable');

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      jurisdiction.blockNumber = parseInt(data.result, 16);
      jurisdiction.status = 'connected';
      jurisdiction.lastUpdate = new Date().toLocaleTimeString();

      // Try to get contract info (this would need actual implementation)
      jurisdiction.contractAddress = '0x1234...5678'; // Placeholder
      jurisdiction.nextEntityNumber = Math.floor(Math.random() * 100) + 1; // Placeholder

      // Mock some entities
      jurisdiction.entities = [
        { id: '#1', name: 'Demo Entity', type: 'Numbered' },
        { id: '#2', name: 'Test Entity', type: 'Numbered' }
      ];

    } catch (error) {
      jurisdiction.status = 'disconnected';
      jurisdiction.lastUpdate = 'Failed';
      jurisdiction.contractAddress = 'Not available';
      jurisdiction.nextEntityNumber = 0;
      jurisdiction.entities = [];
    }

    // Trigger reactivity
    jurisdictions = [...jurisdictions];
  }

  async function refreshAllJurisdictions() {
    for (const jurisdiction of jurisdictions) {
      await refreshJurisdiction(jurisdiction);
    }
  }

  // Load jurisdictions dynamically on component mount
  onMount(async () => {
    await loadJurisdictionsFromServer();
    if (jurisdictions.length > 0) {
      refreshAllJurisdictions();
    }
  });

  async function deployContracts() {
    alert('Contract deployment feature coming soon! For now, use: cd contracts && npx hardhat ignition deploy ignition/modules/Depository.ts --network localhost');
  }

</script>

<div class="jurisdictions-panel">
  <h3>🏛️ Blockchain Jurisdictions Status</h3>
  
  <div class="jurisdiction-grid">
    {#each jurisdictions as jurisdiction}
      <div class="jurisdiction-card" id="jurisdiction-{jurisdiction.name.toLowerCase()}">
        <div class="jurisdiction-header">
          <h4>{jurisdiction.icon} {jurisdiction.name}</h4>
          <span class="connection-status {jurisdiction.status}">
            {#if jurisdiction.status === 'connected'}
              ✅ Connected
            {:else if jurisdiction.status === 'disconnected'}
              ❌ Disconnected
            {:else}
              🔄 Checking...
            {/if}
          </span>
        </div>

        <div class="jurisdiction-details">
          <div class="detail-row">
            <span>📡 RPC URL:</span>
            <span class="rpc-url">{jurisdiction.rpcUrl}</span>
          </div>
          <div class="detail-row">
            <span>🔗 Chain ID:</span>
            <span>{jurisdiction.chainId}</span>
          </div>
          <div class="detail-row">
            <span>📊 Block Number:</span>
            <span>{jurisdiction.blockNumber}</span>
          </div>
          <div class="detail-row">
            <span>⏰ Last Update:</span>
            <span>{jurisdiction.lastUpdate}</span>
          </div>
          <div class="detail-row">
            <span>📝 Contract:</span>
            <span class="contract-address">{jurisdiction.contractAddress}</span>
          </div>
          <div class="detail-row">
            <span>🔢 Next Entity #:</span>
            <span>#{jurisdiction.nextEntityNumber}</span>
          </div>
        </div>
        
        <div class="entities-section">
          <h5>📋 Registered Entities:</h5>
          <div class="entities-list">
            {#if jurisdiction.entities.length > 0}
              {#each jurisdiction.entities as entity}
                <div class="entity-item">
                  <strong>{entity.id}</strong>: {entity.name}
                  <div class="entity-type">{entity.type}</div>
                </div>
              {/each}
            {:else}
              <div class="no-entities">
                {jurisdiction.status === 'connected' ? 'No entities registered yet' : 'Connection required'}
              </div>
            {/if}
          </div>
        </div>
        
        <div class="jurisdiction-actions">
          <Button 
            variant="secondary" 
            size="small"
            disabled={jurisdiction.status === 'checking'}
            on:click={() => refreshJurisdiction(jurisdiction)}
          >
            🔄 Refresh
          </Button>
        </div>
      </div>
    {/each}
  </div>
  
  <div class="global-actions">
    <Button variant="primary" on:click={refreshAllJurisdictions}>
      🔄 Refresh All
    </Button>
    <Button variant="secondary" on:click={deployContracts}>
      🚀 Deploy Contracts
    </Button>
  </div>
</div>

<style>
  .jurisdictions-panel {
    padding: 20px;
  }

  .jurisdictions-panel h3 {
    margin: 0 0 20px 0;
    color: #d4d4d4;
    font-size: 1.2em;
  }

  .jurisdiction-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }

  .jurisdiction-card {
    background: #1e1e1e;
    border: 2px solid #3e3e3e;
    border-radius: 10px;
    padding: 15px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }

  .jurisdiction-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px;
    padding-bottom: 10px;
    border-bottom: 1px solid #3e3e3e;
  }

  .jurisdiction-header h4 {
    margin: 0;
    color: #d4d4d4;
    font-size: 1em;
  }

  .connection-status {
    padding: 4px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: bold;
  }

  .connection-status.connected {
    background: #d4edda;
    color: #155724;
  }

  .connection-status.disconnected {
    background: #f8d7da;
    color: #721c24;
  }

  .connection-status.checking {
    background: #fff3cd;
    color: #856404;
  }

  .jurisdiction-details {
    margin-bottom: 15px;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid #3e3e3e;
    font-size: 13px;
  }

  .detail-row:last-child {
    border-bottom: none;
  }

  .detail-row span:first-child {
    font-weight: 500;
    color: #d4d4d4;
  }

  .detail-row span:last-child {
    color: #9d9d9d;
    text-align: right;
  }

  .contract-address {
    font-family: monospace;
    font-size: 11px !important;
  }

  .entities-section {
    margin-bottom: 15px;
  }

  .entities-section h5 {
    margin: 0 0 10px 0;
    color: #d4d4d4;
    font-size: 14px;
  }

  .entities-list {
    background: #2a2a2a;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 10px;
    min-height: 60px;
    font-size: 12px;
    font-family: monospace;
  }

  .entity-item {
    padding: 4px 0;
    border-bottom: 1px solid #3e3e3e;
    color: #d4d4d4;
  }

  .entity-item:last-child {
    border-bottom: none;
  }

  .entity-type {
    font-size: 10px;
    color: #9d9d9d;
    margin-top: 2px;
  }

  .no-entities {
    color: #6c757d;
    font-style: italic;
    text-align: center;
    padding: 20px 0;
  }

  .jurisdiction-actions {
    text-align: center;
    padding-top: 10px;
    border-top: 1px solid #3e3e3e;
  }

  .global-actions {
    text-align: center;
    padding: 20px;
    border-top: 1px solid #3e3e3e;
    display: flex;
    gap: 10px;
    justify-content: center;
  }
</style>
