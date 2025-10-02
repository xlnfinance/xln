<script lang="ts">
  import { onMount } from 'svelte';
  import AdminTopBar from '../lib/components/Layout/AdminTopBar.svelte';
  import TimeMachine from '../lib/components/Layout/TimeMachine.svelte';
  import EntityPanel from '../lib/components/Entity/EntityPanel.svelte';
  import TransactionHistoryIO from '../lib/components/IO/TransactionHistoryIO.svelte';
  import EntityFormation from '../lib/components/Formation/EntityFormation.svelte';
  import JurisdictionStatus from '../lib/components/Jurisdiction/JurisdictionStatus.svelte';
  import NetworkDirectory from '../lib/components/Network/NetworkDirectory.svelte';
  import NetworkTopology from '../lib/components/Network/NetworkTopology.svelte';
  import ErrorDisplay from '../lib/components/Common/ErrorDisplay.svelte';
  import ErrorPopup from '../lib/components/Common/ErrorPopup.svelte';
  import { initializeXLN, isLoading, error } from '../lib/stores/xlnStore';
  import { tabOperations, tabs } from '../lib/stores/tabStore';
  import { settingsOperations } from '../lib/stores/settingsStore';
  import { timeOperations } from '../lib/stores/timeStore';
  import { history } from '../lib/stores/xlnStore';
  import { get } from 'svelte/store';

  let activeTab = 'formation';

  // Load bird view state from localStorage
  function loadBirdViewState(): boolean {
    try {
      const saved = localStorage.getItem('xln-bird-view-settings');
      const settings = saved ? JSON.parse(saved) : null;
      // Default to graph view (true) on first load
      return settings?.wasLastOpened !== undefined ? settings.wasLastOpened : true;
    } catch {
      return true; // Default to graph view
    }
  }

  let birdViewMode = loadBirdViewState();

  // Bird view toggle handler with state persistence
  function toggleBirdView() {
    birdViewMode = !birdViewMode;

    // Save bird view state immediately
    try {
      const settings = JSON.parse(localStorage.getItem('xln-bird-view-settings') || '{}');
      settings.wasLastOpened = birdViewMode;
      localStorage.setItem('xln-bird-view-settings', JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save bird view state:', e);
    }

    console.log('🗺️ Bird view mode:', birdViewMode ? 'ON' : 'OFF');
  }

  // SEQUENTIAL LOADING: Wait for history to be populated
  async function waitForHistoryToLoad(): Promise<void> {
    return new Promise((resolve) => {
      console.log('🔄 SEQUENTIAL-LOAD: Waiting for history to load...');

      // Check immediately first
      const currentHistory = get(history);
      if (currentHistory.length > 0) {
        console.log('🔄 SEQUENTIAL-LOAD: History already loaded!', currentHistory.length);
        resolve();
        return;
      }

      // Wait for history subscription to fire with data
      const unsubscribe = history.subscribe(($history) => {
        console.log('🔄 SEQUENTIAL-LOAD: History subscription fired:', $history.length);
        if ($history.length > 0) {
          console.log('✅ SEQUENTIAL-LOAD: History loaded successfully with', $history.length, 'snapshots');
          unsubscribe();
          resolve();
        }
      });

      // Timeout after 10 seconds to prevent infinite wait
      setTimeout(() => {
        console.warn('⚠️ SEQUENTIAL-LOAD: History load timeout - proceeding anyway');
        unsubscribe();
        resolve();
      }, 10000);
    });
  }

  // Tab switching function
  function switchTab(tabName: string) {
    activeTab = tabName;
  }

  // Initialize the application
  onMount(async () => {
    console.log('🔄 ONMOUNT-DEBUG: +page.svelte onMount() called - this should only happen ONCE');
    console.log('🔍 ONMOUNT-DEBUG: Current timestamp:', new Date().toISOString());

    // Set up global error handlers FIRST
    window.addEventListener('error', (event) => {
      console.error('❌ Global error caught:', event.error);
      const errorMsg = event.error?.message || event.message || 'An unknown error occurred';
      error.set(`${errorMsg} (Source: ${event.filename || 'Unknown'})`);
    });

    window.addEventListener('unhandledrejection', (event) => {
      console.error('❌ Unhandled promise rejection:', event.reason);
      const errorMsg = event.reason?.message || String(event.reason) || 'Unhandled promise rejection';
      error.set(`${errorMsg} (Source: Promise)`);
    });

    try {
      console.log('🚀 Initializing XLN Svelte application...');

      // Initialize settings first
      settingsOperations.initialize();

      // Load tabs from storage
      tabOperations.loadFromStorage();

      // Initialize default tabs if none exist
      tabOperations.initializeDefaultTabs();

      // SEQUENTIAL LOADING: Initialize XLN environment FIRST
      console.log('🔄 SEQUENTIAL-LOAD: Step 1 - Initializing XLN environment...');
      await initializeXLN();

      // SEQUENTIAL LOADING: Wait for history to be populated, then initialize time machine
      console.log('🔄 SEQUENTIAL-LOAD: Step 2 - Waiting for history to be populated...');
      await waitForHistoryToLoad();

      console.log('🔄 SEQUENTIAL-LOAD: Step 3 - Initializing time machine...');
      timeOperations.initialize();

      console.log('✅ XLN Svelte application initialized successfully');
    } catch (err) {
      console.error('❌ Failed to initialize XLN application:', err);
      const errorMsg = (err as Error)?.message || 'Failed to initialize application';
      error.set(`${errorMsg} (Source: Initialization)`);
    }
  });
</script>

<svelte:head>
  <title>XLN Consensus Visual Debug</title>
  <meta name="description" content="XLN Visual Debugger - Real-time consensus monitoring and debugging interface" />
</svelte:head>

<main class="app">
  <AdminTopBar {birdViewMode} onToggleBirdView={toggleBirdView} />
  <ErrorDisplay />

  {#if $isLoading}
    <div class="loading-container">
      <div class="loading-spinner">🔄</div>
      <div class="loading-text">Loading XLN Environment...</div>
    </div>
  {:else if $error}
    <div class="error-container">
      <div class="error-icon">❌</div>
      <div class="error-text">Failed to load XLN Environment</div>
      <div class="error-details">{$error}</div>
      <button class="retry-btn" on:click={() => initializeXLN()}> Retry </button>
    </div>
  {:else}
    {#if birdViewMode}
      <!-- Bird View Mode: Show Network Topology -->
      <NetworkTopology onBirdViewStateChange={(isOpen) => { if (!isOpen) birdViewMode = false; }} />
    {:else}
      <!-- Normal Mode: Show Entity Panels -->
      <div class="main-content">
        <!-- Entity Panels Container -->
        {#if $tabs.length > 0}
          <div class="entity-panels-container" id="entityPanelsContainer" data-panel-count={$tabs.length}>
            {#each $tabs as tab, index (tab.id)}
              <EntityPanel {tab} isLast={index === $tabs.length - 1} />
            {/each}
          </div>
        {/if}
        <!-- Transaction History & I/O Section -->
        <TransactionHistoryIO />

        <!-- Entity Formation/Jurisdictions Tabs -->
        <div class="actionable-tabs-container">
        <div class="tabs-header">
          <button
            class="tab-button"
            class:active={activeTab === 'formation'}
            on:click={() => switchTab('formation')}
            id="formationTab"
          >
            🏗️ Entity Formation
          </button>
          <button
            class="tab-button"
            class:active={activeTab === 'jurisdictions'}
            on:click={() => switchTab('jurisdictions')}
            id="jurisdictionsTab"
          >
            🏛️ Jurisdictions
          </button>
          <button
            class="tab-button"
            class:active={activeTab === 'network'}
            on:click={() => switchTab('network')}
            id="networkTab"
          >
            🌐 Network
          </button>
        </div>

        <div id="formationTabContent" class="tab-content" class:active={activeTab === 'formation'}>
          <EntityFormation />
        </div>

        <div id="jurisdictionsTabContent" class="tab-content" class:active={activeTab === 'jurisdictions'}>
          <JurisdictionStatus />
        </div>

        <div id="networkTabContent" class="tab-content" class:active={activeTab === 'network'}>
          <NetworkDirectory />
          </div>
        </div>
      </div>
    {/if}

    <!-- Time Machine (always visible) -->
    <TimeMachine />

    <!-- Error Popup -->
    <ErrorPopup />
  {/if}
</main>

<style>
  :global(body) {
    font-family:
      'Inter',
      -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      Roboto,
      sans-serif;
    background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 50%, #0f0f0f 100%);
    min-height: 100vh;
    color: #e8e8e8;
    overflow-x: hidden;
    margin: 0;
    padding: 0;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(html) {
    overflow-x: hidden;
  }

  .app {
    width: 100%;
    margin: 0;
    padding: 0;
  }

  .loading-container,
  .error-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    gap: 16px;
  }

  .loading-spinner {
    font-size: 48px;
    animation: spin 2s linear infinite;
  }

  .loading-text {
    font-size: 18px;
    color: #9d9d9d;
  }

  .error-container {
    background: rgba(220, 53, 69, 0.1);
    border: 1px solid rgba(220, 53, 69, 0.3);
    border-radius: 8px;
    padding: 32px;
    margin: 32px;
    max-width: 600px;
    margin-left: auto;
    margin-right: auto;
  }

  .error-icon {
    font-size: 48px;
  }

  .error-text {
    font-size: 20px;
    font-weight: 600;
    color: #dc3545;
  }

  .error-details {
    font-size: 14px;
    color: #9d9d9d;
    font-family: monospace;
    background: rgba(0, 0, 0, 0.3);
    padding: 12px;
    border-radius: 4px;
    margin-top: 12px;
    word-break: break-word;
  }

  .retry-btn {
    background: #007acc;
    color: white;
    border: none;
    padding: 12px 24px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    font-weight: 500;
    transition: background-color 0.2s ease;
    margin-top: 16px;
  }

  .retry-btn:hover {
    background: #0086e6;
  }

  .main-content {
    display: flex;
    flex-direction: column;
    padding-bottom: 70px; /* Make room for time machine */
    min-height: calc(100vh - 60px); /* Ensure full height minus top bar */
  }

  .entity-panels-container {
    display: flex;
    gap: 0;
    padding: 0;
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden; /* Prevent vertical scrolling */
    scrollbar-width: thin;
    scrollbar-color: #666 #2d2d2d;
    margin-bottom: 20px;
    flex-shrink: 0; /* Prevent shrinking */
  }

  .entity-panels-container::-webkit-scrollbar {
    height: 8px;
  }

  .entity-panels-container::-webkit-scrollbar-thumb {
    background: #666;
    border-radius: 4px;
  }

  .entity-panels-container::-webkit-scrollbar-track {
    background: #2d2d2d;
    border-radius: 4px;
  }

  /* Dynamic panel width based on number of panels */
  .entity-panels-container[data-panel-count='1'] {
    justify-content: center;
  }

  .entity-panels-container[data-panel-count='1'] :global(.entity-panel) {
    flex: 0 0 50%;
    min-width: 50%;
    max-width: 50%;
  }

  .entity-panels-container[data-panel-count='2'] :global(.entity-panel) {
    flex: 1;
    min-width: 50%;
  }

  .entity-panels-container[data-panel-count='3'] :global(.entity-panel) {
    flex: 1;
    min-width: 33.333%;
  }

  .entity-panels-container[data-panel-count='4'] :global(.entity-panel),
  .entity-panels-container[data-panel-count='5'] :global(.entity-panel),
  .entity-panels-container[data-panel-count='6'] :global(.entity-panel),
  .entity-panels-container[data-panel-count='7'] :global(.entity-panel),
  .entity-panels-container[data-panel-count='8'] :global(.entity-panel),
  .entity-panels-container[data-panel-count='9'] :global(.entity-panel),
  .entity-panels-container[data-panel-count='10'] :global(.entity-panel) {
    flex: 0 0 25vw;
    min-width: 25vw;
  }


  /* Tabs System */
  .actionable-tabs-container {
    background: #2d2d2d;
    border: 2px solid #007acc;
    border-radius: 8px;
    margin: 20px;
    overflow: hidden;
    z-index: 5;
    position: relative;
  }

  .tabs-header {
    display: flex;
    background: #252526;
    border-bottom: 1px solid #3e3e3e;
  }

  .tab-button {
    flex: 1;
    background: transparent;
    border: none;
    padding: 15px 20px;
    font-size: 0.95em;
    font-weight: 500;
    color: #9d9d9d;
    cursor: pointer;
    transition: all 0.2s ease;
    border-bottom: 2px solid transparent;
  }

  .tab-button:hover {
    background: rgba(0, 122, 204, 0.15);
    color: #007acc;
  }

  .tab-button.active {
    background: #2d2d2d;
    color: #007acc;
    border-bottom: 2px solid #007acc;
  }

  .tab-content {
    display: none;
    padding: 20px;
    animation: fadeIn 0.3s ease;
    background: #2d2d2d;
    color: #d4d4d4;
  }

  .tab-content.active {
    display: block;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
