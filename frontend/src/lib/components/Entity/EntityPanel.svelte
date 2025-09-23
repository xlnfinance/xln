<script lang="ts">
  import { onMount } from 'svelte';
  import type { Tab, EntityReplica } from '../../types';
  import { getXLN, replicas, history } from '../../stores/xlnStore';
  import { visibleReplicas, currentTimeIndex } from '../../stores/timeStore';
  import { tabOperations } from '../../stores/tabStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';

  // Simple HTML escape (moved from deleted utils)
  function escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  import EntityDropdown from './EntityDropdown.svelte';
  import AccountInspectorDropdown from './AccountInspectorDropdown.svelte';
  import EntityProfile from './EntityProfile.svelte';
  import ConsensusState from './ConsensusState.svelte';
  import ChatMessages from './ChatMessages.svelte';
  import ProposalsList from './ProposalsList.svelte';
  import TransactionHistory from './TransactionHistory/index.svelte';
  import ControlsPanel from './ControlsPanel.svelte';
  import AccountChannels from './AccountChannels.svelte';
  // Import new XLN activation components
  import OrderbookDisplay from '../Trading/OrderbookDisplay.svelte';
  import FrameConsensus from '../Consensus/FrameConsensus.svelte';
  import ConservationMonitor from '../Channels/ConservationMonitor.svelte';

  export let tab: Tab;
  export let isLast: boolean = false;

  let replica: EntityReplica | null = null;
  let showCloseButton = true;
  let selectedAccount: { entityId: string; account: any } | null = null;

  // Reactive statement to get replica data
  $: {
    if (tab.entityId && tab.signer) {
      // Prefer time-aware replicas if available
      const replicaKey = `${tab.entityId}:${tab.signer}`;
      const candidate = $visibleReplicas?.get?.(replicaKey);
      replica = candidate; // TODO: Fix getReplica call
    } else {
      replica = null;
    }
  }

  // Reactive component states
  $: consensusExpanded = $settings.componentStates[`consensus-${tab.id}`] ?? true;
  $: chatExpanded = $settings.componentStates[`chat-${tab.id}`] ?? true;
  $: proposalsExpanded = $settings.componentStates[`proposals-${tab.id}`] ?? false;
  $: historyExpanded = $settings.componentStates[`history-${tab.id}`] ?? false;
  $: controlsExpanded = $settings.componentStates[`controls-${tab.id}`] ?? false;
  // New XLN components
  $: orderbookExpanded = $settings.componentStates[`orderbook-${tab.id}`] ?? true;
  $: frameConsensusExpanded = $settings.componentStates[`frameConsensus-${tab.id}`] ?? true;
  $: conservationExpanded = $settings.componentStates[`conservation-${tab.id}`] ?? true;

  function toggleComponent(componentId: string) {
    settingsOperations.toggleComponentState(componentId);
  }

  // 💰 Financial calculation functions

  // Token registry for consistent naming (matches contract prefunding)
  const TOKEN_REGISTRY: Record<string, { symbol: string; name: string; decimals: number; price: number }> = {
    '0': { symbol: 'NULL', name: 'Null Token', decimals: 18, price: 0 },
    '1': { symbol: 'ETH', name: 'Ethereum', decimals: 18, price: 2500 },       // Contract prefunds 1M
    '2': { symbol: 'USDT', name: 'Tether USD', decimals: 18, price: 1 },       // Contract prefunds 1M
    '3': { symbol: 'USDC', name: 'USD Coin', decimals: 18, price: 1 },         // Contract prefunds 1M
    '4': { symbol: 'ACME', name: 'ACME Corp Shares', decimals: 18, price: 15.50 },
    '5': { symbol: 'BTC', name: 'Bitcoin Shares', decimals: 8, price: 45000 },
  };

  const getTokenInfo = (tokenId: string) => TOKEN_REGISTRY[tokenId] || { symbol: `TKN${tokenId}`, decimals: 18, price: 0 };

  function formatAssetDisplay(tokenId: string, amount: bigint): string {
    const tokenInfo = getTokenInfo(tokenId);
    const divisor = BigInt(10) ** BigInt(tokenInfo.decimals);

    const wholePart = amount / divisor;
    const fractionalPart = amount % divisor;

    if (fractionalPart === 0n) {
      return `${wholePart.toString()} ${tokenInfo.symbol}`;
    }

    const fractionalStr = fractionalPart.toString().padStart(tokenInfo.decimals, '0').replace(/0+$/, '');
    return `${wholePart.toString()}.${fractionalStr} ${tokenInfo.symbol}`;
  }

  function getAssetValue(tokenId: string, amount: bigint): number {
    const tokenInfo = getTokenInfo(tokenId);
    const divisor = BigInt(10) ** BigInt(tokenInfo.decimals);

    const numericAmount = Number(amount) / Number(divisor);
    return numericAmount * tokenInfo.price;
  }

  function calculateTotalNetworth(reserves: Map<string, bigint>): number {
    let total = 0;
    for (const [tokenId, amount] of reserves.entries()) {
      total += getAssetValue(tokenId, amount);
    }
    return total;
  }

  // Handle entity selection from dropdown
  function handleEntitySelect(event: CustomEvent) {
    const { jurisdiction, signer, entityId } = event.detail;

    // Clear selected account when changing entities
    selectedAccount = null;

    tabOperations.updateTab(tab.id, {
      jurisdiction,
      signer,
      entityId,
      title: `Entity ${entityId.slice(-4)}`
    });
  }

  // Handle account selection from AccountInspectorDropdown
  function handleAccountSelect(event: CustomEvent) {
    const { entityId, account } = event.detail;
    selectedAccount = { entityId, account };
    console.log('📋 Account selected:', entityId.slice(-4), account);
  }

  // Handle tab close
  function handleCloseTab() {
    tabOperations.closeTab(tab.id);
  }

  // Handle add new tab
  function handleAddTab() {
    tabOperations.addTab();
  }

  onMount(() => {
    // Check if we should show close button
    const allTabs = tabOperations.getActiveTab();
    // Show close button if more than 1 tab exists
    // This will be updated reactively through the parent

    // Listen for time machine changes (like old index.html)
    const handleTimeChanged = (event: CustomEvent) => {
      console.log('🕰️ EntityPanel received time change event:', event.detail.timeIndex);
      // Force reactivity by triggering replica update
      if (tab.entityId && tab.signer) {
        // The reactive statement will automatically pick up the new visibleReplicas
        // due to timeState changes, but we can force a console log
        console.log(`🔄 Panel ${tab.id} updating for time index:`, event.detail.timeIndex);
      }
    };

    window.addEventListener('timeChanged', handleTimeChanged as EventListener);

    return () => {
      window.removeEventListener('timeChanged', handleTimeChanged as EventListener);
    };
  });
