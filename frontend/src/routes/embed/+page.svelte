<script lang="ts">
  /**
   * Embed Route - Full XLN Workspace (Embeddable)
   *
   * Uses full View.svelte in dev mode for complete functionality
   * Supports scenario parameter for auto-loading
   */

  import { browser } from '$app/environment';
  import View from '$lib/view/View.svelte';

  // Parse URL params
  let embedMode = true;
  let scenarioId = '';

  if (browser) {
    const params = new URLSearchParams(window.location.search);
    scenarioId = params.get('scenario') || params.get('s') || '';
  }
</script>

<svelte:head>
  <title>xln - Embedded Workspace</title>
</svelte:head>

<!-- Full dev mode workspace for embeds -->
<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  {scenarioId}
  userMode={false}
/>

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }

  /* Hide mode toggle in embed */
  :global(.mode-toggle) {
    display: none !important;
  }
</style>
