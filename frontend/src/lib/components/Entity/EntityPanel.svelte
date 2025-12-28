<script lang="ts">
  import { onMount } from 'svelte';
  import type { Tab, EntityReplica } from '$lib/types/ui';
  import { history } from '../../stores/xlnStore';
  import { visibleReplicas, currentTimeIndex } from '../../stores/timeStore';
  import { tabOperations } from '../../stores/tabStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';

  import EntityDropdown from './EntityDropdown.svelte';
  import AccountPanel from './AccountPanel.svelte';
  import ConsensusState from './ConsensusState.svelte';
  import ChatMessages from './ChatMessages.svelte';
  import ProposalsList from './ProposalsList.svelte';
  import TransactionHistory from './TransactionHistory/index.svelte';
  import ControlsPanel from './ControlsPanel.svelte';
  import AccountList from './AccountList.svelte';
  import AccountDropdown from './AccountDropdown.svelte';
  import PaymentPanel from './PaymentPanel.svelte';
  import SettlementPanel from './SettlementPanel.svelte';
  import InsurancePanel from '$lib/view/panels/InsurancePanel.svelte';
  import { xlnFunctions } from '../../stores/xlnStore';

  export let tab: Tab;

  // Safety guard for XLN functions
  export let isLast: boolean = false;

  let replica: EntityReplica | null = null;
  let showCloseButton = true;
  let selectedAccountId: string | null = null;

  // Get environment from context (for /view route) or fall back to global stores (for / route)
  // This allows EntityPanel to work in both isolated and global contexts
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;

  // Extract the stores from entityEnv (or use global stores as fallback)
  // entityEnv.eReplicas, entityEnv.xlnFunctions, entityEnv.history, entityEnv.timeIndex are Readable stores
  const contextReplicas = entityEnv?.eReplicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextHistory = entityEnv?.history;
  const contextTimeIndex = entityEnv?.timeIndex;

  // Use context stores if available, otherwise fall back to global stores
  $: activeReplicas = contextReplicas ? $contextReplicas : $visibleReplicas;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeHistory = contextHistory ? $contextHistory : $history;
  $: activeTimeIndex = contextTimeIndex !== undefined ? $contextTimeIndex : $currentTimeIndex;

  // Reactive statement to get replica data
  $: {
    console.log('🔄 EntityPanel reactive: tab =', { entityId: tab.entityId?.slice(0, 10), signerId: tab.signerId, isActive: tab.isActive });
    console.log('🔄 EntityPanel reactive: activeReplicas size =', activeReplicas?.size);

    if (tab.entityId && tab.signerId) {
      // Prefer time-aware replicas if available
      const replicaKey = `${tab.entityId}:${tab.signerId}`;
      console.log('🔄 Looking for replica:', replicaKey);
      const candidate = activeReplicas?.get?.(replicaKey);
      replica = candidate ?? null;
      console.log('🔄 Replica found?', !!replica);
    } else {
      console.log('🔄 No entityId/signerId in tab - replica = null');
      replica = null;
    }
  }

  // Navigation state - entity view vs focused account view
  $: isAccountFocused = selectedAccountId !== null;
  $: selectedAccount = isAccountFocused && replica?.state?.accounts && selectedAccountId
    ? replica.state.accounts.get(selectedAccountId) : null;

  // Reactive component states
  $: consensusExpanded = $settings.componentStates[`consensus-${tab.id}`] ?? true;
  $: chatExpanded = $settings.componentStates[`chat-${tab.id}`] ?? true;
  $: proposalsExpanded = $settings.componentStates[`proposals-${tab.id}`] ?? false;
  $: historyExpanded = $settings.componentStates[`history-${tab.id}`] ?? false;
  $: controlsExpanded = $settings.componentStates[`controls-${tab.id}`] ?? false;

  function toggleComponent(componentId: string) {
    settingsOperations.toggleComponentState(componentId);
  }

  // 💰 Financial calculation functions

  function formatAssetDisplay(tokenId: string, amount: bigint): string {
    if (!activeXlnFunctions) return `${amount} (token ${tokenId})`;
    const tokenInfo = activeXlnFunctions.getTokenInfo(Number(tokenId));
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
    if (!activeXlnFunctions) return 0;
    const tokenInfo = activeXlnFunctions.getTokenInfo(Number(tokenId));
    const divisor = BigInt(10) ** BigInt(tokenInfo.decimals);

    const numericAmount = Number(amount) / Number(divisor);
    // Simple price oracle for display (USDC=1, ETH=2500)
    const price = Number(tokenId) === 1 ? 1 : 2500;
    return numericAmount * price;
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
    const { jurisdiction, signerId, entityId } = event.detail;

    console.log('🎯 EntityPanel.handleEntitySelect received:', { jurisdiction, signerId, entityId: entityId?.slice(0, 10) });
    console.log('🎯 Current tab:', { id: tab.id, entityId: tab.entityId?.slice(0, 10), signerId: tab.signerId });
    console.log('🎯 Current activeReplicas size:', activeReplicas?.size);

    // Clear selected account when changing entities
    selectedAccountId = null;

    // Update tab (this will trigger reactive statement to load new replica)
    tab = {
      ...tab,
      jurisdiction,
      signerId,
      entityId,
    };

    console.log('🎯 Tab updated to:', { entityId: tab.entityId?.slice(0, 10), signerId: tab.signerId });
  }

  // Handle account selection from dropdown OR account preview click
  function handleAccountSelect(event: CustomEvent) {
    const accountId = event.detail.accountId;
    selectedAccountId = accountId;
    if (accountId) {
    } else {
      console.log('📋 Account selection cleared - back to entity view');
    }
  }

  // Handle account selection from preview click - same as dropdown
  function handleAccountPreviewSelect(event: CustomEvent) {
    // Route to the same handler as dropdown for consistent behavior
    handleAccountSelect(event);
  }

  // Handle back to entity - clear account selection
  function handleBackToEntity() {
    selectedAccountId = null;
    console.log('↩️ Back to entity view');
  }


  // Handle tab close
  function handleCloseTab() {
    tabOperations.closeTab(tab.id);
  }

  // Handle add new tab
  function handleAddTab() {
    tabOperations.addTab();
  }

  // Handle Ask AI - navigate to /ai with entity context
  function handleAskAI() {
    if (!replica) return;

    // Build entity context for AI
    const entityContext = {
      entityId: tab.entityId,
      signerId: tab.signerId,
      jurisdiction: tab.jurisdiction,
      reserves: replica.state?.reserves ? Object.fromEntries(
        Array.from(replica.state.reserves.entries()).map(([k, v]) => [k, v.toString()])
      ) : {},
      accountCount: replica.state?.accounts?.size ?? 0,
      timestamp: Date.now()
    };

    // Store in localStorage for /ai page to read
    localStorage.setItem('xln-entity-context', JSON.stringify(entityContext));

    // Navigate to /ai with context flag
    window.location.href = '/ai?context=entity';
  }

  onMount(() => {
    // Check if we should show close button
    tabOperations.getActiveTab();
    // Show close button if more than 1 tab exists
    // This will be updated reactively through the parent

    // Listen for time machine changes (like old index.html)
    const handleTimeChanged = (event: CustomEvent) => {
      console.log('🕰️ EntityPanel received time change event:', event.detail.timeIndex);
      // Force reactivity by triggering replica update
      if (tab.entityId && tab.signerId) {
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
      <div class="dropdown-group">
        <EntityDropdown
          {tab}
          on:entitySelect={handleEntitySelect}
        />
      </div>
      <div class="dropdown-group">
        {#if replica}
          <AccountDropdown {replica} {selectedAccountId} on:accountSelect={handleAccountSelect} />
        {/if}
      </div>
    </div>
    <div class="panel-header-controls">
      {#if replica}
        <button class="panel-ai-btn" on:click={handleAskAI} title="Ask AI about this entity">
          🤖
        </button>
      {/if}
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

  {#if isAccountFocused && selectedAccount}
    <!-- Focused Account View -->
    <div class="focused-account-view">
      <div class="account-breadcrumb">
        <button class="breadcrumb-back" on:click={handleBackToEntity}>← Entity #{activeXlnFunctions!.getEntityShortId(tab.entityId)}</button>
        <span class="breadcrumb-separator">→</span>
        <span class="breadcrumb-current">Account with Entity #{activeXlnFunctions!.getEntityShortId(selectedAccountId!)}</span>
      </div>
      <AccountPanel
        account={selectedAccount}
        counterpartyId={selectedAccountId || ''}
        entityId={tab.entityId}
        on:back={handleBackToEntity}
      />
    </div>
  {:else if !tab.entityId || !tab.signerId}
    <!-- Empty State: No Entity Selected -->
    <div class="empty-panel-state">
      <div class="empty-panel-message">
        <h3>Select Entity to View Profile</h3>
        <p>Use the dropdown above to select:</p>
        <div class="selection-steps">
          <div class="step"><strong>Jurisdiction</strong> - Network/Port</div>
          <div class="step"><strong>Signer</strong> - Your Identity</div>
          <div class="step"><strong>Entity</strong> - Which Entity</div>
        </div>
        <small>Once selected, you'll see consensus, chat, proposals, and controls.</small>
      </div>
    </div>
  {:else}
    {#if selectedAccount && selectedAccountId}
      <!-- Account Panel View -->
      <AccountPanel
        account={selectedAccount}
        counterpartyId={selectedAccountId}
        entityId={tab.entityId}
        on:back={handleBackToEntity}
      />
    {:else}
      <!-- Normal entity view -->
      <!-- Entity info now only in dropdown, not separate card -->

      <!-- Reserves - Always Visible -->
      {#if replica?.state?.reserves && replica.state.reserves instanceof Map && replica.state.reserves.size > 0}
        <div class="entity-reserves-section">
          <div class="reserves-header">
            <h3>Reserves</h3>
            <div class="portfolio-summary">
              <strong>Portfolio Value: ${calculateTotalNetworth(replica.state.reserves).toFixed(2)}</strong>
            </div>
          </div>
          <div class="reserves-grid">
            {#each Array.from(replica.state.reserves.entries()) as [tokenId, amount]}
              {@const tokenInfo = activeXlnFunctions?.getTokenInfo(Number(tokenId)) ?? { symbol: 'UNK', decimals: 18 }}
              {@const assetValue = getAssetValue(tokenId, amount)}
              {@const totalNetworth = calculateTotalNetworth(replica.state.reserves)}
              {@const globalPercentage = $settings.portfolioScale > 0 ? Math.min((assetValue / $settings.portfolioScale) * 100, 100) : 0}
              {@const portfolioPercentage = totalNetworth > 0 ? (assetValue / totalNetworth) * 100 : 0}

              <div class="reserve-card">
                <div class="reserve-info">
                  <span class="reserve-symbol" style="color: {tokenInfo.symbol === 'ETH' ? '#627eea' : '#2775ca'}">{tokenInfo.symbol}</span>
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
            <h3>Reserves</h3>
          </div>
          <p class="empty-reserves">No reserves yet - deposit assets via Depository.sol</p>
        </div>
      {/if}

      <!-- Insurance Lines - Always Visible (after Reserves, before Accounts) -->
      {#if replica?.state?.insuranceLines && replica.state.insuranceLines.length > 0}
        <div class="entity-insurance-section">
          <div class="insurance-header">
            <h3>🛡️ Insurance Coverage</h3>
          </div>
          <div class="insurance-content">
            <InsurancePanel
              isolatedEnv={contextReplicas ? { subscribe: (fn: any) => contextReplicas.subscribe((val: any) => fn({ eReplicas: val })) } as any : undefined}
              isolatedHistory={contextHistory as any}
              isolatedTimeIndex={contextTimeIndex as any}
            />
          </div>
        </div>
      {/if}

      <!-- Accounts - Always Visible -->
      <div class="entity-accounts-section">
        <div class="accounts-header">
          <h3>Accounts</h3>
        </div>
        <div class="accounts-content">
          <AccountList replica={replica} on:select={handleAccountPreviewSelect} />
        </div>
      </div>

      <!-- Periodic Tasks (moved from above Accounts) -->
      {#if replica && (replica.state as any)?.crontabState}
        {@const now = Date.now()}
        {@const crontabState = (replica.state as any).crontabState}
        {@const tasks = crontabState.tasks}
        {#if tasks instanceof Map}
          <div class="crontab-section">
            <h3>⏰ Periodic Tasks</h3>
            <div class="crontab-timers">
              {#each Array.from(tasks.entries()) as [taskName, task]}
                {@const timeSinceLastRun = now - task.lastRun}
                {@const timeUntilNext = Math.max(0, task.intervalMs - timeSinceLastRun)}
                {@const progress = (timeSinceLastRun / task.intervalMs) * 100}
                <div class="crontab-task">
                  <div class="task-info">
                    <span class="task-name">{taskName}</span>
                    <span class="task-timer">{Math.ceil(timeUntilNext / 1000)}s</span>
                  </div>
                  <div class="task-progress">
                    <div class="task-fill" style="width: {Math.min(progress, 100)}%"></div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

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
      <ChatMessages {replica} {tab} currentTimeIndex={activeTimeIndex ?? -1} />
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
      <TransactionHistory {replica} {tab} runtimeHistory={(activeHistory ?? []) as any[]} currentTimeIndex={activeTimeIndex ?? -1} />
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

  <!-- Payment Component -->
  <div class="panel-component" id="payment-{tab.id}">
    <div
      class="component-header"
      on:click={() => toggleComponent(`payment-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`payment-${tab.id}`)}
    >
      <div class="component-title">
        <span>💸</span>
        <span>Payments</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      style="max-height: none; overflow-y: auto;"
    >
      <PaymentPanel entityId={replica?.entityId || tab.entityId} />
    </div>
  </div>

  <!-- Settlement Component -->
  <div class="panel-component" id="settlement-{tab.id}">
    <div
      class="component-header"
      on:click={() => toggleComponent(`settlement-${tab.id}`)}
      role="button"
      tabindex="0"
      on:keydown={(e) => e.key === 'Enter' && toggleComponent(`settlement-${tab.id}`)}
    >
      <div class="component-title">
        <span>🏦</span>
        <span>Settlement</span>
      </div>
      <div class="component-toggle">▼</div>
    </div>
    <div
      class="component-content"
      style="max-height: none; overflow-y: auto;"
    >
      <SettlementPanel entityId={replica?.entityId || tab.entityId} />
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
    gap: 16px;
    flex: 1;
  }

  .dropdown-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
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

  /* Insurance section */
  .entity-insurance-section {
    margin: 16px;
    padding: 16px;
    background: rgba(138, 43, 226, 0.1);
    border: 1px solid rgba(138, 43, 226, 0.3);
    border-radius: 8px;
  }

  .insurance-header {
    margin-bottom: 12px;
  }

  .insurance-header h3 {
    margin: 0;
    font-size: 16px;
    color: #fff;
  }

  .insurance-content {
    min-height: 150px;
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

  /* Focused Account View Styles */
  .focused-account-view {
    padding: 20px;
  }

  .account-breadcrumb {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #444;
    font-size: 14px;
  }

  .breadcrumb-back {
    background: #333;
    border: 1px solid #555;
    border-radius: 4px;
    color: #007acc;
    cursor: pointer;
    padding: 6px 10px;
    font-size: 12px;
    transition: all 0.2s ease;
  }

  .breadcrumb-back:hover {
    background: #404040;
    border-color: #007acc;
  }

  .breadcrumb-separator {
    color: #666;
    font-weight: bold;
  }

  .breadcrumb-current {
    color: #d4d4d4;
    font-weight: 500;
  }

  .panel-header-controls {
    display: flex;
    gap: 6px;
  }

  .panel-ai-btn,
  .panel-add-btn,
  .panel-close-btn {
    width: 28px;
    height: 28px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    transition: all 0.15s ease;
  }

  .panel-ai-btn:hover {
    background: #007acc;
    border-color: #007acc;
  }

  .panel-add-btn:hover {
    background: #28a745;
    border-color: #28a745;
  }

  .panel-close-btn:hover {
    background: #dc3545;
    border-color: #dc3545;
    color: white;
  }

  /* Periodic Tasks styling */
  .crontab-section {
    margin: 16px 0;
    padding: 16px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
  }

  .crontab-section h3 {
    margin: 0 0 12px 0;
    font-size: 14px;
    font-weight: 600;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }

  .crontab-timers {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .crontab-task {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .task-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .task-name {
    font-size: 13px;
    color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-weight: 400;
  }

  .task-timer {
    font-size: 12px;
    color: #8b949e;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-weight: 500;
  }

  .task-progress {
    height: 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .task-fill {
    height: 100%;
    background: linear-gradient(90deg, #30d158, #32d366);
    transition: width 0.3s ease;
  }
</style>
