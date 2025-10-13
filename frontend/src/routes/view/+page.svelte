<script>
  /**
   * /view - XLN Panel Workspace
   * Production route for embeddable dashboard
   */
  import View from '$lib/view/View.svelte';
</script>

<svelte:head>
  <title>XLN - Panel Workspace</title>
</svelte:head>

<View layout="default" networkMode="simnet" />

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }
</style>
