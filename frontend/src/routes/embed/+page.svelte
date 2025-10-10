<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import IsolatedScenarioPlayer from '$lib/components/Embed/IsolatedScenarioPlayer.svelte';

  // Parse URL parameters
  let scenario = '';
  let width = '100%';
  let height = '600px';
  let autoplay = true;
  let loop = false;
  let slice = '';
  let speed = 1.0;

  onMount(() => {
    // Parse URL parameters (no global state initialization needed)
    scenario = $page.url.searchParams.get('scenario') || 'phantom-grid';
    width = $page.url.searchParams.get('width') || '100%';
    height = $page.url.searchParams.get('height') || '600px';
    autoplay = $page.url.searchParams.get('autoplay') !== 'false';
    loop = $page.url.searchParams.get('loop') === 'true';
    slice = $page.url.searchParams.get('slice') || '';
    speed = parseFloat($page.url.searchParams.get('speed') || '1.0');
  });
</script>

<div class="embed-page">
  {#if scenario}
    <IsolatedScenarioPlayer
      {scenario}
      {width}
      {height}
      {autoplay}
      {loop}
      {slice}
      {speed}
    />
  {:else}
    <div class="loading">Loading...</div>
  {/if}
</div>

<style>
  .embed-page {
    width: 100vw;
    height: 100vh;
    margin: 0;
    padding: 0;
    background: var(--bg);
  }

  .loading,
  .error {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--text);
  }

  .error {
    color: #ff6b6b;
  }
</style>
