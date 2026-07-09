<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/stores';
  import RuntimeStateCard from '$lib/components/shared/RuntimeStateCard.svelte';
  import { appState } from '$lib/stores/appStateStore';
  import {
    initializeXLN,
    refreshCurrentRuntimeProjection,
    isLoading,
    error,
    suspendClientActivity,
    xlnFunctions
  } from '$lib/stores/xlnStore';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeViewPageInfo, setRuntimeViewPage } from '$lib/stores/runtimeViewStore';
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
  import {
    describeRemoteRuntimeImportError,
    parseRemoteRuntimeImportPayload,
  } from '$lib/utils/remoteRuntimeImport';
  import {
    fetchRemoteRuntimeImportSource,
    importRemoteRuntimeEntries,
    persistActiveRemoteRuntimeImport,
  } from '$lib/utils/remoteRuntimeImportFlow';
  import {
    hasAcceptedRemoteRuntime,
    persistRemoteRuntimeRequest,
    readRemoteRuntimeImportPayloadFromHash,
    readRemoteRuntimeImportPayloadFromUrl,
    readRemoteRuntimeImportSourceFromHash,
    readRemoteRuntimeImportSourceFromUrl,
    readRemoteRuntimeRequestFromUrl,
    remoteAcceptKey,
    stripRemoteRuntimeParamsFromHistory,
    type RemoteRuntimeRequest,
  } from '$lib/utils/runtimeConnection';

  let { children } = $props();

  let hasActiveTabLock = $state(false);
  let activeTabLockReady = $state(false);
  let embedBootReady = $state(false);
  let resettingEverything = $state(false);
  let bootGeneration = $state(0);
  let lockTestMode = $state(false);
  let scenarioPreviewMode = $state(false);
  let currentHash = $state('');
  let pendingRemoteRuntime = $state<RemoteRuntimeRequest | null>(null);
  let remoteRuntimeAuthInput = $state('');
  let remoteRuntimeAuthError = $state('');
  let claimingActiveTabLock = $state(false);
  let releaseActiveTabLock: (() => void) | null = null;
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
      replaceState('/app', {});
      await resetEverything({ confirmed: true, reason: 'hash-reset' });
      return true;
    }
    replaceState('/app', {});
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
      await resetEverything({ confirmed: true, reason: 'loading-screen' });
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

  function shouldBootRemoteRuntime(): boolean {
    if (!browser) return false;
    const params = new URLSearchParams(window.location.search);
    const rawMode = (
      params.get('runtime') ||
      params.get('adapter') ||
      localStorage.getItem('xln-runtime-adapter-mode') ||
      ''
    ).trim().toLowerCase();
    return rawMode === 'remote' || rawMode === 'ws' || params.has('ws') || params.has('runtimeWs');
  }

  function stripRemoteRuntimeParams(): void {
    if (!browser) return;
    stripRemoteRuntimeParamsFromHistory();
  }

  async function importRemoteRuntimesIntoApp(input: { payload?: string; source?: string }): Promise<void> {
    const payload = String(input.payload || '').trim();
    const source = String(input.source || '').trim();
    if (!payload && !source) return;
    isLoading.set(true);
    error.set(null);
    try {
      const entries = source
        ? await fetchRemoteRuntimeImportSource(source)
        : parseRemoteRuntimeImportPayload(payload);
      const result = await importRemoteRuntimeEntries(entries);
      const first = result.validated[0]!;
      persistActiveRemoteRuntimeImport(first);
      stripRemoteRuntimeParams();
    } catch (err) {
      stripRemoteRuntimeParams();
      throw new Error(describeRemoteRuntimeImportError(err));
    }
  }

  async function bootAfterActiveTabClaim(options: {
    replaceExistingLock?: boolean;
    persistDeployVersionAfterBoot?: boolean;
    errorLabel: string;
  }): Promise<void> {
    activeTabLockReady = false;
    hasActiveTabLock = false;
    isLoading.set(true);
    error.set(null);
    try {
      if (options.replaceExistingLock) {
        releaseActiveTabLock?.();
        releaseActiveTabLock = null;
      }
      if (!releaseActiveTabLock) {
        releaseActiveTabLock = await initializeActiveTabLock(async () => {
          await deactivateThisTab();
        });
      }
      hasActiveTabLock = true;
      activeTabLockReady = true;
      if (lockTestMode) {
        isLoading.set(false);
        error.set(null);
        embedBootReady = true;
        return;
      }
      await bootApp();
      if (options.persistDeployVersionAfterBoot) {
        try {
          persistDeployVersion(await fetchCurrentDeployVersion());
        } catch (deployError) {
          console.warn('[deploy-version] failed to persist deploy version:', deployError);
        }
      }
    } catch (err) {
      console.error(`${options.errorLabel}:`, err);
      error.set((err as Error)?.message || options.errorLabel);
      activeTabLockReady = true;
      hasActiveTabLock = false;
      isLoading.set(false);
    }
  }

  async function activateAppAfterRuntimeChoice(): Promise<void> {
    pendingRemoteRuntime = null;
    remoteRuntimeAuthInput = '';
    remoteRuntimeAuthError = '';
    await bootAfterActiveTabClaim({
      persistDeployVersionAfterBoot: true,
      errorLabel: 'Runtime activation failed',
    });
  }

  async function claimActiveTabLockInPlace(): Promise<void> {
    if (claimingActiveTabLock) return;
    claimingActiveTabLock = true;
    clearInactiveTabStandby();
    try {
      await bootAfterActiveTabClaim({
        replaceExistingLock: true,
        errorLabel: 'Active tab lock claim failed',
      });
    } finally {
      claimingActiveTabLock = false;
    }
  }

  async function acceptRemoteRuntime(): Promise<void> {
    const request = pendingRemoteRuntime;
    if (!request) return;
    const authKey = request.requiresAuthPaste ? remoteRuntimeAuthInput.trim() : request.authKey;
    if (request.requiresAuthPaste && !authKey.startsWith('xlnra1.')) {
      remoteRuntimeAuthError = 'Paste the capability token to connect.';
      return;
    }
    remoteRuntimeAuthError = '';
    persistRemoteRuntimeRequest({
      ...request,
      authKey,
      acceptKey: remoteAcceptKey(request.wsUrl, authKey),
    });
    stripRemoteRuntimeParams();
    await activateAppAfterRuntimeChoice();
  }

  async function useLocalBrowserRuntime(): Promise<void> {
    localStorage.setItem('xln-runtime-adapter-mode', 'embedded');
    localStorage.removeItem('xln-runtime-adapter-ws');
    localStorage.removeItem('xln-runtime-adapter-access');
    localStorage.removeItem('xln-runtime-adapter-key');
    sessionStorage.removeItem('xln-runtime-adapter-key');
    stripRemoteRuntimeParams();
    await activateAppAfterRuntimeChoice();
  }

  async function changeRemotePage(kind: 'accounts' | 'books', pageIndex: number): Promise<void> {
    setRuntimeViewPage(kind, pageIndex);
    await refreshCurrentRuntimeProjection();
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
    const version = String(root['deployVersion'] || root['networkVersion'] || root['version'] || '').trim();
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

    error.set(`Deploy version changed from ${storedVersion} to ${currentVersion}. Review recovery coverage before resetting local data.`);
    isLoading.set(false);
    return true;
  }

  $effect(() => {
    if (!browser) return;
    const params = new URLSearchParams(pageSearch);
    lockTestMode = params.get('locktest') === '1' && canUseLockTestMode();
    scenarioPreviewMode = params.get('scenarioPreview') === '1';
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
      const bootingRemoteRuntime = shouldBootRemoteRuntime();
      if (!bootingRemoteRuntime) {
        await vaultOperations.initialize();
      }
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      await initializeXLN();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      if (!bootingRemoteRuntime && $runtimeControllerHandle.mode !== 'remote') {
        await vaultOperations.initialize();
      }
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

    const handleLocationChange = () => {
      syncHashLocation();
      void maybeHandleResetHash();
    };

    syncHashLocation();
    window.addEventListener('hashchange', handleLocationChange);

    void (async () => {
      const importPayload = readRemoteRuntimeImportPayloadFromUrl() || readRemoteRuntimeImportPayloadFromHash();
      const importSource = readRemoteRuntimeImportSourceFromUrl() || readRemoteRuntimeImportSourceFromHash();
      const remoteRequest = readRemoteRuntimeRequestFromUrl();
      if (await maybeHandleResetHash()) return;
      const hasExplicitRemoteRuntimeBootstrap = Boolean(importPayload || importSource || remoteRequest);
      if (!hasExplicitRemoteRuntimeBootstrap && await ensureCurrentDeployVersion()) return;
      await importRemoteRuntimesIntoApp({
        payload: importPayload,
        source: importSource,
      });
      if (remoteRequest?.requiresAuthPaste || (remoteRequest && !remoteRequest.authKey && !hasAcceptedRemoteRuntime(remoteRequest))) {
        pendingRemoteRuntime = remoteRequest;
        stripRemoteRuntimeParams();
        activeTabLockReady = true;
        hasActiveTabLock = false;
        isLoading.set(false);
        error.set(null);
        return;
      }
      if (remoteRequest) {
        persistRemoteRuntimeRequest(remoteRequest);
        stripRemoteRuntimeParams();
      }
      if (isInactiveTabStandby()) {
        hasActiveTabLock = false;
        activeTabLockReady = true;
        isLoading.set(false);
        error.set(null);
        return;
      }
      releaseActiveTabLock = await initializeActiveTabLock(async () => {
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
      releaseActiveTabLock?.();
      releaseActiveTabLock = null;
    };
  });
</script>

<svelte:head>
  <title>xln - {$appState.mode === 'user' ? 'Wallet' : 'Network Workspace'}</title>
</svelte:head>

{#if activeTabLockReady && !hasActiveTabLock}
  {#if pendingRemoteRuntime}
    <div class="remote-login-screen" data-testid="remote-runtime-login-screen">
      <section class="remote-login-card">
        <div class="remote-kicker">Remote runtime</div>
        <h2>Connect to this runtime host?</h2>
        <p>
          XLN will attach this app to the runtime that is already running at the host below. This
          will not create a new browser runtime.
        </p>
        <dl>
          <div>
            <dt>Host</dt>
            <dd>{pendingRemoteRuntime.hostLabel}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>{pendingRemoteRuntime.keyLabel}</dd>
          </div>
        </dl>
        {#if pendingRemoteRuntime.requiresAuthPaste}
          <label class="remote-token-input">
            <span>Capability</span>
            <input
              type="password"
              autocomplete="off"
              spellcheck="false"
              bind:value={remoteRuntimeAuthInput}
              placeholder="xlnra1..."
            />
          </label>
          {#if remoteRuntimeAuthError}
            <p class="remote-token-error">{remoteRuntimeAuthError}</p>
          {/if}
        {/if}
        <div class="remote-actions">
          <button class="primary" onclick={acceptRemoteRuntime}>Connect remote runtime</button>
          <button class="secondary" onclick={useLocalBrowserRuntime}>Cancel</button>
        </div>
      </section>
    </div>
  {:else}
    <div class="inactive-tab-screen" data-testid="inactive-tab-screen">
      <h2>Inactive Tab</h2>
      <p>This wallet tab lost the active lock to a newer tab.</p>
      <button
        data-testid="inactive-tab-acquire"
        disabled={claimingActiveTabLock}
        onclick={claimActiveTabLockInPlace}
      >
        {claimingActiveTabLock ? 'Claiming active lock...' : 'Take active lock'}
      </button>
    </div>
  {/if}
{:else if lockTestMode && scenarioPreviewMode}
  <div class="scenario-preview-banner" data-testid="scenario-preview-wallet-banner">
    Scenario preview. Runtime writes and wallet bootstrap are disabled in this view.
  </div>
  {@render children?.()}
{:else if lockTestMode}
  <main class="app-shell-ready app-shell-ready--empty" data-testid="app-runtime-ready"></main>
{:else if $error}
  <div class="error-screen">
    <h2>❌ Initialization Failed</h2>
    <p class="error-msg">{$error}</p>
    <button onclick={() => initializeXLN()}>Retry</button>
    <button onclick={handleResetEverything} disabled={resettingEverything}>
      {resettingEverything ? 'Resetting...' : 'Reset local data'}
    </button>
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
  {#if $runtimeControllerHandle.mode === 'remote' && $runtimeViewPageInfo && ($runtimeViewPageInfo.accountsHasMore || $runtimeViewPageInfo.booksHasMore)}
    <div class="remote-page-notice" data-testid="remote-page-notice">
      <span>
        Accounts {$runtimeViewPageInfo.accountsPageIndex + 1}/{$runtimeViewPageInfo.accountsPageCount || 1}
        ({$runtimeViewPageInfo.accountsShown}/{$runtimeViewPageInfo.accountsTotal})
      </span>
      <button
        type="button"
        disabled={$runtimeViewPageInfo.accountsPageIndex <= 0}
        onclick={() => changeRemotePage('accounts', $runtimeViewPageInfo!.accountsPageIndex - 1)}
      >Prev</button>
      <button
        type="button"
        disabled={!$runtimeViewPageInfo.accountsHasMore}
        onclick={() => changeRemotePage('accounts', $runtimeViewPageInfo!.accountsPageIndex + 1)}
      >Next</button>
      {#if $runtimeViewPageInfo.booksTotal > 0}
        <span>
          Books {$runtimeViewPageInfo.booksPageIndex + 1}/{$runtimeViewPageInfo.booksPageCount || 1}
          ({$runtimeViewPageInfo.booksShown}/{$runtimeViewPageInfo.booksTotal})
        </span>
        <button
          type="button"
          disabled={$runtimeViewPageInfo.booksPageIndex <= 0}
          onclick={() => changeRemotePage('books', $runtimeViewPageInfo!.booksPageIndex - 1)}
        >Prev</button>
        <button
          type="button"
          disabled={!$runtimeViewPageInfo.booksHasMore}
          onclick={() => changeRemotePage('books', $runtimeViewPageInfo!.booksPageIndex + 1)}
        >Next</button>
      {/if}
    </div>
  {/if}
  {@render children?.()}
{/if}

<style>
  .loading-screen,
  .error-screen,
  .inactive-tab-screen,
  .remote-login-screen {
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

  .remote-login-screen {
    padding: 28px;
  }

  .remote-login-card {
    width: min(520px, 100%);
    padding: 28px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 24%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-card-bg, #141416) 92%, transparent);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
  }

  .remote-kicker {
    margin-bottom: 10px;
    color: var(--theme-accent, #facc15);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .remote-login-card h2 {
    margin: 0 0 10px;
    font-size: 26px;
  }

  .remote-login-card p {
    margin: 0 0 18px;
    color: var(--theme-text-secondary, rgba(232, 232, 232, 0.72));
    line-height: 1.5;
  }

  .remote-login-card dl {
    display: grid;
    gap: 10px;
    margin: 0 0 22px;
  }

  .remote-login-card dl > div {
    display: grid;
    grid-template-columns: 78px 1fr;
    gap: 12px;
    align-items: center;
    min-width: 0;
  }

  .remote-login-card dt {
    color: var(--theme-text-muted, #8a8a8f);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .remote-login-card dd {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--theme-text-primary, #e8e8e8);
    font-family: 'SF Mono', monospace;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .remote-token-input {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: -8px 0 20px;
    color: var(--theme-text-muted, #8a8a8f);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .remote-token-input input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 22%, transparent);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.28);
    color: var(--theme-text-primary, #e8e8e8);
    padding: 10px 12px;
    font: 12px 'SF Mono', monospace;
    text-transform: none;
    letter-spacing: 0;
  }

  .remote-token-error {
    margin: -12px 0 18px;
    color: rgba(255, 150, 150, 0.96);
    font-size: 12px;
  }

  .remote-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .remote-actions button {
    min-height: 42px;
    padding: 0 14px;
    border-radius: 7px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    text-decoration: none;
  }

  .remote-actions .primary {
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 38%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #facc15) 22%, var(--theme-surface, #18181b));
    color: var(--theme-text-primary, #fff);
  }

  .remote-actions .secondary {
    border: 1px solid color-mix(in srgb, var(--theme-border, #333) 88%, transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 92%, transparent);
    color: var(--theme-text-secondary, #b4b4ba);
  }

  .app-shell-ready {
    display: contents;
  }

  .scenario-preview-banner {
    position: fixed;
    top: 10px;
    left: 50%;
    z-index: 80;
    transform: translateX(-50%);
    max-width: min(720px, calc(100vw - 24px));
    padding: 8px 12px;
    border: 1px solid rgba(61, 220, 151, 0.36);
    border-radius: 7px;
    background: rgba(12, 35, 26, 0.94);
    color: #d9ffed;
    font-size: 12px;
    font-weight: 800;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  }

  .remote-page-notice {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 60;
    max-width: min(440px, calc(100vw - 28px));
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 9px 12px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 28%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--theme-card-bg, #141416) 94%, transparent);
    color: var(--theme-text-secondary, #d6d3d1);
    font-size: 12px;
    line-height: 1.35;
    box-shadow: 0 16px 46px rgba(0, 0, 0, 0.28);
  }

  .remote-page-notice button {
    min-height: 26px;
    padding: 0 9px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 30%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #141416) 84%, var(--theme-accent, #facc15));
    color: var(--theme-text-primary, #f5f5f4);
    font: inherit;
    cursor: pointer;
  }

  .remote-page-notice button:disabled {
    opacity: 0.45;
    cursor: default;
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
