<script lang="ts">
  /**
   * TokenList - Display token balances with portfolio value
   *
   * Features:
   * - Native ETH + ERC20 token balances
   * - Portfolio total calculation
   * - Auto-refresh with configurable interval
   * - Token icons (placeholder for now)
   */

  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { JsonRpcProvider, Contract, formatEther, formatUnits, type InterfaceAbi } from 'ethers';
  import { EVM_NETWORKS, ERC20_ABI, type EVMNetwork, type TokenInfo } from '$lib/config/evmNetworks';
  import { RefreshCw, TrendingUp, TrendingDown } from 'lucide-svelte';

  export let privateKey: string;
  export let walletAddress: string;

  const dispatch = createEventDispatcher();

  // Network (default to Ethereum mainnet)
  let selectedNetwork: EVMNetwork = EVM_NETWORKS[0]!;

  // Token balances
  interface TokenBalance {
    symbol: string;
    name: string;
    balance: string;
    balanceUSD: number;
    decimals: number;
    address?: string;
    isNative: boolean;
    icon?: string;
    change24h?: number;
  }

  let tokenBalances: TokenBalance[] = [];
  let loading = true;
  let lastUpdated: Date | null = null;
  let refreshInterval = 30; // seconds
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const ERC20_INTERFACE: InterfaceAbi = ERC20_ABI as InterfaceAbi;

  // Mock prices (in real app, fetch from CoinGecko/etc)
  const MOCK_PRICES: Record<string, number> = {
    'ETH': 3500,
    'USDC': 1.0,
    'USDT': 1.0,
    'DAI': 1.0,
    'WETH': 3500,
    'WBTC': 95000,
    'LINK': 15,
    'UNI': 8,
    'AAVE': 150,
    'MKR': 1800,
  };

  function getProvider(): JsonRpcProvider {
    return new JsonRpcProvider(selectedNetwork.rpcUrl);
  }

  async function fetchBalances() {
    if (!walletAddress) return;

    loading = true;
    const balances: TokenBalance[] = [];

    try {
      const provider = getProvider();

      // Fetch native balance
      const nativeBalance = await provider.getBalance(walletAddress);
      const nativeFormatted = formatEther(nativeBalance);
      const nativePrice = MOCK_PRICES[selectedNetwork.symbol] || 0;
      const nativeUSD = parseFloat(nativeFormatted) * nativePrice;

      balances.push({
        symbol: selectedNetwork.symbol,
        name: selectedNetwork.name,
        balance: nativeFormatted,
        balanceUSD: nativeUSD,
        decimals: 18,
        isNative: true,
        change24h: Math.random() * 10 - 5, // Mock change
      });

      // Fetch ERC20 token balances
      for (const token of selectedNetwork.tokens) {
        try {
          const contract = new Contract(token.address, ERC20_INTERFACE, provider);
          const balance = await contract.getFunction('balanceOf')(walletAddress);
          const formatted = formatUnits(balance, token.decimals);

          // Only show tokens with non-zero balance or common tokens
          const isCommonToken = ['USDC', 'USDT', 'DAI', 'WETH'].includes(token.symbol);
          if (parseFloat(formatted) > 0 || isCommonToken) {
            const price = MOCK_PRICES[token.symbol] || 0;
            const usdValue = parseFloat(formatted) * price;

            balances.push({
              symbol: token.symbol,
              name: token.name,
              balance: formatted,
              balanceUSD: usdValue,
              decimals: token.decimals,
              address: token.address,
              isNative: false,
              change24h: Math.random() * 10 - 5, // Mock change
            });
          }
        } catch (e) {
          console.warn(`Failed to fetch ${token.symbol} balance:`, e);
        }
      }

      // Sort by USD value (highest first)
      balances.sort((a, b) => b.balanceUSD - a.balanceUSD);

      tokenBalances = balances;
      lastUpdated = new Date();

      // Calculate portfolio total
      const total = balances.reduce((sum, t) => sum + t.balanceUSD, 0);
      const avgChange = balances.length > 0
        ? balances.reduce((sum, t) => sum + (t.change24h || 0), 0) / balances.length
        : 0;

      dispatch('portfolioUpdate', { total, change: avgChange });

    } catch (e) {
      console.error('Failed to fetch balances:', e);
    } finally {
      loading = false;
    }
  }

  function formatBalance(balance: string, symbol: string): string {
    const num = parseFloat(balance);
    if (num === 0) return '0';
    if (num < 0.0001) return '<0.0001';
    if (num < 1) return num.toFixed(6);
    if (num < 1000) return num.toFixed(4);
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function formatUSD(value: number): string {
    if (value === 0) return '$0.00';
    if (value < 0.01) return '<$0.01';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  }

  function startRefreshTimer() {
    stopRefreshTimer();
    fetchBalances();
    refreshTimer = setInterval(fetchBalances, refreshInterval * 1000);
  }

  function stopRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  onMount(() => {
    startRefreshTimer();
  });

  onDestroy(() => {
    stopRefreshTimer();
  });

  // Re-fetch when network changes
  $: if (selectedNetwork && walletAddress) {
    fetchBalances();
  }
</script>

<div class="token-list">
  <!-- Header -->
  <div class="list-header">
    <span class="header-title">Your Tokens</span>
    <button
      class="refresh-btn"
      on:click={fetchBalances}
      disabled={loading}
      title="Refresh balances"
    >
      <span class:spinning={loading}><RefreshCw size={14} /></span>
    </button>
  </div>

  <!-- Token Items -->
  <div class="tokens">
    {#if loading && tokenBalances.length === 0}
      <div class="loading-state">
        <div class="loading-spinner" />
        <span>Loading balances...</span>
      </div>
    {:else if tokenBalances.length === 0}
      <div class="empty-state">
        <span class="empty-icon">💎</span>
        <span class="empty-text">No tokens found</span>
        <span class="empty-hint">Tokens will appear here once you receive them</span>
      </div>
    {:else}
      {#each tokenBalances as token}
        <div class="token-item" class:zero={parseFloat(token.balance) === 0}>
          <!-- Token Icon -->
          <div class="token-icon" class:native={token.isNative}>
            {#if token.icon}
              <img src={token.icon} alt={token.symbol} />
            {:else}
              <span class="icon-placeholder">{token.symbol.slice(0, 2)}</span>
            {/if}
          </div>

          <!-- Token Info -->
          <div class="token-info">
            <span class="token-symbol">{token.symbol}</span>
            <span class="token-name">{token.name}</span>
          </div>

          <!-- Balance -->
          <div class="token-balance">
            <span class="balance-amount">
              {formatBalance(token.balance, token.symbol)}
            </span>
            <span class="balance-usd">
              {formatUSD(token.balanceUSD)}
            </span>
          </div>

          <!-- 24h Change (optional) -->
          {#if token.change24h !== undefined && token.balanceUSD > 0}
            <div class="token-change" class:positive={token.change24h >= 0} class:negative={token.change24h < 0}>
              {#if token.change24h >= 0}
                <TrendingUp size={12} />
              {:else}
                <TrendingDown size={12} />
              {/if}
              <span>{Math.abs(token.change24h).toFixed(1)}%</span>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <!-- Last Updated -->
  {#if lastUpdated}
    <div class="last-updated">
      Last updated: {lastUpdated.toLocaleTimeString()}
    </div>
  {/if}
</div>

<style>
  .token-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
    margin-bottom: 8px;
  }

  .header-title {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.7);
  }

  .refresh-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .refresh-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 200, 100, 0.8);
  }

  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .refresh-btn .spinning {
    animation: spin 1s linear infinite;
    display: inline-flex;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .tokens {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .token-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 12px;
    transition: all 0.2s ease;
  }

  .token-item:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.08);
  }

  .token-item.zero {
    opacity: 0.5;
  }

  .token-icon {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, rgba(255, 200, 100, 0.15), rgba(255, 150, 50, 0.15));
    border: 1px solid rgba(255, 200, 100, 0.2);
    flex-shrink: 0;
  }

  .token-icon.native {
    background: linear-gradient(135deg, rgba(98, 126, 234, 0.2), rgba(130, 71, 229, 0.2));
    border-color: rgba(98, 126, 234, 0.3);
  }

  .token-icon img {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }

  .icon-placeholder {
    font-size: 12px;
    font-weight: 700;
    color: rgba(255, 200, 100, 0.9);
    text-transform: uppercase;
  }

  .token-icon.native .icon-placeholder {
    color: rgba(98, 126, 234, 0.9);
  }

  .token-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .token-symbol {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
  }

  .token-name {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .token-balance {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .balance-amount {
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
  }

  .balance-usd {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
  }

  .token-change {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 6px;
    min-width: 55px;
    justify-content: center;
  }

  .token-change.positive {
    color: #00ff88;
    background: rgba(0, 255, 136, 0.1);
  }

  .token-change.negative {
    color: #ff4466;
    background: rgba(255, 68, 102, 0.1);
  }

  /* Loading State */
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px;
    color: rgba(255, 255, 255, 0.4);
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(255, 200, 100, 0.2);
    border-top-color: rgba(255, 200, 100, 0.8);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  /* Empty State */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px;
    text-align: center;
  }

  .empty-icon {
    font-size: 32px;
    opacity: 0.5;
  }

  .empty-text {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.6);
  }

  .empty-hint {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.3);
  }

  /* Last Updated */
  .last-updated {
    text-align: center;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.3);
    margin-top: 8px;
  }
</style>
