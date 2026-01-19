<script lang="ts">
  /**
   * /app - XLN Application Workspace
   * Toggles between:
   * - User mode: BrainVault interface (wallet creation/management)
   * - Dev mode: Full network view (developer tools)
   */
  import { browser } from '$app/environment';
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

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }
</style>
