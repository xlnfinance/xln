<script lang="ts">
  import { getXLN, xlnEnvironment, isLoading, error } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { tabOperations } from '../../stores/tabStore';
  import { THEME_DEFINITIONS } from '../../utils/themes';
  import type { ThemeName } from '$lib/types/ui';
  import { VERSION } from '../../generated/version';
  import { errorLog, formatErrorLog } from '../../stores/errorLogStore';

  // Browser capabilities check
  $: browserCapabilities = {
    indexedDB: typeof indexedDB !== 'undefined',
    webGL: (() => {
      try {
        const canvas = document.createElement('canvas');
        return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
      } catch { return false; }
    })(),
    webXR: 'xr' in navigator,
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown'
  };

  // Database health check
  let dbHealth = { available: false, size: 0, location: 'Unknown' };
  async function checkDbHealth() {
    try {
      if (typeof indexedDB !== 'undefined' && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        dbHealth = {
          available: true,
          size: Math.round((estimate.usage || 0) / 1024),
          location: 'IndexedDB (browser)'
        };
      } else {
        dbHealth = { available: false, size: 0, location: 'Unavailable' };
      }
    } catch {
      dbHealth = { available: false, size: 0, location: 'Error checking' };
    }
  }

  // Format error log for textarea
  $: errorLogText = formatErrorLog($errorLog);

  // J-machine status (derived from environment)
  $: jMachineStatus = (() => {
    if (!$xlnEnvironment) return { block: 0, events: 0, height: 0 };
    const maxJBlock = Math.max(0, ...Array.from($xlnEnvironment.replicas?.values() || []).map((r: any) => r.state?.jBlock || 0));
    return {
      block: maxJBlock,
      events: $xlnEnvironment.serverInput?.entityInputs?.length || 0,
      height: $xlnEnvironment.height || 0
    };
  })();

  // J-watcher status with proposer details
  $: jWatcherStatus = (() => {
    if (!$xlnEnvironment) return null;
    try {
      const proposers = Array.from($xlnEnvironment.replicas?.entries() as [string, any][] || [])
        .filter(([, replica]) => replica.isProposer)
        .map(([key, replica]) => {
          const [entityId, signerId] = key.split(':');
          return {
            entityId: entityId?.slice(0,10) + '...' || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })(),
            signerId,
            jBlock: replica.state.jBlock,
          };
        });

      return {
        proposers,
        nextSyncIn: Math.floor((1000 - (Date.now() % 1000)) / 100) / 10,
      };
    } catch (e) {
      return null;
    }
  })();

  // Timer for next sync countdown
  let nextSyncTimer = 0;
  setInterval(() => {
    nextSyncTimer = Math.floor((1000 - (Date.now() % 1000)) / 100) / 10;
  }, 100);

  // RPC endpoint override (for Oculus Quest compatibility)
  const RPC_PRESETS = [
    { label: 'Auto (default)', value: '' },
    { label: 'Path Proxy: /rpc', value: '/rpc' },
    { label: 'Direct Port: :8545', value: ':8545' },
    { label: 'Production Port: :18545', value: ':18545' },
  ];

  let rpcOverride = '';
  let customRpcInput = '';
  let showCustomRpc = false;

  // Load RPC override from localStorage
  onMount(() => {
    const saved = localStorage.getItem('xln_rpc_override');
    if (saved) {
      rpcOverride = saved;
      if (!RPC_PRESETS.find(p => p.value === saved)) {
        customRpcInput = saved;
        showCustomRpc = true;
        rpcOverride = 'custom';
      }
    }
  });

  function handleRpcChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const value = target.value;

    if (value === 'custom') {
      showCustomRpc = true;
      rpcOverride = 'custom';
    } else {
      showCustomRpc = false;
      rpcOverride = value;
      saveAndReconnectRpc(value);
    }
  }

  function handleCustomRpcSubmit() {
    if (customRpcInput) {
      saveAndReconnectRpc(customRpcInput);
    }
  }

  function saveAndReconnectRpc(value: string) {
    localStorage.setItem('xln_rpc_override', value);
    console.log(`🔧 RPC override saved: ${value}`);
    console.log(`🔄 Reloading to apply new RPC configuration...`);
    setTimeout(() => window.location.reload(), 500);
  }

  // Jurisdiction connection status
  let jurisdictionStatus: any = null;
  let statusCheckInterval: any = null;

  async function checkJurisdictionStatus() {
    try {
      const xln = await getXLN();
      const jurisdictions = await xln.getAvailableJurisdictions();

      const status = await Promise.all(jurisdictions.map(async (j: any) => {
        try {
          const { ethers } = await import('ethers');
          const provider = new ethers.JsonRpcProvider(j.address);
          const blockNumber = await Promise.race([
            provider.getBlockNumber(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 2000))
          ]);

          return {
            name: j.name,
            rpcUrl: j.address,
            connected: true,
            lastBlock: blockNumber,
            error: null
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Connection failed';

          // DETAILED ERROR LOGGING FOR OCULUS DEBUGGING
          const debugInfo: any = {
            rpcUrl: j.address,
            jurisdictionName: j.name,
            errorMessage: errorMsg,
            errorType: error?.constructor?.name || typeof error,
            userAgent: navigator.userAgent,
            protocol: window.location.protocol,
            hostname: window.location.hostname,
          };

          // Extract ethers.js specific error details
          if (error && typeof error === 'object') {
            const e = error as any;
            if (e.code) debugInfo.errorCode = e.code;
            if (e.reason) debugInfo.errorReason = e.reason;
            if (e.action) debugInfo.errorAction = e.action;
            if (e.error) debugInfo.nestedError = e.error?.message || String(e.error);
            if (e.stack) debugInfo.stackTrace = e.stack.split('\n').slice(0, 5).join('\n');
          }

          // Log to persistent error store with full details
          errorLog.log(
            `${j.name} RPC connection failed: ${errorMsg}`,
            'Jurisdiction',
            debugInfo
          );

          console.error('🚨 DETAILED RPC ERROR:', debugInfo);

          return {
            name: j.name,
            rpcUrl: j.address,
            connected: false,
            lastBlock: null,
            error: errorMsg
          };
        }
      }));

      jurisdictionStatus = status;
    } catch (error) {
      console.error('Failed to check jurisdiction status:', error);
      jurisdictionStatus = [{
        name: 'Error',
        rpcUrl: 'N/A',
        connected: false,
        lastBlock: null,
        error: error instanceof Error ? error.message : 'Failed to load jurisdictions'
      }];
    }
  }

  // Check status on mount and every 5 seconds
  import { onMount, onDestroy } from 'svelte';
  onMount(() => {
    checkJurisdictionStatus();
    checkDbHealth();
    statusCheckInterval = setInterval(() => {
      checkJurisdictionStatus();
      checkDbHealth();
    }, 5000);
  });

  onDestroy(() => {
    if (statusCheckInterval) clearInterval(statusCheckInterval);
  });

  function handleThemeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    settingsOperations.setTheme(target.value as ThemeName);
  }

  async function handleRunDemo() {
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment || await xln.main();
      const result = await xln.runDemo(env);
      xlnEnvironment.set(result);
    } catch (error) {
      console.error('❌ Demo failed:', error);
      alert(`Demo failed: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async function handlePrepopulate() {
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment || await xln.main();
      await xln.prepopulate(env, xln.processUntilEmpty);
    } catch (error) {
      console.error('❌ Prepopulation failed:', error);
      alert(`Prepopulation failed: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async function handleClearDatabase() {
    if (confirm('Are you sure you want to clear the database? This will reset all data.')) {
      try {
        const xln = await getXLN();
        await xln.clearDatabaseAndHistory();
        localStorage.clear();
        sessionStorage.clear();

        if (typeof indexedDB !== 'undefined') {
          let allDatabases: string[] = [];
          if ('databases' in indexedDB) {
            try {
              const dbs = await (indexedDB as any).databases();
              allDatabases = dbs.map((db: any) => db.name);
            } catch (err) {
              console.log('⚠️ Could not enumerate databases');
            }
          }
          if (allDatabases.length === 0) {
            allDatabases = ['db', 'level-js-db', 'level-db', 'xln-db', '_pouch_db'];
          }
          for (const dbName of allDatabases) {
            try {
              await new Promise<void>((resolve, reject) => {
                const deleteReq = indexedDB.deleteDatabase(dbName);
                deleteReq.onsuccess = () => resolve();
                deleteReq.onerror = () => reject(deleteReq.error);
                deleteReq.onblocked = () => resolve();
              });
            } catch (err) {
              console.log(`⚠️ Could not clear IndexedDB: ${dbName}`);
            }
          }
        }
        window.location.reload();
      } catch (error) {
        console.error('❌ Clear database failed:', error);
        alert(`Clear database failed: ${(error as Error)?.message || 'Unknown error'}`);
      }
    }
  }

  function handleToggleDropdownMode() {
    settingsOperations.toggleDropdownMode();
  }

  function handleAddPanel() {
    tabOperations.addTab();
  }

  function handleServerDelayChange(event: Event) {
    const target = event.target as HTMLInputElement;
    settingsOperations.setServerDelay(parseInt(target.value));
  }
</script>

<div class="settings-container">
  <h1>Settings & Configuration</h1>

  <!-- XLN Initialization Status -->
  {#if $isLoading}
    <div class="init-status loading">
      🔄 XLN Environment loading...
    </div>
  {:else if $error}
    <div class="init-status error">
      ❌ XLN failed to initialize: {$error}
    </div>
  {:else if $xlnEnvironment}
    <div class="init-status success">
      ✅ XLN Environment active (Height: {$xlnEnvironment.height}, Replicas: {$xlnEnvironment.replicas?.size || 0})
    </div>
  {/if}

  <div class="settings-content">
    <!-- Admin Actions Section -->
    <div class="setting-group">
      <h2>Admin Actions</h2>
      <div class="action-buttons">
        <button class="action-btn" on:click={handleRunDemo}>
          <span>▶️</span> Run Demo
        </button>
        <button class="action-btn" on:click={handlePrepopulate}>
          <span>🌐</span> Prepopulate Network
        </button>
        <button class="action-btn" on:click={handleClearDatabase}>
          <span>🗑️</span> Clear Database
        </button>
        <button class="action-btn" on:click={handleAddPanel}>
          <span>📋</span> Add Entity Panel
        </button>
      </div>
    </div>

    <!-- Network Statistics Section -->
    <div class="setting-group">
      <h2>Network Statistics</h2>
      <div class="stats-grid">
        <div class="stat-item">
          <span class="stat-label">J-Block:</span>
          <span class="stat-value">{jMachineStatus.block}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">J-Events:</span>
          <span class="stat-value">{jMachineStatus.events}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">S-Block:</span>
          <span class="stat-value">{jMachineStatus.height}</span>
        </div>
        {#if jWatcherStatus && jWatcherStatus.proposers.length > 0}
          <div class="stat-item stat-full-width">
            <span class="stat-label">Proposers:</span>
            <span class="stat-value">
              {jWatcherStatus.proposers.map((p: any) => `${p.signerId}@${p.jBlock}`).join(', ')}
            </span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Next Sync:</span>
            <span class="stat-value">{nextSyncTimer.toFixed(1)}s</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- RPC Endpoint Override (Oculus Quest Support) -->
    <div class="setting-group">
      <h2>🔌 RPC Endpoint Override</h2>
      <p class="setting-description">
        For Oculus Quest: Use path proxy (/rpc) to avoid HTTPS port issues. Changes auto-reload the page.
      </p>
      <div class="rpc-selector">
        <label for="rpc-preset">RPC Endpoint:</label>
        <select id="rpc-preset" value={rpcOverride} on:change={handleRpcChange}>
          {#each RPC_PRESETS as preset}
            <option value={preset.value}>{preset.label}</option>
          {/each}
          <option value="custom">Custom...</option>
        </select>
      </div>

      {#if showCustomRpc}
        <div class="custom-rpc-input">
          <label for="custom-rpc">Custom RPC:</label>
          <input
            id="custom-rpc"
            type="text"
            bind:value={customRpcInput}
            placeholder="e.g., /rpc/ethereum or :8545"
          />
          <button class="action-btn" on:click={handleCustomRpcSubmit}>
            Apply & Reload
          </button>
        </div>
      {/if}

      {#if rpcOverride}
        <div class="current-override">
          ℹ️ Current override: <code>{rpcOverride === 'custom' ? customRpcInput : rpcOverride}</code>
        </div>
      {/if}
    </div>

    <!-- Jurisdiction Connection Status Section -->
    <div class="setting-group">
      <h2>🌐 Jurisdiction Connection Status</h2>
      {#if jurisdictionStatus === null}
        <div class="connection-status-loading">
          <span>⏳ Checking connections...</span>
        </div>
      {:else}
        <div class="jurisdiction-status-grid">
          {#each jurisdictionStatus as jStatus}
            <div class="jurisdiction-card" class:connected={jStatus.connected} class:disconnected={!jStatus.connected}>
              <div class="jurisdiction-header">
                <span class="jurisdiction-name">{jStatus.name}</span>
                <span class="connection-indicator" class:connected={jStatus.connected}>
                  {jStatus.connected ? '✅ Connected' : '❌ Disconnected'}
                </span>
              </div>
              <div class="jurisdiction-details">
                <div class="detail-row">
                  <span class="detail-label">RPC URL:</span>
                  <span class="detail-value">{jStatus.rpcUrl}</span>
                </div>
                {#if jStatus.connected && jStatus.lastBlock !== null}
                  <div class="detail-row">
                    <span class="detail-label">Latest Block:</span>
                    <span class="detail-value">#{jStatus.lastBlock}</span>
                  </div>
                {:else if jStatus.error}
                  <div class="detail-row error-row">
                    <span class="detail-label">Error:</span>
                    <span class="detail-value">{jStatus.error}</span>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Browser Capabilities Section -->
    <div class="setting-group">
      <h2>🖥️ Browser Capabilities</h2>
      <div class="capabilities-grid">
        <div class="capability-item" class:available={browserCapabilities.indexedDB}>
          <span class="capability-name">IndexedDB:</span>
          <span class="capability-status">{browserCapabilities.indexedDB ? '✅ Available' : '❌ Blocked'}</span>
        </div>
        <div class="capability-item" class:available={browserCapabilities.webGL}>
          <span class="capability-name">WebGL:</span>
          <span class="capability-status">{browserCapabilities.webGL ? '✅ Available' : '❌ Not Available'}</span>
        </div>
        <div class="capability-item" class:available={browserCapabilities.webXR}>
          <span class="capability-name">WebXR:</span>
          <span class="capability-status">{browserCapabilities.webXR ? '✅ Available' : '❌ Not Available'}</span>
        </div>
        <div class="capability-item" class:available={browserCapabilities.secureContext}>
          <span class="capability-name">HTTPS:</span>
          <span class="capability-status">{browserCapabilities.secureContext ? '✅ Secure' : '❌ Insecure'}</span>
        </div>
        <div class="capability-item full-width">
          <span class="capability-name">User Agent:</span>
          <span class="capability-value">{browserCapabilities.userAgent}</span>
        </div>
      </div>
    </div>

    <!-- Database Health Section -->
    <div class="setting-group">
      <h2>💾 Database Health</h2>
      <div class="db-health-grid">
        <div class="health-item">
          <span class="health-label">Status:</span>
          <span class="health-value" class:healthy={dbHealth.available} class:unhealthy={!dbHealth.available}>
            {dbHealth.available ? '✅ Available' : '❌ Unavailable'}
          </span>
        </div>
        <div class="health-item">
          <span class="health-label">Location:</span>
          <span class="health-value">{dbHealth.location}</span>
        </div>
        <div class="health-item">
          <span class="health-label">Size:</span>
          <span class="health-value">{dbHealth.size} KB</span>
        </div>
      </div>
    </div>

    <!-- Persistent Error Log Section -->
    <div class="setting-group">
      <h2>🚨 Error Log</h2>
      <div class="error-log-controls">
        <button class="clear-log-btn" on:click={() => errorLog.clear()}>
          Clear Log
        </button>
        <span class="error-count">{$errorLog.length} errors logged</span>
      </div>
      <textarea></textarea>
        class="error-log-textarea"
        readonly
        value={errorLogText || 'No errors logged yet'}
        placeholder="Error log will appear here..."
      />
    </div>

    <!-- UI Preferences Section -->
    <div class="setting-group">
      <h2>UI Preferences</h2>

      <!-- Dropdown Mode -->
      <div class="preference-item">
        <span>Dropdown Hierarchy</span>
        <div class="toggle-switch">
          <input
            type="checkbox"
            id="dropdownModeToggle"
            checked={$settings.dropdownMode === 'entity-first'}
            on:change={handleToggleDropdownMode}
          />
          <span class="toggle-slider"></span>
        </div>
      </div>
      <div class="toggle-labels">
        <small>Jur→Signer→Entity | Jur→Entity→Signers</small>
      </div>

      <!-- Portfolio Scale -->
      <div class="preference-item">
        <label for="portfolioScaleSlider">Portfolio Bar Scale: ${$settings.portfolioScale.toLocaleString()}</label>
        <input
          type="range"
          id="portfolioScaleSlider"
          min="1000"
          max="10000"
          step="500"
          value={$settings.portfolioScale}
          on:input={(e) => settingsOperations.setPortfolioScale(Number((e.target as HTMLInputElement)?.value || 0))}
          class="settings-slider"
        />
      </div>

      <!-- Theme Selector -->
      <div class="preference-item">
        <label for="themeSelect">Color Scheme</label>
        <select
          id="themeSelect"
          class="theme-select"
          value={$settings.theme}
          on:change={handleThemeChange}
        >
          {#each Object.entries(THEME_DEFINITIONS) as [key, theme]}
            <option value={key}>{theme.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <!-- Developer Tools Section -->
    <div class="setting-group">
      <h2>Developer Tools</h2>

      <div class="preference-item">
        <label for="serverDelaySlider">Server Processing Delay: {$settings.serverDelay}ms</label>
        <input
          type="range"
          id="serverDelaySlider"
          min="0"
          max="1000"
          step="50"
          value={$settings.serverDelay}
          on:input={handleServerDelayChange}
          class="settings-slider"
        />
      </div>
    </div>

    <!-- Build Info Section -->
    <div class="setting-group">
      <h2>Build Info</h2>
      <div class="build-info">
        <div class="build-row">
          <span class="build-label">Commit:</span>
          <a href={VERSION.githubUrl} target="_blank" rel="noopener noreferrer" class="commit-link">
            {VERSION.short} - {VERSION.message.split('\n')[0]}
          </a>
        </div>
        <div class="build-row">
          <span class="build-label">Built:</span>
          <span class="build-value">{new Date(VERSION.buildTime).toLocaleString()}</span>
        </div>
        <div class="build-row">
          <span class="build-label">Branch:</span>
          <span class="build-value">{VERSION.branch}</span>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .settings-container {
    max-width: 900px;
    margin: 60px auto;
    padding: 40px;
    background: rgba(30, 30, 30, 0.8);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  h1 {
    font-size: 32px;
    font-weight: 700;
    color: #00d9ff;
    margin: 0 0 20px 0;
    text-align: center;
  }

  /* Initialization Status */
  .init-status {
    padding: 12px 16px;
    border-radius: 6px;
    margin-bottom: 20px;
    text-align: center;
    font-size: 14px;
    font-weight: 500;
  }

  .init-status.loading {
    background: rgba(255, 193, 7, 0.2);
    border: 1px solid rgba(255, 193, 7, 0.4);
    color: #ffc107;
  }

  .init-status.error {
    background: rgba(255, 76, 76, 0.2);
    border: 1px solid rgba(255, 76, 76, 0.4);
    color: #ff4c4c;
  }

  .init-status.success {
    background: rgba(0, 255, 136, 0.2);
    border: 1px solid rgba(0, 255, 136, 0.4);
    color: #00ff88;
  }

  h2 {
    font-size: 20px;
    color: #ffffff;
    margin: 0 0 16px 0;
    font-weight: 600;
  }

  .settings-content {
    display: flex;
    flex-direction: column;
    gap: 32px;
  }

  .setting-group {
    background: rgba(20, 20, 20, 0.6);
    padding: 24px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  /* Action Buttons */
  .action-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .action-btn {
    padding: 12px 16px;
    background: rgba(0, 122, 204, 0.2);
    border: 1px solid rgba(0, 122, 204, 0.3);
    border-radius: 6px;
    color: #ffffff;
    cursor: pointer;
    font-size: 14px;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .action-btn:hover {
    background: rgba(0, 122, 204, 0.3);
    border-color: rgba(0, 122, 204, 0.5);
  }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    background: rgba(0, 0, 0, 0.3);
    padding: 16px;
    border-radius: 6px;
  }

  .stat-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .stat-full-width {
    grid-column: 1 / -1;
  }

  .stat-label {
    font-size: 13px;
    color: #9d9d9d;
  }

  .stat-value {
    font-size: 13px;
    font-weight: 600;
    color: #00ff88;
    font-family: 'Courier New', monospace;
  }

  /* Jurisdiction Status */
  .connection-status-loading {
    text-align: center;
    padding: 20px;
    color: #9d9d9d;
  }

  .jurisdiction-status-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .jurisdiction-card {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    padding: 16px;
    border: 2px solid rgba(255, 255, 255, 0.05);
  }

  .jurisdiction-card.connected {
    border-color: rgba(0, 255, 136, 0.3);
  }

  .jurisdiction-card.disconnected {
    border-color: rgba(255, 76, 76, 0.3);
  }

  .jurisdiction-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .jurisdiction-name {
    font-size: 16px;
    font-weight: 600;
    color: #00d9ff;
  }

  .connection-indicator {
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    background: rgba(255, 76, 76, 0.2);
    color: #ff4c4c;
  }

  .connection-indicator.connected {
    background: rgba(0, 255, 136, 0.2);
    color: #00ff88;
  }

  .jurisdiction-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
  }

  .detail-label {
    color: #9d9d9d;
  }

  .detail-value {
    color: #d4d4d4;
    font-family: 'Courier New', monospace;
    word-break: break-all;
  }

  .detail-row.error-row .detail-value {
    color: #ff4c4c;
  }

  /* Browser Capabilities */
  .capabilities-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .capability-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .capability-item.full-width {
    grid-column: 1 / -1;
  }

  .capability-name {
    font-size: 13px;
    color: #9d9d9d;
    font-weight: 500;
  }

  .capability-status {
    font-size: 13px;
    font-weight: 600;
  }

  .capability-item.available .capability-status {
    color: #00ff88;
  }

  .capability-item:not(.available) .capability-status {
    color: #ff4c4c;
  }

  .capability-value {
    font-size: 11px;
    color: #999;
    font-family: 'Courier New', monospace;
    word-break: break-all;
  }

  /* Database Health */
  .db-health-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
  }

  .health-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
  }

  .health-label {
    font-size: 12px;
    color: #9d9d9d;
  }

  .health-value {
    font-size: 14px;
    font-weight: 600;
    color: #d4d4d4;
  }

  .health-value.healthy {
    color: #00ff88;
  }

  .health-value.unhealthy {
    color: #ff4c4c;
  }

  /* Error Log */
  .error-log-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .clear-log-btn {
    padding: 6px 12px;
    background: #555;
    border: 1px solid #666;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-size: 13px;
  }

  .clear-log-btn:hover {
    background: #666;
  }

  .error-count {
    font-size: 13px;
    color: #9d9d9d;
  }

  .error-log-textarea {
    width: 100%;
    min-height: 200px;
    max-height: 400px;
    padding: 12px;
    background: #000;
    border: 1px solid #333;
    border-radius: 4px;
    color: #ff4c4c;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    resize: vertical;
    white-space: pre-wrap;
    overflow-y: auto;
  }

  .error-log-textarea::-webkit-scrollbar {
    width: 8px;
  }

  .error-log-textarea::-webkit-scrollbar-track {
    background: #1a1a1a;
  }

  .error-log-textarea::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 4px;
  }

  /* Preference Items */
  .preference-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    font-size: 14px;
  }

  /* Toggle Switch */
  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 60px;
    height: 34px;
  }

  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: #333;
    transition: .4s;
    border-radius: 34px;
  }

  .toggle-slider:before {
    position: absolute;
    content: "";
    height: 26px;
    width: 26px;
    left: 4px;
    bottom: 4px;
    background-color: white;
    transition: .4s;
    border-radius: 50%;
  }

  input:checked + .toggle-slider {
    background-color: #007acc;
  }

  input:checked + .toggle-slider:before {
    transform: translateX(26px);
  }

  .toggle-labels {
    margin-top: 8px;
    font-size: 12px;
    color: #9d9d9d;
  }

  .settings-slider {
    width: 100%;
    margin-top: 8px;
  }



  .theme-select {
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.9);
    cursor: pointer;
    font-size: 13px;
    min-width: 200px;
    transition: all 0.2s;
  }

  .theme-select:hover {
    background: rgba(0, 0, 0, 0.4);
    border-color: rgba(0, 122, 204, 0.5);
  }

  .theme-select:focus {
    outline: none;
    border-color: rgba(0, 122, 204, 0.7);
    box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.1);
  }

  /* Build Info */
  .build-info {
    background: rgba(0, 0, 0, 0.3);
    padding: 16px;
    border-radius: 6px;
    font-family: 'Courier New', monospace;
    font-size: 12px;
  }

  .build-row {
    display: flex;
    gap: 12px;
    padding: 6px 0;
    align-items: baseline;
  }

  .build-label {
    color: rgba(255, 255, 255, 0.5);
    min-width: 60px;
  }

  .build-value {
    color: rgba(255, 255, 255, 0.8);
  }

  .commit-link {
    color: #00d9ff;
    text-decoration: none;
    transition: color 0.2s;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .commit-link:hover {
    color: #00ff88;
    text-decoration: underline;
  }

  /* RPC Selector Styles */
  .setting-description {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 16px;
    line-height: 1.5;
  }

  .rpc-selector {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .rpc-selector label {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.8);
    min-width: 120px;
  }

  .rpc-selector select {
    flex: 1;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #fff;
    font-size: 14px;
    cursor: pointer;
  }

  .rpc-selector select:hover {
    border-color: rgba(0, 217, 255, 0.4);
  }

  .custom-rpc-input {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 6px;
    border: 1px solid rgba(255, 193, 7, 0.3);
  }

  .custom-rpc-input label {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.7);
    min-width: 90px;
  }

  .custom-rpc-input input {
    flex: 1;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #fff;
    font-family: 'Courier New', monospace;
    font-size: 13px;
  }

  .custom-rpc-input input:focus {
    outline: none;
    border-color: rgba(0, 217, 255, 0.6);
  }

  .current-override {
    margin-top: 8px;
    padding: 8px 12px;
    background: rgba(0, 217, 255, 0.1);
    border: 1px solid rgba(0, 217, 255, 0.3);
    border-radius: 4px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
  }

  .current-override code {
    background: rgba(0, 0, 0, 0.6);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: 'Courier New', monospace;
    color: #00d9ff;
  }
</style>
