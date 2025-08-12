<script lang="ts">
  import { xlnOperations } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { tabOperations } from '../../stores/tabStore';

  let showSettingsModal = false;

  // Reactive theme icon
  $: themeIcon = $settings.theme === 'dark' ? '🌙' : '☀️';

  // Event handlers
  async function handleRunDemo() {
    try {
      await xlnOperations.runDemo();
      console.log('✅ Demo completed successfully');
    } catch (error) {
      console.error('❌ Demo failed:', error);
      alert(`Demo failed: ${error.message}`);
    }
  }

  async function handleClearDatabase() {
    if (confirm('Are you sure you want to clear the database? This will reset all data.')) {
      try {
        await xlnOperations.clearDatabase();
        console.log('✅ Database cleared successfully');
      } catch (error) {
        console.error('❌ Clear database failed:', error);
        alert(`Clear database failed: ${error.message}`);
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

  function handleServerDelayChange(event: Event) {
    const target = event.target as HTMLInputElement;
    settingsOperations.setServerDelay(parseInt(target.value));
  }
</script>

<div class="admin-topbar">
  <div class="admin-logo">
    <span class="logo-text">xln</span>
  </div>
  
  <div class="admin-navigation">
    <!-- Navigation content can be added here -->
  </div>
  
  <div class="admin-controls">
    <button class="admin-btn" on:click={handleRunDemo} title="Run Demo">
      <span>▶️</span>
    </button>
    <button class="admin-btn" on:click={handleClearDatabase} title="Clear Database">
      <span>🗑️</span>
    </button>
    <button class="admin-btn" on:click={handleCreateEntity} title="Create New Entity">
      <span>➕</span>
    </button>
    <button class="admin-btn" on:click={handleAddPanel} title="Add Entity Panel">
      <span>📋</span>
    </button>
    <button class="admin-btn" on:click={handleToggleTheme} title="Toggle theme">
      <span id="theme-icon">{themeIcon}</span>
    </button>
    <button class="admin-btn" on:click={handleShowSettings} title="Settings">
      <span>⚙️</span>
    </button>
    <button class="admin-btn" on:click={handleToggleDropdownMode} title="Toggle Dropdown Mode">
      <span>🔄</span>
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
        <div class="setting-group">
          <label for="dropdownModeToggle">
            <strong>Dropdown Hierarchy Mode</strong>
            <br><small>Toggle between Jurisdiction→Signer→Entity vs Jurisdiction→Entity→Signers</small>
          </label>
          <div class="toggle-switch">
            <input 
              type="checkbox" 
              id="dropdownModeToggle" 
              checked={$settings.dropdownMode === 'entity-first'}
              on:change={handleToggleDropdownMode}
            >
            <span class="toggle-slider"></span>
          </div>
          <div class="toggle-labels">
            <span>Jur→Signer→Entity</span>
            <span>Jur→Entity→Signers</span>
          </div>
        </div>
        
        <div class="setting-group">
          <label for="serverDelaySlider">
            <strong>Server Processing Delay</strong>
            <br><small>Simulate network delay in consensus processing (0ms = instant)</small>
          </label>
          <div class="slider-container">
            <input 
              type="range" 
              id="serverDelaySlider" 
              min="0" 
              max="1000" 
              value={$settings.serverDelay}
              on:input={handleServerDelayChange}
            >
            <div class="slider-value">
              <span>{$settings.serverDelay}</span> ms
            </div>
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
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 1px 0 rgba(255, 255, 255, 0.05) inset;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .admin-logo {
    display: flex;
    align-items: center;
    gap: 12px;
    color: #007acc;
    font-weight: 600;
  }
  
  .logo-text {
    font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
    font-size: 20px;
    font-weight: 400;
    color: #ffffff;
    letter-spacing: 0.5px;
    text-transform: lowercase;
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
</style>
