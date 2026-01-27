<script lang="ts">
  /**
   * WalletView - MetaMask-style wallet interface for BrainVault
   *
   * Sleek fintech UI with:
   * - Portfolio value display
   * - J-machine integration (future)
   * - Token list with balances
   * - Send/Receive/Bridge actions
   * - Activity tab with Etherscan links
   */

  import { createEventDispatcher } from 'svelte';
  import TokenList from './TokenList.svelte';
  import ERC20Send from './ERC20Send.svelte';
  import XLNSend from './XLNSend.svelte';
  import DepositToEntity from './DepositToEntity.svelte';
  import { ArrowUpRight, ArrowDownLeft, Repeat, ExternalLink, Copy, Check } from 'lucide-svelte';

  // Props from BrainVault
  export let privateKey: string;
  export let walletAddress: string;
  export let entityId: string;
  export let identiconSrc: string = '';
  export let networkEnabled: boolean = false;

  const dispatch = createEventDispatcher();

  // Tabs
  type Tab = 'tokens' | 'activity' | 'send' | 'receive' | 'bridge';
  let activeTab: Tab = 'tokens';
  const canBridge = !!entityId;

  // Portfolio state (will be populated by TokenList)
  let portfolioValue = 0;
  let portfolioChange = 0;

  // Copy state
  let copied = false;

  function copyAddress() {
    navigator.clipboard.writeText(walletAddress);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }

  function formatUSD(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  }

  function handlePortfolioUpdate(event: CustomEvent<{ total: number; change: number }>) {
    portfolioValue = event.detail.total;
    portfolioChange = event.detail.change;
  }

  // Etherscan link for activity
  function getEtherscanLink(): string {
    return `https://etherscan.io/address/${walletAddress}`;
  }
</script>

