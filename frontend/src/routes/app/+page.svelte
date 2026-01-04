<script lang="ts">
  /**
   * /app - XLN Application Workspace
   * User mode: Simple single-entity view (consumer-focused)
   * Dev mode: Full network graph + multi-panel inspection
   *
   * Both modes share same runtime state (critical for consistency)
   * Supports ?embed=1 for minimal UI mode
   */
  import { browser } from '$app/environment';
  import View from '$lib/view/View.svelte';
  import { appMode, toggleMode } from '$lib/stores/modeStore';

  // Parse URL params
  let embedMode = false;
  let scenarioId = '';
  if (browser) {
    const params = new URLSearchParams(window.location.search);
    embedMode = params.get('embed') === '1';
    // Don't auto-load scenario for main app (only if explicitly specified)
    scenarioId = params.get('scenario') || '';
  }
</script>

<svelte:head>
  <title>xln - {$appMode === 'user' ? 'Wallet' : 'Network Workspace'}</title>
</svelte:head>

<!-- Always use View.svelte (shares runtime state), just pass mode -->
<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  {scenarioId}
  userMode={$appMode === 'user'}
/>

<!-- Mode Toggle Button (bottom-right) -->
<button
  class="mode-toggle"
  on:click={() => toggleMode()}
  title="Switch to {$appMode === 'user' ? 'developer' : 'user'} mode"
>
  {$appMode === 'user' ? 'Dev' : 'User'}
</button>

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }

  .mode-toggle {
    position: fixed;
    bottom: 16px;
    right: 16px;
    background: rgba(168, 85, 247, 0.1);
    border: 1px solid rgba(168, 85, 247, 0.3);
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 11px;
    font-family: 'SF Mono', monospace;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    backdrop-filter: blur(8px);
    transition: all 0.2s;
    z-index: 9999;
  }

  .mode-toggle:hover {
    background: rgba(168, 85, 247, 0.2);
    border-color: rgba(168, 85, 247, 0.5);
  }
</style>
