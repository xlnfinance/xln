<!--
  EntityPanelTabs.svelte - Rabby-style tabbed Entity interface

  Single scroll container, no nested scrollbars.
  Clean fintech design with proper form inputs.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Tab, EntityReplica } from '$lib/types/ui';
  import { history } from '../../stores/xlnStore';
  import { visibleReplicas, currentTimeIndex, isLive, timeOperations } from '../../stores/timeStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { xlnFunctions, entityPositions } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';

  // Icons
  import {
    ArrowUpRight, ArrowDownLeft, Repeat, Landmark, Users, Activity,
    MessageCircle, Settings as SettingsIcon, BookUser,
    ChevronDown, Wallet, AlertTriangle, PlusCircle, Radio, Copy, Check
  } from 'lucide-svelte';

  // Child components
  import EntityDropdown from './EntityDropdown.svelte';
  import AccountDropdown from './AccountDropdown.svelte';
  import AccountPanel from './AccountPanel.svelte';
  import AccountList from './AccountList.svelte';
  import PaymentPanel from './PaymentPanel.svelte';
  import SwapPanel from './SwapPanel.svelte';
  import SettlementPanel from './SettlementPanel.svelte';
  import ChatMessages from './ChatMessages.svelte';
  import ConsensusState from './ConsensusState.svelte';
  import ProposalsList from './ProposalsList.svelte';
  import JurisdictionDropdown from '$lib/components/Jurisdiction/JurisdictionDropdown.svelte';
  import FormationPanel from './FormationPanel.svelte';
  import QRPanel from './QRPanel.svelte';
  import HubDiscoveryPanel from './HubDiscoveryPanel.svelte';

  export let tab: Tab;
  export let isLast: boolean = false;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let initialAction: 'r2r' | 'r2c' | undefined = undefined;

  // Tab types
  type ViewTab = 'external' | 'reserves' | 'accounts' | 'send' | 'swap' | 'onj' | 'activity' | 'chat' | 'contacts' | 'receive' | 'hubs' | 'create' | 'settings';

  // Set initial tab based on action
  function getInitialTab(): ViewTab {
    if (initialAction === 'r2r') return 'send';
    if (initialAction === 'r2c') return 'onj'; // On-chain jurisdiction for R2C
    return 'accounts';
  }
  let activeTab: ViewTab = getInitialTab();

  // State
  let replica: EntityReplica | null = null;
  let selectedAccountId: string | null = null;
  let selectedJurisdictionName: string | null = null;
  let activityCount = 0;
  let addressCopied = false;

  // Copy address to clipboard
  async function copyAddress() {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    try {
      await navigator.clipboard.writeText(entityId);
      addressCopied = true;
      setTimeout(() => addressCopied = false, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // Get avatar URL
  $: avatarUrl = activeXlnFunctions?.generateEntityAvatar?.(tab.entityId) || '';

  // Format short address for display
  function formatAddress(addr: string): string {
    if (!addr || addr.length < 12) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  }

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextReplicas = entityEnv?.eReplicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextHistory = entityEnv?.history;
  const contextTimeIndex = entityEnv?.timeIndex;
  const contextEnv = entityEnv?.env;
  const contextIsLive = entityEnv?.isLive;

  // Reactive stores
  $: activeReplicas = contextReplicas ? $contextReplicas : $visibleReplicas;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeHistory = contextHistory ? $contextHistory : $history;
  $: activeTimeIndex = contextTimeIndex !== undefined ? $contextTimeIndex : $currentTimeIndex;
  $: activeEnv = contextEnv ? $contextEnv : null;
  $: activeIsLive = contextIsLive !== undefined ? $contextIsLive : $isLive;

  // Get replica
  $: {
    if (tab.entityId && tab.signerId) {
      const replicaKey = `${tab.entityId}:${tab.signerId}`;
      replica = activeReplicas?.get?.(replicaKey) ?? null;
    } else {
      replica = null;
    }
  }

  // Navigation
  $: isAccountFocused = selectedAccountId !== null;
  $: selectedAccount = isAccountFocused && replica?.state?.accounts && selectedAccountId
    ? replica.state.accounts.get(selectedAccountId) : null;

  // Jurisdictions
  $: availableJurisdictions = (() => {
    const env = activeEnv;
    if (!env?.jReplicas) return [];
    if (env.jReplicas instanceof Map) return Array.from(env.jReplicas.values());
    if (Array.isArray(env.jReplicas)) return env.jReplicas;
    return Object.values(env.jReplicas || {});
  })() as Array<{ name?: string }>;

  $: {
    if (showJurisdiction && availableJurisdictions.length > 0 && !selectedJurisdictionName) {
      selectedJurisdictionName = (activeEnv as any)?.activeJurisdiction || availableJurisdictions[0]?.name;
    }
  }

  // Activity count
  $: {
    let activity = 0;
    if (replica?.state?.lockBook) activity += replica.state.lockBook.size;
    activityCount = activity;
  }

  // Contacts (persisted in localStorage)
  let contacts: Array<{ name: string; entityId: string }> = [];
  let newContactName = '';
  let newContactId = '';

  // BrowserVM reserves (fetched directly from on-chain state)
  let browserVMReserves: Map<number, bigint> = new Map();
  let reservesLoading = true;
  let faucetFunding = false;

  // External tokens (ERC20 balances held by signer EOA)
  interface ExternalToken {
    symbol: string;
    address: string;
    balance: bigint;
    decimals: number;
    tokenId: number;
  }
  let externalTokens: ExternalToken[] = [];
  let externalTokensLoading = true;
  let depositingToken: string | null = null; // symbol of token being deposited

  // Faucet: fund entity reserves with test tokens
  async function faucetReserves() {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;

    faucetFunding = true;
    try {
      // Faucet B: Reserve transfer (ALWAYS use prod API, no BrowserVM fake)
      const response = await fetch('https://xln.finance/api/faucet/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          tokenId: 1, // USDC
          amount: '1000'
        })
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Faucet failed');
      }

      console.log('[EntityPanel] Reserve faucet success:', result);
      toasts.success('Received 1,000 USDC in reserves!');

      // Refresh reserves
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      console.error('[EntityPanel] Reserve faucet failed:', err);
      toasts.error(`Reserve faucet failed: ${(err as Error).message}`);
    } finally {
      faucetFunding = false;
    }
  }

  async function faucetOffchain() {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;

    faucetFunding = true;
    try {
      // Faucet C: Offchain payment (requires account with hub)
      const response = await fetch('https://xln.finance/api/faucet/offchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          tokenId: 1, // USDC
          amount: '100'
        })
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Faucet failed');
      }

      console.log('[EntityPanel] Offchain faucet success:', result);
      toasts.success('Received $100 USDC via offchain payment!');

      // Refresh UI
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      console.error('[EntityPanel] Offchain faucet failed:', err);
      toasts.error(`Offchain faucet failed: ${(err as Error).message}`);
    } finally {
      faucetFunding = false;
    }
  }

  async function fetchBrowserVMReserves() {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;

    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      // CRITICAL: Use activeEnv from context, NOT xln.getEnv() which returns wrong module-level env
      const jadapter = xln.getActiveJAdapter?.(activeEnv);
      if (!jadapter?.getReserves) {
        reservesLoading = false;
        return;
      }

      const newReserves = new Map<number, bigint>();
      // Fetch USDC, WETH, USDT (tokens 1, 2, 3) - include ALL tokens even with 0 balance
      for (const tokenId of [1, 2, 3]) {
        try {
          const balance = await jadapter.getReserves(entityId, tokenId);
          newReserves.set(tokenId, balance);
        } catch (err) {
          // Token might not be registered, set to 0
          newReserves.set(tokenId, 0n);
        }
      }
      browserVMReserves = newReserves;
      reservesLoading = false;
    } catch (err) {
      console.error('[EntityPanel] Failed to fetch reserves:', err);
      reservesLoading = false;
    }
  }

  // Known token addresses for RPC mode (from deploy-tokens.cjs on anvil)
  const KNOWN_TOKENS: ExternalToken[] = [
    { symbol: 'USDC', address: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E', balance: 0n, decimals: 18, tokenId: 1 },
    { symbol: 'WETH', address: '0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB', balance: 0n, decimals: 18, tokenId: 2 },
    { symbol: 'USDT', address: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9', balance: 0n, decimals: 18, tokenId: 3 },
  ];

  // Fetch external tokens (ERC20 balances for signer) - works for both BrowserVM and RPC modes
  async function fetchExternalTokens() {
    const signerId = tab.signerId;
    if (!signerId) {
      externalTokensLoading = false;
      return;
    }

    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      // CRITICAL: Use activeEnv from context, NOT xln.getEnv() which returns wrong module-level env
      const jadapter = xln.getActiveJAdapter?.(activeEnv);

      // Get token list - either from BrowserVM registry or known hardcoded list
      let tokenList: ExternalToken[];
      const browserVM = jadapter?.getBrowserVM?.();
      if (browserVM?.getTokenRegistry) {
        // BrowserVM mode - use registry
        const registry = browserVM.getTokenRegistry();
        tokenList = registry.map((t: any) => ({
          symbol: t.symbol,
          address: t.address,
          balance: 0n,
          decimals: t.decimals,
          tokenId: t.tokenId,
        }));
      } else {
        // RPC mode - use known tokens
        tokenList = KNOWN_TOKENS.map(t => ({ ...t, balance: 0n }));
      }

      // Query ERC20 balances via ethers provider
      const provider = jadapter?.provider;
      if (!provider) {
        // Fallback: try to use browserVM getErc20Balance
        if (browserVM?.getErc20Balance) {
          for (const token of tokenList) {
            try {
              token.balance = await browserVM.getErc20Balance(token.address, signerId);
            } catch { }
          }
        }
        externalTokens = tokenList;
        externalTokensLoading = false;
        return;
      }

      // Query balances via ERC20 balanceOf
      const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
      const { ethers } = await import('ethers');

      for (const token of tokenList) {
        try {
          const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
          token.balance = await erc20.balanceOf(signerId);
        } catch (err) {
          console.warn(`[EntityPanel] Failed to fetch ${token.symbol} balance:`, err);
        }
      }

      externalTokens = tokenList;
      externalTokensLoading = false;
    } catch (err) {
      console.error('[EntityPanel] Failed to fetch external tokens:', err);
      externalTokensLoading = false;
    }
  }

  // Deposit ERC20 token to entity reserve
  async function depositToReserve(token: ExternalToken) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = tab.signerId;
    if (!entityId || !signerId || token.balance <= 0n) return;

    depositingToken = token.symbol;
    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      // CRITICAL: Use activeEnv from context, NOT xln.getEnv() which returns wrong module-level env
      const jadapter = xln.getActiveJAdapter?.(activeEnv);
      if (!jadapter?.externalTokenToReserve) {
        throw new Error('J-adapter deposit not available');
      }

      // Get signer's private key from runtime
      const runtime = xln.getRuntime?.();
      const seed = runtime?.seed;
      if (!seed) {
        throw new Error('No runtime seed available');
      }

      // Use the XLN runtime's exposed crypto function
      const privKey = xln.getCachedSignerPrivateKey?.(seed, signerId);
      if (!privKey) {
        throw new Error('Cannot derive signer private key');
      }

      // Deposit all available balance
      await jadapter.externalTokenToReserve(privKey, entityId, token.address, token.balance);

      console.log(`[EntityPanel] Deposited ${token.symbol} to entity reserves`);

      // Refresh both balances
      await Promise.all([fetchBrowserVMReserves(), fetchExternalTokens()]);
    } catch (err) {
      console.error('[EntityPanel] Deposit failed:', err);
      toasts.error(`Deposit failed: ${(err as Error).message}`);
    } finally {
      depositingToken = null;
    }
  }

  // Faucet external tokens (ERC20 to signer EOA)
  async function faucetExternalTokens() {
    const signerId = tab.signerId;
    if (!signerId) return;

    faucetFunding = true;
    try {
      // Faucet A: ERC20 to wallet (ALWAYS use prod API, no BrowserVM fake)
      const response = await fetch('https://xln.finance/api/faucet/erc20', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress: signerId,
          tokenSymbol: 'USDC',
          amount: '100'
        })
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Faucet failed');
      }

      console.log('[EntityPanel] External faucet success:', result);
      toasts.success('Received 100 USDC in wallet!');

      // Refresh external tokens
      setTimeout(() => fetchExternalTokens(), 1000);
    } catch (err) {
      console.error('[EntityPanel] External faucet failed:', err);
      toasts.error(`External faucet failed: ${(err as Error).message}`);
    } finally {
      faucetFunding = false;
    }
  }

  // Refetch balances when entity/signer changes
  $: if (tab.entityId) {
    fetchBrowserVMReserves();
  }
  $: if (tab.signerId) {
    fetchExternalTokens();
  }

  onMount(() => {
    const saved = localStorage.getItem('xln-contacts');
    if (saved) contacts = JSON.parse(saved);

    // Fetch reserves and external tokens on mount and periodically
    fetchBrowserVMReserves();
    fetchExternalTokens();
    const interval = setInterval(() => {
      fetchBrowserVMReserves();
      fetchExternalTokens();
    }, 5000);
    return () => clearInterval(interval);
  });

  function saveContact() {
    if (!newContactName.trim() || !newContactId.trim()) return;
    contacts = [...contacts, { name: newContactName.trim(), entityId: newContactId.trim() }];
    localStorage.setItem('xln-contacts', JSON.stringify(contacts));
    newContactName = '';
    newContactId = '';
  }

  function deleteContact(idx: number) {
    contacts = contacts.filter((_, i) => i !== idx);
    localStorage.setItem('xln-contacts', JSON.stringify(contacts));
  }

  // Formatting
  function getTokenInfo(tokenId: number) {
    return activeXlnFunctions?.getTokenInfo(tokenId) ?? { symbol: 'UNK', decimals: 18 };
  }

  function formatAmount(amount: bigint, decimals: number): string {
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2);
    return `${whole.toLocaleString()}.${fracStr}`;
  }

  function formatCompact(value: number): string {
    if (!$settings.compactNumbers) {
      return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (value >= 1_000_000) return '$' + (value / 1_000_000).toFixed(2) + 'M';
    if (value >= 1_000) return '$' + (value / 1_000).toFixed(2) + 'K';
    return '$' + value.toFixed(2);
  }

  function getAssetValue(tokenId: number, amount: bigint): number {
    const info = getTokenInfo(tokenId);
    const divisor = BigInt(10) ** BigInt(info.decimals);
    const numericAmount = Number(amount) / Number(divisor);
    const price = tokenId === 1 ? 1 : 2500;
    return numericAmount * price;
  }

  function calculatePortfolioValue(reserves: Map<string, bigint>): number {
    let total = 0;
    for (const [tokenId, amount] of reserves.entries()) {
      total += getAssetValue(Number(tokenId), amount);
    }
    return total;
  }

  // Handlers
  function handleEntitySelect(event: CustomEvent) {
    const { jurisdiction, signerId, entityId } = event.detail;
    selectedAccountId = null;
    tab = { ...tab, jurisdiction, signerId, entityId };
  }

  function handleAccountSelect(event: CustomEvent) {
    selectedAccountId = event.detail.accountId;
  }

  function handleJurisdictionSelect(event: CustomEvent<{ selected: string | null }>) {
    const next = event.detail?.selected;
    if (next) selectedJurisdictionName = next;
  }

  function handleBackToAccounts() {
    selectedAccountId = null;
    activeTab = 'accounts';
  }

  function goToLive() {
    // Jump to live frame
    timeOperations.goToLive();
  }

  // Tab config
  // Pending batch count for On-Chain tab badge
  $: pendingBatchCount = (() => {
    if (!replica?.state) return 0;
    const batch = (replica.state as any)?.jBatchState?.batch;
    if (!batch) return 0;
    return (batch.reserveToCollateral?.length || 0) +
           (batch.collateralToReserve?.length || 0) +
           (batch.settlements?.length || 0) +
           (batch.reserveToReserve?.length || 0);
  })();

  const tabs: Array<{ id: ViewTab; icon: any; label: string; showBadge?: boolean; badgeType?: 'activity' | 'pending' }> = [
    { id: 'external', icon: Wallet, label: 'External' },
    { id: 'reserves', icon: Landmark, label: 'Reserves' },
    { id: 'accounts', icon: Users, label: 'Accounts' },
    { id: 'send', icon: ArrowUpRight, label: 'Send' },
    { id: 'swap', icon: Repeat, label: 'Swap' },
    { id: 'onj', icon: Landmark, label: 'On-Chain', showBadge: true, badgeType: 'pending' },
    { id: 'activity', icon: Activity, label: 'Activity', showBadge: true, badgeType: 'activity' },
    { id: 'chat', icon: MessageCircle, label: 'Chat' },
    { id: 'contacts', icon: BookUser, label: 'Contacts' },
    { id: 'receive', icon: ArrowDownLeft, label: 'Receive' },
    { id: 'hubs', icon: Radio, label: 'Hubs' },
    { id: 'create', icon: PlusCircle, label: 'Create' },
    { id: 'settings', icon: SettingsIcon, label: 'Settings' },
  ];
</script>

<div class="entity-panel" data-panel-id={tab.id}>
  <!-- Header -->
  {#if !hideHeader}
    <header class="header">
      {#if showJurisdiction}
        <JurisdictionDropdown
          bind:selected={selectedJurisdictionName}
          on:select={handleJurisdictionSelect}
        />
      {/if}
      <EntityDropdown
        {tab}
        on:entitySelect={handleEntitySelect}
      />
      {#if replica}
        <AccountDropdown
          {replica}
          {selectedAccountId}
          on:accountSelect={handleAccountSelect}
        />
      {/if}
    </header>
  {/if}

  <!-- Historical Mode Warning -->
  {#if !activeIsLive}
    <div class="history-warning" on:click={goToLive}>
      <AlertTriangle size={14} />
      <span>Viewing historical state. Click to go LIVE.</span>
    </div>
  {/if}

  <!-- Main Content - SINGLE SCROLL -->
  <main class="main-scroll">
    {#if !tab.entityId || !tab.signerId}
      <div class="empty-state">
        <Wallet size={40} />
        <h3>Select Entity</h3>
        <p>Choose from the dropdown above</p>
      </div>

    {:else if isAccountFocused && selectedAccount && selectedAccountId}
      <div class="focused-view">
        <button class="back-btn" on:click={handleBackToAccounts}>
          Back to Entity
        </button>
        <div class="focused-title">
          Account with #{activeXlnFunctions?.getEntityShortId(selectedAccountId)}
        </div>
        <AccountPanel
          account={selectedAccount}
          counterpartyId={selectedAccountId}
          entityId={tab.entityId}
          on:back={handleBackToAccounts}
        />
      </div>

    {:else if replica}
      <!-- Entity Identity -->
      <section class="entity-identity">
        <div class="identity-row">
          {#if avatarUrl}
            <img src={avatarUrl} alt="Entity avatar" class="entity-avatar" />
          {:else}
            <div class="entity-avatar placeholder">
              {activeXlnFunctions?.getEntityShortId?.(tab.entityId)?.slice(0,2) || '??'}
            </div>
          {/if}
          <div class="identity-info">
            <span class="entity-name">
              Entity #{activeXlnFunctions?.getEntityShortId?.(tab.entityId) || '?'}
            </span>
            <button class="address-row" on:click={copyAddress} title="Click to copy full address">
              <span class="address-text">{formatAddress(replica?.state?.entityId || tab.entityId)}</span>
              {#if addressCopied}
                <Check size={12} class="copy-icon copied" />
              {:else}
                <Copy size={12} class="copy-icon" />
              {/if}
            </button>
          </div>
        </div>
      </section>

      <!-- Portfolio Summary -->
      <section class="portfolio">
        {#if browserVMReserves.size > 0}
          {@const portfolioValue = calculatePortfolioValue(browserVMReserves)}
          <div class="total-value">{formatCompact(portfolioValue)}</div>
          <div class="total-label">Total Reserves</div>
          <div class="token-list">
            {#each Array.from(browserVMReserves.entries()) as [tokenId, amount]}
              {@const info = getTokenInfo(Number(tokenId))}
              {@const value = getAssetValue(Number(tokenId), amount)}
              {@const pct = portfolioValue > 0 ? (value / portfolioValue) * 100 : 0}
              <div class="token-row">
                <span class="t-symbol" class:eth={info.symbol === 'ETH'} class:usd={info.symbol !== 'ETH'}>
                  {info.symbol}
                </span>
                <span class="t-amount">{formatAmount(amount, info.decimals)}</span>
                <div class="t-bar"><div class="t-fill" style="width:{pct}%"></div></div>
                <span class="t-value">{formatCompact(value)}</span>
              </div>
            {/each}
          </div>
        {:else if reservesLoading}
          <div class="total-value dim">Loading...</div>
          <div class="total-label">Fetching reserves</div>
        {:else}
          <div class="total-value dim">$0.00</div>
          <div class="total-label">No reserves</div>
          <button class="btn-faucet" on:click={faucetReserves} disabled={faucetFunding}>
            {faucetFunding ? 'Funding...' : '💧 Get Test Funds'}
          </button>
        {/if}
      </section>

      <!-- Tab Bar -->
      <nav class="tabs">
        {#each tabs as t}
          <button
            class="tab"
            class:active={activeTab === t.id}
            on:click={() => activeTab = t.id}
          >
            <svelte:component this={t.icon} size={15} />
            <span>{t.label}</span>
            {#if t.showBadge && t.badgeType === 'activity' && activityCount > 0}
              <span class="badge">{activityCount}</span>
            {:else if t.showBadge && t.badgeType === 'pending' && pendingBatchCount > 0}
              <span class="badge pending">{pendingBatchCount}</span>
            {/if}
          </button>
        {/each}
      </nav>

      <!-- Tab Content -->
      <section class="content">
        {#if activeTab === 'external'}
          <!-- External Tokens (ERC20 wallet balances) -->
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <h4 class="section-head" style="margin: 0;">External Tokens (ERC20)</h4>
            <button class="btn-refresh" on:click={() => fetchExternalTokens()} disabled={externalTokensLoading} style="padding: 4px 12px; cursor: pointer;">
              {externalTokensLoading ? '⏳' : '🔄 Refresh'}
            </button>
          </div>
          <p class="muted wallet-address">Wallet: {tab.signerId?.slice(0, 8)}...{tab.signerId?.slice(-4)}</p>

          {#if externalTokensLoading}
            <div class="token-list-loading">
              <div class="loading-spinner"></div>
              <span>Loading balances...</span>
            </div>
          {:else}
            <div class="token-list-grid">
              {#each externalTokens as token}
                <div class="token-card" class:has-balance={token.balance > 0n}>
                  <div class="token-header">
                    <span class="token-icon" class:usdc={token.symbol === 'USDC'} class:weth={token.symbol === 'WETH'} class:usdt={token.symbol === 'USDT'}>
                      {token.symbol.slice(0, 1)}
                    </span>
                    <span class="token-symbol">{token.symbol}</span>
                  </div>
                  <div class="token-balance">
                    {#if token.balance > 0n}
                      <span class="balance-amount">{formatAmount(token.balance, token.decimals)}</span>
                    {:else}
                      <span class="balance-zero">0.00</span>
                    {/if}
                  </div>
                  <div class="token-actions">
                    {#if token.balance > 0n}
                      <button class="btn-token-action deposit" on:click={() => depositToReserve(token)} disabled={depositingToken === token.symbol}>
                        {depositingToken === token.symbol ? 'Depositing...' : 'Deposit to Reserve'}
                      </button>
                    {:else}
                      <button class="btn-token-action faucet" on:click={faucetExternalTokens} disabled={faucetFunding}>
                        {faucetFunding ? 'Funding...' : 'Get from Faucet'}
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}

        {:else if activeTab === 'reserves'}
          <!-- Reserves Detail (Depository.sol balances) -->
          <h4 class="section-head">On-Chain Reserves (Depository)</h4>
          <p class="muted wallet-address">Entity: {(replica?.state?.entityId || tab.entityId)?.slice(0, 10)}...{(replica?.state?.entityId || tab.entityId)?.slice(-6)}</p>

          {#if reservesLoading}
            <div class="token-list-loading">
              <div class="loading-spinner"></div>
              <span>Loading reserves...</span>
            </div>
          {:else}
            {@const hasAnyBalance = Array.from(browserVMReserves.values()).some(b => b > 0n)}
            <div class="token-list-grid">
              {#each Array.from(browserVMReserves.entries()) as [tokenId, amount]}
                {@const info = getTokenInfo(Number(tokenId))}
                {@const value = getAssetValue(Number(tokenId), amount)}
                <div class="token-card" class:has-balance={amount > 0n}>
                  <div class="token-header">
                    <span class="token-icon" class:usdc={info.symbol === 'USDC'} class:weth={info.symbol === 'WETH' || info.symbol === 'ETH'} class:usdt={info.symbol === 'USDT'}>
                      {info.symbol.slice(0, 1)}
                    </span>
                    <span class="token-symbol">{info.symbol}</span>
                  </div>
                  <div class="token-balance">
                    {#if amount > 0n}
                      <span class="balance-amount">{formatAmount(amount, info.decimals)}</span>
                      <span class="balance-value">{formatCompact(value)}</span>
                    {:else}
                      <span class="balance-zero">0.00</span>
                    {/if}
                  </div>
                  <div class="token-actions">
                    {#if amount === 0n}
                      <button class="btn-token-action faucet" on:click={faucetReserves} disabled={faucetFunding}>
                        {faucetFunding ? 'Funding...' : 'Get from Faucet'}
                      </button>
                    {:else}
                      <span class="token-status">Available for transfers</span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
            {#if !hasAnyBalance}
              <p class="hint-text">No reserves yet. Use the faucet or deposit external tokens to add funds.</p>
            {/if}
          {/if}

        {:else if activeTab === 'send'}
          <PaymentPanel entityId={replica.state?.entityId || tab.entityId} {contacts} />

        {:else if activeTab === 'swap'}
          <SwapPanel {replica} {tab} />

        {:else if activeTab === 'onj'}
          {#if !activeIsLive}
            <div class="live-required">
              <AlertTriangle size={20} />
              <p>On-chain actions require LIVE mode</p>
              <button class="btn-live" on:click={goToLive}>Go to LIVE</button>
            </div>
          {:else}
            <SettlementPanel entityId={replica.state?.entityId || tab.entityId} {contacts} />
          {/if}

        {:else if activeTab === 'accounts'}
          <button class="btn-faucet" on:click={faucetOffchain} disabled={faucetFunding}>
            {faucetFunding ? 'Funding...' : '💧 Get Test Funds (Offchain)'}
          </button>
          <AccountList {replica} on:select={handleAccountSelect} />

        {:else if activeTab === 'activity'}
          {#if replica.state?.lockBook && replica.state.lockBook.size > 0}
            <h4 class="section-head">Pending HTLCs</h4>
            {#each Array.from(replica.state.lockBook.entries()) as [lockId, lock]}
              <div class="activity-row">
                <span class="a-icon">lock</span>
                <div class="a-info">
                  <span class="a-title">#{lockId.slice(0, 8)}</span>
                  <span class="a-sub">{lock.direction}</span>
                </div>
                <span class="a-amt">{formatAmount(lock.amount, 6)}</span>
              </div>
            {/each}
          {/if}
          <h4 class="section-head">Consensus</h4>
          <ConsensusState {replica} />
          <h4 class="section-head">Proposals</h4>
          <ProposalsList {replica} {tab} />

        {:else if activeTab === 'chat'}
          <ChatMessages {replica} {tab} currentTimeIndex={activeTimeIndex ?? -1} />

        {:else if activeTab === 'contacts'}
          <h4 class="section-head">Saved Contacts</h4>
          {#if contacts.length === 0}
            <p class="muted">No contacts saved yet</p>
          {:else}
            {#each contacts as contact, idx}
              <div class="contact-row">
                <div class="c-info">
                  <span class="c-name">{contact.name}</span>
                  <span class="c-id">{contact.entityId.slice(0, 16)}...</span>
                </div>
                <button class="c-delete" on:click={() => deleteContact(idx)}>x</button>
              </div>
            {/each}
          {/if}

          <h4 class="section-head">Add Contact</h4>
          <div class="add-contact">
            <input type="text" placeholder="Name" bind:value={newContactName} />
            <input type="text" placeholder="Entity ID (0x... or #123)" bind:value={newContactId} />
            <button class="btn-add" on:click={saveContact}>Add</button>
          </div>

        {:else if activeTab === 'receive'}
          <QRPanel entityId={replica?.state?.entityId || tab.entityId} />

        {:else if activeTab === 'hubs'}
          <HubDiscoveryPanel entityId={replica?.state?.entityId || tab.entityId} />

        {:else if activeTab === 'create'}
          <FormationPanel />

        {:else if activeTab === 'settings'}
          <div class="setting-row">
            <span>Compact Numbers</span>
            <button class="toggle" class:on={$settings.compactNumbers}
              on:click={() => settingsOperations.setCompactNumbers(!$settings.compactNumbers)}>
              {$settings.compactNumbers ? 'On' : 'Off'}
            </button>
          </div>
          <div class="setting-row">
            <span>Verbose Logging</span>
            <button class="toggle" class:on={$settings.verboseLogging}
              on:click={() => settingsOperations.setVerboseLogging(!$settings.verboseLogging)}>
              {$settings.verboseLogging ? 'On' : 'Off'}
            </button>
          </div>
          <div class="setting-block">
            <label>Entity ID</label>
            <code>{tab.entityId}</code>
          </div>
          <div class="setting-block">
            <label>Signer ID</label>
            <code>{tab.signerId}</code>
          </div>
          <div class="setting-block">
            <label>Jurisdiction</label>
            <code>{selectedJurisdictionName || 'None'}</code>
          </div>
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  .entity-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #0c0a09;
    color: #e7e5e4;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #171412;
    border-bottom: 1px solid #292524;
    flex-shrink: 0;
  }

  .header :global(select),
  .header :global(button),
  .header :global(.dropdown-trigger) {
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 12px;
    padding: 6px 10px;
    cursor: pointer;
  }

  /* History Warning */
  .history-warning {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px;
    background: #422006;
    border-bottom: 1px solid #713f12;
    color: #fbbf24;
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .history-warning:hover {
    background: #4a2408;
  }

  /* Main Scroll - SINGLE SCROLLBAR */
  .main-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .main-scroll::-webkit-scrollbar {
    width: 6px;
  }

  .main-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .main-scroll::-webkit-scrollbar-thumb {
    background: #44403c;
    border-radius: 3px;
  }

  /* Empty State */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 300px;
    color: #78716c;
    gap: 12px;
  }

  .empty-state h3 {
    margin: 0;
    font-size: 16px;
    color: #a8a29e;
  }

  .empty-state p {
    margin: 0;
    font-size: 12px;
  }

  /* Focused Account View */
  .focused-view {
    padding: 16px;
  }

  .back-btn {
    display: inline-block;
    padding: 6px 12px;
    margin-bottom: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #fbbf24;
    font-size: 12px;
    cursor: pointer;
  }

  .focused-title {
    font-size: 14px;
    color: #78716c;
    margin-bottom: 12px;
  }

  /* Entity Identity */
  .entity-identity {
    padding: 16px;
    border-bottom: 1px solid #1c1917;
  }

  .identity-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .entity-avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    flex-shrink: 0;
  }

  .entity-avatar.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: #0c0a09;
  }

  .identity-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .entity-name {
    font-size: 16px;
    font-weight: 600;
    color: #fafaf9;
  }

  .address-row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .address-row:hover {
    border-color: #fbbf24;
    background: #292524;
  }

  .address-text {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
  }

  .address-row :global(.copy-icon) {
    color: #78716c;
  }

  .address-row :global(.copy-icon.copied) {
    color: #22c55e;
  }

  /* Portfolio */
  .portfolio {
    padding: 20px 16px;
    text-align: center;
    border-bottom: 1px solid #1c1917;
  }

  .total-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 32px;
    font-weight: 600;
    color: #fafaf9;
  }

  .total-value.dim {
    color: #57534e;
  }

  .total-label {
    font-size: 11px;
    color: #78716c;
    margin-top: 2px;
    margin-bottom: 16px;
  }

  .btn-faucet {
    margin-top: 8px;
    padding: 12px 24px;
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    border: none;
    border-radius: 8px;
    color: #f0f9ff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
    transform: translateY(-1px);
  }

  .btn-faucet:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* External Tokens */
  .external-tokens {
    padding: 12px 16px;
    border-bottom: 1px solid #1c1917;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .section-header h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .signer-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #57534e;
  }

  .ext-loading {
    font-size: 12px;
    color: #57534e;
    text-align: center;
    padding: 12px;
  }

  .ext-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ext-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: #1c1917;
    border-radius: 6px;
  }

  .ext-symbol {
    font-weight: 600;
    font-size: 12px;
    width: 50px;
  }

  .ext-symbol.eth { color: #627eea; }
  .ext-symbol.usd { color: #2775ca; }

  .ext-amount {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #a8a29e;
  }

  .btn-deposit {
    padding: 4px 10px;
    background: linear-gradient(135deg, #16a34a, #15803d);
    border: none;
    border-radius: 4px;
    color: #f0fdf4;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-deposit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .ext-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: #1c1917;
    border-radius: 6px;
    font-size: 12px;
    color: #57534e;
  }

  .btn-faucet-small {
    padding: 4px 10px;
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    border: none;
    border-radius: 4px;
    color: #f0f9ff;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-faucet-small:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-faucet-small:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .token-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 400px;
    margin: 0 auto;
  }

  .token-row {
    display: grid;
    grid-template-columns: 50px 1fr 80px 60px;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .t-symbol {
    font-weight: 600;
    text-align: left;
  }

  .t-symbol.eth { color: #627eea; }
  .t-symbol.usd { color: #2775ca; }

  .t-amount {
    font-family: 'JetBrains Mono', monospace;
    color: #a8a29e;
    text-align: right;
  }

  .t-bar {
    height: 4px;
    background: #1c1917;
    border-radius: 2px;
    overflow: hidden;
  }

  .t-fill {
    height: 100%;
    background: #fbbf24;
    border-radius: 2px;
  }

  .t-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #57534e;
    text-align: right;
  }

  /* Token List Grid - Beautiful card layout */
  .wallet-address {
    margin-bottom: 16px;
  }

  .token-list-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 40px 20px;
    color: #78716c;
  }

  .loading-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #292524;
    border-top-color: #fbbf24;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .token-list-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .token-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 12px;
    transition: all 0.15s;
  }

  .token-card:hover {
    border-color: #44403c;
  }

  .token-card.has-balance {
    border-color: #365314;
    background: linear-gradient(135deg, #1c1917 0%, #1a2e05 100%);
  }

  .token-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .token-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: 700;
    font-size: 16px;
    color: white;
    background: #44403c;
  }

  .token-icon.usdc {
    background: linear-gradient(135deg, #2775ca, #1e5aa8);
  }

  .token-icon.weth {
    background: linear-gradient(135deg, #627eea, #4c62c7);
  }

  .token-icon.usdt {
    background: linear-gradient(135deg, #26a17b, #1e8a69);
  }

  .token-symbol {
    font-weight: 600;
    font-size: 15px;
    color: #fafaf9;
  }

  .token-balance {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .balance-amount {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 600;
    color: #fafaf9;
  }

  .balance-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #78716c;
  }

  .balance-zero {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 600;
    color: #44403c;
  }

  .token-actions {
    margin-top: 4px;
  }

  .btn-token-action {
    width: 100%;
    padding: 10px 16px;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-token-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-token-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-token-action.faucet {
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    color: #f0f9ff;
  }

  .btn-token-action.faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-token-action:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .token-status {
    font-size: 11px;
    color: #57534e;
    font-style: italic;
  }

  .hint-text {
    text-align: center;
    font-size: 12px;
    color: #57534e;
    margin-top: 16px;
    padding: 12px;
    background: #1c1917;
    border-radius: 8px;
  }

  /* Tabs */
  .tabs {
    display: flex;
    padding: 0 8px;
    background: #0f0d0c;
    border-bottom: 1px solid #1c1917;
    overflow-x: auto;
    flex-shrink: 0;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 10px 10px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #78716c;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .tab:hover {
    color: #a8a29e;
  }

  .tab.active {
    color: #fbbf24;
    border-bottom-color: #fbbf24;
  }

  .badge {
    background: #dc2626;
    color: white;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 8px;
  }

  .badge.pending {
    background: #ca8a04;
    color: #fef3c7;
  }

  /* Content */
  .content {
    padding: 16px;
  }

  .section-head {
    font-size: 10px;
    font-weight: 600;
    color: #57534e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 0 8px;
  }

  .section-head:first-child {
    margin-top: 0;
  }

  .muted {
    color: #57534e;
    font-size: 12px;
    font-style: italic;
  }

  /* Activity */
  .activity-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 6px;
  }

  .a-icon {
    font-size: 10px;
    padding: 4px 6px;
    background: #292524;
    border-radius: 4px;
    color: #78716c;
  }

  .a-info {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .a-title {
    font-size: 12px;
    color: #e7e5e4;
  }

  .a-sub {
    font-size: 10px;
    color: #57534e;
  }

  .a-amt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
  }

  /* Contacts */
  .contact-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 6px;
  }

  .c-info {
    display: flex;
    flex-direction: column;
  }

  .c-name {
    font-size: 13px;
    color: #e7e5e4;
  }

  .c-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #57534e;
  }

  .c-delete {
    width: 24px;
    height: 24px;
    background: #292524;
    border: none;
    border-radius: 4px;
    color: #78716c;
    cursor: pointer;
  }

  .add-contact {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .add-contact input {
    padding: 10px 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #e7e5e4;
    font-size: 13px;
  }

  .add-contact input::placeholder {
    color: #57534e;
  }

  .add-contact input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  .btn-add {
    padding: 10px;
    background: linear-gradient(135deg, #92400e, #78350f);
    border: none;
    border-radius: 6px;
    color: #fef3c7;
    font-weight: 500;
    cursor: pointer;
  }

  /* Settings */
  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .toggle {
    padding: 4px 12px;
    background: #292524;
    border: none;
    border-radius: 4px;
    color: #78716c;
    font-size: 11px;
    cursor: pointer;
  }

  .toggle.on {
    background: #422006;
    color: #fbbf24;
  }

  .setting-block {
    padding: 12px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .setting-block label {
    display: block;
    font-size: 10px;
    color: #57534e;
    margin-bottom: 6px;
  }

  .setting-block code {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
    background: #0c0a09;
    padding: 8px;
    border-radius: 4px;
    word-break: break-all;
  }

  /* Live Required */
  .live-required {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
    color: #78716c;
    gap: 12px;
  }

  .live-required p {
    margin: 0;
    font-size: 13px;
  }

  .btn-live {
    padding: 10px 20px;
    background: #422006;
    border: 1px solid #713f12;
    border-radius: 6px;
    color: #fbbf24;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-live:hover {
    background: #4a2408;
  }

  /* Override child component styling */
  .content :global(.payment-panel),
  .content :global(.swap-panel),
  .content :global(.settlement-panel),
  .content :global(.account-list),
  .content :global(.scrollable-component) {
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    height: auto !important;
    overflow: visible !important;
  }

  .content :global(input),
  .content :global(select) {
    background: #1c1917 !important;
    border: 1px solid #292524 !important;
    border-radius: 6px !important;
    color: #e7e5e4 !important;
    padding: 10px 12px !important;
    font-size: 13px !important;
  }

  .content :global(input:focus),
  .content :global(select:focus) {
    outline: none !important;
    border-color: #fbbf24 !important;
  }

  .content :global(input::placeholder) {
    color: #57534e !important;
  }

  .content :global(button:not(.tab):not(.toggle):not(.back-btn):not(.btn-add):not(.btn-live):not(.c-delete)) {
    background: #1c1917 !important;
    border: 1px solid #292524 !important;
    border-radius: 6px !important;
    color: #a8a29e !important;
    padding: 10px 14px !important;
    font-size: 12px !important;
    cursor: pointer !important;
  }

  .content :global(h3),
  .content :global(h4),
  .content :global(label) {
    color: #a8a29e !important;
  }
</style>
