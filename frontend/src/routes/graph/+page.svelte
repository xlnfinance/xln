<script lang="ts">
  import NetworkTopology from '../../lib/components/Network/NetworkTopology.svelte';

  let zenMode = false;

  function toggleZenMode() {
    zenMode = !zenMode;
  }
</script>

<div class="graph-page">
  <NetworkTopology {zenMode} hideButton={false} {toggleZenMode} />
</div>

<style>
  .graph-page {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
</style>
