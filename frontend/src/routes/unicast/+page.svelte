<script lang="ts">
  import BroadcastVsUnicast from '$lib/components/Landing/BroadcastVsUnicast.svelte';
</script>

<svelte:head>
  <title>Why Broadcast Dies at Scale - XLN</title>
  <meta name="description" content="Visual proof of O(n) broadcast bottleneck vs O(1) unicast routing" />
</svelte:head>

<div class="unicast-page">
  <div class="header">
    <h1>Why Broadcast Dies at Scale</h1>
    <p class="subtitle">Visual proof: O(n) broadcast bottleneck vs O(1) unicast routing</p>
    <a href="/" class="back-link">← Back to xln.finance</a>
  </div>

  <div class="visualization-container">
    <BroadcastVsUnicast />
  </div>
</div>

<style>
  .unicast-page {
    min-height: 100vh;
    background: #000;
    color: #fff;
    padding: 2rem;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
  }

  .header {
    max-width: 1200px;
    margin: 0 auto 3rem;
    text-align: center;
  }

  .header h1 {
    font-size: 2.5rem;
    font-weight: 600;
    color: #fff;
    margin: 0 0 1rem;
  }

  .subtitle {
    font-size: 1.1rem;
    color: rgba(255, 255, 255, 0.7);
    margin: 0 0 2rem;
  }

  .back-link {
    display: inline-block;
    color: rgba(255, 255, 255, 0.6);
    text-decoration: none;
    padding: 0.5rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    transition: all 0.2s;
    font-size: 0.9rem;
  }

  .back-link:hover {
    color: #fff;
    border-color: rgba(255, 255, 255, 0.5);
    background: rgba(255, 255, 255, 0.05);
  }

  .visualization-container {
    max-width: 1600px;
    margin: 0 auto;
  }
</style>