<div class="wallet-view">
  <!-- Portfolio Value -->
  <div class="portfolio-section">
    <div class="portfolio-value">
      <span class="value">{formatUSD(portfolioValue)}</span>
      <span class="change" class:positive={portfolioChange >= 0} class:negative={portfolioChange < 0}>
        {portfolioChange >= 0 ? '+' : ''}{portfolioChange.toFixed(2)}%
      </span>
    </div>
  </div>

  <!-- Action Buttons -->
  <div class="action-buttons">
    <button
      class="action-btn"
      class:active={activeTab === 'send'}
      on:click={() => activeTab = 'send'}
      title="Send tokens to another address"
    >
      <div class="btn-icon"><ArrowUpRight size={18} /></div>
      <span>Send</span>
    </button>
    <button
      class="action-btn"
      class:active={activeTab === 'receive'}
      on:click={() => activeTab = 'receive'}
      title="Receive tokens - show your address"
    >
      <div class="btn-icon"><ArrowDownLeft size={18} /></div>
      <span>Receive</span>
    </button>
    <button
      class="action-btn"
      class:active={activeTab === 'bridge'}
      class:disabled={!canBridge}
      on:click={() => activeTab = 'bridge'}
      title="Bridge tokens to xln Entity for instant payments"
      disabled={!canBridge}
    >
      <div class="btn-icon"><Repeat size={18} /></div>
      <span>Bridge</span>
    </button>
  </div>

  <!-- Main Content (no tabs - unified view) -->
  <div class="tab-content">
    {#if activeTab === 'send'}
      <div class="send-tab">
        <!-- XLN Send (simnet/instant) -->
        <XLNSend {entityId} />

        <!-- Divider -->
        <div class="send-divider">
          <span>Or send on-chain</span>
        </div>

        <!-- ERC20 Send (on-chain) -->
        <ERC20Send {privateKey} {walletAddress} />
      </div>
    {:else if activeTab === 'receive'}
      <div class="receive-tab">
        <div class="receive-content">
          <div class="qr-placeholder">
            <!-- Simple address display for now -->
            <div class="address-display">
              <img src={identiconSrc} alt="Identicon" class="receive-identicon" />
              <code class="receive-address">{walletAddress}</code>
            </div>
          </div>
          <button class="copy-address-btn" on:click={copyAddress}>
            {#if copied}
              <Check size={16} />
              <span>Copied!</span>
            {:else}
              <Copy size={16} />
              <span>Copy Address</span>
            {/if}
          </button>
          <p class="receive-hint">
            Share this address to receive assets when on-chain bridges are enabled
          </p>
        </div>
      </div>
    {:else if activeTab === 'bridge'}
      <div class="bridge-tab">
        {#if !canBridge}
          <div class="bridge-empty">
            Select an Entity above to deposit to its reserves.
          </div>
        {:else}
          <DepositToEntity {privateKey} {walletAddress} {entityId} />
        {/if}
      </div>
    {:else}
      <!-- Default: Tokens + Activity inline -->
      <TokenList
        {privateKey}
        {walletAddress}
        enabled={networkEnabled}
        on:portfolioUpdate={handlePortfolioUpdate}
      />

      <!-- Activity Section (inline) -->
      {#if networkEnabled}
        <div class="activity-section">
          <div class="activity-header">
            <span class="activity-title">Recent</span>
            <a
              href={getEtherscanLink()}
              target="_blank"
              rel="noopener noreferrer"
              class="view-all-link"
            >
              View All <ExternalLink size={12} />
            </a>
          </div>
          <div class="activity-empty">
            <span>No recent activity</span>
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .wallet-view {
    width: 100%;
    max-width: 630px;
    margin: 0 auto;
    background: linear-gradient(180deg, rgba(20, 18, 15, 0.95) 0%, rgba(10, 8, 5, 0.98) 100%);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 16px;
    overflow: hidden;
  }

  /* Portfolio Section */
  .portfolio-section {
    padding: 24px 20px;
    text-align: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .portfolio-value {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 12px;
  }

  .portfolio-value .value {
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: 32px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
    letter-spacing: -0.02em;
  }

  .portfolio-value .change {
    font-size: 14px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 6px;
  }

  .change.positive {
    color: #00ff88;
    background: rgba(0, 255, 136, 0.1);
  }

  .change.negative {
    color: #ff4466;
    background: rgba(255, 68, 102, 0.1);
  }

  /* Action Buttons */
  .action-buttons {
    display: flex;
    justify-content: center;
    gap: 16px;
    padding: 16px 20px 20px;
  }

  .action-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 20px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    min-width: 80px;
  }

  .action-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 200, 100, 0.3);
    transform: translateY(-2px);
  }

  .action-btn.active {
    background: rgba(255, 200, 100, 0.15);
    border-color: rgba(255, 200, 100, 0.4);
    color: rgba(255, 200, 100, 1);
  }

  .action-btn.disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
  }

  .action-btn.disabled:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.08);
    transform: none;
  }

  .btn-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 200, 100, 0.1);
    border-radius: 50%;
    color: rgba(255, 200, 100, 0.9);
  }

  .action-btn.active .btn-icon {
    background: rgba(255, 200, 100, 0.2);
  }

  /* Tab Navigation */
  .tab-nav {
    display: flex;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    padding: 0 20px;
  }

  .tab-btn {
    flex: 1;
    padding: 14px 16px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: rgba(255, 255, 255, 0.5);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .tab-btn:hover {
    color: rgba(255, 255, 255, 0.8);
  }

  .tab-btn.active {
    color: rgba(255, 200, 100, 1);
    border-bottom-color: rgba(255, 200, 100, 0.8);
  }

  /* Tab Content */
  .tab-content {
    padding: 16px;
    min-height: 300px;
    max-height: 500px;
    overflow-y: auto;
  }

  .bridge-empty {
    padding: 24px;
    text-align: center;
    color: rgba(255, 255, 255, 0.6);
    font-size: 13px;
  }

  /* Activity Tab */
  .activity-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 280px;
  }

  .activity-placeholder {
    text-align: center;
    padding: 24px;
  }

  .placeholder-icon {
    width: 64px;
    height: 64px;
    margin: 0 auto 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 16px;
    color: rgba(255, 255, 255, 0.3);
  }

  .placeholder-text {
    color: rgba(255, 255, 255, 0.6);
    font-size: 14px;
    margin-bottom: 16px;
  }

  .etherscan-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    background: linear-gradient(135deg, rgba(255, 200, 100, 0.9), rgba(255, 150, 50, 0.9));
    border-radius: 10px;
    color: #000;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.2s ease;
  }

  .etherscan-link:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(255, 200, 100, 0.3);
  }

  .placeholder-hint {
    margin-top: 20px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.3);
  }

  .hint-tooltip {
    cursor: help;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.2);
  }

  /* Receive Tab */
  .receive-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px;
  }

  .receive-content {
    text-align: center;
    width: 100%;
  }

  .qr-placeholder {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 16px;
  }

  .address-display {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .receive-identicon {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    border: 3px solid rgba(255, 200, 100, 0.3);
  }

  .receive-address {
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.8);
    word-break: break-all;
    padding: 12px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
    max-width: 100%;
  }

  .copy-address-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .copy-address-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 200, 100, 0.3);
  }

  .receive-hint {
    margin-top: 16px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.5;
  }

  /* Send/Bridge tabs use existing components */
  .send-tab, .bridge-tab {
    padding: 0;
  }

  .send-tab :global(.erc20-send),
  .bridge-tab :global(.deposit-container) {
    border: none;
    background: transparent;
    padding: 0;
  }

  /* Activity Section (inline below tokens) */
  .activity-section {
    margin-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding: 12px 16px;
  }

  .activity-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .activity-title {
    font-size: 13px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.6);
  }

  .view-all-link {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: rgba(255, 200, 100, 0.7);
    text-decoration: none;
    transition: color 0.15s;
  }

  .view-all-link:hover {
    color: rgba(255, 200, 100, 1);
  }

  .activity-empty {
    padding: 16px;
    text-align: center;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
  }

  /* Send Divider */
  .send-divider {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 20px 0;
    color: rgba(255, 255, 255, 0.3);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .send-divider::before,
  .send-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
  }
</style>
