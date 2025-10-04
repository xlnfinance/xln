<script lang="ts">
  import { getXLN, xlnEnvironment } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { tabOperations } from '../../stores/tabStore';
  import { viewMode, viewModeOperations, type ViewMode } from '../../stores/viewModeStore';

  let showSettingsModal = false;

  const viewTabs: Array<{ mode: ViewMode; icon: string; label: string; title: string }> = [
    { mode: 'home', icon: '🏠', label: 'Home', title: 'XLN Overview' },
    { mode: 'graph3d', icon: '🗺️', label: 'Graph 3D', title: '3D Network Topology' },
    { mode: 'graph2d', icon: '🛰️', label: 'Graph 2D', title: '2D Network Topology' },
    { mode: 'panels', icon: '📊', label: 'Panels', title: 'Entity Panels' },
    { mode: 'terminal', icon: '💻', label: 'Terminal', title: 'Console View' }
  ];

  // Reactive theme icon
  $: themeIcon = $settings.theme === 'dark' ? '🌙' : '☀️';
  $: activeView = $viewMode;

  // J-machine status (derived from environment)
  $: jMachineStatus = (() => {
    if (!$xlnEnvironment) return { block: 0, events: 0, height: 0 };
    // Get max jBlock from all entities instead of server-level tracking
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

  // Event handlers
  async function handleRunDemo() {
    try {
      // Direct XLN call - no wrapper needed
      console.log('🎯 Running XLN demo...');
      const xln = await getXLN();
      const env = $xlnEnvironment || await xln.main();

      console.log('🔍 Environment before demo:', {
        replicas: env?.replicas?.size || 0,
        height: env?.height || 0
      });

      const result = await xln.runDemo(env);

      console.log('🔍 Environment after demo:', {
        replicas: result?.replicas?.size || 0,
        height: result?.height || 0,
        entity1Reserves: result?.replicas?.get('0x0000000000000000000000000000000000000000000000000000000000000001:s1')?.state?.reserves?.size || 0,
        entity2Reserves: result?.replicas?.get('0x0000000000000000000000000000000000000000000000000000000000000002:s2')?.state?.reserves?.size || 0
      });

      if (result?.replicas?.get('0x0000000000000000000000000000000000000000000000000000000000000001:s1')?.state?.reserves) {
        const e1reserves = result.replicas.get('0x0000000000000000000000000000000000000000000000000000000000000001:s1').state.reserves;
        console.log('🔍 Entity 1 reserves after demo:');
        for (const [tokenId, amount] of e1reserves.entries()) {
          console.log(`  Token ${tokenId}: ${amount.toString()}`);
        }
      }

      xlnEnvironment.set(result);
      console.log('✅ Demo completed successfully');
      console.log(`📸 History snapshots: ${result.history.length}`);
      console.log('🔍 Store updated, UI should refresh automatically');
    } catch (error) {
      console.error('❌ Demo failed:', error);
      alert(`Demo failed: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async function handlePrepopulate() {
    try {
      console.log('🌐 Starting XLN Prepopulation...');
      const xln = await getXLN();
      const env = $xlnEnvironment || await xln.main();

      console.log('🔍 Environment before prepopulation:', {
        replicas: env?.replicas?.size || 0,
        height: env?.height || 0
      });

      // Call the prepopulate function with the environment
      await xln.prepopulate(env, xln.processUntilEmpty);

      console.log('🔍 Environment after prepopulation:', {
        replicas: env?.replicas?.size || 0,
        height: env?.height || 0,
        accounts: Array.from(env?.replicas?.values() || [])
          .map((r: any) => r.state?.accounts?.size || 0)
          .reduce((a, b) => a + b, 0)
      });

      // Environment and history are now updated automatically by applyServerInput
      // which calls notifyEnvChange, triggering the registered callback
      // that updates xlnEnvironment store, which in turn updates the derived history store

      console.log('✅ Prepopulation completed successfully');
      console.log('🔍 Store updated, UI should refresh automatically');
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
        
        // Clear all browser storage
        localStorage.clear();
        sessionStorage.clear();
        
        // Clear ALL IndexedDB databases
        if (typeof indexedDB !== 'undefined') {
          // Get all database names dynamically
          let allDatabases: string[] = [];

          // Try modern API first (Chrome 71+)
          if ('databases' in indexedDB) {
            try {
              const dbs = await (indexedDB as any).databases();
              allDatabases = dbs.map((db: any) => db.name);
              console.log(`📋 Found ${allDatabases.length} IndexedDB databases:`, allDatabases);
            } catch (err) {
              console.log('⚠️ Could not enumerate databases, using fallback list');
            }
          }

          // Fallback: known database names from Level.js and our app
          if (allDatabases.length === 0) {
            allDatabases = ['db', 'level-js-db', 'level-db', 'xln-db', '_pouch_db'];
          }

          // Delete all databases
          for (const dbName of allDatabases) {
            try {
              await new Promise<void>((resolve, reject) => {
                const deleteReq = indexedDB.deleteDatabase(dbName);
                deleteReq.onsuccess = () => resolve();
                deleteReq.onerror = () => reject(deleteReq.error);
                deleteReq.onblocked = () => {
                  console.log(`⚠️ Database ${dbName} deletion blocked, forcing...`);
                  resolve(); // Continue anyway
                };
              });
              console.log(`✅ Cleared IndexedDB: ${dbName}`);
            } catch (err) {
              console.log(`⚠️ Could not clear IndexedDB: ${dbName}`, err);
            }
          }
        }
        
        console.log('✅ All storage cleared successfully');
        // Reload the page to reinitialize with clean state
        window.location.reload();
      } catch (error) {
        console.error('❌ Clear database failed:', error);
        alert(`Clear database failed: ${(error as Error)?.message || 'Unknown error'}`);
      }
    }
  }

  function handleCreateEntity() {
    // TODO: Show entity creation modal
    alert('Entity Creator coming soon! Use the Controls section in any panel for now.');
  }


  function handleToggleTheme() {
    settingsOperations.toggleTheme();
  }

  function handleShowSettings() {
    showSettingsModal = true;
  }

  function handleCloseSettings() {
    showSettingsModal = false;
  }

  function handleToggleDropdownMode() {
    settingsOperations.toggleDropdownMode();
  }

  function handleAddPanel() {
    tabOperations.addTab();
  }

  function handleChangeView(mode: ViewMode) {
    if (activeView !== mode) {
      viewModeOperations.set(mode);
    }
  }

  function handleServerDelayChange(event: Event) {
    const target = event.target as HTMLInputElement;
    settingsOperations.setServerDelay(parseInt(target.value));
  }
</script>

<div class="admin-topbar">
  <div class="admin-logo">
    <span class="logo-text">xln</span>
    <div class="view-switcher">
      {#each viewTabs as tab}
        <button
          class="view-switch-btn"
          class:active={activeView === tab.mode}
          on:click={() => handleChangeView(tab.mode)}
          title={tab.title}
        >
          <span class="view-icon">{tab.icon}</span>
          <span class="view-label">{tab.label}</span>
        </button>
      {/each}
    </div>
    </div>
    <button class="settings-btn" on:click={handleShowSettings} title="Settings">
      <span>⚙️</span>
    </button>
  </div>
</div>

<!-- Settings Modal -->
{#if showSettingsModal}
  <div class="modal-overlay" on:click={handleCloseSettings}>
    <div class="modal-content" on:click|stopPropagation>
      <div class="modal-header">
        <h3>⚙️ Settings</h3>
        <button class="modal-close" on:click={handleCloseSettings}>&times;</button>
      </div>
      <div class="modal-body">
        <!-- Admin Actions Section -->
        <div class="setting-group">
          <label><strong>Admin Actions</strong></label>
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
          <label>
            <strong>Network Statistics</strong>
          </label>
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

        <!-- UI Preferences Section -->
        <div class="setting-group">
          <label><strong>UI Preferences</strong></label>

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

          <!-- Theme -->
          <div class="preference-item">
            <span>Theme</span>
            <button class="theme-toggle-btn" on:click={handleToggleTheme}>
              {themeIcon} {$settings.theme === 'dark' ? 'Dark' : 'Light'}
            </button>
          </div>
        </div>

        <!-- Developer Tools Section -->
        <div class="setting-group">
          <label><strong>Developer Tools</strong></label>

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
      </div>
    </div>
  </div>
{/if}

<style>
  .admin-topbar {
    background: rgba(20, 20, 20, 0.95);
    backdrop-filter: blur(20px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .admin-logo {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
  }

  .logo-text {
    font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
    font-size: 20px;
    font-weight: 400;
    color: #ffffff;
    letter-spacing: 0.5px;
    text-transform: lowercase;
  }

  .j-machine-status {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-left: 20px;
    padding-left: 16px;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
  }

  .j-status-item {
    font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
    font-size: 11px;
    color: #aaa;
    background: rgba(0, 122, 204, 0.1);
    border: 1px solid rgba(0, 122, 204, 0.3);
    padding: 4px 8px;
    border-radius: 4px;
    white-space: nowrap;
    transition: all 0.2s ease;
  }

  .j-status-item:hover {
    color: #007acc;
    border-color: #007acc;
    background: rgba(0, 122, 204, 0.2);
  }

  .admin-navigation {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    max-width: 600px;
  }

  .admin-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .admin-btn {
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 6px;
    padding: 8px 10px;
    color: #d4d4d4;
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    height: 36px;
  }

  .admin-btn:hover {
    background: #404040;
    border-color: #007acc;
    color: #007acc;
  }

  /* Settings Modal Styles */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
  }
  
  .modal-content {
    background: #2d2d2d;
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    max-width: 500px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    border: 1px solid #3e3e3e;
  }
  
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px;
    border-bottom: 1px solid #3e3e3e;
  }
  
  .modal-header h3 {
    margin: 0;
    color: #d4d4d4;
  }
  
  .modal-close {
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
    color: #d4d4d4;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .modal-close:hover {
    background-color: #404040;
    border-radius: 50%;
  }
  
  .modal-body {
    padding: 20px;
  }
  
  .setting-group {
    margin-bottom: 25px;
  }
  
  .setting-group label {
    display: block;
    margin-bottom: 10px;
    color: #d4d4d4;
    font-size: 14px;
  }
  
  .setting-group small {
    color: #9d9d9d;
  }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    background: rgba(0, 0, 0, 0.2);
    padding: 12px;
    border-radius: 6px;
    margin-top: 8px;
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
    font-size: 12px;
    color: #9d9d9d;
  }

  .stat-value {
    font-size: 12px;
    font-weight: 600;
    color: #00ff88;
    font-family: 'Courier New', monospace;
  }

  /* Toggle Switch */
  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 60px;
    height: 34px;
    margin: 10px 0;
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
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: #9d9d9d;
    margin-top: 5px;
  }
  
  /* Slider */
  .slider-container {
    margin: 10px 0;
  }
  
  .slider-container input[type="range"] {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: #333;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }
  
  .slider-container input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #007acc;
    cursor: pointer;
  }
  
  .slider-container input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #007acc;
    cursor: pointer;
    border: none;
  }
  
  .slider-value {
    text-align: center;
    margin-top: 8px;
    font-weight: 600;
    color: #d4d4d4;
  }


  /* Global portfolio scale control */
  .scale-control {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: 16px;
  }

  .scale-label {
    font-size: 11px;
    color: #9d9d9d;
    white-space: nowrap;
  }

  .scale-slider {
    width: 80px;
    height: 4px;
    background: #404040;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }

  .scale-slider::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    background: #007acc;
    border-radius: 50%;
    cursor: pointer;
  }

  .scale-slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    background: #007acc;
    border-radius: 50%;
    border: none;
    cursor: pointer;
  }

  /* Liquid Glass Morphism View Switcher */
  .view-switcher {
    display: flex;
    gap: 4px;
    margin-left: 16px;
    padding: 4px;
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow:
      0 4px 24px rgba(0, 0, 0, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .view-switch-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    font-size: 13px;
    font-weight: 500;
    position: relative;
    overflow: hidden;
  }

  .view-switch-btn::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(0, 122, 204, 0) 0%, rgba(0, 122, 204, 0.1) 100%);
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  .view-switch-btn:hover::before {
    opacity: 1;
  }

  .view-switch-btn:hover {
    color: rgba(255, 255, 255, 0.8);
  }

  .view-switch-btn.active {
    background: linear-gradient(135deg, rgba(0, 122, 204, 0.2) 0%, rgba(0, 180, 255, 0.15) 100%);
    color: #00ccff;
    box-shadow:
      0 2px 12px rgba(0, 122, 204, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .view-switch-btn.active::before {
    opacity: 0;
  }

  .view-icon {
    font-size: 16px;
    line-height: 1;
  }

  .view-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }

  /* Settings Button */
  .settings-btn {
    padding: 8px 12px;
    background: rgba(40, 40, 40, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .settings-btn:hover {
    background: rgba(50, 50, 50, 0.9);
    color: #ffffff;
    border-color: rgba(0, 122, 204, 0.5);
  }

  /* Action Buttons in Settings */
  .action-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
  }

  .action-btn {
    padding: 8px 12px;
    background: rgba(0, 122, 204, 0.2);
    border: 1px solid rgba(0, 122, 204, 0.3);
    border-radius: 4px;
    color: #ffffff;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .action-btn:hover {
    background: rgba(0, 122, 204, 0.3);
    border-color: rgba(0, 122, 204, 0.5);
  }

  /* Preference Items */
  .preference-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    font-size: 13px;
  }

  .settings-slider {
    width: 100%;
    margin-top: 8px;
  }

  .theme-toggle-btn {
    padding: 4px 12px;
    background: rgba(40, 40, 40, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    font-size: 12px;
  }
</style>
