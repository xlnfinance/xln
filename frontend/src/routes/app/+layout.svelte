<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import RuntimeStateCard from '$lib/components/shared/RuntimeStateCard.svelte';
  import { appState } from '$lib/stores/appStateStore';
  import {
    initializeXLN,
    isLoading,
    error,
    suspendClientActivity,
    xlnFunctions
  } from '$lib/stores/xlnStore';
  import { settingsOperations } from '$lib/stores/settingsStore';
  import { tabOperations } from '$lib/stores/tabStore';
  import { timeOperations } from '$lib/stores/timeStore';
  import { vaultOperations } from '$lib/stores/vaultStore';
  import { resetEverything } from '$lib/utils/resetEverything';
  import {
    clearInactiveTabStandby,
    initializeActiveTabLock,
    isInactiveTabStandby
  } from '$lib/utils/activeTabLock';

  let { children } = $props();

  let hasActiveTabLock = $state(false);
  let activeTabLockReady = $state(false);
  let embedBootReady = $state(false);
  let resettingEverything = $state(false);
  let bootGeneration = $state(0);
  let lockTestMode = $state(false);
  let currentHash = $state('');
  const pageSearch = $derived(browser ? $page.url.search : '');
  const DEPLOY_VERSION_KEY = 'xln-deploy-version';

  type DeployVersionPayload = {
    version: string;
  };

  type HashRouteState = {
    route: string;
    params: URLSearchParams;
  };

  function readCurrentHash(): string {
    if (!browser) return '';
    return window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  }

  function parseHashRouteState(rawHash: string): HashRouteState {
    const hash = String(rawHash || '').trim();
    const queryIndex = hash.indexOf('?');
    const route = queryIndex >= 0 ? hash.slice(0, queryIndex).trim().toLowerCase() : hash.trim().toLowerCase();
    const params = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : hash);
    return { route, params };
  }

  function isResetHashActive(): boolean {
    return parseHashRouteState(currentHash).route === 'reset';
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

  async function handleResetEverything(): Promise<void> {
    if (resettingEverything) return;
    const confirmed = window.confirm(
      'Reset ALL local XLN data? Wallets, runtimes, settings, and IndexedDB databases will be deleted.'
    );
    if (!confirmed) return;
    resettingEverything = true;
    try {
      await resetEverything('loading-screen');
    } finally {
      resettingEverything = false;
    }
  }

  function canUseLockTestMode(): boolean {
    if (!browser) return false;
    const hostname = window.location.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  }

  function syncHashLocation(): void {
    if (!browser) return;
    currentHash = readCurrentHash();
  }

  function readStoredDeployVersion(): string {
    if (!browser) return '';
    return String(localStorage.getItem(DEPLOY_VERSION_KEY) || '').trim();
  }

  function persistDeployVersion(version: string): void {
    if (!browser || !version) return;
    localStorage.setItem(DEPLOY_VERSION_KEY, version);
  }

  function parseDeployVersionPayload(payload: unknown): DeployVersionPayload {
    if (!payload || typeof payload !== 'object') {
      throw new Error('INVALID_DEPLOY_VERSION_PAYLOAD');
    }

    const root = payload as Record<string, unknown>;
    const version = String(root.version || '').trim();
    if (!version) {
      throw new Error('MISSING_DEPLOY_VERSION');
    }

    return { version };
  }

  async function fetchCurrentDeployVersion(): Promise<string> {
    const response = await fetch(`/api/jurisdictions?ts=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'cache-control': 'no-cache, no-store, must-revalidate',
        pragma: 'no-cache',
      },
    });
    if (!response.ok) {
      throw new Error(`DEPLOY_VERSION_FETCH_FAILED:${response.status}`);
    }
    const payload = parseDeployVersionPayload(await response.json());
    return payload.version;
  }

  async function ensureCurrentDeployVersion(): Promise<boolean> {
    let currentVersion = '';
    try {
      currentVersion = await fetchCurrentDeployVersion();
    } catch (error) {
      console.warn('[deploy-version] failed to fetch deploy version:', error);
      return false;
    }

    const storedVersion = readStoredDeployVersion();
    if (!storedVersion) {
      persistDeployVersion(currentVersion);
      return false;
    }
    if (storedVersion === currentVersion) return false;

    await resetEverything(`deploy-version-mismatch:${storedVersion}->${currentVersion}`);
    return true;
  }

  $effect(() => {
    if (!browser) return;
    const params = new URLSearchParams(pageSearch);
    lockTestMode = params.get('locktest') === '1' && canUseLockTestMode();
  });

  async function deactivateThisTab(): Promise<void> {
    hasActiveTabLock = false;
    activeTabLockReady = true;
    error.set(null);
    isLoading.set(false);
    bootGeneration += 1;
    try {
      await vaultOperations.suspendAllRuntimeActivity();
      await suspendClientActivity();
    } catch (err) {
      console.warn('Failed to suspend inactive tab activity:', err);
    }
  }

  async function bootApp(): Promise<void> {
    if (!hasActiveTabLock) return;
    const generation = ++bootGeneration;
    embedBootReady = false;
    try {
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      settingsOperations.initialize();
      tabOperations.loadFromStorage();
      tabOperations.initializeDefaultTabs();
      await initializeXLN();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      await vaultOperations.initialize();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      await tick();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      timeOperations.initialize();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      embedBootReady = true;
    } catch (err) {
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      console.error('Failed to initialize XLN:', err);
      error.set((err as Error)?.message || 'Initialization failed');
      embedBootReady = false;
    }
  }

  onMount(() => {
    let disposed = false;
    let releaseLock: (() => void) | null = null;

    const handleLocationChange = () => {
      syncHashLocation();
      void maybeHandleResetHash();
    };

    syncHashLocation();
    window.addEventListener('hashchange', handleLocationChange);

    void (async () => {
      if (await ensureCurrentDeployVersion()) return;
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
      if (lockTestMode) {
        isLoading.set(false);
        error.set(null);
        embedBootReady = true;
        try {
          persistDeployVersion(await fetchCurrentDeployVersion());
        } catch (error) {
          console.warn('[deploy-version] failed to persist deploy version:', error);
        }
        return;
      }
      await bootApp();
      try {
        persistDeployVersion(await fetchCurrentDeployVersion());
      } catch (error) {
        console.warn('[deploy-version] failed to persist deploy version:', error);
      }
    })().catch((err) => {
      if (disposed) return;
      console.error('Failed to initialize active tab lock:', err);
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
  <div class="inactive-tab-screen" data-testid="inactive-tab-screen">
    <h2>Inactive Tab</h2>
    <p>This wallet tab lost the active lock to a newer tab.</p>
    <button
      data-testid="inactive-tab-reload"
      onclick={() => {
        clearInactiveTabStandby();
        window.location.reload();
      }}
    >
      Reload to acquire active lock
    </button>
  </div>
{:else if lockTestMode}
  <main class="app-shell-ready app-shell-ready--empty" data-testid="app-runtime-ready"></main>
{:else if $error}
  <div class="error-screen">
    <h2>❌ Initialization Failed</h2>
    <p class="error-msg">{$error}</p>
    <button onclick={() => initializeXLN()}>Retry</button>
  </div>
{:else if !activeTabLockReady || $isLoading || !$xlnFunctions.isReady}
  <div class="loading-screen" data-testid="app-loading-screen">
    <RuntimeStateCard
      title="Starting XLN"
      description="Restoring local runtime state."
      status="Loading vaults, replicas, and runtime modules"
      actionLabel={resettingEverything ? 'Resetting...' : 'Reset local data'}
      actionDisabled={resettingEverything}
      onAction={handleResetEverything}
      testId="app-loading-card"
    />
  </div>
{:else}
  {@render children?.()}
{/if}

<style>
  .loading-screen,
  .error-screen,
  .inactive-tab-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    background:
      radial-gradient(circle at top, color-mix(in srgb, var(--theme-accent, #facc15) 12%, transparent), transparent 32%),
      radial-gradient(circle at bottom, color-mix(in srgb, var(--theme-accent, #facc15) 7%, transparent), transparent 28%),
      var(--theme-bg-gradient, linear-gradient(180deg, #0d0d10 0%, #09090b 100%));
    color: var(--theme-text-primary, #e8e8e8);
  }

  .app-shell-ready {
    display: contents;
  }

  .error-screen {
    gap: 16px;
    padding: 40px;
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
    padding: 12px 18px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 24%, transparent);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-accent, #facc15) 18%, var(--theme-surface, var(--theme-card-bg, #18181b))),
      color-mix(in srgb, var(--theme-accent, #facc15) 10%, var(--theme-background, #09090b))
    );
    color: color-mix(in srgb, var(--theme-accent, #facc15) 58%, white);
    font-weight: 700;
    cursor: pointer;
  }

  .error-msg {
    max-width: 560px;
    margin: 0;
    color: color-mix(in srgb, var(--theme-danger, #ef4444) 78%, var(--theme-text-primary, white));
    text-align: center;
  }
</style>
