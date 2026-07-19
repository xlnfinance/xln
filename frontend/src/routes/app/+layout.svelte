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
  import {
    runtimeViewPageInfo,
    runtimeViewPageNeedsNavigation,
    setRuntimeViewPage,
  } from '$lib/stores/runtimeViewStore';
  import { errorLog } from '$lib/stores/errorLogStore';
  import { settingsOperations } from '$lib/stores/settingsStore';
  import { tabOperations } from '$lib/stores/tabStore';
  import { timeOperations } from '$lib/stores/timeStore';
  import { vaultOperations } from '$lib/stores/vaultStore';
  import { resolveDeployVersionAction } from '$lib/utils/deployVersionPolicy';
  import { resetEverything } from '$lib/utils/resetEverything';
  import { parseStorageSchemaMismatch } from '$lib/utils/storageSchemaRecovery';
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
  let recoveringStorage = $state(false);
  let storageRecoveryError = $state('');
  let bootGeneration = $state(0);
  const initialSearchParams = browser ? new URLSearchParams(window.location.search) : null;
  let lockTestMode = $state(initialSearchParams?.get('locktest') === '1' && canUseLockTestMode());
  let scenarioPreviewMode = $state(initialSearchParams?.get('scenarioPreview') === '1');
  let currentHash = $state('');
  let pendingRemoteRuntime = $state<RemoteRuntimeRequest | null>(null);
  let remoteRuntimeAuthInput = $state('');
  let remoteRuntimeAuthError = $state('');
  let claimingActiveTabLock = $state(false);
  let runtimeImportLocationInFlight = false;
  let releaseActiveTabLock: (() => void) | null = null;
  const pageSearch = $derived(browser ? $page.url.search : '');
  const storageSchemaMismatch = $derived(parseStorageSchemaMismatch($error));
  const DEPLOY_VERSION_KEY = 'xln-deploy-version';
  type DeployVersionPayload = {
    version: string;
    ephemeralTestnet: boolean;
  };

  function logAppShellDiagnostic(message: string, details?: unknown): void {
    errorLog.log(message, 'App Shell', details);
  }

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

  async function handleStorageSchemaRecovery(): Promise<void> {
    if (recoveringStorage || resettingEverything) return;
    recoveringStorage = true;
    storageRecoveryError = '';
    try {
      await vaultOperations.recoverSchemaMismatchedRuntimesFromConfiguredBackups();
      error.set(null);
      isLoading.set(true);
      await bootApp();
    } catch (recoveryError) {
      storageRecoveryError = recoveryError instanceof Error
        ? recoveryError.message
        : String(recoveryError);
      logAppShellDiagnostic('Storage schema recovery failed', recoveryError);
    } finally {
      recoveringStorage = false;
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

  type RemoteRuntimeBootstrapResult = 'continue' | 'pending-auth';

  function showInactiveTabStandby(): void {
    hasActiveTabLock = false;
    activeTabLockReady = true;
    isLoading.set(false);
    error.set(null);
  }

  async function processRemoteRuntimeBootstrapFromLocation(): Promise<RemoteRuntimeBootstrapResult> {
    const importPayload = readRemoteRuntimeImportPayloadFromUrl() || readRemoteRuntimeImportPayloadFromHash();
    const importSource = readRemoteRuntimeImportSourceFromUrl() || readRemoteRuntimeImportSourceFromHash();
    const remoteRequest = readRemoteRuntimeRequestFromUrl();
    await importRemoteRuntimesIntoApp({
      payload: importPayload,
      source: importSource,
    });
    if (remoteRequest && (remoteRequest.requiresAuthPaste || (!remoteRequest.authKey && !hasAcceptedRemoteRuntime(remoteRequest)))) {
      pendingRemoteRuntime = remoteRequest;
      stripRemoteRuntimeParams();
      showInactiveTabStandby();
      return 'pending-auth';
    }
    if (remoteRequest) {
      persistRemoteRuntimeRequest(remoteRequest);
      stripRemoteRuntimeParams();
    }
    return 'continue';
  }

  async function processRuntimeImportLocationChange(): Promise<void> {
    if (runtimeImportLocationInFlight || !hasActiveTabLock || isInactiveTabStandby()) return;
    const importPayload = readRemoteRuntimeImportPayloadFromUrl() || readRemoteRuntimeImportPayloadFromHash();
    const importSource = readRemoteRuntimeImportSourceFromUrl() || readRemoteRuntimeImportSourceFromHash();
    if (!importPayload && !importSource) return;
    runtimeImportLocationInFlight = true;
    try {
      await importRemoteRuntimesIntoApp({
        payload: importPayload,
        source: importSource,
      });
      await activateAppAfterRuntimeChoice();
    } catch (err) {
      logAppShellDiagnostic('Remote runtime import failed', err);
      error.set((err as Error)?.message || 'Remote runtime import failed');
      isLoading.set(false);
    } finally {
      runtimeImportLocationInFlight = false;
    }
  }

  async function bootAfterActiveTabClaim(options: {
    replaceExistingLock?: boolean;
    persistDeployVersionAfterBoot?: boolean;
    processLocationRemoteBootstrap?: boolean;
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
      if (options.processLocationRemoteBootstrap) {
        const bootstrapResult = await processRemoteRuntimeBootstrapFromLocation();
        if (bootstrapResult === 'pending-auth') return;
      }
      if (lockTestMode) {
        isLoading.set(false);
        error.set(null);
        embedBootReady = true;
        return;
      }
      await bootApp();
      if (options.persistDeployVersionAfterBoot) {
        try {
          persistDeployVersion((await fetchCurrentDeployVersion()).version);
        } catch (deployError) {
          logAppShellDiagnostic('Deploy version persistence failed after boot', deployError);
        }
      }
    } catch (err) {
      logAppShellDiagnostic(options.errorLabel, err);
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
        processLocationRemoteBootstrap: true,
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

    return { version, ephemeralTestnet: root['ephemeralTestnet'] === true };
  }

  async function fetchCurrentDeployVersion(): Promise<DeployVersionPayload> {
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
    return payload;
  }

  async function ensureCurrentDeployVersion(): Promise<boolean> {
    let current: DeployVersionPayload;
    try {
      current = await fetchCurrentDeployVersion();
    } catch (error) {
      logAppShellDiagnostic('Deploy version fetch failed', error);
      return false;
    }

    const storedVersion = readStoredDeployVersion();
    const action = resolveDeployVersionAction(storedVersion, current.version, current.ephemeralTestnet);
    if (action === 'persist-current') {
      persistDeployVersion(current.version);
      return false;
    }
    if (action === 'continue') return false;
    if (action === 'reset-ephemeral-testnet') {
      await resetEverything({ confirmed: true, reason: 'deploy-version-change-testnet' });
      return true;
    }

    error.set(`Deploy version changed from ${storedVersion} to ${current.version}. Review recovery coverage before resetting local data.`);
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
      logAppShellDiagnostic('Inactive tab activity suspension failed', err);
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
      logAppShellDiagnostic('XLN initialization failed', err);
      error.set((err as Error)?.message || 'Initialization failed');
      embedBootReady = false;
    }
  }

  onMount(() => {
    let disposed = false;

    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      vaultOperations.beginRuntimePageUnload();
    };

    const handleLocationChange = () => {
      syncHashLocation();
      void (async () => {
        if (await maybeHandleResetHash()) return;
        await processRuntimeImportLocationChange();
      })();
    };

    syncHashLocation();
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('hashchange', handleLocationChange);

    void (async () => {
      const importPayload = readRemoteRuntimeImportPayloadFromUrl() || readRemoteRuntimeImportPayloadFromHash();
      const importSource = readRemoteRuntimeImportSourceFromUrl() || readRemoteRuntimeImportSourceFromHash();
      const remoteRequest = readRemoteRuntimeRequestFromUrl();
      if (await maybeHandleResetHash()) return;
      const hasExplicitRemoteRuntimeBootstrap = Boolean(importPayload || importSource || remoteRequest);
      if (isInactiveTabStandby()) {
        showInactiveTabStandby();
        return;
      }
      if (!hasExplicitRemoteRuntimeBootstrap && await ensureCurrentDeployVersion()) return;
      const bootstrapResult = await processRemoteRuntimeBootstrapFromLocation();
      if (bootstrapResult === 'pending-auth') return;
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
          persistDeployVersion((await fetchCurrentDeployVersion()).version);
        } catch (error) {
          logAppShellDiagnostic('Deploy version persistence failed in lock test mode', error);
        }
        return;
      }
      await bootApp();
      try {
        persistDeployVersion((await fetchCurrentDeployVersion()).version);
      } catch (error) {
        logAppShellDiagnostic('Deploy version persistence failed after app boot', error);
      }
    })().catch((err) => {
      if (disposed) return;
      logAppShellDiagnostic('Active tab lock initialization failed', err);
      error.set((err as Error)?.message || 'Active tab lock initialization failed');
      activeTabLockReady = true;
      hasActiveTabLock = false;
      isLoading.set(false);
    });

    return () => {
      disposed = true;
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('hashchange', handleLocationChange);
      releaseActiveTabLock?.();
      releaseActiveTabLock = null;
    };
  });
