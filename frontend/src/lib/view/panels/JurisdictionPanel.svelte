<script lang="ts">
  /**
   * Jurisdiction Panel - Smart Contract Introspection
   * Shows EntityProvider.sol and Depository.sol state in real-time
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, onDestroy } from 'svelte';
  import { panelBridge } from '../utils/panelBridge';
  import { browserVMProvider } from '../utils/browserVMProvider';
  import type { EVMEvent } from '../utils/browserVMProvider';

  // ═══════════════════════════════════════════════════════════════════════════
  //                              STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let loading = true;
  let error: string | null = null;
  let activeTab: 'entityProvider' | 'depository' | 'events' = 'entityProvider';

  // EntityProvider state
  let nextEntityNumber = 0;
  let registeredEntities: Array<{
    entityId: string;
    entityNumber: number;
    name: string;
    quorum: string[];
    threshold: number;
  }> = [];

  // Depository state
  let reserves: Map<string, Map<number, bigint>> = new Map();
  let collateral: Map<string, Map<string, Map<number, bigint>>> = new Map();
  let insuranceLines: Map<string, Array<{
    insurer: string;
    tokenId: number;
    remaining: bigint;
    expiresAt: bigint;
  }>> = new Map();

  // Events
  let events: EVMEvent[] = [];
  let eventUnsubscribe: (() => void) | null = null;

  // Known entity IDs (from scenarios)
  const KNOWN_ENTITIES = [
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000000000000000000000000000003',
    '0x0000000000000000000000000000000000000000000000000000000000000004',
    '0x0000000000000000000000000000000000000000000000000000000000000005',
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  //                              LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  onMount(async () => {
    try {
      await browserVMProvider.init();

      // Subscribe to all events
      eventUnsubscribe = browserVMProvider.onAny((event) => {
        events = [event, ...events].slice(0, 100); // Keep last 100 events
      });

      // Load initial state
      await refreshAll();
      loading = false;
    } catch (err: any) {
      error = err.message;
      loading = false;
    }
  });

  onDestroy(() => {
    eventUnsubscribe?.();
  });

  // Listen for updates from other panels
  const unsubscribeReserves = panelBridge.on('reserves:updated', () => {
    refreshDepository();
  });

  onDestroy(() => {
    unsubscribeReserves();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //                              DATA LOADING
  // ═══════════════════════════════════════════════════════════════════════════

  async function refreshAll() {
    await Promise.all([
      refreshEntityProvider(),
      refreshDepository(),
    ]);
  }

  async function refreshEntityProvider() {
    try {
      nextEntityNumber = await browserVMProvider.getNextEntityNumber();

      // Query known entities
      const entities: typeof registeredEntities = [];
      for (const entityId of KNOWN_ENTITIES) {
        const info = await browserVMProvider.getEntityInfo(entityId);
        if (info.exists) {
          entities.push({
            entityId,
            entityNumber: 0, // TODO: fetch from contract when available
            name: info.name || '',
            quorum: info.quorum || [],
            threshold: info.threshold || 0,
          });
        }
      }
      registeredEntities = entities;
    } catch (err: any) {
      console.error('[JurisdictionPanel] EntityProvider refresh failed:', err);
    }
  }

  async function refreshDepository() {
    try {
      const tokensLength = await browserVMProvider.getTokensLength();
      const maxTokenId = Math.max(tokensLength, 2);

      // Clear old data
      reserves.clear();
      collateral.clear();
      insuranceLines.clear();

      for (const entityId of KNOWN_ENTITIES) {
        // Get reserves
        const entityReserves = new Map<number, bigint>();
        for (let tokenId = 1; tokenId <= maxTokenId; tokenId++) {
          const balance = await browserVMProvider.getReserves(entityId, tokenId);
          if (balance > 0n) {
            entityReserves.set(tokenId, balance);
          }
        }
        if (entityReserves.size > 0) {
          reserves.set(entityId, entityReserves);
        }

        // Get collateral with other entities
        const entityCollateral = new Map<string, Map<number, bigint>>();
        for (const counterpartyId of KNOWN_ENTITIES) {
          if (counterpartyId === entityId) continue;
          const counterpartyCollateral = new Map<number, bigint>();
          for (let tokenId = 1; tokenId <= maxTokenId; tokenId++) {
            const amount = await browserVMProvider.getCollateral(entityId, counterpartyId, tokenId);
            if (amount > 0n) {
              counterpartyCollateral.set(tokenId, amount);
            }
          }
          if (counterpartyCollateral.size > 0) {
            entityCollateral.set(counterpartyId, counterpartyCollateral);
          }
        }
        if (entityCollateral.size > 0) {
          collateral.set(entityId, entityCollateral);
        }

        // Get insurance lines
        const lines = await browserVMProvider.getInsuranceLines(entityId);
        if (lines.length > 0) {
          insuranceLines.set(entityId, lines);
        }
      }

      // Trigger reactivity
      reserves = reserves;
      collateral = collateral;
      insuranceLines = insuranceLines;
    } catch (err: any) {
      console.error('[JurisdictionPanel] Depository refresh failed:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //                              HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function formatEntityId(entityId: string): string {
    return entityId.slice(0, 10) + '...' + entityId.slice(-4);
  }

  function formatBalance(balance: bigint): string {
    // Format with commas
    return balance.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatBalanceShort(balance: bigint): string {
    const num = Number(balance);
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toString();
  }

  function getTokenName(tokenId: number): string {
    return tokenId === 1 ? 'USDC' : tokenId === 2 ? 'ETH' : `Token ${tokenId}`;
  }

  function getEntityName(entityId: string): string {
    const entity = registeredEntities.find(e => e.entityId === entityId);
    if (entity?.name) return entity.name;
    const num = registeredEntities.find(e => e.entityId === entityId)?.entityNumber;
    if (num) return `#${num}`;
    return formatEntityId(entityId);
  }

  function formatTimestamp(ts: bigint): string {
    if (ts === 0n) return 'Never';
    const date = new Date(Number(ts) * 1000);
    return date.toLocaleString();
  }
</script>

<div class="jurisdiction-panel">
  <!-- Header -->
  <div class="header">
    <h3>Jurisdiction</h3>
    <div class="meta">
      <span class="contract-badge">
        EP: {browserVMProvider.getEntityProviderAddress().slice(0, 8)}...
      </span>
      <span class="contract-badge">
        DEP: {browserVMProvider.getDepositoryAddress().slice(0, 8)}...
      </span>
    </div>
    <button on:click={refreshAll} disabled={loading} class="refresh-btn">
      {loading ? '...' : 'Refresh'}
    </button>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'entityProvider'}
      on:click={() => activeTab = 'entityProvider'}
    >
      EntityProvider
    </button>
    <button
      class="tab"
      class:active={activeTab === 'depository'}
      on:click={() => activeTab = 'depository'}
    >
      Depository
    </button>
    <button
      class="tab"
      class:active={activeTab === 'events'}
      on:click={() => activeTab = 'events'}
    >
      Events ({events.length})
    </button>
  </div>

  <!-- Content -->
  <div class="content">
    {#if loading}
      <div class="loading">
        <div class="spinner"></div>
        <p>Initializing BrowserVM...</p>
      </div>
    {:else if error}
      <div class="error">
        <p>{error}</p>
        <button on:click={refreshAll}>Retry</button>
      </div>
    {:else if activeTab === 'entityProvider'}
      <!-- EntityProvider Tab -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Contract State</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Next Entity #</span>
          <span class="stat-value">{nextEntityNumber}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Registered</span>
          <span class="stat-value">{registeredEntities.length}</span>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">Registered Entities</span>
        </div>
        {#if registeredEntities.length === 0}
          <div class="empty">No entities registered</div>
        {:else}
          {#each registeredEntities as entity}
            <div class="entity-card">
              <div class="entity-header">
                <span class="entity-number">#{entity.entityNumber}</span>
                <span class="entity-name">{entity.name || 'Unnamed'}</span>
              </div>
              <div class="entity-details">
                <div class="detail-row">
                  <span class="detail-label">ID</span>
                  <span class="detail-value mono">{formatEntityId(entity.entityId)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Threshold</span>
                  <span class="detail-value">{entity.threshold}/{entity.quorum.length}</span>
                </div>
                {#if entity.quorum.length > 0}
                  <div class="detail-row">
                    <span class="detail-label">Quorum</span>
                    <div class="quorum-list">
                      {#each entity.quorum as addr}
                        <span class="quorum-addr">{addr.slice(0, 8)}...</span>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

    {:else if activeTab === 'depository'}
      <!-- Depository Tab -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Reserves</span>
        </div>
        {#if reserves.size === 0}
          <div class="empty">No reserves</div>
        {:else}
          <table class="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Token</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {#each [...reserves.entries()] as [entityId, entityReserves]}
                {#each [...entityReserves.entries()] as [tokenId, balance]}
                  <tr>
                    <td>{getEntityName(entityId)}</td>
                    <td>{getTokenName(tokenId)}</td>
                    <td class="mono">{formatBalanceShort(balance)}</td>
                  </tr>
                {/each}
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">Collateral</span>
        </div>
        {#if collateral.size === 0}
          <div class="empty">No collateral posted</div>
        {:else}
          <table class="data-table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Token</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {#each [...collateral.entries()] as [entityId, counterparties]}
                {#each [...counterparties.entries()] as [counterpartyId, tokens]}
                  {#each [...tokens.entries()] as [tokenId, amount]}
                    <tr>
                      <td>{getEntityName(entityId)}</td>
                      <td>{getEntityName(counterpartyId)}</td>
                      <td>{getTokenName(tokenId)}</td>
                      <td class="mono">{formatBalanceShort(amount)}</td>
                    </tr>
                  {/each}
                {/each}
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">Insurance Lines</span>
        </div>
        {#if insuranceLines.size === 0}
          <div class="empty">No insurance lines</div>
        {:else}
          <table class="data-table">
            <thead>
              <tr>
                <th>Insured</th>
                <th>Insurer</th>
                <th>Token</th>
                <th>Remaining</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {#each [...insuranceLines.entries()] as [entityId, lines]}
                {#each lines as line}
                  <tr>
                    <td>{getEntityName(entityId)}</td>
                    <td>{formatEntityId(line.insurer)}</td>
                    <td>{getTokenName(line.tokenId)}</td>
                    <td class="mono">{formatBalanceShort(line.remaining)}</td>
                    <td>{formatTimestamp(line.expiresAt)}</td>
                  </tr>
                {/each}
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

    {:else if activeTab === 'events'}
      <!-- Events Tab -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Contract Events</span>
          <span class="event-count">{events.length} events</span>
        </div>
        {#if events.length === 0}
          <div class="empty">No events yet</div>
        {:else}
          <div class="events-list">
            {#each events as event}
              <div class="event-item">
                <div class="event-header">
                  <span class="event-name">{event.name}</span>
                  <span class="event-block">Block {event.blockNumber}</span>
                </div>
                <div class="event-args">
                  {#each Object.entries(event.args) as [key, value]}
                    <div class="event-arg">
                      <span class="arg-key">{key}:</span>
                      <span class="arg-value">
                        {typeof value === 'bigint' ? formatBalance(value) : String(value).slice(0, 20)}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .jurisdiction-panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    color: #c9d1d9;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .header {
    padding: 12px 16px;
    border-bottom: 1px solid #21262d;
    display: flex;
    align-items: center;
    gap: 12px;
    background: #161b22;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #f0f6fc;
  }

  .meta {
    display: flex;
    gap: 8px;
    flex: 1;
  }

  .contract-badge {
    font-size: 10px;
    padding: 2px 6px;
    background: #21262d;
    border-radius: 4px;
    font-family: monospace;
    color: #7ee787;
  }

  .refresh-btn {
    padding: 4px 10px;
    background: #238636;
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
  }

  .refresh-btn:hover:not(:disabled) {
    background: #2ea043;
  }

  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tabs {
    display: flex;
    background: #161b22;
    border-bottom: 1px solid #21262d;
  }

  .tab {
    flex: 1;
    padding: 10px;
    background: transparent;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }

  .tab:hover {
    color: #c9d1d9;
  }

  .tab.active {
    color: #58a6ff;
    border-bottom-color: #58a6ff;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }

  .loading, .error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
    gap: 12px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid #21262d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error {
    color: #f85149;
  }

  .error button {
    padding: 6px 12px;
    background: #21262d;
    border: 1px solid #30363d;
    color: #c9d1d9;
    border-radius: 4px;
    cursor: pointer;
  }

  .section {
    margin-bottom: 16px;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid #21262d;
    margin-bottom: 8px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    font-size: 12px;
  }

  .stat-label {
    color: #8b949e;
  }

  .stat-value {
    color: #f0f6fc;
    font-weight: 500;
  }

  .empty {
    padding: 20px;
    text-align: center;
    color: #484f58;
    font-size: 12px;
    font-style: italic;
  }

  .entity-card {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 8px;
  }

  .entity-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .entity-number {
    font-size: 14px;
    font-weight: 600;
    color: #58a6ff;
  }

  .entity-name {
    font-size: 13px;
    color: #f0f6fc;
  }

  .entity-details {
    font-size: 11px;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
  }

  .detail-label {
    color: #8b949e;
  }

  .detail-value {
    color: #c9d1d9;
  }

  .mono {
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 11px;
  }

  .quorum-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .quorum-addr {
    font-size: 10px;
    padding: 1px 4px;
    background: #21262d;
    border-radius: 3px;
    font-family: monospace;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }

  .data-table th,
  .data-table td {
    padding: 6px 8px;
    text-align: left;
    border-bottom: 1px solid #21262d;
  }

  .data-table th {
    background: #161b22;
    color: #8b949e;
    font-weight: 500;
    font-size: 10px;
    text-transform: uppercase;
  }

  .data-table tbody tr:hover {
    background: #161b22;
  }

  .events-list {
    max-height: 400px;
    overflow-y: auto;
  }

  .event-item {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 6px;
  }

  .event-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .event-name {
    font-weight: 600;
    color: #7ee787;
    font-size: 12px;
  }

  .event-block {
    font-size: 10px;
    color: #8b949e;
  }

  .event-count {
    font-size: 10px;
    color: #8b949e;
  }

  .event-args {
    font-size: 10px;
  }

  .event-arg {
    display: flex;
    gap: 4px;
    padding: 2px 0;
  }

  .arg-key {
    color: #8b949e;
  }

  .arg-value {
    color: #c9d1d9;
    font-family: monospace;
    word-break: break-all;
  }
</style>
