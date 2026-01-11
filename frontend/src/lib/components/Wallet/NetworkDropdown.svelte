<script lang="ts">
  import { onMount } from 'svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { EVM_NETWORKS, type EVMNetwork } from '$lib/config/evmNetworks';
  import { selectedNetwork, networkStatus, setNetwork, refreshNetworkStatus } from '$lib/stores/networkStore';

  let isOpen = false;

  function selectNetwork(network: EVMNetwork) {
    setNetwork(network);
    isOpen = false;
  }

  onMount(() => {
    refreshNetworkStatus();
  });
</script>

<Dropdown bind:open={isOpen} minWidth={160} maxWidth={240}>
  <span slot="trigger" class="trigger-content">
    <span
      class="status-dot"
      class:connected={$networkStatus === 'connected'}
      class:connecting={$networkStatus === 'connecting'}
      class:error={$networkStatus === 'error'}
    ></span>
    <span class="trigger-text">{$selectedNetwork.name}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    <div class="menu-section">Mainnets</div>
    {#each EVM_NETWORKS.filter(n => !n.isTestnet) as network}
      <button
        class="menu-item"
        class:selected={network.chainId === $selectedNetwork.chainId}
        on:click={() => selectNetwork(network)}
      >
        <span class="menu-label">{network.name}</span>
      </button>
    {/each}
    <div class="menu-divider"></div>
    <div class="menu-section">Testnets</div>
    {#each EVM_NETWORKS.filter(n => n.isTestnet) as network}
      <button
        class="menu-item"
        class:selected={network.chainId === $selectedNetwork.chainId}
        on:click={() => selectNetwork(network)}
      >
        <span class="menu-label">{network.name}</span>
      </button>
    {/each}
  </div>
</Dropdown>

<style>
  .trigger-content {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ffcc00;
    box-shadow: 0 0 8px rgba(255, 204, 0, 0.5);
  }

  .status-dot.connected {
    background: #00ff88;
    box-shadow: 0 0 8px rgba(0, 255, 136, 0.5);
  }

  .status-dot.error {
    background: #ff4466;
    box-shadow: 0 0 8px rgba(255, 68, 102, 0.5);
  }

  .trigger-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-arrow {
    color: #888;
    font-size: 10px;
    transition: transform 0.2s;
  }

  .trigger-arrow.open {
    transform: rotate(180deg);
  }

  .menu-content {
    padding: 4px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #e1e1e1;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.12s;
    text-align: left;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .menu-item.selected {
    background: rgba(0, 122, 255, 0.18);
  }

  .menu-label {
    flex: 1;
  }

  .menu-divider {
    height: 1px;
    background: #333;
    margin: 4px 8px;
  }

  .menu-section {
    padding: 6px 12px;
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
</style>
