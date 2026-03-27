<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import EmbeddedPayButton from '$lib/components/Embed/EmbeddedPayButton.svelte';
  import { appState } from '$lib/stores/appStateStore';
  import {
    initializeXLN,
    isLoading,
    error,
    prepareDevSession,
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

  let embeddedPayMode = $state(false);
  let hasActiveTabLock = $state(false);
  let activeTabLockReady = $state(false);
  let embedBootReady = $state(false);
  let resettingEverything = $state(false);
  let bootGeneration = $state(0);
  let lockTestMode = $state(false);
  let currentHash = $state('');
  const pageSearch = $derived(browser ? $page.url.search : '');

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

  function hasLegacyEmbedQuery(search: string): boolean {
    const params = new URLSearchParams(search);
    return params.get('embed') === '1' || params.has('e');
  }

  function isEmbeddedPayRoute(state: HashRouteState, search: string): boolean {
    if (state.route !== 'pay') return false;
    return hasLegacyEmbedQuery(search)
      || state.params.get('mode') === 'embed'
      || state.params.get('embed') === '1'
      || state.params.get('embed') === 'true';
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

  $effect(() => {
    if (!browser) return;
    const params = new URLSearchParams(pageSearch);
    lockTestMode = params.get('locktest') === '1' && canUseLockTestMode();
  });

  $effect(() => {
    if (!browser) return;
    const hashState = parseHashRouteState(currentHash);
    embeddedPayMode = isEmbeddedPayRoute(hashState, pageSearch);
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
      await prepareDevSession();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      settingsOperations.initialize();
      tabOperations.loadFromStorage();
      if (!embeddedPayMode) {
        tabOperations.initializeDefaultTabs();
      }
      await initializeXLN();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      await vaultOperations.initialize();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      await tick();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      if (!embeddedPayMode) {
        timeOperations.initialize();
      }
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
        return;
      }
      await bootApp();
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
{:else if lockTestMode}
  <main class="app-shell-ready app-shell-ready--empty" data-testid="app-runtime-ready"></main>
{:else if $error}
  <div class="error-screen">
    <h2>❌ Initialization Failed</h2>
    <p class="error-msg">{$error}</p>
    <button on:click={() => initializeXLN()}>Retry</button>
  </div>
{:else if !activeTabLockReady || $isLoading || !$xlnFunctions.isReady}
  <div class="loading-screen" data-testid="app-loading-screen">
    <div class="loading-shell">
      <div class="loading-mark">
        <div class="loading-halo"></div>
        <img src="/img/finis.png" alt="XLN Runtime" class="loading-emblem" />
      </div>
      <div class="loading-copy">
        <span class="loading-kicker">Secure Local Runtime</span>
        <h1>Booting XLN</h1>
        <p>Restoring vaults, ledgers, replicas, and local chain state.</p>
      </div>
      <div class="loading-status">
        <span class="loading-dot"></span>
        <span>Loading runtime modules and persistent state</span>
      </div>
      <div class="loading-actions">
        <button class="loading-reset" type="button" on:click={handleResetEverything} disabled={resettingEverything}>
          {resettingEverything ? 'Resetting...' : 'Reset Everything'}
        </button>
      </div>
    </div>
  </div>
{:else}
  {@render children?.()}
{/if}

<style>
  .loading-screen,
  .error-screen,
  .inactive-tab-screen,
  .embedded-pay-screen {
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

  .loading-shell {
    width: min(420px, calc(100vw - 40px));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    padding: 36px 28px 30px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 18%, transparent);
    border-radius: 28px;
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--theme-surface, var(--theme-card-bg, #18181b)) 94%, var(--theme-background, #09090b)),
        color-mix(in srgb, var(--theme-background, #09090b) 96%, black)
      );
    box-shadow:
      0 28px 80px color-mix(in srgb, black 42%, transparent),
      inset 0 1px 0 color-mix(in srgb, var(--theme-text-primary, white) 4%, transparent);
  }

  .loading-mark {
    position: relative;
    width: 196px;
    height: 196px;
    display: grid;
    place-items: center;
  }

  .loading-halo {
    position: absolute;
    inset: 20px;
    border-radius: 999px;
    background: radial-gradient(circle, color-mix(in srgb, var(--theme-accent, #facc15) 16%, transparent), transparent 70%);
    filter: blur(10px);
    animation: pulse 2.8s ease-in-out infinite;
  }

  .loading-emblem {
    position: relative;
    width: 172px;
    height: 172px;
    object-fit: contain;
    filter: drop-shadow(0 18px 34px rgba(0, 0, 0, 0.42));
    animation: drift 4.8s ease-in-out infinite;
  }

  .loading-copy {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }

  .loading-kicker {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--theme-accent, #facc15) 76%, var(--theme-text-primary, white));
  }

  .loading-copy h1 {
    margin: 0;
    font-size: clamp(28px, 4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.03em;
    color: var(--theme-text-primary, #fafaf9);
  }

  .loading-copy p {
    margin: 0;
    max-width: 32ch;
    font-size: 14px;
    line-height: 1.55;
    color: color-mix(in srgb, var(--theme-text-secondary, #a1a1aa) 88%, transparent);
  }

  .loading-status {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--theme-surface, var(--theme-card-bg, #18181b)) 70%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.12)) 72%, transparent);
    color: color-mix(in srgb, var(--theme-text-secondary, #a1a1aa) 88%, transparent);
    font-size: 12px;
  }

  .loading-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--theme-accent, #facc15);
    box-shadow: 0 0 14px color-mix(in srgb, var(--theme-accent, #facc15) 66%, transparent);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .loading-actions {
    display: flex;
    justify-content: center;
    width: 100%;
  }

  .loading-reset {
    padding: 10px 14px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--theme-danger, #ef4444) 24%, transparent);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-danger, #ef4444) 18%, var(--theme-surface, var(--theme-card-bg, #18181b))),
      color-mix(in srgb, var(--theme-danger, #ef4444) 10%, var(--theme-background, #09090b))
    );
    color: color-mix(in srgb, var(--theme-danger, #ef4444) 62%, white);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
  }

  .loading-reset:hover:not(:disabled) {
    transform: translateY(-1px);
    color: color-mix(in srgb, var(--theme-danger, #ef4444) 48%, white);
    border-color: color-mix(in srgb, var(--theme-danger, #ef4444) 44%, transparent);
  }

  .loading-reset:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.72; transform: scale(0.98); }
    50% { opacity: 1; transform: scale(1.03); }
  }

  @keyframes drift {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
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
