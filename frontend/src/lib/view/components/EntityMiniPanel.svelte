<script lang="ts">
  // @ts-nocheck - TODO: Add proper types
  /**
   * EntityMiniPanel - Compact popup when clicking entity in Graph3D
   * Shows quick info + actions, can expand to full panel
   *
   * TIME-TRAVEL AWARE: Reads from isolatedHistory[timeIndex] when scrubbing
   */
  import { createEventDispatcher } from 'svelte';
  import type { Writable } from 'svelte/store';
  import { formatTokenAmount } from './entity/shared/formatters';

  export let entityId: string;
  export let entityName: string = '';
  export let position: { x: number; y: number } = { x: 0, y: 0 };
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;

  const dispatch = createEventDispatcher();

  // TIME-TRAVEL AWARE: Read from history[timeIndex] when scrubbing, else live state
  $: env = (() => {
    const timeIdx = $isolatedTimeIndex;
    const hist = $isolatedHistory;
    if (timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return hist[idx];  // Historical frame
    }
    return $isolatedEnv;  // Live state
  })();

  /**
   * Get reserve values from reserves object (handles both Map and plain Object formats)
   * Maps serialize to plain objects when passed through postMessage/JSON
   */
  function getReserveValue(reserves: Map<string, bigint> | Record<string, unknown> | undefined, key: string): bigint {
    if (!reserves) return 0n;
    // If it's a Map, use .get()
    if (reserves instanceof Map) {
      return reserves.get(key) || 0n;
    }
    // If it's a plain object (serialized Map), use property access
    if (typeof reserves === 'object') {
      const v = (reserves as Record<string, unknown>)[key];
      if (v === undefined || v === null) return 0n;
      if (typeof v === 'string') {
        const numStr = v.replace(/n$/, '');
        return BigInt(numStr);
      }
      return BigInt(v as bigint);
    }
    return 0n;
  }

  // Find replica for this entity
  $: replica = (() => {
    if (!env?.eReplicas) return null;
    // Handle both Map and plain Object (serialized)
    if (env.eReplicas instanceof Map) {
      return Array.from(env.eReplicas.entries()).find(([key]: [string, any]) => key.startsWith(entityId + ':'))?.[1];
    }
    // Plain object case
    const entries = Object.entries(env.eReplicas);
    return entries.find(([key]) => key.startsWith(entityId + ':'))?.[1];
  })();

  $: reserves = getReserveValue(replica?.state?.reserves, '1');

  // Handle both Map and plain Object (serialized) for accounts
  $: accounts = (() => {
    if (!replica?.state?.accounts) return [];
    if (replica.state.accounts instanceof Map) {
      return Array.from(replica.state.accounts.entries());
    }
    return Object.entries(replica.state.accounts);
  })();

  // Get delta from account (handles both Map and Object)
  function getDelta(acc: any, tokenId: number): any {
    if (!acc?.deltas) return null;
    if (acc.deltas instanceof Map) {
      return acc.deltas.get(tokenId);
    }
    return acc.deltas[tokenId];
  }

  $: totalCollateral = accounts.reduce((sum: bigint, [_, acc]: [string, any]) => {
    const delta = getDelta(acc, 1);
    return sum + BigInt(delta?.collateral || 0);
  }, 0n);

  // Use shared formatter with token ID 1 (USDC default)
  function formatAmount(amount: bigint): string {
    return formatTokenAmount(1, amount);
  }

  function openFullPanel() {
    dispatch('openFull', { entityId, entityName });
  }

  function close() {
    dispatch('close');
  }

  // Actions
  async function quickR2R() {
    dispatch('action', { type: 'r2r', entityId });
  }

  async function quickR2C() {
    dispatch('action', { type: 'r2c', entityId });
  }
</script>

<div
  class="mini-panel"
  style="left: {position.x}px; top: {position.y}px;"
