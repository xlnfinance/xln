<!--
  TokenSelect.svelte - Reusable token selector

  Clean design with token icons and consistent formatting.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';

  export let value: number = 1;
  export let disabled: boolean = false;
  export let label: string = '';
  export let compact: boolean = false;

  const dispatch = createEventDispatcher();

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  $: activeFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // Token definitions
  const tokens = [
    { id: 1, symbol: 'USDC', name: 'USD Coin', color: '#2775ca', icon: '$' },
    { id: 2, symbol: 'WETH', name: 'Wrapped Ether', color: '#627eea', icon: 'E' },
    { id: 3, symbol: 'USDT', name: 'Tether', color: '#26a17b', icon: '$' },
  ];

  let showDropdown = false;

  $: selectedToken = tokens.find(t => t.id === value) ?? tokens[0]!;

  function selectToken(id: number) {
    value = id;
    showDropdown = false;
    dispatch('change', { value: id });
  }

  function toggleDropdown() {
    if (!disabled) showDropdown = !showDropdown;
  }

  function handleBlur() {
    setTimeout(() => showDropdown = false, 150);
  }
</script>

<div class="token-select" class:disabled class:compact>
  {#if label}
    <label class="select-label">{label}</label>
  {/if}

  <button
    class="select-trigger"
    type="button"
    on:click={toggleDropdown}
    on:blur={handleBlur}
    {disabled}
  >
    <span class="token-icon" style="background: {selectedToken.color}">
      {selectedToken.icon}
    </span>
    <span class="token-symbol">{selectedToken.symbol}</span>
    <svg class="chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>

  {#if showDropdown}
    <div class="dropdown">
      {#each tokens as token}
        <button
          class="dropdown-item"
          class:selected={token.id === value}
          on:mousedown|preventDefault={() => selectToken(token.id)}
        >
          <span class="token-icon" style="background: {token.color}">
            {token.icon}
          </span>
          <div class="token-info">
            <span class="token-symbol">{token.symbol}</span>
            {#if !compact}
              <span class="token-name">{token.name}</span>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .token-select {
    position: relative;
  }

  .token-select.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .select-label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: #78716c;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .select-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    color: #e7e5e4;
    font-size: 14px;
    cursor: pointer;
    transition: border-color 0.15s;
    width: 100%;
    box-sizing: border-box;
  }

  .compact .select-trigger {
    padding: 8px 10px;
    min-width: 80px;
  }

  .select-trigger:hover:not(:disabled) {
    border-color: #44403c;
  }

  .select-trigger:focus {
    outline: none;
    border-color: #fbbf24;
  }

  .token-icon {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    color: white;
    flex-shrink: 0;
  }

  .compact .token-icon {
    width: 20px;
    height: 20px;
    font-size: 10px;
  }

  .token-symbol {
    font-weight: 500;
    flex: 1;
    text-align: left;
  }

  .chevron {
    color: #78716c;
    flex-shrink: 0;
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100;
    overflow: hidden;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    background: none;
    border: none;
    color: #e7e5e4;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
  }

  .dropdown-item:hover {
    background: #292524;
  }

  .dropdown-item.selected {
    background: #422006;
  }

  .token-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .token-name {
    font-size: 11px;
    color: #78716c;
  }
</style>