</script>

<svelte:head>
  <title>xln - {$appState.mode === 'user' ? 'Wallet' : 'Network Workspace'}</title>
</svelte:head>

{#if activeTabLockReady && !hasActiveTabLock && !$error}
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
  <div class="error-screen" data-testid="app-initialization-error">
    {#if storageSchemaMismatch}
      <h2>Local runtime needs recovery</h2>
      <p class="schema-recovery-copy">
        This device has storage schema {storageSchemaMismatch.storedVersion}, while this build requires
        schema {storageSchemaMismatch.currentVersion}. No incompatible data was applied or deleted.
      </p>
      <p class="schema-recovery-copy">
        Restore the latest authenticated encrypted backup first. Reset only if you intentionally want to
        discard every local wallet and runtime on this device.
      </p>
      <div class="schema-recovery-actions">
        <button
          class="primary-recovery-action"
          data-testid="storage-schema-recover"
          onclick={handleStorageSchemaRecovery}
          disabled={recoveringStorage || resettingEverything}
        >
          {recoveringStorage ? 'Restoring...' : 'Restore encrypted backup'}
        </button>
        <button
          data-testid="storage-schema-reset"
          onclick={handleResetEverything}
          disabled={recoveringStorage || resettingEverything}
        >
          {resettingEverything ? 'Resetting...' : 'Reset local data'}
        </button>
      </div>
      {#if storageRecoveryError}
        <p class="schema-recovery-error" data-testid="storage-schema-recovery-error">{storageRecoveryError}</p>
      {/if}
      <details class="schema-recovery-details">
        <summary>Technical details</summary>
        <code>{$error}</code>
      </details>
    {:else}
      <h2>❌ Initialization Failed</h2>
      <p class="error-msg">{$error}</p>
      <button onclick={() => initializeXLN()}>Retry</button>
      <button onclick={handleResetEverything} disabled={resettingEverything}>
        {resettingEverything ? 'Resetting...' : 'Reset local data'}
      </button>
    {/if}
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
  {#if $runtimeControllerHandle.mode === 'remote' && $runtimeViewPageInfo && runtimeViewPageNeedsNavigation($runtimeViewPageInfo)}
    <div class="remote-page-notice" data-testid="remote-page-notice">
      {#if runtimeViewPageNeedsNavigation($runtimeViewPageInfo, 'accounts')}
        <div class="remote-page-group">
          <span><strong>Accounts</strong> {$runtimeViewPageInfo.accountsPageIndex + 1}/{$runtimeViewPageInfo.accountsPageCount}</span>
          <button
            type="button"
            aria-label="Previous accounts page"
            disabled={$runtimeViewPageInfo.accountsPageIndex <= 0}
            onclick={() => changeRemotePage('accounts', $runtimeViewPageInfo!.accountsPageIndex - 1)}
          >‹</button>
          <button
            type="button"
            aria-label="Next accounts page"
            disabled={!$runtimeViewPageInfo.accountsHasMore}
            onclick={() => changeRemotePage('accounts', $runtimeViewPageInfo!.accountsPageIndex + 1)}
          >›</button>
        </div>
      {/if}
      {#if $runtimeViewPageInfo.booksTotal > 0 && runtimeViewPageNeedsNavigation($runtimeViewPageInfo, 'books')}
        <div class="remote-page-group">
          <span><strong>Books</strong> {$runtimeViewPageInfo.booksPageIndex + 1}/{$runtimeViewPageInfo.booksPageCount}</span>
        <button
          type="button"
          aria-label="Previous books page"
          disabled={$runtimeViewPageInfo.booksPageIndex <= 0}
          onclick={() => changeRemotePage('books', $runtimeViewPageInfo!.booksPageIndex - 1)}
        >‹</button>
        <button
          type="button"
          aria-label="Next books page"
          disabled={!$runtimeViewPageInfo.booksHasMore}
          onclick={() => changeRemotePage('books', $runtimeViewPageInfo!.booksPageIndex + 1)}
        >›</button>
        </div>
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
    max-width: min(360px, calc(100vw - 28px));
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 28%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--theme-card-bg, #141416) 94%, transparent);
    color: var(--theme-text-secondary, #d6d3d1);
    font-size: 11px;
    line-height: 1.35;
    box-shadow: 0 16px 46px rgba(0, 0, 0, 0.28);
  }

  .remote-page-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .remote-page-group + .remote-page-group {
    padding-left: 6px;
    border-left: 1px solid color-mix(in srgb, var(--theme-card-border, #3f3f46) 72%, transparent);
  }

  .remote-page-group span {
    padding: 0 4px;
    color: var(--theme-text-muted, #a8a29e);
    white-space: nowrap;
  }

  .remote-page-group strong {
    color: var(--theme-text-primary, #f5f5f4);
  }

  .remote-page-notice button {
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #facc15) 30%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #141416) 84%, var(--theme-accent, #facc15));
    color: var(--theme-text-primary, #f5f5f4);
    font: inherit;
    font-size: 18px;
    line-height: 1;
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

  .error-screen h2,
  .schema-recovery-copy {
    margin: 0;
  }

  .schema-recovery-copy {
    max-width: 640px;
    color: var(--theme-text-secondary, rgba(232, 232, 232, 0.76));
    text-align: center;
    line-height: 1.55;
  }

  .schema-recovery-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
  }

  .error-screen .primary-recovery-action {
    border-color: color-mix(in srgb, var(--theme-accent, #facc15) 52%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #facc15) 28%, var(--theme-background, #09090b));
    color: var(--theme-text-primary, white);
  }

  .schema-recovery-error {
    max-width: 640px;
    margin: 0;
    color: var(--theme-danger, #ef4444);
    text-align: center;
    overflow-wrap: anywhere;
  }

  .schema-recovery-details {
    max-width: min(720px, calc(100vw - 48px));
    color: var(--theme-text-muted, #a8a29e);
    font-size: 12px;
  }

  .schema-recovery-details code {
    display: block;
    margin-top: 8px;
    overflow-wrap: anywhere;
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

  .error-screen button:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .error-msg {
    max-width: 560px;
    margin: 0;
    color: color-mix(in srgb, var(--theme-danger, #ef4444) 78%, var(--theme-text-primary, white));
    text-align: center;
  }
</style>
