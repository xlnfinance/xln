<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let pairOptions: Array<{ value: string; label: string }> = [];
  export let selectedPairValue = '';
  export let baseTokenSymbol = '';
  export let quoteTokenSymbol = '';
  export let orderbookScopeMode: 'aggregated' | 'selected' = 'aggregated';
  let selectedPairLabel = '';

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

  $: selectedPairLabel =
    pairOptions.find((pair) => pair.value === selectedPairValue)?.label
    || `${baseTokenSymbol}/${quoteTokenSymbol}`
    || 'Select pair';
</script>

<div class="swap-toolbar">
  <div class="toolbar-select toolbar-select-pair">
    <span class="toolbar-select-label">Pair</span>
    <select
      class="pair-select"
      value={selectedPairValue}
      data-testid="swap-pair-select"
      aria-label="Swap pair"
      title={selectedPairLabel}
      on:change={handlePairChange}
    >
      {#each pairOptions as pair (pair.value)}
        <option value={pair.value}>{pair.label}</option>
      {/each}
    </select>
    <span class="toolbar-chevron" aria-hidden="true">▾</span>
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
    grid-template-columns: minmax(0, 1.8fr) minmax(112px, 0.7fr);
    gap: 10px;
    align-items: stretch;
    margin-bottom: 8px;
  }

  .toolbar-select {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
    min-height: 40px;
    border: 1px solid #2d313b;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(34, 35, 42, 0.96), rgba(24, 25, 31, 0.96));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
  }

  .toolbar-select:hover {
    border-color: rgba(251, 191, 36, 0.24);
  }

  .toolbar-select:focus-within {
    border-color: rgba(251, 191, 36, 0.5);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.03),
      0 0 0 3px rgba(251, 191, 36, 0.08);
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

  select {
    width: 100%;
    min-width: 0;
    height: 40px;
    border: 0;
    background: transparent;
    padding: 0 36px 0 12px;
    font-size: 13px;
    font-weight: 650;
    color: #f3f4f6;
    color-scheme: dark;
    outline: none;
    box-sizing: border-box;
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
  }

  select option {
    background: #0f1117;
    color: #f3f4f6;
  }

  .pair-select {
    padding-top: 14px;
    padding-bottom: 6px;
    line-height: 1.15;
  }

  .toolbar-select-label {
    position: absolute;
    top: 7px;
    left: 12px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(194, 200, 211, 0.52);
    pointer-events: none;
  }

  .toolbar-chevron {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: rgba(229, 231, 235, 0.7);
    font-size: 12px;
    pointer-events: none;
  }

  .scope-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(17, 18, 23, 0.9);
    color: #c2c8d3;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
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
      grid-template-columns: minmax(0, 1fr) minmax(108px, 0.8fr);
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
