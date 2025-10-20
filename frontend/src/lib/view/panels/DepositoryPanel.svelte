<script lang="ts">
  /**
   * Depository Panel - Live J-state viewer
   * Queries Depository.sol via BrowserVM
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, onDestroy } from 'svelte';
  import { panelBridge } from '../utils/panelBridge';
  import { browserVMProvider } from '../utils/browserVMProvider';

  let reserves: Map<string, Map<number, bigint>> = new Map();
  let selectedEntityId: string | null = null;
  let currentBlock = 0;
  let loading = true;
  let error: string | null = null;

  // Grid-2 entities (matches ArchitectPanel scenario)
  const ENTITIES = [
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000000000000000000000000000003',
    '0x0000000000000000000000000000000000000000000000000000000000000004',
    '0x0000000000000000000000000000000000000000000000000000000000000005',
  ];

  onMount(async () => {
    try {
      await browserVMProvider.init();
      await refreshReserves();
      loading = false;
    } catch (err: any) {
      error = err.message;
      loading = false;
    }
  });

  async function refreshReserves() {
    try {
      const tokensLength = await browserVMProvider.getTokensLength();

      // Clear old data
      reserves.clear();

      for (const entityId of ENTITIES) {
        const entityReserves = new Map();

        // Check token 1-2 (USDC, ETH)
        const maxTokenId = Math.max(tokensLength, 2);

        for (let tokenId = 1; tokenId <= maxTokenId; tokenId++) {
          const balance = await browserVMProvider.getReserves(entityId, tokenId);

          if (balance > 0n) {
            entityReserves.set(tokenId, balance);
          }
        }

        if (entityReserves.size > 0) {
          reserves.set(entityId, entityReserves);
        }
      }

      reserves = reserves; // Trigger reactivity
    } catch (err: any) {
      console.error('[Depository] Refresh failed:', err);
      error = `Query failed: ${err.message}`;
    }
  }

  // Listen for entity selection from other panels
  const unsubscribeSelection = panelBridge.on('entity:selected', ({ entityId }) => {
    selectedEntityId = entityId;
  });

  // Listen for reserve updates from Architect panel
  const unsubscribeReserves = panelBridge.on('reserves:updated', () => {
    refreshReserves();
  });

  onDestroy(() => {
    unsubscribeSelection();
    unsubscribeReserves();
  });

  function formatBalance(balance: bigint): string {
    return balance.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function getTokenName(tokenId: number): string {
    return tokenId === 1 ? 'USDC' : tokenId === 2 ? 'ETH' : `Token ${tokenId}`;
  }
</script>

<div class="depository-panel">
  <div class="header">
    <h3>💰 Depository (J-State)</h3>
    <div class="meta">
      <span>Contract: {browserVMProvider.getDepositoryAddress().slice(0, 10)}...</span>
      <span>|</span>
      <span>Mode: Simnet</span>
    </div>
    <button on:click={refreshReserves} disabled={loading} class="refresh-btn">
      {loading ? '⏳' : '🔄'} Refresh
    </button>
  </div>

  {#if loading}
    <div class="loading">
      <div class="spinner"></div>
      <p>Initializing BrowserVM...</p>
    </div>
  {:else if error}
    <div class="error">
      <p>❌ {error}</p>
      <button on:click={refreshReserves}>Retry</button>
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Entity</th>
          <th>Token</th>
          <th>Reserves</th>
        </tr>
      </thead>
      <tbody>
        {#each [...reserves.entries()] as [entityId, entityReserves]}
          {#each [...entityReserves.entries()] as [tokenId, balance]}
            <tr class:selected={entityId === selectedEntityId}>
              <td>{entityId.slice(0, 10)}...</td>
              <td>{getTokenName(tokenId)} ({tokenId})</td>
              <td>{formatBalance(balance)}</td>
            </tr>
          {/each}
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .depository-panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    color: #cccccc;
    overflow: hidden;
  }

  .header {
    padding: 12px 16px;
    border-bottom: 2px solid #007acc;
    display: flex;
    align-items: center;
    gap: 12px;
    background: #2d2d30;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
    color: #ffffff;
  }

  .meta {
    font-size: 11px;
    color: #8b949e;
    display: flex;
    gap: 8px;
  }

  .refresh-btn {
    margin-left: auto;
    padding: 6px 12px;
    background: #0e639c;
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  .refresh-btn:hover:not(:disabled) {
    background: #1177bb;
  }

  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading, .error {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #3e3e3e;
    border-top-color: #007acc;
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
    margin-top: 12px;
    padding: 8px 16px;
    background: #0e639c;
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    overflow-y: auto;
  }

  th, td {
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid #3e3e3e;
  }

  th {
    background: #2d2d30;
    color: #ffffff;
    font-weight: 600;
    position: sticky;
    top: 0;
  }

  tbody tr:hover {
    background: #2d2d30;
  }

  tbody tr.selected {
    background: #094771;
  }

  td {
    font-family: 'Monaco', 'Courier New', monospace;
  }
</style>
