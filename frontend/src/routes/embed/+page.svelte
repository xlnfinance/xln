<script lang="ts">
  /**
   * Embed Route - Full XLN Graph 3D View (Embeddable)
   *
   * Reuses NetworkTopology.svelte (6159 lines) - don't reinvent
   * Just hides nav bar for iframe embedding
   */

  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import NetworkTopology from '$lib/components/Network/NetworkTopology.svelte';

  let scenario = 'phantom-grid';
  let isolatedEnv: any = null;
  let isolatedHistory: any[] = [];

  onMount(async () => {
    scenario = $page.url.searchParams.get('s') || $page.url.searchParams.get('scenario') || 'phantom-grid';

    // Load scenario into isolated env
    const runtimeUrl = new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href;
    const XLN = await import(/* @vite-ignore */ runtimeUrl);

    isolatedEnv = XLN.createEmptyEnv();

    // Load scenario
    const scenarioText = await fetch(`/scenarios/${scenario}.scenario.txt`).then(r => r.text());
    const parsed = await XLN.parseScenario(scenarioText);

    // Execute to populate env
    const context = { entityMapping: new Map() };
    await XLN.executeScenario(parsed, isolatedEnv, context);

    isolatedHistory = [...isolatedEnv.history];
  });
</script>

<!-- Full NetworkTopology with isolated env -->
<div class="embed-page">
  {#if isolatedEnv}
    <NetworkTopology
      {isolatedEnv}
      {isolatedHistory}
      embedded={true}
    />
  {:else}
    <div class="loading">Loading scenario...</div>
  {/if}
</div>

<style>
  .embed-page {
    width: 100vw;
    height: 100vh;
    margin: 0;
    padding: 0;
    background: #000;
    overflow: hidden;
  }

  /* Hide nav bar in embed mode */
  :global(.nav-bar) {
    display: none !important;
  }
</style>
