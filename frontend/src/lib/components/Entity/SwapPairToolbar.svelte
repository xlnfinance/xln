<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const PRICE_STEP_OPTIONS = ['0.0001', '0.001', '0.01', '0.1', '1', '10', '50', '100'] as const;

  export let pairOptions: Array<{ value: string; label: string }> = [];
  export let selectedPairValue = '';
  export let baseTokenSymbol = '';
  export let quoteTokenSymbol = '';
  export let orderbookScopeMode: 'aggregated' | 'selected' = 'aggregated';
  export let selectedPriceStep: (typeof PRICE_STEP_OPTIONS)[number] = '0.0001';
  export let autoResolvedPriceStep: (typeof PRICE_STEP_OPTIONS)[number] = '1';

  const dispatch = createEventDispatcher<{
    pairchange: string;
    togglescope: void;
    pricestepchange: string;
  }>();

  function handlePairChange(event: Event): void {
    dispatch('pairchange', (event.currentTarget as HTMLSelectElement).value);
  }

  function toggleScope(): void {
    dispatch('togglescope');
  }

  function handlePriceStepChange(event: Event): void {
    dispatch('pricestepchange', (event.currentTarget as HTMLSelectElement).value);
  }
</script>

<div class="swap-toolbar">
  <div class="toolbar-select toolbar-select-pair">
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

  <label class="toolbar-select toolbar-select-step">
    <select
      value={selectedPriceStep}
      aria-label="Orderbook precision"
      data-testid="swap-orderbook-step-select"
      on:change={handlePriceStepChange}
    >
      {#each PRICE_STEP_OPTIONS as step}
        <option value={step}>{step}</option>
      {/each}
    </select>
  </label>
</div>

<style>
  .swap-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) minmax(112px, 0.7fr) minmax(132px, 0.8fr);
    gap: 10px;
    align-items: stretch;
    margin-bottom: 8px;
  }

  .toolbar-select {
    position: relative;
    display: flex;
    align-items: center;
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

  .toolbar-select-step {
    padding-left: 0;
  }

  select {
    width: 100%;
    min-width: 0;
    height: 32px;
    border: 0;
    background: transparent;
    padding: 0 12px;
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
    .swap-toolbar {
      grid-template-columns: minmax(0, 1fr) minmax(108px, 0.8fr) minmax(116px, 0.9fr);
    }

    .scope-toggle {
      width: auto;
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
