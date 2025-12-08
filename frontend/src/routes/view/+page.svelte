<script>
  /**
   * /view - XLN Panel Workspace
   * Production route for embeddable dashboard
   * Supports ?embed=1 for minimal UI mode (used in /scenarios page)
   * Supports ?scenario=xxx for auto-loading scenarios
   * Supports ?autoplay=1 for auto-running scenario on load
   */
  import { browser } from '$app/environment';
  import View from '$lib/view/View.svelte';

  // Parse URL params
  let embedMode = false;
  let scenarioId = '';
  let autoplay = false;
  if (browser) {
    const params = new URLSearchParams(window.location.search);
    embedMode = params.get('embed') === '1';
    scenarioId = params.get('scenario') || '';
    autoplay = params.get('autoplay') === '1';
  }
</script>

<svelte:head>
  <title>xln - Panel Workspace</title>
</svelte:head>

<View layout="default" networkMode="simnet" {embedMode} {scenarioId} {autoplay} />

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }
</style>
