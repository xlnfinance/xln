<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let tradeSide: 'buy-base' | 'sell-base' = 'buy-base';
  export let selectedHubOptions: Array<{ value: string; label: string }> = [];
  export let selectedHubValue = '';

  const dispatch = createEventDispatcher<{
    tradesidechange: 'buy-base' | 'sell-base';
    hubchange: string;
  }>();

  function handleHubChange(event: Event): void {
    dispatch('hubchange', (event.currentTarget as HTMLSelectElement).value);
  }
</script>

<div class="order-form-header">
  <div class="mode-rail">
    <button
      type="button"
      class="side-tab"
      class:is-buy-active={tradeSide === 'buy-base'}
      data-testid="swap-side-buy"
      on:click={() => dispatch('tradesidechange', 'buy-base')}
    >Buy</button>
    <button
      type="button"
      class="side-tab"
      class:is-sell-active={tradeSide === 'sell-base'}
      data-testid="swap-side-sell"
      on:click={() => dispatch('tradesidechange', 'sell-base')}
    >Sell</button>
  </div>
  {#if selectedHubOptions.length > 0}
    <select
      class="hub-select-inline"
      value={selectedHubValue}
      on:change={handleHubChange}
      data-testid="swap-account-select"
    >
      {#each selectedHubOptions as hub (hub.value)}
        <option value={hub.value}>{hub.label}</option>
      {/each}
    </select>
  {/if}
</div>

<style>
  .order-form-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(160px, 220px);
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .mode-rail {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(28, 29, 35, 0.96), rgba(19, 20, 26, 0.96));
  }

  .side-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    padding: 0 12px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.03);
    font-size: 12px;
    font-weight: 700;
    color: #a7afbd;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
    user-select: none;
  }

  .side-tab.is-buy-active {
    border-color: rgba(34, 197, 94, 0.32);
    background: linear-gradient(180deg, rgba(22, 163, 74, 0.22), rgba(22, 101, 52, 0.18));
    color: #dcfce7;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .side-tab.is-sell-active {
    border-color: rgba(239, 68, 68, 0.28);
    background: linear-gradient(180deg, rgba(185, 28, 28, 0.22), rgba(127, 29, 29, 0.18));
    color: #ffe4e6;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .side-tab:hover {
    color: #d1d5db;
  }

  .hub-select-inline {
    background: #111217;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    color: #e5e7eb;
    font-size: 12px;
    font-weight: 600;
    height: 34px;
    padding: 0 10px;
    cursor: pointer;
    justify-self: end;
    width: min(100%, 220px);
    max-width: 220px;
    min-width: 0;
    color-scheme: dark;
    box-sizing: border-box;
  }

  .hub-select-inline option {
    background: #0f1117;
    color: #f3f4f6;
  }

  @media (max-width: 900px) {
    .order-form-header {
      grid-template-columns: 1fr;
      align-items: stretch;
      gap: 8px;
    }

    .mode-rail {
      width: 100%;
    }

    .side-tab,
    .type-tab-text {
      width: 100%;
    }

    .hub-select-inline {
      justify-self: stretch;
      width: 100%;
      max-width: none;
    }
  }
</style>
