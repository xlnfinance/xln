<script lang="ts">
  /**
   * InspectorHeader - Compact BrainVault status header
   *
   * Shows: Network | Address | Balance | Unlock button
   * Designed as header for XLNInspector superset panel.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { activeSigner, activeVault } from '$lib/stores/vaultStore';
  import { shortAddress } from '$lib/utils/format';

  interface Props {
    isolatedEnv: Writable<any>;
  }

  let { isolatedEnv }: Props = $props();

  // Modal state for full BrainVault view
  let showVaultModal = $state(false);

  // Reactive signer info
  let signer = $derived($activeSigner);
  let vault = $derived($activeVault);

  // Get balance from environment (first entity reserve)
  const balance = $derived.by(() => {
    const env = $isolatedEnv;
    if (!env?.eReplicas || !signer?.entityId) return null;

    // Find signer's entity
    for (const [key, replica] of env.eReplicas) {
      if (key.startsWith(signer.entityId)) {
        const reserves = replica?.state?.reserves;
        if (reserves instanceof Map && reserves.size > 0) {
          // Get first token balance (usually USDC)
          const first = reserves.entries().next().value;
          if (first) {
            const [tokenId, amount] = first;
            return { tokenId, amount };
          }
        }
      }
    }
    return null;
  });

  // Format balance for display
  function formatBalance(amount: bigint): string {
    const decimals = 18n;
    const divisor = 10n ** decimals;
    const whole = amount / divisor;
    const frac = (amount % divisor) / (10n ** 16n); // 2 decimal places
    return `${whole}.${frac.toString().padStart(2, '0')}`;
  }
</script>

<header class="inspector-header">
  <div class="left">
    <span class="network-badge">BrowserVM</span>
  </div>

  <div class="center">
    {#if signer}
      <span class="address" title={signer.address}>
        {shortAddress(signer.address)}
      </span>
      {#if balance}
        <span class="balance">
          {formatBalance(balance.amount)} USDC
        </span>
      {/if}
    {:else}
      <span class="no-wallet">No wallet connected</span>
    {/if}
  </div>

  <div class="right">
    {#if vault}
      <button class="vault-btn" onclick={() => showVaultModal = true}>
        {vault.id}
      </button>
    {:else}
      <button class="unlock-btn" onclick={() => showVaultModal = true}>
        Unlock Vault
      </button>
    {/if}
  </div>
</header>

<!-- BrainVault Modal -->
{#if showVaultModal}
  <div class="modal-overlay" onclick={() => showVaultModal = false}>
    <div class="modal-content" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2>BrainVault</h2>
        <button class="close-btn" onclick={() => showVaultModal = false}>
          &times;
        </button>
      </div>
      <div class="modal-body">
        {#await import('$lib/components/Views/BrainVaultView.svelte') then { default: BrainVaultView }}
          <BrainVaultView />
        {/await}
      </div>
    </div>
  </div>
{/if}

<style>
  .inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: linear-gradient(180deg, #1a1f26 0%, #161b22 100%);
    border-bottom: 1px solid var(--border-primary, #30363d);
    min-height: 48px;
  }

  .left, .center, .right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .left {
    flex: 0 0 auto;
  }

  .center {
    flex: 1;
    justify-content: center;
  }

  .right {
    flex: 0 0 auto;
  }

  .network-badge {
    padding: 4px 8px;
    background: var(--accent-blue, #1f6feb);
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .address {
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 13px;
    color: var(--text-primary, #e6edf3);
  }

  .balance {
    padding: 4px 8px;
    background: var(--bg-tertiary, #21262d);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--accent-green, #3fb950);
  }

  .no-wallet {
    font-size: 13px;
    color: var(--text-secondary, #8b949e);
    font-style: italic;
  }

  .vault-btn, .unlock-btn {
    padding: 6px 12px;
    border: 1px solid var(--border-primary, #30363d);
    border-radius: 6px;
    background: var(--bg-tertiary, #21262d);
    color: var(--text-primary, #e6edf3);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .vault-btn:hover, .unlock-btn:hover {
    background: var(--bg-hover, #30363d);
    border-color: var(--border-hover, #484f58);
  }

  .unlock-btn {
    background: var(--accent-blue, #1f6feb);
    border-color: var(--accent-blue, #1f6feb);
    color: white;
  }

  .unlock-btn:hover {
    background: #388bfd;
    border-color: #388bfd;
  }

  /* Modal styles */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: var(--bg-primary, #0d1117);
    border: 1px solid var(--border-primary, #30363d);
    border-radius: 12px;
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-primary, #30363d);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .close-btn {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary, #8b949e);
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .close-btn:hover {
    background: var(--bg-tertiary, #21262d);
    color: var(--text-primary, #e6edf3);
  }

  .modal-body {
    flex: 1;
    overflow: auto;
    padding: 20px;
  }
</style>
