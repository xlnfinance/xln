<script lang="ts">
  import Graph3DPanel from '../../lib/view/panels/Graph3DPanel.svelte';

  let zenMode = false;

  function toggleZenMode() {
    zenMode = !zenMode;
  }
</script>

<div class="graph-page">
  <Graph3DPanel {zenMode} hideButton={false} {toggleZenMode} />
</div>

<style>
  .graph-page {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
</style>