</script>

<div class="entity-panel" data-panel-id={tab.id}>
  <div class="panel-header">
    <div class="panel-header-dropdowns">
      <EntityDropdown
        {tab}
        on:entitySelect={handleEntitySelect}
      />
      <AccountInspectorDropdown {replica} on:accountSelect={handleAccountSelect} />
    </div>
    <div class="panel-header-controls">
      {#if isLast}
        <button class="panel-add-btn" on:click={handleAddTab} title="Add Entity Panel">
          ➕
        </button>
      {/if}
      {#if showCloseButton}
        <button class="panel-close-btn" on:click={handleCloseTab} title="Close panel">
          ×
        </button>
      {/if}
    </div>
  </div>

  {#if !tab.entityId || !tab.signer}
    <!-- Empty State: No Entity Selected -->
    <div class="empty-panel-state">
      <div class="empty-panel-message">
        <div class="empty-icon">🏢</div>
        <h3>Select Entity to View Profile</h3>
        <p>Use the dropdown above to select:</p>
        <div class="selection-steps">
          <div class="step">📍 <strong>Jurisdiction</strong> → Network/Port</div>
          <div class="step">👤 <strong>Signer</strong> → Your Identity</div>
          <div class="step">🏢 <strong>Entity</strong> → Which Entity</div>
        </div>
        <small>Once selected, you'll see consensus, chat, proposals, and controls.</small>
      </div>
    </div>
  {:else}
    {#if selectedAccount}
      <!-- Account-specific view -->
      <div class="account-view-header">
        <div class="account-title">
          <h3>🏢 Entity {selectedAccount.entityId.slice(-4)} Account Details</h3>
          <button class="back-to-entity-btn" on:click={() => selectedAccount = null}>
            ← Back to Entity Overview
          </button>
        </div>
      </div>
      
      <!-- Dedicated Account Information Panel -->
      <div class="panel-component account-details-panel">
        <div class="component-header">
          <div class="component-title">
            <span>💳</span>
            <span>Account with Entity {selectedAccount.entityId.slice(-4)}</span>
          </div>
        </div>
        <div class="component-content" style="max-height: none; padding: 20px;">
          <div class="account-full-details">
            <!-- Account status -->
            <div class="account-status-section">
              <h4>Account Status</h4>
              <div class="status-row">
                <span class="label">Status:</span>
                <span class="value {selectedAccount.account.mempool?.length > 0 ? 'pending' : 'synced'}">
                  {selectedAccount.account.mempool?.length > 0 ? '🟡 Pending' : '✅ Synced'}
                </span>
              </div>
              <div class="status-row">
                <span class="label">Frame:</span>
                <span class="value">#{selectedAccount.account.currentFrame?.frameId || 0}</span>
              </div>
              <div class="status-row">
                <span class="label">Mempool:</span>
                <span class="value">{selectedAccount.account.mempool?.length || 0} transactions</span>
              </div>
            </div>

            <!-- Token balances -->
            {#if selectedAccount.account.deltas && selectedAccount.account.deltas.size > 0}
              <div class="token-balances-section">
                <h4>Token Balances</h4>
                {#each Array.from(selectedAccount.account.deltas.entries()) as [tokenId, delta]}
                  {@const tokenInfo = getTokenInfo(tokenId)}
                  <div class="token-detail-card">
                    <div class="token-header">
                      <span class="token-symbol" style="color: {tokenInfo.symbol === 'ETH' ? '#627eea' : tokenInfo.symbol === 'USDT' ? '#26a17b' : '#007acc'}">{tokenInfo.symbol}</span>
                      <span class="token-name">{tokenInfo.name}</span>
                    </div>
                    <div class="balance-details">
                      <div class="balance-item">
                        <span class="balance-label">Collateral:</span>
                        <span class="balance-value">{delta.collateral?.toString() || '0'}</span>
                      </div>
                      <div class="balance-item">
                        <span class="balance-label">Off-chain Delta:</span>
                        <span class="balance-value">{delta.offdelta?.toString() || '0'}</span>
                      </div>
                      <div class="balance-item">
                        <span class="balance-label">On-chain Delta:</span>
                        <span class="balance-value">{delta.ondelta?.toString() || '0'}</span>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="no-tokens">
                <p>No token balances yet</p>
              </div>
            {/if}

            <!-- Mempool transactions -->
            {#if selectedAccount.account.mempool && selectedAccount.account.mempool.length > 0}
              <div class="mempool-section">
                <h4>Pending Transactions</h4>
                {#each selectedAccount.account.mempool as tx, i}
                  <div class="mempool-tx">
                    <span class="tx-index">#{i}</span>
                    <span class="tx-type">{tx.type || 'Unknown'}</span>
                    <span class="tx-data">{JSON.stringify(tx.data).slice(0, 50)}...</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {:else}
      <!-- Normal entity view -->
      <!-- Entity Profile Section -->
      <EntityProfile {replica} {tab} />

      <!-- Reserves - Always Visible -->
      {#if replica?.state?.reserves && replica.state.reserves.size > 0}
        <div class="entity-reserves-section">
          <div class="reserves-header">
            <h3>💰 Reserves</h3>
            <div class="portfolio-summary">
              <strong>Portfolio Value: ${calculateTotalNetworth(replica.state.reserves).toFixed(2)}</strong>
            </div>
          </div>
          <div class="reserves-grid">
            {#each Array.from(replica.state.reserves.entries()) as [tokenId, amount]}
              {@const tokenInfo = getTokenInfo(tokenId)}
              {@const assetValue = getAssetValue(tokenId, amount)}
              {@const totalNetworth = calculateTotalNetworth(replica.state.reserves)}
              {@const globalPercentage = $settings.portfolioScale > 0 ? Math.min((assetValue / $settings.portfolioScale) * 100, 100) : 0}
              {@const portfolioPercentage = totalNetworth > 0 ? (assetValue / totalNetworth) * 100 : 0}

              <div class="reserve-card">
                <div class="reserve-info">
                  <span class="reserve-symbol" style="color: {tokenInfo.symbol === 'ETH' ? '#627eea' : tokenInfo.symbol === 'USDT' ? '#26a17b' : '#007acc'}">{tokenInfo.symbol}</span>
                  <span class="reserve-amount">{formatAssetDisplay(tokenId, amount)}</span>
                  <span class="reserve-value">${assetValue.toFixed(2)} ({portfolioPercentage.toFixed(1)}% of entity)</span>
                </div>
                <div class="reserve-bar">
                  <div class="reserve-fill" style="width: {globalPercentage}%" title="Relative to global scale: ${$settings.portfolioScale}"></div>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="entity-reserves-section">
          <div class="reserves-header">
            <h3>💰 Reserves</h3>
          </div>
          <p class="empty-reserves">No reserves yet - deposit assets via Depository.sol</p>
        </div>
      {/if}

      <!-- Accounts - Always Visible -->
      <div class="entity-accounts-section">
        <div class="accounts-header">
          <h3>💳 Accounts</h3>
        </div>
        <div class="accounts-content">
          <AccountChannels {replica} />
        </div>
      </div>

      <!-- Consensus State Component -->
      <div class="panel-component" id="consensus-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!consensusExpanded}
      on:click={() => toggleComponent(`consensus-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`consensus-${tab.id}`)}
    >
      <div class="component-title">
        <span>⚖️</span>
        <span>Consensus State</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!consensusExpanded}
      style="max-height: 200px;"
    >
      <ConsensusState {replica} />
    </div>
  </div>

  <!-- Frame Consensus Component (NEW) -->
  <div class="panel-component" id="frameConsensus-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!frameConsensusExpanded}
      on:click={() => toggleComponent(`frameConsensus-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`frameConsensus-${tab.id}`)}
    >
      <div class="component-title">
        <span>🔄</span>
        <span>Frame Consensus</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!frameConsensusExpanded}
      style="max-height: 300px;"
    >
      <FrameConsensus entityState={replica?.state} entityId={tab.entityId} />
    </div>
  </div>

  <!-- Orderbook Display Component (NEW) -->
  <div class="panel-component" id="orderbook-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!orderbookExpanded}
      on:click={() => toggleComponent(`orderbook-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`orderbook-${tab.id}`)}
    >
      <div class="component-title">
        <span>📊</span>
        <span>Orderbook</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!orderbookExpanded}
      style="max-height: 400px;"
    >
      <OrderbookDisplay entityId={tab.entityId} orderbook={replica?.state?.orderbook} />
    </div>
  </div>

  <!-- Conservation Monitor Component (NEW) -->
  <div class="panel-component" id="conservation-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!conservationExpanded}
      on:click={() => toggleComponent(`conservation-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`conservation-${tab.id}`)}
    >
      <div class="component-title">
        <span>⚖️</span>
        <span>Conservation Monitor</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!conservationExpanded}
      style="max-height: 400px;"
    >
      <ConservationMonitor channels={replica?.state?.channels || new Map()} entityId={tab.entityId} />
    </div>
  </div>

  <!-- Chat Component -->
  <div class="panel-component" id="chat-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!chatExpanded}
      on:click={() => toggleComponent(`chat-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`chat-${tab.id}`)}
    >
      <div class="component-title">
        <span>💬</span>
        <span>Chat</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!chatExpanded}
      style="max-height: 25vh;"
    >
      <ChatMessages {replica} {tab} currentTimeIndex={$currentTimeIndex} />
    </div>
  </div>

  <!-- Proposals Component -->
  <div class="panel-component" id="proposals-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!proposalsExpanded}
      on:click={() => toggleComponent(`proposals-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`proposals-${tab.id}`)}
    >
      <div class="component-title">
        <span>📋</span>
        <span>Proposals</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!proposalsExpanded}
      style="max-height: 25vh;"
    >
      <ProposalsList {replica} {tab} />
    </div>
  </div>

  <!-- Transaction History Component -->
  <div class="panel-component entity-history-panel" id="history-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!historyExpanded}
      on:click={() => toggleComponent(`history-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`history-${tab.id}`)}
    >
      <div class="component-title">
        <span>🗂️</span>
        <span>History</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!historyExpanded}
      style="max-height: 50vh;"
    >
      <TransactionHistory {replica} {tab} serverHistory={$history} currentTimeIndex={$currentTimeIndex} />
    </div>
  </div>

  <!-- Controls Component -->
  <div class="panel-component" id="controls-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!controlsExpanded}
      on:click={() => toggleComponent(`controls-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`controls-${tab.id}`)}
    >
      <div class="component-title">
        <span>⚙️</span>
        <span>Controls</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!controlsExpanded}
      style="max-height: 400px;"
    >
      <ControlsPanel {replica} {tab} />
    </div>
  </div>
    {/if}
  {/if}
</div>

<style>
  .entity-panel {
    background: #2d2d2d;
    border-right: 1px solid #3e3e3e;
    padding: 20px;
    flex: 1;
    min-width: 25vw;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #3e3e3e;
    gap: 12px;
  }

  .panel-header-dropdowns {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }

  .panel-header-dropdowns > :global(*) {
    flex: 1;
    min-width: 0;
  }

  .panel-header-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-add-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #007acc;
    color: white;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: all 0.2s ease;
  }

  .panel-add-btn:hover {
    background: #0086e6;
    transform: scale(1.1);
  }

  .panel-close-btn {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #666;
    color: white;
    border: none;
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .panel-close-btn:hover {
    background: #888;
    transform: scale(1.1);
  }

  /* Collapsible Component System */
  .panel-component {
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    margin-bottom: 12px;
    overflow: hidden;
  }

  .component-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #2d2d2d;
    border-bottom: 1px solid #3e3e3e;
    cursor: pointer;
    user-select: none;
    transition: background-color 0.2s ease;
  }

  .component-header:hover {
    background: #333333;
  }

  .component-title {
    font-size: 0.9em;
    font-weight: 500;
    color: #d4d4d4;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .component-toggle {
    color: #9d9d9d;
    font-size: 12px;
    transition: transform 0.2s ease;
  }

  .component-header.collapsed .component-toggle {
    transform: rotate(-90deg);
  }

  .component-content {
    transition: max-height 0.3s ease, opacity 0.3s ease;
    overflow: hidden;
  }

  .component-content.collapsed {
    max-height: 0 !important;
    opacity: 0;
  }

  .empty-panel-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 300px;
    padding: 40px 20px;
  }

  .empty-panel-message {
    text-align: center;
    max-width: 300px;
    color: #d4d4d4;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.6;
  }

  .empty-panel-message h3 {
    margin: 0 0 12px 0;
    color: #007acc;
    font-size: 18px;
  }

  .empty-panel-message p {
    margin: 0 0 16px 0;
    color: #999;
  }

  .selection-steps {
    text-align: left;
    margin: 16px 0;
  }

  .step {
    margin: 8px 0;
    padding: 6px 0;
    font-size: 14px;
    color: #ccc;
  }

  .empty-panel-message small {
    color: #777;
    font-style: italic;
    font-size: 12px;
  }

  .entity-history-panel {
    background: #1e1e1e;
  }

  /* 💰 Reserves Component Styles */
  .reserves-container {
    padding: 10px 0;
  }

  .portfolio-summary {
    margin-bottom: 15px;
    padding: 8px 12px;
    background: #333;
    border-radius: 4px;
    border-left: 3px solid #00ff88;
  }

  .portfolio-summary strong {
    color: #00ff88;
    font-size: 1.1em;
  }

  .asset-row {
    display: flex;
    flex-direction: column;
    margin-bottom: 12px;
    padding: 8px 12px;
    background: #2a2a2a;
    border-radius: 4px;
    border: 1px solid #3e3e3e;
  }

  .asset-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .asset-symbol {
    font-weight: bold;
    color: #ffffff;
    font-family: 'Courier New', monospace;
  }

  .asset-amount {
    color: #d4d4d4;
    font-family: 'Courier New', monospace;
  }

  .asset-value {
    color: #00ff88;
    font-weight: bold;
    font-family: 'Courier New', monospace;
  }

  .portfolio-bar-container {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .portfolio-bar {
    flex: 1;
    height: 8px;
    background: #1a1a1a;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid #3e3e3e;
  }

  .portfolio-fill {
    height: 100%;
    background: linear-gradient(90deg, #00ff88, #00cc66);
    transition: width 0.3s ease;
    border-radius: 3px;
  }

  .asset-percentage {
    color: #00ff88;
    font-family: 'Courier New', monospace;
    font-size: 0.85em;
    min-width: 45px;
    text-align: right;
  }

  .empty-state {
    color: #777;
    font-style: italic;
    text-align: center;
    padding: 20px;
  }

  /* Account View Styles */
  .account-view-header {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #3e3e3e;
  }

  .account-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .account-title h3 {
    margin: 0;
    color: #007acc;
    font-size: 18px;
  }

  .back-to-entity-btn {
    padding: 6px 12px;
    background: #555;
    border: 1px solid #666;
    border-radius: 4px;
    color: #d4d4d4;
    cursor: pointer;
    font-size: 14px;
    transition: all 0.2s ease;
  }

  .back-to-entity-btn:hover {
    background: #666;
    border-color: #007acc;
  }

  .account-details-panel {
    background: #252526;
  }

  .account-full-details {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .account-status-section h4,
  .token-balances-section h4,
  .mempool-section h4 {
    margin: 0 0 12px 0;
    color: #007acc;
    font-size: 16px;
    border-bottom: 1px solid #3e3e3e;
    padding-bottom: 6px;
  }

  .status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid #333;
  }

  .status-row:last-child {
    border-bottom: none;
  }

  .status-row .label {
    font-weight: bold;
    color: #ccc;
  }

  .status-row .value {
    font-family: 'Courier New', monospace;
    color: #d4d4d4;
  }

  .status-row .value.pending {
    color: #ffc107;
  }

  .status-row .value.synced {
    color: #28a745;
  }

  .token-detail-card {
    background: #2a2a2a;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .token-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #333;
  }

  .token-symbol {
    font-weight: bold;
    font-size: 16px;
    font-family: 'Courier New', monospace;
  }

  .token-name {
    color: #999;
    font-size: 14px;
  }

  .balance-details {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
  }

  .balance-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .balance-label {
    font-size: 12px;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .balance-value {
    font-family: 'Courier New', monospace;
    font-size: 14px;
    color: #d4d4d4;
    font-weight: bold;
  }

  .no-tokens {
    text-align: center;
    padding: 20px;
    color: #777;
    font-style: italic;
  }

  .mempool-tx {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: #2a2a2a;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    margin-bottom: 8px;
  }

  .tx-index {
    font-family: 'Courier New', monospace;
    color: #007acc;
    font-weight: bold;
    min-width: 30px;
  }

  .tx-type {
    font-weight: bold;
    color: #ffc107;
    min-width: 100px;
  }

  .tx-data {
    font-family: 'Courier New', monospace;
    color: #999;
    flex: 1;
    font-size: 12px;
  }

  /* Always-visible reserves section */
  .entity-reserves-section {
    background: #2d2d2d;
    border: 1px solid #444;
    border-radius: 8px;
    margin: 16px 20px;
    padding: 16px;
  }

  .reserves-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .reserves-header h3 {
    margin: 0;
    color: #e8e8e8;
    font-size: 1.1em;
  }

  .portfolio-summary {
    color: #28a745;
    font-weight: 600;
  }

  .reserves-grid {
    display: grid;
    gap: 8px;
  }

  .reserve-card {
    background: #1a1a1a;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 12px;
  }

  .reserve-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .reserve-symbol {
    font-weight: bold;
    font-size: 1.1em;
  }

  .reserve-amount {
    color: #e8e8e8;
    font-weight: 500;
  }

  .reserve-value {
    color: #28a745;
    font-size: 0.9em;
  }

  .reserve-bar {
    height: 4px;
    background: #333;
    border-radius: 2px;
    overflow: hidden;
  }

  .reserve-fill {
    height: 100%;
    background: linear-gradient(90deg, #28a745, #20c997);
    transition: width 0.3s ease;
  }

  .empty-reserves {
    color: #777;
    font-style: italic;
    text-align: center;
    margin: 0;
  }

  /* Always-visible accounts section */
  .entity-accounts-section {
    background: #2d2d2d;
    border: 1px solid #444;
    border-radius: 8px;
    margin: 16px 20px;
    padding: 16px;
  }

  .accounts-header {
    margin-bottom: 12px;
  }

  .accounts-header h3 {
    margin: 0;
    color: #e8e8e8;
    font-size: 1.1em;
  }

  .accounts-content {
    /* Let AccountChannels handle its own styling */
  }
</style>
