<script lang="ts">
  /**
   * UserModePanel - RJEA hierarchical navigation for user mode
   *
   * Uses existing EntityDropdown + AccountDropdown components.
   * No popups, mobile-friendly, unified dropdown system.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { writable } from 'svelte/store';
  import { activeSigner, activeVault } from '$lib/stores/vaultStore';
  import { xlnFunctions } from '$lib/stores/xlnStore';
  import { setEntityEnvContext } from './components/entity/shared/EntityEnvContext';
  import { shortAddress } from '$lib/utils/format';
  import type { Tab } from '$lib/types/ui';

  import EntityDropdown from '$lib/components/Entity/EntityDropdown.svelte';
  import AccountDropdown from '$lib/components/Entity/AccountDropdown.svelte';
  import EntityPanel from '$lib/components/Entity/EntityPanel.svelte';
  import AccountPanel from '$lib/components/Entity/AccountPanel.svelte';

  interface Props {
    isolatedEnv: Writable<any>;
    isolatedHistory?: Writable<any[]>;
    isolatedTimeIndex?: Writable<number>;
    isolatedIsLive?: Writable<boolean>;
  }

  let {
    isolatedEnv,
    isolatedHistory = writable([]),
    isolatedTimeIndex = writable(-1),
    isolatedIsLive = writable(true)
  }: Props = $props();

  // Set context for EntityPanel/AccountPanel
  setEntityEnvContext({
    isolatedEnv,
    isolatedHistory,
    isolatedTimeIndex,
    isolatedIsLive,
  });

  // Selection state
  let selectedEntityId = $state<string | null>(null);
  let selectedSignerId = $state<string | null>(null);
  let selectedAccountId = $state<string | null>(null);

  // Reactive: signer info from vault
  const signer = $derived($activeSigner);
  const vault = $derived($activeVault);

  // Current frame (time-aware)
  const currentFrame = $derived.by(() => {
    const timeIdx = $isolatedTimeIndex;
    const hist = $isolatedHistory;
    const env = $isolatedEnv;

    if (timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return hist[idx];
    }
    return env;
  });

  // Get replica for selected entity
  const selectedReplica = $derived.by(() => {
    if (!selectedEntityId || !selectedSignerId || !currentFrame?.eReplicas) return null;
    const key = `${selectedEntityId}:${selectedSignerId}`;
    const replicas = currentFrame.eReplicas instanceof Map
      ? currentFrame.eReplicas
      : new Map(Object.entries(currentFrame.eReplicas || {}));
    return replicas.get(key) || null;
  });

  // Get selected account
  const selectedAccount = $derived.by(() => {
    if (!selectedReplica || !selectedAccountId) return null;
    return selectedReplica.state?.accounts?.get(selectedAccountId) || null;
  });

  // Tab for EntityPanel
  const entityTab: Tab = $derived({
    id: 'user-entity',
    title: selectedEntityId ? `Entity ${selectedEntityId.slice(0, 8)}` : 'Entity',
    entityId: selectedEntityId || '',
    signerId: selectedSignerId || '',
    jurisdiction: 'browservm',
    isActive: true,
  });

  // Handle entity selection from dropdown
  function handleEntitySelect(event: CustomEvent<{ jurisdiction: string; signerId: string; entityId: string }>) {
    const { signerId, entityId } = event.detail;
    selectedEntityId = entityId;
    selectedSignerId = signerId;
    selectedAccountId = null; // Reset account when entity changes
    console.log('[UserModePanel] Entity selected:', entityId.slice(0, 10), signerId.slice(0, 10));
  }

  // Handle account selection from dropdown
  function handleAccountSelect(event: CustomEvent<{ accountId: string }>) {
    selectedAccountId = event.detail.accountId;
    console.log('[UserModePanel] Account selected:', selectedAccountId?.slice(0, 10));
  }

  // Balance from selected entity reserves
  const balance = $derived.by(() => {
    if (!selectedReplica?.state?.reserves) return null;
    const reserves = selectedReplica.state.reserves;
    if (reserves instanceof Map && reserves.size > 0) {
      const first = reserves.entries().next().value;
      if (first) {
        const [tokenId, amount] = first;
        return { tokenId, amount };
      }
    }
    return null;
  });

  // Format balance
  function formatBalance(amount: bigint, decimals: number = 18): string {
    const dec = BigInt(decimals);
    const divisor = 10n ** dec;
    const whole = amount / divisor;
    const fracDivisor = dec > 2n ? 10n ** (dec - 2n) : 1n;
    const frac = fracDivisor > 0n ? (amount % divisor) / fracDivisor : 0n;
    return `${whole}.${frac.toString().padStart(2, '0')}`;
  }
</script>

<div class="user-panel">
  <!-- Header: BrainVault inline (no popup) -->
  <header class="panel-header">
    <div class="header-left">
      <span class="network-badge">BrowserVM</span>
    </div>
    <div class="header-center">
      {#if signer}
        <span class="address">{shortAddress(signer.address)}</span>
        {#if balance}
          {@const tokenInfo = $xlnFunctions?.getTokenInfo(Number(balance.tokenId)) ?? { symbol: 'TKN', decimals: 18 }}
          <span class="balance">{formatBalance(balance.amount, tokenInfo.decimals)} {tokenInfo.symbol}</span>
        {/if}
      {:else}
        <span class="no-wallet">No wallet connected</span>
      {/if}
    </div>
    <div class="header-right">
      {#if vault}
        <a href="/vault" class="vault-link">{vault.id}</a>
      {:else}
        <a href="/vault" class="vault-link unlock">Unlock</a>
      {/if}
    </div>
  </header>

  <!-- Navigation: R → J → E → A dropdowns -->
  <nav class="panel-nav">
    <!-- Entity Dropdown (includes signer) -->
    <div class="nav-dropdown entity-dropdown">
      <EntityDropdown
        tab={entityTab}
        on:entitySelect={handleEntitySelect}
      />
    </div>

    <!-- Account Dropdown (when entity selected) -->
    {#if selectedReplica}
      <div class="nav-dropdown account-dropdown">
        <AccountDropdown
          replica={selectedReplica}
          {selectedAccountId}
          on:accountSelect={handleAccountSelect}
        />
      </div>
    {/if}
  </nav>

  <!-- Content: Show based on selection depth -->
  <main class="panel-content">
    {#if selectedAccountId && selectedAccount}
      <!-- Account selected: show AccountPanel -->
      <AccountPanel
        account={selectedAccount}
        entityId={selectedEntityId || ''}
        counterpartyId={selectedAccountId}
      />
    {:else if selectedEntityId && selectedReplica}
      <!-- Entity selected: show EntityPanel -->
      <EntityPanel tab={entityTab} isLast={true} />
    {:else}
      <!-- Nothing selected: show empty state -->
      <div class="empty-state">
        <h2>Select an Entity</h2>
        <p>Use the dropdown above to select an entity and view its state.</p>
        {#if !signer}
          <a href="/vault" class="action-btn">Create Wallet First</a>
        {/if}
      </div>
    {/if}
  </main>
</div>

<style>
  .user-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary, #0d1117);
    color: var(--text-primary, #e6edf3);
  }

  /* Header */
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: linear-gradient(180deg, #1a1f26 0%, #161b22 100%);
    border-bottom: 1px solid var(--border-primary, #30363d);
    min-height: 44px;
    flex-wrap: wrap;
    gap: 8px;
  }

  .header-left, .header-center, .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .network-badge {
    padding: 4px 8px;
    background: var(--accent-blue, #1f6feb);
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .address {
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 13px;
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
  }

  .vault-link {
    padding: 6px 12px;
    border: 1px solid var(--border-primary, #30363d);
    border-radius: 6px;
    background: var(--bg-tertiary, #21262d);
    color: var(--text-primary, #e6edf3);
    font-size: 12px;
    text-decoration: none;
    transition: all 0.15s ease;
  }

  .vault-link:hover {
    background: var(--bg-hover, #30363d);
  }

  .vault-link.unlock {
    background: var(--accent-blue, #1f6feb);
    border-color: var(--accent-blue, #1f6feb);
    color: white;
  }

  /* Navigation */
  .panel-nav {
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-secondary, #161b22);
    border-bottom: 1px solid var(--border-primary, #30363d);
    flex-wrap: wrap;
  }

  .nav-dropdown {
    flex: 1;
    min-width: 200px;
  }

  /* Content */
  .panel-content {
    flex: 1;
    overflow: auto;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 300px;
    text-align: center;
    padding: 2rem;
  }

  .empty-state h2 {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
    color: var(--text-primary, #e6edf3);
  }

  .empty-state p {
    color: var(--text-secondary, #8b949e);
    margin-bottom: 1rem;
  }

  .action-btn {
    padding: 10px 20px;
    background: var(--accent-blue, #1f6feb);
    border: none;
    border-radius: 6px;
    color: white;
    font-size: 14px;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .action-btn:hover {
    background: #388bfd;
  }

  /* Mobile responsive */
  @media (max-width: 768px) {
    .panel-header {
      padding: 6px 10px;
    }

    .header-center {
      order: 3;
      width: 100%;
      justify-content: center;
    }

    .nav-dropdown {
      min-width: 100%;
    }

    .panel-nav {
      flex-direction: column;
    }
  }
</style>
