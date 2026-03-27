<script lang="ts">
  /**
   * Embed Route - Full XLN Workspace (Embeddable)
   *
   * Uses full View.svelte in dev mode for complete functionality
   * Scenario loading is manual-only from Dock panels.
   */

  import View from '$lib/view/View.svelte';

  let embedMode = true;
</script>

<svelte:head>
  <title>xln - Embedded Workspace</title>
</svelte:head>

<!-- Full dev mode workspace for embeds -->
<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  userMode={false}
/>

<style>
  :global(body) {
    margin: 0;
  }

  /* Hide mode toggle in embed */
  :global(.mode-toggle) {
    display: none !important;
  }
</style>
