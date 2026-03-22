<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from '$app/environment';
  import View from '$lib/view/View.svelte';
  import EmbeddedPayButton from '$lib/components/Embed/EmbeddedPayButton.svelte';
  import { appState } from '$lib/stores/appStateStore';
  import { initializeXLN, isLoading, error, prepareDevSession, suspendClientActivity, xlnFunctions } from '$lib/stores/xlnStore';
  import { settingsOperations } from '$lib/stores/settingsStore';
  import { tabOperations } from '$lib/stores/tabStore';
  import { timeOperations } from '$lib/stores/timeStore';
  import { vaultOperations } from '$lib/stores/vaultStore';
  import { resetEverything } from '$lib/utils/resetEverything';
  import {
    clearInactiveTabStandby,
    initializeActiveTabLock,
    isInactiveTabStandby,
  } from '$lib/utils/activeTabLock';

  let embedMode = false;
  let embeddedPayMode = false;
  let deepLinkedPayRoute = false;
  let hasActiveTabLock = false;
  let activeTabLockReady = false;
  let embedBootReady = false;

  function isResetHashActive(): boolean {
    if (!browser) return false;
    const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const route = rawHash.split('?')[0]?.trim().toLowerCase() || '';
    return route === 'reset';
  }

  async function maybeHandleResetHash(): Promise<boolean> {
    if (!isResetHashActive()) return false;
    const confirmed = window.confirm('reset everything');
    if (confirmed) {
      history.replaceState(null, '', '/app');
      await resetEverything('hash-reset');
      return true;
    }
    history.replaceState(null, '', '/app');
    return false;
  }

  function syncModeFromLocation(): void {
    if (!browser) return;
    const params = new URLSearchParams(window.location.search);
    const hasEmbedQuery = params.get('embed') === '1' || params.has('e');
    embedMode = hasEmbedQuery;
    const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const qIndex = rawHash.indexOf('?');
    const hashRoute = qIndex >= 0 ? rawHash.slice(0, qIndex).trim().toLowerCase() : rawHash.trim().toLowerCase();
    const hashParams = new URLSearchParams(qIndex >= 0 ? rawHash.slice(qIndex + 1) : rawHash);
    deepLinkedPayRoute = hashRoute === 'pay';
    embeddedPayMode =
      hashRoute === 'pay' &&
      (
        hasEmbedQuery ||
        hashParams.get('mode') === 'embed' ||
        hashParams.get('embed') === '1' ||
        hashParams.get('embed') === 'true'
      );
  }

  if (browser) {
    syncModeFromLocation();
  }

  async function deactivateThisTab(): Promise<void> {
    await vaultOperations.suspendAllRuntimeActivity();
    await suspendClientActivity();
    hasActiveTabLock = false;
    activeTabLockReady = true;
    error.set(null);
    isLoading.set(false);
  }

  async function bootApp(): Promise<void> {
    if (!hasActiveTabLock) return;
    embedBootReady = false;
    try {
      console.log('[app.boot] start', { embeddedPayMode });
      await prepareDevSession();
      console.log('[app.boot] prepareDevSession done');

      // Initialize settings first
      settingsOperations.initialize();
      console.log('[app.boot] settings initialized');

      // Load tabs from storage for both normal and embedded pay flows.
      // Embedded pay must resolve the same active entity as the normal app.
      tabOperations.loadFromStorage();
      if (!embeddedPayMode) {
        tabOperations.initializeDefaultTabs();
      }
      console.log('[app.boot] tabs initialized');

      // Initialize XLN environment (includes history loading)
      await initializeXLN();
      console.log('[app.boot] initializeXLN done');

      // Embed pay button still needs an active wallet/runtime loaded from storage.
      await vaultOperations.initialize();
      console.log('[app.boot] vaultOperations.initialize done');
      await tick();
      console.log('[app.boot] store flush done');

      // Initialize time machine
      if (!embeddedPayMode) {
        timeOperations.initialize();
        console.log('[app.boot] time initialized');
      }
      embedBootReady = true;
      console.log('[app.boot] ready', { embeddedPayMode });
    } catch (err) {
      console.error('❌ Failed to initialize XLN:', err);
      error.set((err as Error)?.message || 'Initialization failed');
      embedBootReady = false;
    }
  }

  // Initialize runtime on mount
  onMount(() => {
    let disposed = false;
    let releaseLock: (() => void) | null = null;

    const handleLocationChange = () => {
      syncModeFromLocation();
      void maybeHandleResetHash();
    };
    window.addEventListener('hashchange', handleLocationChange);
    void (async () => {
      if (await maybeHandleResetHash()) return;
      if (isInactiveTabStandby()) {
        hasActiveTabLock = false;
        activeTabLockReady = true;
        isLoading.set(false);
        error.set(null);
        return;
      }
      releaseLock = await initializeActiveTabLock(async () => {
        await deactivateThisTab();
      });
      if (disposed) return;
      hasActiveTabLock = true;
      activeTabLockReady = true;
      await bootApp();
    })().catch((err) => {
      if (disposed) return;
      console.error('❌ Failed to initialize active tab lock:', err);
      error.set((err as Error)?.message || 'Active tab lock initialization failed');
      activeTabLockReady = true;
      hasActiveTabLock = false;
      isLoading.set(false);
    });

    return () => {
      disposed = true;
      window.removeEventListener('hashchange', handleLocationChange);
      releaseLock?.();
    };
  });
</script>

<svelte:head>
  <title>xln - {$appState.mode === 'user' ? 'Wallet' : 'Network Workspace'}</title>
</svelte:head>

{#if activeTabLockReady && !hasActiveTabLock}
  <div class="inactive-tab-screen">
    <h2>Inactive Tab</h2>
    <p>This wallet tab lost the active lock to a newer tab.</p>
    <button
      on:click={() => {
        clearInactiveTabStandby();
        window.location.reload();
      }}
    >
      Reload to acquire active lock
    </button>
  </div>
{:else if embeddedPayMode}
  <div class="embedded-pay-screen">
    <EmbeddedPayButton />
  </div>
{:else if !activeTabLockReady || $isLoading || !$xlnFunctions.isReady}
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
  .error-screen,
  .inactive-tab-screen,
  .embedded-pay-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: var(--theme-bg-gradient, #0a0a0a);
    color: var(--theme-text-primary, #e8e8e8);
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
    color: var(--theme-accent, #00d9ff);
  }

  .error-screen {
    gap: 16px;
    padding: 40px;
  }

  .embedded-pay-screen {
    padding: 0;
    background: transparent;
  }

  .inactive-tab-screen {
    gap: 14px;
    padding: 40px;
    text-align: center;
  }

  .inactive-tab-screen h2 {
    font-size: 32px;
    color: var(--theme-text-primary, #f2e7c8);
    margin: 0;
  }

  .inactive-tab-screen p {
    margin: 0;
    color: var(--theme-text-secondary, rgba(232, 232, 232, 0.72));
    font-size: 16px;
  }

  .inactive-tab-screen button,
  .error-screen button {
    appearance: none;
    border: 1px solid var(--theme-input-border, rgba(217, 179, 58, 0.45));
    background: var(--theme-surface, rgba(38, 30, 18, 0.96));
    color: var(--theme-accent, #f2d37a);
    border-radius: 12px;
    padding: 12px 18px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
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

  .inactive-tab-screen button:hover,
  .error-screen button:hover {
    transform: translateY(-1px);
    border-color: rgba(217, 179, 58, 0.6);
    background: rgba(52, 39, 20, 0.98);
  }
</style>
