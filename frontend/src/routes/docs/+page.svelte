<script lang="ts">
  import DocsView from '$lib/components/Views/DocsView.svelte';
</script>

<svelte:head>
  <title>Documentation | xln</title>
  <meta name="description" content="xln technical documentation - JEA model, payment spec, architecture guides" />
</svelte:head>

<div class="docs-page">
  <DocsView />
</div>

<style>
  .docs-page {
    min-height: 100vh;
    background: #0a0a0a;
  }
</style>
