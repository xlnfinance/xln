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
  import ScenarioPanel from '../lib/components/Scenario/ScenarioPanel.svelte';
  import AdminPanel from '../lib/components/Admin/AdminPanel.svelte';
  import BrainVaultView from '../lib/components/Views/BrainVaultView.svelte';
  import SettingsView from '../lib/components/Views/SettingsView.svelte';
  import DocsView from '../lib/components/Views/DocsView.svelte';
  import TerminalView from '../lib/components/Views/TerminalView.svelte';
  import InvariantTicker from '../lib/components/Home/InvariantTicker.svelte';
  import { initializeXLN, isLoading, error, replicas } from '../lib/stores/xlnStore';
  import { tabOperations, tabs } from '../lib/stores/tabStore';
  import { settingsOperations } from '../lib/stores/settingsStore';
  import { timeOperations } from '../lib/stores/timeStore';
  import { history } from '../lib/stores/xlnStore';
  import { viewMode } from '../lib/stores/viewModeStore';
  import { get } from 'svelte/store';

  let activeTab = 'formation';
  let zenMode = false; // Zen mode: hide UI chrome
  let hideButton = false; // Full zen: also hide the toggle button

  // Keyboard shortcut for zen mode
  function handleKeyboard(event: KeyboardEvent) {
    if (event.key === 'z' || event.key === 'Z') {
      toggleFullZen();
    }
  }

  // Full zen mode (Z key) - hide everything including button
  function toggleFullZen() {
    zenMode = !zenMode;
    hideButton = !hideButton;
  }

  // Button-triggered zen - hide UI but keep button visible for mobile
  function toggleZenMode() {
    zenMode = !zenMode;
    hideButton = false; // Always keep button visible when using button
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

    // Add keyboard listener for zen mode
    window.addEventListener('keydown', handleKeyboard);

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

      // Auto-open first entity panel if none exist
      const currentTabs = get(tabs);
      const currentReplicas = get(replicas);
      if (currentTabs.length === 0 && currentReplicas && currentReplicas.size > 0) {
        const firstReplicaKey = Array.from(currentReplicas.keys())[0];
        if (firstReplicaKey && typeof firstReplicaKey === 'string') {
          const firstEntityId = firstReplicaKey.split(':')[0];
          if (firstEntityId) {
            console.log(`📋 Auto-opening panel for first entity: ${firstEntityId.slice(0,10)}...`);
            tabOperations.addTab(firstEntityId);
          }
        }
      }

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

<main class="app" class:zen-mode={zenMode}>
  {#if !zenMode}
    <AdminTopBar />
  {/if}
  <ErrorDisplay />

  {#if $isLoading && $viewMode !== 'settings'}
    <div class="loading-container">
      <div class="loading-spinner">🔄</div>
      <div class="loading-text">Loading XLN Environment...</div>
    </div>
  {:else if $error && $viewMode !== 'settings'}
    <div class="error-container">
      <div class="error-icon">❌</div>
      <div class="error-text">Failed to load XLN Environment</div>
      <div class="error-details">{$error}</div>
      <button class="retry-btn" on:click={() => initializeXLN()}> Retry </button>
      <button class="settings-btn" on:click={() => viewMode.set('settings')}>
        ⚙️ Open Settings
      </button>
    </div>
  {:else if $viewMode === 'settings'}
    <!-- Settings always accessible, even during errors -->
    <SettingsView />
  {:else}
    {#if $viewMode === 'home'}
      <!-- Home View: Whitepaper & Introduction -->
      <div class="home-container">
        <h1>xln</h1>
        <p class="subtitle">Reserve-Credit Provable Account Network</p>

        <div class="whitepaper-content">
          <h2>The Problem</h2>
          <p>For centuries, finance ran on <strong>FCUAN</strong> (Full-Credit Unprovable Account Networks): traditional banking, CEXs, brokers. Pure credit scales phenomenally but offers weak security—assets can be seized, hubs can default.</p>

          <p>In 2017, Lightning introduced <strong>FRPAP</strong> (Full-Reserve Provable Account Primitives): payment channels with cryptographic proofs. Full security but hits the <em>inbound liquidity wall</em>—an architectural limit, not a bug.</p>

          <h2>The Solution</h2>
          <p><strong>xln</strong> is the first <strong>RCPAN</strong> (Reserve-Credit Provable Account Network): credit where it scales, collateral where it secures. A principled hybrid.</p>

          <div class="invariant-box">
            <InvariantTicker
              label="FCUAN"
              description="−leftCredit ≤ Δ ≤ rightCredit"
              pattern="[---.---]"
            />
            <InvariantTicker
              label="FRPAP"
              description="0 ≤ Δ ≤ collateral"
              pattern="[.===]"
            />
            <InvariantTicker
              label="RCPAN"
              description="−leftCredit ≤ Δ ≤ collateral + rightCredit"
              pattern="[---.===---]"
            />
          </div>

          <h2>Key Properties</h2>
          <ul>
            <li>Infinite scalability: O(1) per-hop updates vs O(n) broadcast</li>
            <li>No inbound liquidity problem: credit + collateral hybrid</li>
            <li>Bounded risk: counterparty loss capped at collateral + credit</li>
            <li>Local state: no sequencers, no data availability dependencies</li>
          </ul>

          <h2>Interactive Tutorials</h2>
          <p>Click "Graph 3D" above, then select a scenario from the sidebar:</p>

          <div class="tutorial-grid">
            <div class="tutorial-item">
              <strong>1. H-Network (Default)</strong>
              <p>Basic topology: 2 hubs, 4 users</p>
            </div>
            <div class="tutorial-item">
              <strong>2. Diamond-Dybvig Bank Run</strong>
              <p>Fractional reserve instability demonstration</p>
            </div>
            <div class="tutorial-item">
              <strong>3. Lightning Inbound Capacity Problem</strong>
              <p>Why full-reserve hits liquidity walls</p>
            </div>
            <div class="tutorial-item">
              <strong>4. Credit Line Expansion</strong>
              <p>FCUAN-style trust-based scaling</p>
            </div>
            <div class="tutorial-item">
              <strong>5. Collateral Backstop</strong>
              <p>How reserves limit counterparty risk</p>
            </div>
            <div class="tutorial-item">
              <strong>6. Multi-Hop Routing</strong>
              <p>Payment paths through network topology</p>
            </div>
            <div class="tutorial-item">
              <strong>7. Hub Liquidity Crisis</strong>
              <p>Cascading failures in hub-spoke networks</p>
            </div>
            <div class="tutorial-item">
              <strong>8. Bilateral Settlement</strong>
              <p>Netting and on-chain finalization</p>
            </div>
            <div class="tutorial-item">
              <strong>9. Credit-Collateral Rebalancing</strong>
              <p>Dynamic adjustment of risk parameters</p>
            </div>
            <div class="tutorial-item">
              <strong>10. Multi-Jurisdiction Flow</strong>
              <p>Cross-chain settlement coordination</p>
            </div>
          </div>

          <h2>Get Started</h2>
          <p>Click "Graph 3D" to explore the network, or "Panels" to manage entities directly. Use the time machine to replay any state transition.</p>
        </div>
      </div>
    {:else if $viewMode === 'docs'}
      <!-- Docs View: Documentation -->
      <DocsView />
    {:else if $viewMode === 'brainvault'}
      <!-- BrainVault View: Wallet Generator -->
      <BrainVaultView />
    {:else if $viewMode === 'graph3d' || $viewMode === 'graph2d'}
      <!-- Graph View Mode: Show Network Topology -->
      <NetworkTopology {zenMode} {hideButton} {toggleZenMode} />
    {:else if $viewMode === 'terminal'}
      <!-- Terminal View: Command Interface -->
      <TerminalView />
    {:else if $viewMode === 'panels'}
      <!-- Panels Mode: Show Entity Panels -->
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
          <button
            class="tab-button"
            class:active={activeTab === 'scenarios'}
            on:click={() => switchTab('scenarios')}
            id="scenariosTab"
          >
            🎬 Scenarios
          </button>
          <button
            class="tab-button"
            class:active={activeTab === 'admin'}
            on:click={() => switchTab('admin')}
            id="adminTab"
          >
            🔧 Admin
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

        <div id="scenariosTabContent" class="tab-content" class:active={activeTab === 'scenarios'}>
          <ScenarioPanel />
        </div>

        <div id="adminTabContent" class="tab-content" class:active={activeTab === 'admin'}>
          <AdminPanel />
        </div>
        </div>
      </div>
    {/if}

    <!-- Time Machine (hidden in zen mode, home view, docs, terminal, and brainvault view) -->
    {#if !zenMode && $viewMode !== 'home' && $viewMode !== 'docs' && $viewMode !== 'terminal' && $viewMode !== 'brainvault'}
      <TimeMachine />
    {/if}

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
    background: var(--theme-bg-gradient, linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 50%, #0f0f0f 100%));
    min-height: 100vh;
    color: var(--theme-text-primary, #e8e8e8);
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

  .retry-btn,
  .settings-btn {
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
    margin-right: 12px;
  }

  .retry-btn:hover,
  .settings-btn:hover {
    background: #0086e6;
  }

  .settings-btn {
    background: #555;
  }

  .settings-btn:hover {
    background: #666;
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

  /* Zen Mode - Complete UI immersion */
  .app.zen-mode {
    /* Full screen, no chrome */
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  .app.zen-mode :global(.network-topology-container) {
    /* Graph fills entire viewport in zen mode */
    width: 100vw !important;
    height: 100vh !important;
    top: 0 !important;
  }

  .app.zen-mode :global(.admin-topbar),
  .app.zen-mode :global(.time-machine),
  .app.zen-mode :global(.topology-overlay),
  .app.zen-mode :global(.error-display) {
    display: none !important;
  }

  /* Button visibility controlled by hideButton prop, NOT zen-mode CSS */

  /* Home Page */
  .home-container {
    max-width: 900px;
    margin: 60px auto;
    padding: 40px;
    background: rgba(30, 30, 30, 0.8);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .home-container h1 {
    font-size: 48px;
    font-weight: 700;
    color: #00d9ff;
    margin: 0 0 12px 0;
    text-align: center;
    text-shadow: 0 0 30px rgba(0, 217, 255, 0.5);
  }

  .home-container .subtitle {
    font-size: 18px;
    color: rgba(255, 255, 255, 0.7);
    text-align: center;
    margin: 0 0 40px 0;
  }

  .whitepaper-content h2 {
    font-size: 24px;
    color: #ffffff;
    margin: 32px 0 16px 0;
    font-weight: 600;
  }

  .whitepaper-content p {
    font-size: 16px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.85);
    margin: 0 0 16px 0;
  }

  .whitepaper-content ul {
    list-style: none;
    padding: 0;
    margin: 16px 0;
  }

  .whitepaper-content li {
    font-size: 16px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.85);
    margin: 8px 0;
    padding-left: 24px;
    position: relative;
  }

  .whitepaper-content li:before {
    content: '▸';
    position: absolute;
    left: 0;
    color: #00ff88;
  }

  .invariant-box {
    background: rgba(0, 122, 204, 0.1);
    border-left: 3px solid #007acc;
    padding: 16px 20px;
    margin: 24px 0;
    font-family: 'Courier New', monospace;
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .invariant-box :global(.header strong) {
    color: #00d9ff;
  }

  .tutorial-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 16px;
    margin: 24px 0;
  }

  .tutorial-item {
    background: rgba(40, 40, 40, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 16px;
    transition: all 0.2s ease;
  }

  .tutorial-item:hover {
    background: rgba(50, 50, 50, 0.8);
    border-color: rgba(0, 122, 204, 0.5);
    transform: translateY(-2px);
  }

  .tutorial-item strong {
    display: block;
    color: #00d9ff;
    margin-bottom: 8px;
    font-size: 14px;
  }

  .tutorial-item p {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.7);
    margin: 0;
    line-height: 1.5;
  }
</style>
