<script lang="ts">
  import { getXLN, xlnEnvironment } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { tabOperations } from '../../stores/tabStore';
  import { THEME_DEFINITIONS } from '../../utils/themes';
  import type { ThemeName } from '../../types';
  import { VERSION } from '../../generated/version';

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
    margin: 0 0 40px 0;
    text-align: center;
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

  .theme-toggle-btn {
    padding: 8px 16px;
    background: rgba(40, 40, 40, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    font-size: 13px;
  }

  .theme-toggle-btn:hover {
    background: rgba(50, 50, 50, 0.8);
    border-color: rgba(0, 122, 204, 0.5);
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
</style>