>
  <div class="header">
    <span class="name">{entityName || entityId.slice(0, 10) + '...'}</span>
    <button class="close-btn" on:click={close}>×</button>
  </div>

  <div class="stats">
    <div class="stat">
      <span class="label">Reserve</span>
      <span class="value">{formatAmount(reserves)} USDC</span>
    </div>
    <div class="stat">
      <span class="label">Collateral</span>
      <span class="value">{formatAmount(totalCollateral)} USDC</span>
    </div>
    <div class="stat">
      <span class="label">Accounts</span>
      <span class="value">{accounts.length}</span>
    </div>
  </div>

  <div class="quick-actions">
    <button class="action-btn r2r" on:click={quickR2R} title="Reserve to Reserve">
      R2R
    </button>
    <button class="action-btn r2c" on:click={quickR2C} title="Reserve to Collateral">
      R2C
    </button>
    <button class="action-btn expand" on:click={openFullPanel} title="Open Full Panel">
      ⤢
    </button>
  </div>

  {#if accounts.length > 0}
    <div class="accounts-preview">
      <div class="section-title">Accounts</div>
      {#each accounts.slice(0, 3) as [counterpartyId, acc]}
        {@const delta = getDelta(acc, 1)}
        {@const ondelta = BigInt(delta?.ondelta || 0)}
        <div class="account-row">
          <span class="peer">{counterpartyId.slice(0, 8)}...</span>
          <span class="ondelta" class:positive={ondelta > 0n} class:negative={ondelta < 0n}>
            {ondelta > 0n ? '+' : ''}{formatAmount(ondelta)}
          </span>
        </div>
      {/each}
      {#if accounts.length > 3}
        <div class="more">+{accounts.length - 3} more</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .mini-panel {
    position: fixed;
    z-index: 10000;
    background: #0c0a09;
    border: 1px solid #fbbf24;
    border-radius: 10px;
    padding: 14px;
    min-width: 220px;
    max-width: 300px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 20px rgba(251, 191, 36, 0.15);
    font-family: 'Inter', -apple-system, sans-serif;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid #292524;
  }

  .name {
    font-weight: 600;
    color: #e7e5e4;
    font-size: 14px;
  }

  .close-btn {
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 4px;
    color: #78716c;
    font-size: 16px;
    cursor: pointer;
    padding: 2px 8px;
    transition: all 0.15s;
  }

  .close-btn:hover {
    color: #ef4444;
    border-color: #ef4444;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }

  .stat {
    text-align: center;
    padding: 8px 4px;
    background: #1c1917;
    border-radius: 6px;
  }

  .label {
    display: block;
    font-size: 9px;
    color: #57534e;
    text-transform: uppercase;
    margin-bottom: 2px;
  }

  .value {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #fbbf24;
    font-weight: 600;
  }

  .quick-actions {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
  }

  .action-btn {
    flex: 1;
    padding: 8px;
    border: 1px solid #292524;
    border-radius: 6px;
    background: #1c1917;
    color: #a8a29e;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .action-btn:hover {
    background: #292524;
  }

  .action-btn.r2r:hover { border-color: #22c55e; color: #22c55e; }
  .action-btn.r2c:hover { border-color: #fbbf24; color: #fbbf24; }
  .action-btn.expand:hover { border-color: #8b5cf6; color: #8b5cf6; }

  .accounts-preview {
    border-top: 1px solid #292524;
    padding-top: 10px;
  }

  .section-title {
    font-size: 9px;
    color: #57534e;
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  .account-row {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    padding: 4px 8px;
    background: #1c1917;
    border-radius: 4px;
    margin-bottom: 4px;
  }

  .peer {
    font-family: 'JetBrains Mono', monospace;
    color: #a8a29e;
  }

  .ondelta {
    font-family: 'JetBrains Mono', monospace;
    color: #57534e;
  }

  .ondelta.positive {
    color: #22c55e;
  }

  .ondelta.negative {
    color: #ef4444;
  }

  .more {
    font-size: 10px;
    color: #57534e;
    text-align: center;
    margin-top: 6px;
  }
</style>
