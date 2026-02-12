<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import View from '$lib/view/View.svelte';
  import { appState } from '$lib/stores/appStateStore';
  import { initializeXLN, isLoading, error } from '$lib/stores/xlnStore';
  import { settingsOperations } from '$lib/stores/settingsStore';
  import { tabOperations } from '$lib/stores/tabStore';
  import { timeOperations } from '$lib/stores/timeStore';

  // Parse URL params
  let embedMode = false;
  let scenarioId = '';

  if (browser) {
    const params = new URLSearchParams(window.location.search);
    embedMode = params.get('embed') === '1';
    scenarioId = params.get('scenario') || '';
  }

  // Initialize runtime on mount
  onMount(async () => {
    console.log('🚀 Initializing XLN application in /app...');

    try {
      // Initialize settings first
      settingsOperations.initialize();

      // Load tabs from storage
      tabOperations.loadFromStorage();

      // Initialize default tabs if none exist
      tabOperations.initializeDefaultTabs();

      // Initialize XLN environment (includes history loading)
      await initializeXLN();

      // Initialize time machine
      timeOperations.initialize();

      console.log('✅ XLN application initialized');
    } catch (err) {
      console.error('❌ Failed to initialize XLN:', err);
      error.set((err as Error)?.message || 'Initialization failed');
    }
  });
</script>

<svelte:head>
  <title>xln - {$appState.mode === 'user' ? 'Wallet' : 'Network Workspace'}</title>
</svelte:head>

{#if $isLoading}
  <div class="loading-screen">
    <img src="/img/finis.png" alt="Loading" class="loading-spinner" />
    <p>Loading xln runtime...</p>
  </div>
{:else if $error}
  <div class="error-screen">
    <h2>❌ Initialization Failed</h2>
    <p class="error-msg">{$error}</p>
    <button on:click={() => initializeXLN()}>Retry</button>
  </div>
{:else}
  <!-- View.svelte is base layout for everything -->
  <View
    layout="default"
    networkMode="simnet"
    {embedMode}
    {scenarioId}
    userMode={$appState.mode === 'user'}
  />
{/if}

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
    height: 100vh;
  }

  .loading-screen,
  .error-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: #0a0a0a;
    color: #e8e8e8;
  }

  .loading-spinner {
    width: 320px;
    height: 320px;
    animation: spin 2s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .loading-screen p {
    margin-top: 24px;
    font-size: 18px;
    color: #00d9ff;
  }

  .error-screen {
    gap: 16px;
    padding: 40px;
  }

  .error-screen h2 {
    font-size: 32px;
    color: #ff4444;
  }

  .error-msg {
    font-family: monospace;
    background: rgba(255, 68, 68, 0.1);
    padding: 16px;
    border-radius: 8px;
    border: 1px solid rgba(255, 68, 68, 0.3);
  }

  .error-screen button {
    padding: 12px 32px;
    background: #007acc;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 16px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .error-screen button:hover {
    background: #0086e6;
  }
</style>
