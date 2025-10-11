<script>
  /**
   * XLNView Demo Route
   * Test the new panel workspace
   */
  import XLNView from '../../../../view/XLNView.svelte';
</script>

<svelte:head>
  <title>XLNView Demo - Panel Workspace</title>
</svelte:head>

<XLNView layout="default" networkMode="simnet" />

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }
</style>
