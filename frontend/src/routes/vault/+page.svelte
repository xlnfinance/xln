<script lang="ts">
  import { onMount } from 'svelte';
  import BrainVaultView from '$lib/components/Views/BrainVaultView.svelte';
  import { showingLandingPage } from '$lib/stores/uiStore';

  // Signal that we're not on landing page so GlobalLanguageSwitcher shows
  onMount(() => {
    showingLandingPage.set(false);
  });
</script>

<svelte:head>
  <title>BrainVault - Memory-Hard Wallet Derivation | xln</title>
  <meta name="description" content="Generate a cryptocurrency wallet from your memory. Sharded argon2id key derivation - secure, deterministic, no seed phrase backup needed." />
</svelte:head>

<!-- BrainVaultView handles its own full-page layout -->
<BrainVaultView />

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background: #0a0a0f;
    overflow-x: hidden;
  }
</style>
