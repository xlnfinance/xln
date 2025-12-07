<script>
  /**
   * /view - XLN Panel Workspace
   * Production route for embeddable dashboard
   * Supports ?embed=1 for minimal UI mode (used in /scenarios page)
   * Supports ?scenario=xxx for auto-loading scenarios
   */
  import { browser } from '$app/environment';
  import View from '$lib/view/View.svelte';

  // Parse URL params
  let embedMode = false;
  let scenarioId = '';
  if (browser) {
    const params = new URLSearchParams(window.location.search);
    embedMode = params.get('embed') === '1';
    scenarioId = params.get('scenario') || '';
  }
</script>

<svelte:head>
  <title>xln - Panel Workspace</title>
</svelte:head>

<View layout="default" networkMode="simnet" {embedMode} {scenarioId} />

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }
</style>
