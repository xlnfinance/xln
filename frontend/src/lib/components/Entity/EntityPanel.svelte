<script lang="ts">
  import { onMount } from 'svelte';
  import type { Tab, EntityReplica } from '../../types';
  import { xlnOperations, replicas } from '../../stores/xlnStore';
  import { visibleReplicas } from '../../stores/timeStore';
  import { tabOperations } from '../../stores/tabStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { XLNServer, escapeHtml } from '../../utils/xlnServer';
  import EntityDropdown from './EntityDropdown.svelte';
  import EntityProfile from './EntityProfile.svelte';
  import ConsensusState from './ConsensusState.svelte';
  import ChatMessages from './ChatMessages.svelte';
  import ProposalsList from './ProposalsList.svelte';
  import TransactionHistory from './TransactionHistory.svelte';
  import ControlsPanel from './ControlsPanel.svelte';

  export let tab: Tab;
  export let isLast: boolean = false;

  let replica: EntityReplica | null = null;
  let showCloseButton = true;

  // Reactive statement to get replica data
  $: {
    if (tab.entityId && tab.signer) {
      // Prefer time-aware replicas if available
      const candidate = $visibleReplicas?.get?.(`${tab.entityId}:${tab.signer}`);
      replica = candidate || xlnOperations.getReplica(tab.entityId, tab.signer);
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

  function toggleComponent(componentId: string) {
    settingsOperations.toggleComponentState(componentId);
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
      style="max-height: 40vh;"
    >
      <TransactionHistory {replica} {tab} />
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

  .entity-history-panel {
    background: #1e1e1e;
  }
</style>
