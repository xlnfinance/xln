<script lang="ts">
  import { onMount } from 'svelte';

  export let scenario: string;
  export let height: string = '600px';
  export let loop: string = '';
  export let camera: string = 'orbital';
  export let controls: boolean = true;

  let loaded = false;
  let error: string | null = null;

  onMount(async () => {
    try {
      // TODO: Load and execute scenario when scenario engine is ready
      // For now, just mark as loaded
      loaded = true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load scenario';
      console.error('XlnScenario error:', err);
    }
  });
</script>

<div class="xln-scenario-wrapper" style="height: {height}">
  {#if error}
    <div class="error-state">
      <p>⚠️ {error}</p>
    </div>
  {:else if loaded}
    <div class="xln-scenario">
      <!-- TODO: Integrate NetworkTopology when ready -->
      <div class="placeholder">
        <p>🎮 Interactive 3D visualization</p>
        <p>Scenario: <code>{scenario}</code></p>
        <small>NetworkTopology integration coming soon</small>
      </div>
    </div>
  {:else}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading scenario...</p>
    </div>
  {/if}
</div>

<style>
  .xln-scenario-wrapper {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin: 1.5rem 0;
    background: var(--bg);
  }

  .xln-scenario {
    width: 100%;
    height: 100%;
  }

  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-state {
    color: #ff6b6b;
  }

  .error-state p {
    margin: 0;
    padding: 1rem;
  }

  .loading-state p {
    margin: 0;
    font-size: 0.875rem;
  }

  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 2rem;
    text-align: center;
  }

  .placeholder p {
    margin: 0.5rem 0;
  }

  .placeholder code {
    background: var(--bg);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
  }

  .placeholder small {
    color: var(--text-secondary);
    margin-top: 1rem;
  }
</style>
