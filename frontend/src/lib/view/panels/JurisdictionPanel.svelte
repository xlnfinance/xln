<script lang="ts">
  /**
   * Jurisdiction Panel - READS DIRECTLY FROM BROWSERVM EVM STATE TRIE
   * NO caching, NO syncing - calls browserVMProvider.getReserves() directly
   * Uses actual Depository.sol storage via EVM call
   */

  import type { Writable } from 'svelte/store';
  import type { BrowserVMProvider } from '../utils/browserVMProvider';
  import { untrack } from 'svelte';
  import { ethers } from 'ethers';
  import { panelBridge } from '../utils/panelBridge';

  // Props
  interface Props {
    isolatedEnv: Writable<any>;
    isolatedHistory?: Writable<any[]>;
    isolatedTimeIndex?: Writable<number>;
  }

  let { isolatedEnv, isolatedHistory, isolatedTimeIndex }: Props = $props();

  // Tab state
  let activeTab = $state<'entityProvider' | 'depository'>('depository');

  // Reactive state for EVM reads
  let reserves = $state<Array<{ entityId: string; name: string; tokenId: number; amount: bigint }>>([]);
  let entities = $state<Array<{ entityId: string; name: string; quorum: string[]; threshold: number }>>([]);
  let loading = $state(false);

  // BrowserVM instance management
  let browserVM = $state<BrowserVMProvider | null>(null);

  // Try to get BrowserVM instance
  function getBrowserVM(): BrowserVMProvider | null {
    if (typeof window !== 'undefined') {
      const w = window as { __xlnBrowserVM?: BrowserVMProvider };
      return w.__xlnBrowserVM ?? null;
    }
    return null;
  }

  // Initialize BrowserVM reference
  $effect(() => {
    const vm = getBrowserVM();
    if (vm) {
      browserVM = vm;
      return; // Consistent return type (undefined)
    }

    // Poll briefly for initialization (e.g. if loaded before runtime)
    const timer = setInterval(() => {
      const vm = getBrowserVM();
      if (vm) {
        browserVM = vm;
        clearInterval(timer);
      }
    }, 500);
    
    // Cleanup function
    return () => clearInterval(timer);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //          DIRECT EVM STORAGE READS (via browserVMProvider)
  // ═══════════════════════════════════════════════════════════════════════════

  const USDC_TOKEN_ID = 1;

  // Get entity IDs from env (just to know which entities exist)
  function getEntityIds(env: any): Array<{ entityId: string; name: string }> {
    if (!env?.eReplicas) return [];
    const result: Array<{ entityId: string; name: string }> = [];
    const seen = new Set<string>();

    const entries = env.eReplicas instanceof Map
      ? Array.from(env.eReplicas.entries())
      : Object.entries(env.eReplicas);

    for (const entry of entries) {
      const [key, replica] = entry as [string, any];
      const entityId = key.split(':')[0] ?? '';
      if (entityId && !seen.has(entityId)) {
        seen.add(entityId);
        result.push({
          entityId,
          name: replica?.name || `E${entityId.slice(-4)}`,
        });
      }
    }
    return result;
  }

  // Ensure entity ID is in valid bytes32 format for EVM
  function ensureHexId(id: string): string {
    // If it's a valid hex string of correct length (0x + 64 chars = 66), use it
    if (ethers.isHexString(id) && id.length === 66) { 
        return id;
    }
    
    // If it's a hex string but short (e.g. 0x1), pad it
    if (ethers.isHexString(id)) {
        return ethers.zeroPadValue(id, 32);
    }

    // If it's not hex, hash it (assuming it's a name or other ID format)
    // Using keccak256 of utf8 bytes matches standard Solidity hashing for strings
    return ethers.keccak256(ethers.toUtf8Bytes(id));
  }

  // Read reserves DIRECTLY from BrowserVM EVM storage
  async function readReservesFromEVM(
    entityIds: Array<{ entityId: string; name: string }>,
    vm: BrowserVMProvider
  ) {
    const results: Array<{ entityId: string; name: string; tokenId: number; amount: bigint }> = [];

    for (const { entityId, name } of entityIds) {
      try {
        const hexId = ensureHexId(entityId);
        // DIRECT EVM CALL - reads Depository.sol _reserves mapping
        const amount = await vm.getReserves(hexId, USDC_TOKEN_ID);
        if (amount > 0n) {
          results.push({ entityId, name, tokenId: USDC_TOKEN_ID, amount });
        }
      } catch (err) {
        console.error(`[J-Panel] Failed to read reserves for ${entityId}:`, err);
      }
    }

    return results;
  }

  // React to env/timeIndex changes - re-read from EVM
  $effect(() => {
    const env = $isolatedEnv;
    // We don't strictly depend on timeIndex for validity, but we reload when it changes
    // to reflect potential EVM state changes (if runtime syncs EVM state).
    const timeIndex = isolatedTimeIndex ? ($isolatedTimeIndex ?? -1) : -1;
    const vm = browserVM;

    // Local active flag for cleanup
    let active = true;

    // Update entities list first (synchronous)
    const entityIds = getEntityIds(env);
    entities = entityIds.map(e => ({
        entityId: e.entityId,
        name: e.name,
        quorum: [],
        threshold: 1,
    }));

    if (!vm || entityIds.length === 0) {
        reserves = [];
        return;
    }

    // Debounce/Delay slightly to batch rapid updates and avoid race conditions
    const timer = setTimeout(() => {
        if (!active) return;
        loading = true;
        readReservesFromEVM(entityIds, vm).then(r => {
            if (active) {
                reserves = r;
                loading = false;
            }
        }).catch(err => {
            if (active) {
                console.error('[J-Panel] EVM read failed:', err);
                loading = false;
            }
        });
    }, 50); // 50ms debounce

    return () => {
        active = false;
        clearTimeout(timer);
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //                              HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function formatEntityId(entityId: string): string {
    if (!entityId) return 'N/A';
    // Try to detect if it's a long hex string
    if (entityId.startsWith('0x') && entityId.length > 10) {
        // Check if it looks like an auto-generated number
        try {
             // Take last 8 chars
             const suffix = entityId.slice(-8);
             const num = parseInt(suffix, 16);
             // If number is small and ID is mostly zeros?
             // Just show abbreviated hex
             return entityId.slice(0, 6) + '...' + entityId.slice(-4);
        } catch {
             return entityId.slice(0, 6) + '...' + entityId.slice(-4);
        }
    }
    return entityId;
  }

  function formatBalance(balance: bigint): string {
    // Convert from 18 decimals to human-readable
    const num = Number(balance) / 1e18;
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(0)}K`;
    return `$${num.toFixed(0)}`;
  }

  function handleEntityClick(entityId: string) {
    panelBridge.emit('entity:selected', { entityId });
  }

  function handleEntityExpand(entityId: string, name: string) {
    panelBridge.emit('openEntityOperations', { entityId, entityName: name || formatEntityId(entityId) });
  }

  // Get depository address from browserVM
  let depAddress = $derived(browserVM?.getDepositoryAddress?.() || '');
</script>

<div class="jurisdiction-panel">
  <!-- Header -->
  <div class="header">
    <h3>J-Machine EVM</h3>
    <div class="meta">
      <span class="contract-badge" title="Depository">DEP: {depAddress ? depAddress.slice(0,10) + '...' : 'N/A'}</span>
      {#if loading}
        <span class="loading-badge">reading EVM...</span>
      {/if}
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'entityProvider'}
      onclick={() => activeTab = 'entityProvider'}
    >
      EntityProvider.sol
    </button>
    <button
      class="tab"
      class:active={activeTab === 'depository'}
      onclick={() => activeTab = 'depository'}
    >
      Depository.sol
    </button>
  </div>

  <!-- Content -->
  <div class="content">
    {#if activeTab === 'entityProvider'}
      <!-- EntityProvider.sol storage -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">mapping(bytes32 =&gt; Entity) entities</span>
          <span class="count">{entities.length}</span>
        </div>
        {#if entities.length === 0}
          <div class="empty">No entities registered</div>
        {:else}
          {#each entities as entity}
            <div
              class="entity-row clickable"
              onclick={() => handleEntityClick(entity.entityId)}
              ondblclick={() => handleEntityExpand(entity.entityId, entity.name)}
              role="button"
              tabindex="0"
            >
              <span class="entity-id">{formatEntityId(entity.entityId)}</span>
              <span class="entity-name">{entity.name || '—'}</span>
              <span class="entity-threshold">{entity.threshold}/{entity.quorum.length || 1}</span>
              <button
                class="expand-btn"
                onclick={(e) => { e.stopPropagation(); handleEntityExpand(entity.entityId, entity.name); }}
                title="Open Entity Panel"
              >↗</button>
            </div>
          {/each}
        {/if}
      </div>

    {:else if activeTab === 'depository'}
      <!-- Depository.sol storage - DIRECT FROM EVM -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">mapping(bytes32 =&gt; mapping(uint =&gt; uint)) _reserves</span>
          <span class="count">{reserves.length}</span>
        </div>
        {#if reserves.length === 0}
          <div class="empty">{loading ? 'Reading from EVM...' : 'No reserves'}</div>
        {:else}
          <div class="storage-table">
            {#each reserves as r}
              <div
                class="storage-row clickable"
                onclick={() => handleEntityClick(r.entityId)}
                ondblclick={() => handleEntityExpand(r.entityId, r.name)}
                role="button"
                tabindex="0"
              >
                <span class="entity-label">{r.name}</span>
                <span class="key">[{formatEntityId(r.entityId)}][{r.tokenId}]</span>
                <span class="value">{formatBalance(r.amount)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">mapping(bytes =&gt; mapping(uint =&gt; AccountCollateral)) _collaterals</span>
          <span class="count">0</span>
        </div>
        <div class="empty">No collateral</div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">mapping(bytes32 =&gt; InsuranceLine[]) insuranceLines</span>
          <span class="count">0</span>
        </div>
        <div class="empty">No insurance</div>
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
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 11px;
  }

  .header {
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
    display: flex;
    align-items: center;
    gap: 8px;
    background: #161b22;
  }

  .header h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: #7ee787;
  }

  .meta {
    display: flex;
    gap: 6px;
    flex: 1;
  }

  .contract-badge {
    font-size: 9px;
    padding: 2px 5px;
    background: #21262d;
    border-radius: 3px;
    color: #8b949e;
  }

  .loading-badge {
    font-size: 9px;
    padding: 2px 5px;
    background: #3d3000;
    border-radius: 3px;
    color: #d29922;
  }

  .tabs {
    display: flex;
    background: #161b22;
    border-bottom: 1px solid #21262d;
  }

  .tab {
    flex: 1;
    padding: 6px 8px;
    background: transparent;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 10px;
    border-bottom: 2px solid transparent;
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
    padding: 8px;
  }

  .section {
    margin-bottom: 12px;
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 4px;
    overflow: hidden;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    background: #0d1117;
    border-bottom: 1px solid #21262d;
  }

  .section-title {
    font-size: 9px;
    color: #d29922;
  }

  .count {
    font-size: 9px;
    color: #8b949e;
    padding: 1px 4px;
    background: #21262d;
    border-radius: 3px;
  }

  .empty {
    padding: 12px;
    text-align: center;
    color: #484f58;
    font-size: 10px;
    font-style: italic;
  }

  .entity-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
  }

  .entity-row:last-child {
    border-bottom: none;
  }

  .clickable {
    cursor: pointer;
    transition: background 0.15s;
  }

  .clickable:hover {
    background: #1c2128;
  }

  .entity-id {
    color: #58a6ff;
    font-weight: 500;
    min-width: 40px;
  }

  .entity-name {
    flex: 1;
    color: #c9d1d9;
  }

  .entity-threshold {
    color: #8b949e;
    font-size: 10px;
  }

  .expand-btn {
    padding: 2px 6px;
    background: transparent;
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
  }

  .expand-btn:hover {
    background: #21262d;
    color: #58a6ff;
  }

  .storage-table {
    padding: 4px 0;
  }

  .storage-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    border-bottom: 1px solid #21262d;
    gap: 8px;
  }

  .storage-row:last-child {
    border-bottom: none;
  }

  .entity-label {
    color: #58a6ff;
    font-weight: 500;
    min-width: 50px;
  }

  .key {
    color: #8b949e;
    flex: 1;
    font-size: 9px;
  }

  .value {
    color: #7ee787;
    font-weight: 600;
    font-size: 12px;
  }
</style>
