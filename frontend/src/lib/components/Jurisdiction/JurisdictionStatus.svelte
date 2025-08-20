<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { 
    jurisdictionService, 
    jurisdictions, 
    isConnecting, 
    connectionError, 
    allJurisdictionsConnected,
    formatShares,
    calculateOwnershipPercentage,
    formatEntityId,
    type JurisdictionStatus,
    type EntityShareInfo
  } from '../../services/jurisdictionService';

  let refreshInterval: NodeJS.Timeout;
  let selectedJurisdiction: string = 'ethereum';
  let entityNumber: number = 1;
  let entityInfo: EntityShareInfo | null = null;
  let loadingEntityInfo = false;

  // Initialize jurisdiction service on mount
  onMount(async () => {
    try {
      await jurisdictionService.initialize();
      
      // Set up periodic refresh
      refreshInterval = setInterval(() => {
        jurisdictionService.refreshJurisdictionStatus();
      }, 30000); // Refresh every 30 seconds
      
      // Load initial entity info
      await loadEntityInfo();
    } catch (error) {
      console.error('Failed to initialize jurisdiction service:', error);
    }
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
    jurisdictionService.disconnect();
  });

  async function handleRefresh() {
    await jurisdictionService.refreshJurisdictionStatus();
  }

  async function loadEntityInfo() {
    if (!entityNumber || entityNumber < 1) return;
    
    loadingEntityInfo = true;
    try {
      entityInfo = await jurisdictionService.getEntityInfo(selectedJurisdiction, entityNumber);
    } catch (error) {
      console.error('Failed to load entity info:', error);
      entityInfo = null;
    } finally {
      loadingEntityInfo = false;
    }
  }

  async function handleCreateEntity() {
    try {
      const boardHash = `0x${Math.random().toString(16).substr(2, 64)}`;
      const result = await jurisdictionService.createEntity(selectedJurisdiction, boardHash);
      console.log('Entity created:', result);
      
      // Update entity number to the newly created one
      entityNumber = result.entityNumber;
      await loadEntityInfo();
    } catch (error) {
      console.error('Failed to create entity:', error);
    }
  }

  function getStatusColor(status: JurisdictionStatus): string {
    if (!status.connected) return '#dc3545'; // red
    if (status.error) return '#ffc107'; // yellow
    return '#28a745'; // green
  }

  function getStatusIcon(status: JurisdictionStatus): string {
    if (!status.connected) return '❌';
    if (status.error) return '⚠️';
    return '✅';
  }

  function formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  function formatBlockHeight(height: number): string {
    return height.toLocaleString();
  }

  // Reactive statements
  $: jurisdictionArray = Array.from($jurisdictions.entries());
  $: connectedCount = jurisdictionArray.filter(([_, status]) => status.connected).length;
</script>

