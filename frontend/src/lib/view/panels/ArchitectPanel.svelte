<script lang="ts">
  /**
   * Architect Panel - God-mode controls (extracted from NetworkTopology sidebar)
   * 5 modes: Explore, Build, Economy, Governance, Resolve
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  type Mode = 'explore' | 'build' | 'economy' | 'governance' | 'resolve';
  let currentMode: Mode = 'economy';
</script>

<div class="architect-panel">
  <div class="header">
    <h3>🎬 Architect</h3>
  </div>

  <div class="mode-selector">
    <button
      class:active={currentMode === 'explore'}
      on:click={() => currentMode = 'explore'}
    >
      🔍 Explore
    </button>
    <button
      class:active={currentMode === 'build'}
      on:click={() => currentMode = 'build'}
    >
      🏗️ Build
    </button>
    <button
      class:active={currentMode === 'economy'}
      on:click={() => currentMode = 'economy'}
    >
      💰 Economy
    </button>
    <button
      class:active={currentMode === 'governance'}
      on:click={() => currentMode = 'governance'}
    >
      ⚖️ Governance
    </button>
    <button
      class:active={currentMode === 'resolve'}
      on:click={() => currentMode = 'resolve'}
    >
      ⚔️ Resolve
    </button>
  </div>

  <div class="mode-content">
    {#if currentMode === 'economy'}
      <h4>Economy Mode</h4>
      <p>• Mint reserves</p>
      <p>• R2R transfers</p>
      <p>• Run scenarios</p>
      <p>• Batch operations</p>
    {:else if currentMode === 'build'}
      <h4>Build Mode</h4>
      <p>• Create entities</p>
      <p>• Place in 3D</p>
      <p>• Topology patterns</p>
    {:else}
      <h4>{currentMode.charAt(0).toUpperCase() + currentMode.slice(1)} Mode</h4>
      <p>Coming soon...</p>
    {/if}
  </div>
</div>

<style>
  .architect-panel {
    width: 100%;
    height: 100%;
    background: #1e1e1e;
    color: #ccc;
    display: flex;
    flex-direction: column;
  }

  .header {
    padding: 12px;
    background: #2d2d30;
    border-bottom: 2px solid #007acc;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
  }

  .mode-selector {
    display: flex;
    gap: 4px;
    padding: 8px;
    background: #252526;
    border-bottom: 1px solid #3e3e3e;
    flex-wrap: wrap;
  }

  .mode-selector button {
    flex: 1;
    min-width: 80px;
    padding: 8px 12px;
    background: #2d2d30;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  .mode-selector button:hover {
    background: #37373d;
    border-color: #007acc;
  }

  .mode-selector button.active {
    background: #0e639c;
    color: white;
    border-color: #1177bb;
  }

  .mode-content {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }

  .mode-content h4 {
    margin: 0 0 12px 0;
    color: #fff;
    font-size: 13px;
  }

  .mode-content p {
    margin: 8px 0;
    font-size: 12px;
    color: #8b949e;
  }
</style>
