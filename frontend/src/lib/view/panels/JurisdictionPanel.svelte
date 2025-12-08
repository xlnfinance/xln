<script lang="ts">
  /**
   * Jurisdiction Panel - Time-travel aware J-Machine viewer
   * Shows jurisdiction data from the CURRENT FRAME (respects time machine)
   * Features: dropdown selector, entity reserves, collaterals
   */

  import type { Writable } from 'svelte/store';
  import { get } from 'svelte/store';
  import { panelBridge } from '../utils/panelBridge';

  // Props
  interface Props {
    isolatedEnv: Writable<any>;
    isolatedHistory?: Writable<any[]>;
    isolatedTimeIndex?: Writable<number>;
  }

  let { isolatedEnv, isolatedHistory, isolatedTimeIndex }: Props = $props();

  // Selected jurisdiction
  let selectedJurisdictionName = $state<string | null>(null);

  // Tab state
  let activeTab = $state<'overview' | 'reserves' | 'collaterals'>('overview');

  // ═══════════════════════════════════════════════════════════════════════════
  //          TIME-TRAVEL AWARE DATA DERIVATION
  // ═══════════════════════════════════════════════════════════════════════════

  // Get current frame based on timeIndex
  function getCurrentFrame(): any {
    const timeIndex = isolatedTimeIndex ? get(isolatedTimeIndex) : -1;
    const history = isolatedHistory ? get(isolatedHistory) : [];
    const env = get(isolatedEnv);

    if (timeIndex >= 0 && history && history.length > 0) {
      const idx = Math.min(timeIndex, history.length - 1);
      return history[idx];
    }
    return env; // Live mode - return env directly
  }

  // Get jurisdictions from current frame
  let jurisdictions = $derived.by(() => {
    const timeIndex = isolatedTimeIndex ? ($isolatedTimeIndex ?? -1) : -1;
    const history = isolatedHistory ? $isolatedHistory : [];
    const env = $isolatedEnv;

    // From historical frame
    if (timeIndex >= 0 && history && history.length > 0) {
      const idx = Math.min(timeIndex as number, history.length - 1);
      const frame = history[idx];
      // EnvSnapshot has jReplicas as array
      return frame?.jReplicas || [];
    }

    // From live env (jReplicas is a Map)
    if (env?.jReplicas) {
      if (env.jReplicas instanceof Map) {
        return Array.from(env.jReplicas.values());
      }
      return env.jReplicas;
    }

    return [];
  });

  // Auto-select first jurisdiction when available
  $effect(() => {
    if (jurisdictions.length > 0 && !selectedJurisdictionName) {
      selectedJurisdictionName = jurisdictions[0].name;
      console.log(`[J-Panel] Auto-selected jurisdiction: ${selectedJurisdictionName}`);
    }
    // Reset selection if current selection no longer exists
    if (selectedJurisdictionName && !jurisdictions.find((j: any) => j.name === selectedJurisdictionName)) {
      selectedJurisdictionName = jurisdictions.length > 0 ? jurisdictions[0].name : null;
    }
  });

  // Get selected jurisdiction data
  let selectedJurisdiction = $derived.by(() => {
    if (!selectedJurisdictionName) return null;
    return jurisdictions.find((j: any) => j.name === selectedJurisdictionName) || null;
  });

  // Get entity names from current frame
  function getEntityNames(): Map<string, string> {
    const names = new Map<string, string>();
    const timeIndex = isolatedTimeIndex ? ($isolatedTimeIndex ?? -1) : -1;
    const history = isolatedHistory ? $isolatedHistory : [];
    const env = $isolatedEnv;

    let eReplicas: Map<string, any> | null = null;

    if (timeIndex >= 0 && history && history.length > 0) {
      const idx = Math.min(timeIndex as number, history.length - 1);
      eReplicas = history[idx]?.eReplicas;
    } else {
      eReplicas = env?.eReplicas;
    }

    if (eReplicas) {
      const entries = eReplicas instanceof Map ? Array.from(eReplicas.entries()) : Object.entries(eReplicas);
      for (const [key, replica] of entries) {
        const entityId = key.split(':')[0];
        if (entityId && !names.has(entityId)) {
          names.set(entityId, (replica as any)?.name || `E${entityId.slice(-4)}`);
        }
      }
    }

    return names;
  }

  let entityNames = $derived(getEntityNames());

  // Get reserves from selected jurisdiction
  let reserves = $derived.by(() => {
    if (!selectedJurisdiction?.reserves) return [];
    const result: Array<{ entityId: string; name: string; tokenId: number; amount: bigint }> = [];

    const reservesMap = selectedJurisdiction.reserves instanceof Map
      ? selectedJurisdiction.reserves
      : new Map(Object.entries(selectedJurisdiction.reserves || {}));

    for (const [entityId, tokenMap] of reservesMap.entries()) {
      const tokens = tokenMap instanceof Map ? tokenMap : new Map(Object.entries(tokenMap || {}));
      for (const [tokenId, amount] of tokens.entries()) {
        if (amount > 0n) {
          result.push({
            entityId,
            name: entityNames.get(entityId) || `E${entityId.slice(-4)}`,
            tokenId: Number(tokenId),
            amount: BigInt(amount),
          });
        }
      }
    }

    return result;
  });

  // Get collaterals from selected jurisdiction
  let collaterals = $derived.by(() => {
    if (!selectedJurisdiction?.collaterals) return [];
    const result: Array<{ channelKey: string; tokenId: number; collateral: bigint; ondelta: bigint }> = [];

    const collMap = selectedJurisdiction.collaterals instanceof Map
      ? selectedJurisdiction.collaterals
      : new Map(Object.entries(selectedJurisdiction.collaterals || {}));

    for (const [channelKey, tokenMap] of collMap.entries()) {
      const tokens = tokenMap instanceof Map ? tokenMap : new Map(Object.entries(tokenMap || {}));
      for (const [tokenId, data] of tokens.entries()) {
        if (data && (data.collateral > 0n || data.ondelta !== 0n)) {
          result.push({
            channelKey,
            tokenId: Number(tokenId),
            collateral: BigInt(data.collateral || 0),
            ondelta: BigInt(data.ondelta || 0),
          });
        }
      }
    }

    return result;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //                              HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function formatEntityId(entityId: string): string {
    if (!entityId) return 'N/A';
    if (entityId.startsWith('0x') && entityId.length > 10) {
      return entityId.slice(0, 6) + '...' + entityId.slice(-4);
    }
    return entityId;
  }

  function formatBalance(balance: bigint): string {
    const num = Number(balance) / 1e18;
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(0)}K`;
    return `$${num.toFixed(0)}`;
  }

  function formatChannelKey(key: string): string {
    if (!key) return 'N/A';
    if (key.length > 20) {
      return key.slice(0, 10) + '...' + key.slice(-6);
    }
    return key;
  }

  function handleEntityClick(entityId: string) {
    panelBridge.emit('entity:selected', { entityId });
  }

  function handleEntityExpand(entityId: string, name: string) {
    panelBridge.emit('openEntityOperations', { entityId, entityName: name || formatEntityId(entityId) });
  }
</script>

<div class="jurisdiction-panel">
  <!-- Header with dropdown -->
  <div class="header">
    <h3>J-Machine</h3>
    <div class="j-selector">
      <select bind:value={selectedJurisdictionName} disabled={jurisdictions.length === 0}>
        {#if jurisdictions.length === 0}
          <option value="">No jurisdictions</option>
        {:else}
          {#each jurisdictions as j}
            <option value={j.name}>{j.name}</option>
          {/each}
        {/if}
      </select>
    </div>
    <div class="meta">
      {#if selectedJurisdiction}
        <span class="block-badge" title="Block Height">
          #{selectedJurisdiction.blockNumber?.toString() || '0'}
        </span>
      {/if}
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab" class:active={activeTab === 'overview'} onclick={() => activeTab = 'overview'}>
      Overview
    </button>
    <button class="tab" class:active={activeTab === 'reserves'} onclick={() => activeTab = 'reserves'}>
      Reserves ({reserves.length})
    </button>
    <button class="tab" class:active={activeTab === 'collaterals'} onclick={() => activeTab = 'collaterals'}>
      Collaterals ({collaterals.length})
    </button>
  </div>

  <!-- Content -->
  <div class="content">
    {#if !selectedJurisdiction}
      <div class="empty">No jurisdiction selected</div>
    {:else if activeTab === 'overview'}
      <!-- Overview tab -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Jurisdiction Info</span>
        </div>
        <div class="info-grid">
          <div class="info-row">
            <span class="info-label">Name</span>
            <span class="info-value">{selectedJurisdiction.name}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Block</span>
            <span class="info-value">#{selectedJurisdiction.blockNumber?.toString() || '0'}</span>
          </div>
          {#if selectedJurisdiction.contracts?.depository}
            <div class="info-row">
              <span class="info-label">Depository</span>
              <span class="info-value mono">{formatEntityId(selectedJurisdiction.contracts.depository)}</span>
            </div>
          {/if}
          {#if selectedJurisdiction.contracts?.entityProvider}
            <div class="info-row">
              <span class="info-label">EntityProvider</span>
              <span class="info-value mono">{formatEntityId(selectedJurisdiction.contracts.entityProvider)}</span>
            </div>
          {/if}
          <div class="info-row">
            <span class="info-label">Mempool</span>
            <span class="info-value">{selectedJurisdiction.mempool?.length || 0} pending txs</span>
          </div>
          <div class="info-row">
            <span class="info-label">Position</span>
            <span class="info-value mono">
              ({selectedJurisdiction.position?.x || 0}, {selectedJurisdiction.position?.y || 0}, {selectedJurisdiction.position?.z || 0})
            </span>
          </div>
        </div>
      </div>

    {:else if activeTab === 'reserves'}
      <!-- Reserves tab -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">_reserves mapping</span>
          <span class="count">{reserves.length}</span>
        </div>
        {#if reserves.length === 0}
          <div class="empty">No reserves in this frame</div>
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

    {:else if activeTab === 'collaterals'}
      <!-- Collaterals tab -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">_collaterals mapping</span>
          <span class="count">{collaterals.length}</span>
        </div>
        {#if collaterals.length === 0}
          <div class="empty">No collaterals in this frame</div>
        {:else}
          <div class="storage-table">
            {#each collaterals as c}
              <div class="storage-row" role="row">
                <span class="channel-key">{formatChannelKey(c.channelKey)}</span>
                <span class="token-id">[{c.tokenId}]</span>
                <span class="collateral-value">{formatBalance(c.collateral)}</span>
                <span class="ondelta-value" class:positive={c.ondelta > 0n} class:negative={c.ondelta < 0n}>
                  {c.ondelta >= 0n ? '+' : ''}{formatBalance(c.ondelta)}
                </span>
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

  .j-selector {
    flex: 1;
  }

  .j-selector select {
    width: 100%;
    padding: 4px 8px;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 4px;
    color: #c9d1d9;
    font-size: 11px;
    cursor: pointer;
  }

  .j-selector select:hover {
    border-color: #58a6ff;
  }

  .j-selector select:focus {
    outline: none;
    border-color: #58a6ff;
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
  }

  .meta {
    display: flex;
    gap: 6px;
  }

  .block-badge {
    font-size: 9px;
    padding: 2px 5px;
    background: #21262d;
    border-radius: 3px;
    color: #8b949e;
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

  .info-grid {
    padding: 8px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    border-bottom: 1px solid #21262d;
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .info-label {
    color: #8b949e;
    font-size: 10px;
  }

  .info-value {
    color: #c9d1d9;
    font-size: 10px;
  }

  .info-value.mono {
    font-family: 'Monaco', 'Menlo', monospace;
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

  .clickable {
    cursor: pointer;
    transition: background 0.15s;
  }

  .clickable:hover {
    background: #1c2128;
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

  .channel-key {
    color: #d29922;
    font-size: 9px;
    min-width: 80px;
  }

  .token-id {
    color: #8b949e;
    font-size: 9px;
    min-width: 30px;
  }

  .collateral-value {
    color: #7ee787;
    font-weight: 600;
    min-width: 60px;
    text-align: right;
  }

  .ondelta-value {
    color: #8b949e;
    min-width: 60px;
    text-align: right;
  }

  .ondelta-value.positive {
    color: #7ee787;
  }

  .ondelta-value.negative {
    color: #f85149;
  }
</style>
