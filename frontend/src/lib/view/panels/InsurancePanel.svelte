<!--
  InsurancePanel.svelte
  A panel for the XLNView workspace that displays the insurance policies
  covering a selected entity.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { panelBridge } from '../utils/panelBridge';
  import { getXLN } from '$lib/stores/xlnStore';
  import type { XLNModule } from '@xln/runtime/xln-api';
  import type { JAdapter } from '@xln/runtime/jadapter';
  import type { Writable } from 'svelte/store';

  // --- PROPS (passed from View.svelte) ---
  let { isolatedEnv, isolatedHistory, isolatedTimeIndex }: {
    isolatedEnv?: Writable<any>;
    isolatedHistory?: Writable<any[]>;
    isolatedTimeIndex?: Writable<number>;
  } = $props();

  // --- TYPES ---
  interface InsuranceLine {
    insurer: string;
    tokenId: number;
    remaining: bigint;
    expiresAt: bigint;
  }

  // --- STATE ---
  let selectedEntityId: string | null = $state(null);
  let insuranceLines: InsuranceLine[] = $state([]);
  let isLoading = $state(false);
  let errorMessage: string | null = $state(null);

  // Time-travel awareness: check if viewing historical frame
  // Insurance data is NOT snapshotted in history, so we show a warning
  $effect(() => {
    const timeIdx = isolatedTimeIndex ? ($isolatedTimeIndex ?? -1) : -1;
    if (timeIdx >= 0 && selectedEntityId) {
      // User is viewing history - insurance data won't match
      console.log('[InsurancePanel] ⚠️ Viewing historical frame - insurance shows LIVE data');
    }
  });

  // Derived: are we in history mode?
  let isHistoryMode = $derived(isolatedTimeIndex ? (($isolatedTimeIndex ?? -1) >= 0) : false);

  // Unsubscribe function
  let unsubscribe: (() => void) | null = null;

  // --- LIFECYCLE ---
  onMount(() => {
    // Listen for entity selection events from other panels (e.g., Graph3D)
    unsubscribe = panelBridge.on('entity:selected', handleEntitySelection);
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  // --- LOGIC ---
  async function handleEntitySelection({ entityId }: { entityId: string }) {
    if (selectedEntityId === entityId) return;

    selectedEntityId = entityId;
    await fetchInsuranceData();
  }

  let cachedXLN: XLNModule | null = null;

  async function getBrowserVMFromEnv(): Promise<any | null> {
    const env = isolatedEnv ? $isolatedEnv : null;
    if (!env) return null;
    const xln = cachedXLN ?? await getXLN();
    cachedXLN = xln;
    const jadapter: JAdapter | null = xln.getActiveJAdapter?.(env) ?? null;
    return jadapter?.getBrowserVM?.() ?? null;
  }

  async function fetchInsuranceData() {
    if (!selectedEntityId) return;
    const browserVM = await getBrowserVMFromEnv();
    if (!browserVM?.getInsuranceLines) {
      errorMessage = 'Insurance data unavailable for this jurisdiction';
      insuranceLines = [];
      return;
    }

    isLoading = true;
    errorMessage = null;
    try {
      // Use the function implemented by Claude to get on-chain insurance data
      const lines = await browserVM.getInsuranceLines(selectedEntityId);
      insuranceLines = lines.map((line: any) => ({
        ...line,
        // Convert BigInts from contract to something more usable if needed
        remaining: BigInt(line.remaining),
        expiresAt: BigInt(line.expiresAt)
      }));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      insuranceLines = [];
    } finally {
      isLoading = false;
    }
  }

  // Manual refresh button
  async function refresh() {
    await fetchInsuranceData();
  }

  function formatEntityId(id: string) {
    return `${id.slice(0, 6)}...${id.slice(-4)}`;
  }

  function formatAmount(amount: bigint) {
    // Basic formatting, assuming 6 decimals for this example
    return (Number(amount) / 1e6).toFixed(2);
  }

  function formatExpiry(timestamp: bigint) {
    if (timestamp === 0n) return 'N/A';
    return new Date(Number(timestamp) * 1000).toLocaleDateString();
  }
</script>

<div class="insurance-panel-container">
  <div class="header">
    <h3>Insurance Coverage</h3>
    {#if selectedEntityId}
      <button class="refresh-btn" onclick={refresh} disabled={isLoading}>
        {isLoading ? '...' : '↻'}
      </button>
    {/if}
  </div>

  {#if isHistoryMode}
    <div class="history-warning">
      ⚠️ Viewing historical frame - Insurance shows LIVE data only
    </div>
  {/if}

  {#if !selectedEntityId}
    <div class="placeholder">Select an entity to view its insurance coverage.</div>
  {:else if isLoading}
    <div class="loading">Loading insurance data for {formatEntityId(selectedEntityId)}...</div>
  {:else if errorMessage}
    <div class="error">Error: {errorMessage}</div>
  {:else if insuranceLines.length === 0}
    <div class="placeholder">No insurance lines found for {formatEntityId(selectedEntityId)}.</div>
  {:else}
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Insurer</th>
            <th>Token ID</th>
            <th>Remaining Coverage</th>
            <th>Expires At</th>
          </tr>
        </thead>
        <tbody>
          {#each insuranceLines as line}
            <tr>
              <td class="monospace" title={line.insurer}>{formatEntityId(line.insurer)}</td>
              <td>{line.tokenId}</td>
              <td>{formatAmount(line.remaining)} USDC</td>
              <td>{formatExpiry(line.expiresAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .insurance-panel-container {
    padding: 16px;
    background-color: #1a1a1a;
    color: #fff;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .header {
    border-bottom: 1px solid #333;
    padding-bottom: 8px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header h3 {
    margin: 0;
    font-size: 1.2em;
    color: #00dd88;
  }
  .refresh-btn {
    background: #2a2a2a;
    border: 1px solid #444;
    color: #ccc;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 4px;
    font-size: 14px;
  }
  .refresh-btn:hover:not(:disabled) {
    background: #3a3a3a;
    color: #fff;
  }
  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .placeholder, .loading, .error {
    text-align: center;
    padding: 32px;
    color: #888;
  }
  .error {
    color: #ff4444;
  }
  .history-warning {
    background: #3d2a00;
    border: 1px solid #ff9800;
    color: #ffcc00;
    padding: 8px 12px;
    margin-bottom: 12px;
    border-radius: 4px;
    font-size: 12px;
    text-align: center;
  }
  .table-container {
    overflow-y: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid #2a2a2a;
  }
  th {
    font-size: 0.9em;
    color: #aaa;
  }
  td {
    font-size: 0.95em;
  }
  .monospace {
    font-family: 'SF Mono', 'Monaco', monospace;
  }
</style>
