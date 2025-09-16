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
  import EntityProfile from './EntityProfile.svelte';
  import ConsensusState from './ConsensusState.svelte';
  import ChatMessages from './ChatMessages.svelte';
  import ProposalsList from './ProposalsList.svelte';
  import TransactionHistory from './TransactionHistory/index.svelte';
  import ControlsPanel from './ControlsPanel.svelte';
  import AccountChannels from './AccountChannels.svelte';

  export let tab: Tab;
  export let isLast: boolean = false;

  let replica: EntityReplica | null = null;
  let showCloseButton = true;

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
  $: reservesExpanded = $settings.componentStates[`reserves-${tab.id}`] ?? false;
  $: channelsExpanded = $settings.componentStates[`channels-${tab.id}`] ?? false;
  $: chatExpanded = $settings.componentStates[`chat-${tab.id}`] ?? true;
  $: proposalsExpanded = $settings.componentStates[`proposals-${tab.id}`] ?? false;
  $: historyExpanded = $settings.componentStates[`history-${tab.id}`] ?? false;
  $: controlsExpanded = $settings.componentStates[`controls-${tab.id}`] ?? false;

  function toggleComponent(componentId: string) {
    settingsOperations.toggleComponentState(componentId);
  }

  // 💰 Financial calculation functions

  // Mock asset prices for demo (in real system, fetch from oracle/API)
  const assetPrices: Record<string, number> = {
    'ETH': 2500,      // $2,500 per ETH
    'USDT': 1,        // $1 per USDT
    'USDC': 1,        // $1 per USDC
    'ACME-SHARES': 15.50, // $15.50 per ACME share
    'BTC-SHARES': 45000   // $45,000 per BTC share
  };

  function formatAssetDisplay(balance: any): string {
    const divisor = BigInt(10) ** BigInt(balance.decimals);
    const wholePart = balance.amount / divisor;
    const fractionalPart = balance.amount % divisor;

    if (fractionalPart === 0n) {
      return `${wholePart} ${balance.symbol}`;
    }

    const fractionalStr = fractionalPart.toString().padStart(balance.decimals, '0');
    return `${wholePart}.${fractionalStr} ${balance.symbol}`;
  }

  function getAssetValue(balance: any): number {
    const divisor = BigInt(10) ** BigInt(balance.decimals);
    const amount = Number(balance.amount) / Number(divisor);
    const price = assetPrices[balance.symbol] || 0;
    return amount * price;
  }

  function calculateTotalNetworth(reserves: Map<string, any>): number {
    let total = 0;
    for (const [symbol, balance] of reserves.entries()) {
      total += getAssetValue(balance);
    }
    return total;
  }

  // Handle entity selection from dropdown
  function handleEntitySelect(event: CustomEvent) {
    const { jurisdiction, signer, entityId } = event.detail;

    tabOperations.updateTab(tab.id, {
      jurisdiction,
      signer,
      entityId,
      title: `Entity ${entityId.slice(-4)}`
    });
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
    <EntityDropdown
      {tab}
      on:entitySelect={handleEntitySelect}
    />
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
    <!-- Entity Profile Section -->
    <EntityProfile {replica} {tab} />

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

  <!-- Reserves Component -->
  <div class="panel-component" id="reserves-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!reservesExpanded}
      on:click={() => toggleComponent(`reserves-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`reserves-${tab.id}`)}
    >
      <div class="component-title">
        <span>💰</span>
        <span>Reserves</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!reservesExpanded}
      style="max-height: 300px;"
    >
      {#if replica?.state?.reserves && replica.state.reserves.size > 0}
        <div class="reserves-container">
          <!-- Portfolio Summary -->
          <div class="portfolio-summary">
            <strong>Portfolio Value: ${calculateTotalNetworth(replica.state.reserves).toFixed(2)}</strong>
          </div>

          <!-- Asset List with Portfolio Bars -->
          {#each Array.from(replica.state.reserves.entries()) as [symbol, balance]}
            {@const assetValue = getAssetValue(balance)}
            {@const totalNetworth = calculateTotalNetworth(replica.state.reserves)}
            {@const percentage = totalNetworth > 0 ? (assetValue / totalNetworth) * 100 : 0}

            <div class="asset-row">
              <div class="asset-info">
                <span class="asset-symbol">{balance.symbol}</span>
                <span class="asset-amount">{formatAssetDisplay(balance)}</span>
                <span class="asset-value">${assetValue.toFixed(2)}</span>
              </div>

              <!-- Green portfolio bar showing percentage -->
              <div class="portfolio-bar-container">
                <div class="portfolio-bar">
                  <div
                    class="portfolio-fill"
                    style="width: {percentage}%"
                  ></div>
                </div>
                <span class="asset-percentage">{percentage.toFixed(1)}%</span>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty-state">No reserves yet - deposit assets via Depository.sol</p>
      {/if}
    </div>
  </div>

  <!-- Account Channels Component -->
  <div class="panel-component" id="channels-{tab.id}">
    <div
      class="component-header"
      class:collapsed={!channelsExpanded}
      on:click={() => toggleComponent(`channels-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`channels-${tab.id}`)}
    >
      <div class="component-title">
        <span>🔗</span>
        <span>Account Channels</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      class:collapsed={!channelsExpanded}
      style="max-height: 400px;"
    >
      <AccountChannels {replica} />
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
      <ChatMessages {replica} {tab} />
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
</style>
