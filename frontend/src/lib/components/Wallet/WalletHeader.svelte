<script lang="ts">
  /**
   * WalletHeader - Address display with identicon and network selector
   *
   * Features:
   * - Identicon avatar
   * - Truncated address with copy
   * - Network/J-machine dropdown (future)
   */

  import { createEventDispatcher } from 'svelte';
  import { EVM_NETWORKS, type EVMNetwork } from '$lib/config/evmNetworks';
  import { Copy, Check, ChevronDown } from 'lucide-svelte';

  export let walletAddress: string;
  export let identiconSrc: string = '';

  const dispatch = createEventDispatcher();

  // Network state
  let selectedNetwork: EVMNetwork = EVM_NETWORKS[0]!;
  let networkDropdownOpen = false;

  // Copy state
  let copied = false;

  function truncateAddress(address: string): string {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  function handleCopy() {
    navigator.clipboard.writeText(walletAddress);
    copied = true;
    setTimeout(() => copied = false, 2000);
    dispatch('copy');
  }

  function selectNetwork(network: EVMNetwork) {
    selectedNetwork = network;
    networkDropdownOpen = false;
    dispatch('networkChange', { network });
  }

  // Close dropdown on outside click
  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.network-dropdown')) {
      networkDropdownOpen = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="wallet-header">
  <!-- Network Selector -->
  <div class="network-dropdown" class:open={networkDropdownOpen}>
    <button
      class="network-trigger"
      on:click|stopPropagation={() => networkDropdownOpen = !networkDropdownOpen}
      title="Select network (j-machine)"
    >
      <span class="network-dot" style="background: {selectedNetwork.isTestnet ? '#ff9944' : '#00ff88'}" />
      <span class="network-name">{selectedNetwork.name}</span>
      <ChevronDown size={14} class="chevron" />
    </button>
    {#if networkDropdownOpen}
      <div class="network-menu">
        <div class="menu-section">
          <span class="section-label">Mainnets</span>
          {#each EVM_NETWORKS.filter(n => !n.isTestnet) as network}
            <button
              class="network-item"
              class:selected={network.chainId === selectedNetwork.chainId}
              on:click|stopPropagation={() => selectNetwork(network)}
            >
              <span class="network-dot" style="background: #00ff88" />
              <span>{network.name}</span>
            </button>
          {/each}
        </div>
        <div class="menu-section">
          <span class="section-label">Testnets</span>
          {#each EVM_NETWORKS.filter(n => n.isTestnet) as network}
            <button
              class="network-item"
              class:selected={network.chainId === selectedNetwork.chainId}
              on:click|stopPropagation={() => selectNetwork(network)}
            >
              <span class="network-dot" style="background: #ff9944" />
              <span>{network.name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Address Display -->
  <div class="address-section">
    {#if identiconSrc}
      <img src={identiconSrc} alt="Identicon" class="identicon" />
    {:else}
      <div class="identicon-placeholder" />
    {/if}
    <button class="address-btn" on:click={handleCopy} title="Copy address">
      <code class="address">{truncateAddress(walletAddress)}</code>
      {#if copied}
        <Check size={14} class="copy-icon copied" />
      {:else}
        <Copy size={14} class="copy-icon" />
      {/if}
    </button>
  </div>
</div>

<style>
  .wallet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    background: rgba(255, 255, 255, 0.02);
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  /* Network Dropdown */
  .network-dropdown {
    position: relative;
  }

  .network-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .network-trigger:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .network-dropdown.open .network-trigger {
    border-color: rgba(255, 200, 100, 0.4);
  }

  .network-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .network-name {
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .network-trigger :global(.chevron) {
    color: rgba(255, 255, 255, 0.4);
    transition: transform 0.2s ease;
  }

  .network-dropdown.open .network-trigger :global(.chevron) {
    transform: rotate(180deg);
  }

  .network-menu {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    min-width: 180px;
    background: rgba(20, 18, 15, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 8px;
    z-index: 100;
    backdrop-filter: blur(20px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .menu-section {
    padding: 4px 0;
  }

  .menu-section:not(:last-child) {
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 4px;
    padding-bottom: 8px;
  }

  .section-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.35);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 10px 6px;
  }

  .network-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s ease;
    text-align: left;
  }

  .network-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .network-item.selected {
    background: rgba(255, 200, 100, 0.15);
    color: rgba(255, 200, 100, 1);
  }

  /* Address Section */
  .address-section {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .identicon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid rgba(255, 200, 100, 0.3);
  }

  .identicon-placeholder {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(255, 200, 100, 0.3), rgba(255, 150, 50, 0.3));
  }

  .address-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .address-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .address {
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
  }

  .address-btn :global(.copy-icon) {
    color: rgba(255, 255, 255, 0.4);
    transition: color 0.2s ease;
  }

  .address-btn:hover :global(.copy-icon) {
    color: rgba(255, 200, 100, 0.8);
  }

  .address-btn :global(.copy-icon.copied) {
    color: #00ff88;
  }
</style>
