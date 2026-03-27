<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let pairOptions: Array<{ value: string; label: string }> = [];
  export let selectedPairValue = '';
  export let baseTokenSymbol = '';
  export let quoteTokenSymbol = '';
  export let orderbookScopeMode: 'aggregated' | 'selected' = 'aggregated';

  const dispatch = createEventDispatcher<{
    pairchange: string;
    togglescope: void;
  }>();

  function handlePairChange(event: Event): void {
    dispatch('pairchange', (event.currentTarget as HTMLSelectElement).value);
  }

  function toggleScope(): void {
    dispatch('togglescope');
  }
</script>

<div class="swap-toolbar">
  <div class="toolbar-select toolbar-select-pair">
    <div class="pair-select-preview" aria-hidden="true">
      <span
        class="pair-token-badge"
        class:usdc={baseTokenSymbol === 'USDC'}
        class:usdt={baseTokenSymbol === 'USDT'}
        class:weth={baseTokenSymbol === 'WETH' || baseTokenSymbol === 'ETH'}
      >
        {baseTokenSymbol.slice(0, 1)}
      </span>
      <span
        class="pair-token-badge overlap"
        class:usdc={quoteTokenSymbol === 'USDC'}
        class:usdt={quoteTokenSymbol === 'USDT'}
        class:weth={quoteTokenSymbol === 'WETH' || quoteTokenSymbol === 'ETH'}
      >
        {quoteTokenSymbol.slice(0, 1)}
      </span>
    </div>
    <select
      value={selectedPairValue}
      data-testid="swap-pair-select"
      aria-label="Swap pair"
      on:change={handlePairChange}
    >
      {#each pairOptions as pair (pair.value)}
        <option value={pair.value}>{pair.label}</option>
      {/each}
    </select>
  </div>

  <button
    type="button"
    class="scope-toggle"
    class:is-selected={orderbookScopeMode === 'selected'}
    aria-pressed={orderbookScopeMode === 'selected'}
    data-testid="swap-scope-toggle"
    data-scope-mode={orderbookScopeMode}
    on:click={toggleScope}
  >
    {orderbookScopeMode === 'aggregated' ? 'Aggregated' : 'Selected'}
  </button>
</div>

<style>
  .swap-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    margin-bottom: 8px;
  }

  .toolbar-select {
    position: relative;
    min-width: 0;
    border: 1px solid #2d313b;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(34, 35, 42, 0.96), rgba(24, 25, 31, 0.96));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  .toolbar-select::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.04);
  }

  .toolbar-select-pair {
    min-width: 120px;
  }

  .pair-select-preview {
    position: absolute;
    top: 50%;
    left: 10px;
    display: inline-flex;
    align-items: center;
    transform: translateY(-50%);
    pointer-events: none;
    z-index: 1;
  }

  .pair-token-badge {
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: #1f2937;
    color: #f3f4f6;
    font-size: 9px;
    font-weight: 700;
    box-shadow: 0 0 0 1px rgba(9, 9, 11, 0.65);
  }

  .pair-token-badge.overlap {
    margin-left: -4px;
  }

  .pair-token-badge.usdc {
    background: #2563eb;
  }

  .pair-token-badge.usdt {
    background: #059669;
  }

  .pair-token-badge.weth {
    background: #7c3aed;
  }

  select {
    width: 100%;
    min-width: 0;
    height: 32px;
    border: 0;
    background: transparent;
    padding: 0 10px 0 40px;
    font-size: 12px;
    font-weight: 600;
    color: #e5e7eb;
    color-scheme: dark;
    outline: none;
    box-sizing: border-box;
  }

  select option {
    background: #0f1117;
    color: #f3f4f6;
  }

  .scope-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(17, 18, 23, 0.9);
    color: #c2c8d3;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    box-sizing: border-box;
    transition: color 100ms ease, border-color 100ms ease, background 100ms ease;
  }

  .scope-toggle:hover {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.65);
  }

  .scope-toggle.is-selected {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.34);
    background: rgba(251, 191, 36, 0.1);
  }

  @media (max-width: 900px) {
    .toolbar-select-pair {
      min-width: 0;
    }
  }

  @media (max-width: 640px) {
    .swap-toolbar {
      grid-template-columns: 1fr;
    }

    .scope-toggle {
      width: 100%;
    }
  }
</style>
