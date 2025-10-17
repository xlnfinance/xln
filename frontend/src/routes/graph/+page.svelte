<script lang="ts">
  import Graph3DPanel from '../../lib/view/panels/Graph3DPanel.svelte';

  let zenMode = false;

  function toggleZenMode() {
    zenMode = !zenMode;
  }
</script>

<div class="graph-page">
  <!-- OLD ROUTE DISABLED: <Graph3DPanel {zenMode} hideButton={false} {toggleZenMode} /> -->
  <div class="disabled-message">
    <h2>Graph3D has moved to /view</h2>
    <p>Visit <a href="/view">/view</a> for the new isolated panel workspace.</p>
  </div>
</div>

<style>
  .graph-page {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
</style>
