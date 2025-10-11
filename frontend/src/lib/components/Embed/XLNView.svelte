<script lang="ts">
  /**
   * XLNView - Universal Embeddable XLN Scenario Player
   *
   * Wraps IsolatedScenarioPlayer with view tabs (3D + Panels)
   *
   * Usage:
   *   <XLNView scenario="phantom-grid" />
   *   <XLNView scenario="diamond-dybvig" view="panels" />
   */

  import IsolatedScenarioPlayer from './IsolatedScenarioPlayer.svelte';

  export let scenario: string = 'phantom-grid';
  export let view: '3d' | 'panels' = '3d';
  export let autoplay: boolean = true;
  export let loop: boolean = false;
  export let speed: number = 1.0;
  export let width: string = '100%';
  export let height: string = '600px';

  let currentView: '3d' | 'panels' = view;

  function switchView(newView: '3d' | 'panels') {
    currentView = newView;
  }
</script>

<div class="xlnview" style="width: {width}; height: {height};">
  <!-- View Tabs -->
  <div class="view-tabs">
    <button
      class:active={currentView === '3d'}
      on:click={() => switchView('3d')}
    >
      🗺️ Graph
    </button>
    <button
      class:active={currentView === 'panels'}
      on:click={() => switchView('panels')}
    >
      📊 Panels
    </button>
  </div>

  <!-- View Container -->
  <div class="view-content">
    {#if currentView === '3d'}
      <!-- Use existing IsolatedScenarioPlayer for 3D -->
      <IsolatedScenarioPlayer
        {scenario}
        {autoplay}
        {loop}
        {speed}
        width="100%"
        height="100%"
      />
    {:else}
      <!-- Panels view (TODO: integrate EntityPanel with isolated env) -->
      <div class="panels-placeholder">
        <p>📊 Panels View</p>
        <p>Coming soon: Entity wallet perspective synced to same timeline</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .xlnview {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #000;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .loading, .error {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    flex-direction: column;
    gap: 1rem;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid rgba(255, 255, 255, 0.1);
    border-top-color: #0ea5e9;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .view-tabs {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.9);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .view-tabs button {
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.2s;
    font-size: 0.875rem;
  }

  .view-tabs button:hover {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
  }

  .view-tabs button.active {
    background: #0ea5e9;
    color: #fff;
    border-color: #0ea5e9;
  }

  .view-container {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .panels-view {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .entity-switcher {
    display: flex;
    gap: 0.5rem;
    padding: 1rem;
    flex-wrap: wrap;
    background: rgba(0, 0, 0, 0.5);
  }

  .entity-switcher button {
    padding: 0.25rem 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-size: 0.75rem;
  }

  .entity-switcher button.active {
    background: #0ea5e9;
    border-color: #0ea5e9;
  }

  .time-machine-wrapper {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
  }
</style>