<div class="jurisdiction-status">
  <div class="header">
    <h2>🏛️ J-Machine Status</h2>
    <div class="header-actions">
      <div class="connection-status" class:connected={$allJurisdictionsConnected}>
        {#if $isConnecting}
          <span class="status-indicator connecting">🔄</span>
          <span>Connecting...</span>
        {:else if $allJurisdictionsConnected}
          <span class="status-indicator connected">✅</span>
          <span>All Connected ({connectedCount}/3)</span>
        {:else}
          <span class="status-indicator error">⚠️</span>
          <span>Partial Connection ({connectedCount}/3)</span>
        {/if}
      </div>
      <button class="refresh-btn" on:click={handleRefresh} disabled={$isConnecting}>
        🔄 Refresh
      </button>
    </div>
  </div>

  {#if $connectionError}
    <div class="error-banner">
      <span class="error-icon">❌</span>
      <span class="error-text">{$connectionError}</span>
    </div>
  {/if}

  <div class="jurisdictions-grid">
    {#each jurisdictionArray as [name, status]}
      <div class="jurisdiction-card" class:connected={status.connected} class:error={!!status.error}>
        <div class="card-header">
          <div class="jurisdiction-info">
            <span class="status-icon">{getStatusIcon(status)}</span>
            <h3>{status.name}</h3>
          </div>
          <div class="status-indicator" style="color: {getStatusColor(status)}">
            {status.connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>

        <div class="card-content">
          <div class="info-row">
            <span class="label">Block Height:</span>
            <span class="value">{formatBlockHeight(status.blockHeight)}</span>
          </div>
          <div class="info-row">
            <span class="label">Last Update:</span>
            <span class="value">{formatTimestamp(status.lastUpdate)}</span>
          </div>
          {#if status.error}
            <div class="info-row error">
              <span class="label">Error:</span>
              <span class="value">{status.error}</span>
            </div>
          {/if}
        </div>

        <div class="card-actions">
          <button 
            class="action-btn" 
            class:primary={name === selectedJurisdiction}
            on:click={() => { selectedJurisdiction = name; loadEntityInfo(); }}
          >
            {name === selectedJurisdiction ? '✓ Selected' : 'Select'}
          </button>
        </div>
      </div>
    {/each}
  </div>

  <div class="entity-operations">
    <div class="section-header">
      <h3>🏗️ Entity Operations</h3>
      <div class="selected-jurisdiction">
        Selected: <strong>{selectedJurisdiction}</strong>
      </div>
    </div>

    <div class="operations-grid">
      <div class="operation-card">
        <h4>Create New Entity</h4>
        <p>Create a numbered entity with C/D shares on the selected jurisdiction</p>
        <button class="create-btn" on:click={handleCreateEntity}>
          🏗️ Create Entity
        </button>
      </div>

      <div class="operation-card">
        <h4>View Entity Info</h4>
        <div class="entity-lookup">
          <label for="entityNumber">Entity Number:</label>
          <input 
            id="entityNumber"
            type="number" 
            bind:value={entityNumber} 
            min="1" 
            placeholder="Enter entity number"
            on:change={loadEntityInfo}
          />
          <button class="lookup-btn" on:click={loadEntityInfo} disabled={loadingEntityInfo}>
            {loadingEntityInfo ? '🔄' : '🔍'} Lookup
          </button>
        </div>
      </div>
    </div>

    {#if entityInfo}
      <div class="entity-info-card">
        <div class="entity-header">
          <h4>Entity {formatEntityId(entityInfo.entityNumber)} on {entityInfo.jurisdiction}</h4>
          <div class="entity-id">{entityInfo.entityId}</div>
        </div>

        <div class="shares-info">
          <div class="share-type">
            <div class="share-header">
              <span class="share-icon">🗳️</span>
              <span class="share-name">C-Shares (Control)</span>
            </div>
            <div class="share-details">
              <div class="share-amount">{formatShares(entityInfo.cShares)}</div>
              <div class="share-percentage">
                {calculateOwnershipPercentage(entityInfo.cShares, entityInfo.totalCShares)}%
              </div>
            </div>
          </div>

          <div class="share-type">
            <div class="share-header">
              <span class="share-icon">💰</span>
              <span class="share-name">D-Shares (Dividend)</span>
            </div>
            <div class="share-details">
              <div class="share-amount">{formatShares(entityInfo.dShares)}</div>
              <div class="share-percentage">
                {calculateOwnershipPercentage(entityInfo.dShares, entityInfo.totalDShares)}%
              </div>
            </div>
          </div>
        </div>

        <div class="board-hash">
          <span class="label">Board Hash:</span>
          <span class="hash">{entityInfo.boardHash}</span>
        </div>
      </div>
    {:else if loadingEntityInfo}
      <div class="loading-entity">
        <span class="loading-spinner">🔄</span>
        <span>Loading entity information...</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .jurisdiction-status {
    background: #2d2d2d;
    border-radius: 8px;
    padding: 24px;
    color: #e8e8e8;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #3e3e3e;
  }

  .header h2 {
    margin: 0;
    color: #007acc;
    font-size: 1.5em;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .connection-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    background: rgba(220, 53, 69, 0.1);
    border: 1px solid rgba(220, 53, 69, 0.3);
    font-size: 0.9em;
  }

  .connection-status.connected {
    background: rgba(40, 167, 69, 0.1);
    border-color: rgba(40, 167, 69, 0.3);
  }

  .status-indicator.connecting {
    animation: spin 1s linear infinite;
  }

  .refresh-btn {
    background: #007acc;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    transition: background-color 0.2s ease;
  }

  .refresh-btn:hover:not(:disabled) {
    background: #0086e6;
  }

  .refresh-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .error-banner {
    background: rgba(220, 53, 69, 0.1);
    border: 1px solid rgba(220, 53, 69, 0.3);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .error-icon {
    font-size: 1.2em;
  }

  .error-text {
    color: #dc3545;
    font-weight: 500;
  }

  .jurisdictions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 20px;
    margin-bottom: 32px;
  }

  .jurisdiction-card {
    background: #252526;
    border: 2px solid #3e3e3e;
    border-radius: 8px;
    padding: 20px;
    transition: all 0.2s ease;
  }

  .jurisdiction-card.connected {
    border-color: rgba(40, 167, 69, 0.5);
  }

  .jurisdiction-card.error {
    border-color: rgba(255, 193, 7, 0.5);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .jurisdiction-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .jurisdiction-info h3 {
    margin: 0;
    color: #e8e8e8;
    font-size: 1.2em;
  }

  .status-icon {
    font-size: 1.3em;
  }

  .card-content {
    margin-bottom: 16px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 0.9em;
  }

  .info-row.error {
    color: #ffc107;
  }

  .label {
    color: #9d9d9d;
  }

  .value {
    color: #e8e8e8;
    font-weight: 500;
  }

  .card-actions {
    display: flex;
    justify-content: flex-end;
  }

  .action-btn {
    background: #3e3e3e;
    color: #e8e8e8;
    border: 1px solid #5a5a5a;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    transition: all 0.2s ease;
  }

  .action-btn.primary {
    background: #007acc;
    border-color: #007acc;
    color: white;
  }

  .action-btn:hover {
    background: #4a4a4a;
  }

  .action-btn.primary:hover {
    background: #0086e6;
  }

  .entity-operations {
    border-top: 1px solid #3e3e3e;
    padding-top: 24px;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .section-header h3 {
    margin: 0;
    color: #007acc;
    font-size: 1.3em;
  }

  .selected-jurisdiction {
    color: #9d9d9d;
    font-size: 0.9em;
  }

  .selected-jurisdiction strong {
    color: #007acc;
  }

  .operations-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 20px;
    margin-bottom: 24px;
  }

  .operation-card {
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 8px;
    padding: 20px;
  }

  .operation-card h4 {
    margin: 0 0 8px 0;
    color: #e8e8e8;
    font-size: 1.1em;
  }

  .operation-card p {
    margin: 0 0 16px 0;
    color: #9d9d9d;
    font-size: 0.9em;
    line-height: 1.4;
  }

  .create-btn {
    background: #28a745;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 500;
    transition: background-color 0.2s ease;
    width: 100%;
  }

  .create-btn:hover {
    background: #218838;
  }

  .entity-lookup {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entity-lookup label {
    color: #9d9d9d;
    font-size: 0.9em;
  }

  .entity-lookup input {
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    padding: 8px 12px;
    color: #e8e8e8;
    font-size: 0.9em;
  }

  .entity-lookup input:focus {
    outline: none;
    border-color: #007acc;
  }

  .lookup-btn {
    background: #007acc;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    transition: background-color 0.2s ease;
  }

  .lookup-btn:hover:not(:disabled) {
    background: #0086e6;
  }

  .lookup-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .entity-info-card {
    background: #252526;
    border: 2px solid #007acc;
    border-radius: 8px;
    padding: 20px;
    margin-top: 20px;
  }

  .entity-header {
    margin-bottom: 20px;
  }

  .entity-header h4 {
    margin: 0 0 8px 0;
    color: #007acc;
    font-size: 1.2em;
  }

  .entity-id {
    font-family: monospace;
    font-size: 0.8em;
    color: #9d9d9d;
    word-break: break-all;
  }

  .shares-info {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }

  .share-type {
    background: #1e1e1e;
    border-radius: 6px;
    padding: 16px;
  }

  .share-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .share-icon {
    font-size: 1.2em;
  }

  .share-name {
    color: #e8e8e8;
    font-weight: 500;
  }

  .share-details {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .share-amount {
    color: #007acc;
    font-size: 1.1em;
    font-weight: 600;
  }

  .share-percentage {
    color: #28a745;
    font-weight: 500;
  }

  .board-hash {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: #1e1e1e;
    border-radius: 6px;
    font-size: 0.9em;
  }

  .board-hash .label {
    color: #9d9d9d;
  }

  .board-hash .hash {
    font-family: monospace;
    color: #e8e8e8;
    word-break: break-all;
  }

  .loading-entity {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 40px;
    color: #9d9d9d;
  }

  .loading-spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
