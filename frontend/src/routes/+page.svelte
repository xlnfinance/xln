<script lang="ts">
  import LandingPage from '../lib/components/Landing/LandingPage.svelte';
  import { goto } from '$app/navigation';
  import { browser } from '$app/env';

  const description = 'Bilateral accounts with signed proofs, collateral-backed settlement, and explicit credit risk.';

  function handleUnlock() {
    // Navigate to /app when user clicks "Launch App"
    if (browser) {
      localStorage.setItem('open', 'true');
      goto('/app');
    }
  }
</script>

<svelte:head>
  <title>xln - cross-local network</title>
  <meta name="description" content={description} />

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://xln.finance/" />
  <meta property="og:title" content="xln - cross-local network" />
  <meta property="og:description" content={description} />
  <meta property="og:image" content="https://xln.finance/img/preview.png" />

  <!-- Twitter -->
  <meta property="twitter:card" content="summary_large_image" />
  <meta property="twitter:url" content="https://xln.finance/" />
  <meta property="twitter:title" content="xln - cross-local network" />
  <meta property="twitter:description" content={description} />
  <meta property="twitter:image" content="https://xln.finance/img/preview.png" />
  <meta property="twitter:site" content="@xlnfinance" />
</svelte:head>

<LandingPage onUnlock={handleUnlock} />

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 50%, #0f0f0f 100%);
    min-height: 100vh;
    color: #e8e8e8;
  }
</style>
