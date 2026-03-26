<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let tradeSide: 'buy-base' | 'sell-base' = 'buy-base';
  export let orderType: 'limit' | 'market' = 'limit';
  export let selectedHubOptions: Array<{ value: string; label: string }> = [];
  export let selectedHubValue = '';

  const dispatch = createEventDispatcher<{
    tradesidechange: 'buy-base' | 'sell-base';
    ordertypechange: 'limit' | 'market';
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
    <button
      type="button"
      class="type-tab-text"
      class:active={orderType === 'limit'}
      on:click={() => dispatch('ordertypechange', 'limit')}
    >Limit</button>
    <button
      type="button"
      class="type-tab-text"
      class:active={orderType === 'market'}
      on:click={() => dispatch('ordertypechange', 'market')}
    >Market</button>
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
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.02);
  }

  .side-tab,
  .type-tab-text {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 0 10px;
    border-radius: 9px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.02);
    font-size: 12px;
    font-weight: 600;
    color: #8c95a4;
    cursor: pointer;
    transition: color 100ms ease, border-color 100ms ease, background 100ms ease;
    user-select: none;
  }

  .type-tab-text.active {
    border-color: rgba(251, 191, 36, 0.3);
    background: rgba(251, 191, 36, 0.08);
    color: #fbbf24;
  }

  .side-tab.is-buy-active {
    border-color: rgba(22, 163, 74, 0.28);
    background: rgba(22, 163, 74, 0.1);
    color: #86efac;
  }

  .side-tab.is-sell-active {
    border-color: rgba(220, 38, 38, 0.24);
    background: rgba(220, 38, 38, 0.1);
    color: #fda4af;
  }

  .side-tab:hover,
  .type-tab-text:hover {
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
