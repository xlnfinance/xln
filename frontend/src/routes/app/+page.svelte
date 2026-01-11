<script lang="ts">
  /**
   * /app - XLN Application Workspace
   * Toggles between:
   * - User mode: BrainVault interface (wallet creation/management)
   * - Dev mode: Full network view (developer tools)
   */
  import { browser } from '$app/environment';
  import BrainVaultView from '$lib/components/Views/BrainVaultView.svelte';
  import View from '$lib/view/View.svelte';
  import { appState, toggleMode } from '$lib/stores/appStateStore';

  // Parse URL params for dev mode
  let embedMode = false;
  let scenarioId = '';
  if (browser) {
    const params = new URLSearchParams(window.location.search);
    embedMode = params.get('embed') === '1';
    scenarioId = params.get('scenario') || '';
  }
</script>

<svelte:head>
  <title>xln - {$appState.mode === 'user' ? 'Wallet' : 'Network Workspace'}</title>
</svelte:head>

<!-- View.svelte is base layout for everything -->
<!-- userMode=true: Simple BrainVault UX (no graph, no time machine) -->
<!-- userMode=false: Full IDE (graph, panels, time machine) -->
<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  {scenarioId}
  userMode={$appState.mode === 'user'}
/>

<!-- Mode Toggle Button (bottom-right) -->
<button
  class="mode-toggle"
  class:active={$appState.mode === 'dev'}
  on:click={() => toggleMode()}
  title="Toggle Dock mode"
>
  Dock
</button>

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }

  .mode-toggle {
    position: fixed;
    bottom: 80px;
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

  .mode-toggle.active {
    background: rgba(168, 85, 247, 0.25);
    border-color: rgba(168, 85, 247, 0.7);
    color: rgba(255, 255, 255, 0.95);
  }
</style>
