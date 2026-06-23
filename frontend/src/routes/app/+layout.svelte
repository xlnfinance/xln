<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import RuntimeStateCard from '$lib/components/shared/RuntimeStateCard.svelte';
  import { appState } from '$lib/stores/appStateStore';
  import {
    initializeXLN,
    appRuntimeAdapterMode,
    appRuntimeAdapterPageInfo,
    refreshRuntimeAdapterEnvironment,
    setRuntimeAdapterPage,
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
  import { normalizeWsUrl } from '$lib/utils/wsUrl';
  import {
    REMOTE_RUNTIME_IMPORT_HASH_PARAM,
    REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY,
    formatRemoteRuntimeImportLines,
    parseRemoteRuntimeImportPayload,
    parseRemoteRuntimeImportText,
    persistRemoteRuntimeImports,
    type StoredRemoteRuntimeImportEntry,
  } from '$lib/utils/remoteRuntimeImport';
  import { validateRemoteRuntimeEntry } from '$lib/utils/remoteRuntimeValidation';

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
  let pendingRemoteRuntimeImport = $state<RemoteRuntimeImportRequest | null>(null);
  let remoteRuntimeAuthInput = $state('');
  let remoteRuntimeAuthError = $state('');
  let remoteRuntimeImportText = $state('');
  let remoteRuntimeImportError = $state('');
  let remoteRuntimeImportStatus = $state('');
  let remoteRuntimeImportRows = $state<RemoteRuntimeImportRow[]>([]);
  let remoteRuntimeImporting = $state(false);
  const pageSearch = $derived(browser ? $page.url.search : '');
  const DEPLOY_VERSION_KEY = 'xln-deploy-version';
  const REMOTE_ACCEPT_PREFIX = 'xln-remote-runtime-accepted:';

  type DeployVersionPayload = {
    version: string;
  };

  type RemoteRuntimeRequest = {
    wsUrl: string;
    authKey: string;
    hostLabel: string;
    keyLabel: string;
    acceptKey: string;
    requiresAuthPaste?: boolean;
  };

  type RemoteRuntimeImportRequest = {
    source: 'hash' | 'query';
    autoImport: boolean;
    initialError?: string;
  };

  type RemoteRuntimeImportRow = {
    index: number;
    label: string;
    access: 'read' | 'admin';
    wsUrl: string;
    status: 'pending' | 'checking' | 'connected' | 'error';
    detail: string;
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
      await resetEverything({ confirmed: true, reason: 'hash-reset' });
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

  function normalizeRuntimeWsUrl(value: string): string {
    const parsed = new URL(normalizeWsUrl(String(value || '').trim()));
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('REMOTE_RUNTIME_WS_REQUIRED');
    }
    return parsed.toString();
  }

  function describeAuthKey(key: string): string {
    if (!key) return 'no key';
    if (key.startsWith('xlnra1.read.')) return 'read capability';
    if (key.startsWith('xlnra1.full.')) return 'full capability';
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
  }

  function hostLabelForWsUrl(wsUrl: string): string {
    try {
      const parsed = new URL(wsUrl);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return wsUrl;
    }
  }

  function remoteAcceptKey(wsUrl: string, authKey: string): string {
    return `${REMOTE_ACCEPT_PREFIX}${wsUrl}|${authKey.slice(0, 16)}|${authKey.slice(-16)}`;
  }

  function readRemoteRuntimeRequestFromUrl(): RemoteRuntimeRequest | null {
    if (!browser) return null;
    const params = new URLSearchParams(window.location.search);
    const mode = String(params.get('runtime') || params.get('adapter') || '').trim().toLowerCase();
    const wsParam = String(params.get('ws') || params.get('runtimeWs') || '').trim();
    if (mode !== 'remote' || !wsParam) return null;
    const keyParam = String(params.get('token') || params.get('authKey') || params.get('key') || params.get('auth') || '').trim();
    const authKey = keyParam.startsWith('xlnra1.') ? keyParam : '';
    const requiresAuthPaste = !authKey && (params.has('key') || params.has('auth'));
    const wsUrl = normalizeRuntimeWsUrl(wsParam);
    return {
      wsUrl,
      authKey,
      hostLabel: hostLabelForWsUrl(wsUrl),
      keyLabel: requiresAuthPaste ? 'capability must be pasted' : describeAuthKey(authKey),
      acceptKey: remoteAcceptKey(wsUrl, authKey),
      requiresAuthPaste,
    };
  }

  function applyRemoteRuntimeImportPayload(payload: string, source: RemoteRuntimeImportRequest['source'], autoImport: boolean): RemoteRuntimeImportRequest {
    try {
      const entries = parseRemoteRuntimeImportPayload(payload);
      remoteRuntimeImportText = formatRemoteRuntimeImportLines(entries);
      remoteRuntimeImportRows = entries.map((entry, index) => ({
        index,
        label: entry.label,
        access: entry.access,
        wsUrl: entry.wsUrl,
        status: 'pending',
        detail: autoImport ? 'queued' : 'waiting',
      }));
      remoteRuntimeImportError = '';
      remoteRuntimeImportStatus = autoImport ? 'Auto-import queued' : '';
      return { source, autoImport };
    } catch (error) {
      remoteRuntimeImportText = payload;
      remoteRuntimeImportRows = [];
      const message = error instanceof Error ? error.message : String(error);
      remoteRuntimeImportError = message;
      remoteRuntimeImportStatus = '';
      return { source, autoImport: false, initialError: message };
    }
  }

  function runtimeImportPayloadFromParams(params: URLSearchParams): string {
    return String(
      params.get('runtimeList') ||
      params.get('runtime-list') ||
      params.get('runtimeImport') ||
      params.get(REMOTE_RUNTIME_IMPORT_HASH_PARAM) ||
      params.get('runtimes') ||
      params.get('remote-runtimes') ||
      params.get('xlnRemoteRuntimes') ||
      '',
    ).trim();
  }

  function readRemoteRuntimeImportRequestFromUrl(): RemoteRuntimeImportRequest | null {
    if (!browser) return null;
    const payload = runtimeImportPayloadFromParams(new URLSearchParams(window.location.search));
    if (!payload) return null;
    return applyRemoteRuntimeImportPayload(payload, 'query', true);
  }

  function readRemoteRuntimeImportRequestFromHash(): RemoteRuntimeImportRequest | null {
    if (!browser) return null;
    const hash = readCurrentHash().trim();
    if (!hash) return null;
    const params = new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
    const payload = runtimeImportPayloadFromParams(params);
    if (!payload) return null;
    return applyRemoteRuntimeImportPayload(payload, 'hash', true);
  }

  function stripRemoteRuntimeParams(): void {
    if (!browser) return;
    const url = new URL(window.location.href);
    for (const key of ['runtime', 'adapter', 'ws', 'runtimeWs', 'token', 'authKey', 'key', 'auth']) {
      url.searchParams.delete(key);
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    history.replaceState(null, '', next || '/app');
  }

  function stripRemoteRuntimeImportHash(): void {
    if (!browser) return;
    const url = new URL(window.location.href);
    url.hash = '';
    history.replaceState(null, '', `${url.pathname}${url.search}`);
    syncHashLocation();
  }

  function stripRemoteRuntimeImportParams(): void {
    if (!browser) return;
    const url = new URL(window.location.href);
    for (const key of [
      'runtimeList',
      'runtime-list',
      'runtimeImport',
      REMOTE_RUNTIME_IMPORT_HASH_PARAM,
      'runtimes',
      'remote-runtimes',
      'xlnRemoteRuntimes',
    ]) {
      url.searchParams.delete(key);
    }
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function persistRemoteRuntimeRequest(request: RemoteRuntimeRequest): void {
    localStorage.setItem('xln-runtime-adapter-mode', 'remote');
    localStorage.setItem('xln-runtime-adapter-ws', request.wsUrl);
    if (request.authKey) {
      localStorage.removeItem('xln-runtime-adapter-key');
      sessionStorage.setItem('xln-runtime-adapter-key', request.authKey);
    } else {
      localStorage.removeItem('xln-runtime-adapter-key');
      sessionStorage.removeItem('xln-runtime-adapter-key');
    }
    sessionStorage.setItem(request.acceptKey, '1');
  }

  function hasAcceptedRemoteRuntime(request: RemoteRuntimeRequest): boolean {
    try {
      localStorage.removeItem('xln-runtime-adapter-key');
      return sessionStorage.getItem(request.acceptKey) === '1';
    } catch {
      return false;
    }
  }

  function acceptRemoteRuntime(): void {
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
    window.location.reload();
  }

  function setRemoteRuntimeImportRow(index: number, patch: Partial<RemoteRuntimeImportRow>): void {
    remoteRuntimeImportRows = remoteRuntimeImportRows.map((row) =>
      row.index === index ? { ...row, ...patch } : row,
    );
  }

  function persistActiveRemoteRuntime(entry: StoredRemoteRuntimeImportEntry): void {
    localStorage.setItem('xln-runtime-adapter-mode', 'remote');
    localStorage.setItem('xln-runtime-adapter-ws', entry.wsUrl);
    localStorage.removeItem('xln-runtime-adapter-key');
    sessionStorage.setItem('xln-runtime-adapter-key', entry.token);
  }

  async function acceptRemoteRuntimeImport(): Promise<boolean> {
    if (remoteRuntimeImporting) return false;
    remoteRuntimeImporting = true;
    remoteRuntimeImportError = '';
    remoteRuntimeImportStatus = 'Parsing import list';
    try {
      const entries = parseRemoteRuntimeImportText(remoteRuntimeImportText);
      remoteRuntimeImportRows = entries.map((entry, index) => ({
        index,
        label: entry.label,
        access: entry.access,
        wsUrl: entry.wsUrl,
        status: 'pending',
        detail: 'waiting',
      }));
      const importedAt = Date.now();
      const validated: StoredRemoteRuntimeImportEntry[] = [];
      for (const [index, entry] of entries.entries()) {
        remoteRuntimeImportStatus = `Checking ${entry.label || entry.wsUrl}`;
        validated.push(await validateRemoteRuntimeEntry(entry, {
          index,
          importedAt,
          onProgress: (progress) => setRemoteRuntimeImportRow(progress.index, {
            status: progress.status,
            detail: progress.detail,
          }),
        }));
      }
      if (validated.length === 0) throw new Error('REMOTE_RUNTIME_IMPORT_EMPTY');
      const persisted = persistRemoteRuntimeImports(validated, { merge: true });
      sessionStorage.setItem(REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY, JSON.stringify({
        ok: true,
        importedAt,
        count: validated.length,
        total: persisted.length,
        entries: validated.map(entry => ({
          label: entry.label,
          access: entry.access,
          wsUrl: entry.wsUrl,
          runtimeId: entry.runtimeId,
          height: entry.height,
          entityCount: entry.entityCount,
        })),
      }));
      persistActiveRemoteRuntime(validated[0]!);
      stripRemoteRuntimeImportHash();
      window.location.reload();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      remoteRuntimeImportError = message;
      remoteRuntimeImportStatus = 'Import failed';
      return false;
    } finally {
      remoteRuntimeImporting = false;
    }
  }

  function useLocalBrowserRuntime(): void {
    localStorage.setItem('xln-runtime-adapter-mode', 'embedded');
    stripRemoteRuntimeParams();
    stripRemoteRuntimeImportHash();
    window.location.reload();
  }

  async function changeRemotePage(kind: 'accounts' | 'books', pageIndex: number): Promise<void> {
    setRuntimeAdapterPage(kind, pageIndex);
    await refreshRuntimeAdapterEnvironment();
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
      await initializeXLN();
      if (generation !== bootGeneration || !hasActiveTabLock) return;
      if ($appRuntimeAdapterMode !== 'remote') {
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
      const remoteImportRequest = readRemoteRuntimeImportRequestFromUrl() ?? readRemoteRuntimeImportRequestFromHash();
      if (remoteImportRequest) {
        pendingRemoteRuntimeImport = remoteImportRequest;
        if (remoteImportRequest.source === 'query') stripRemoteRuntimeImportParams();
        else stripRemoteRuntimeImportHash();
        if (remoteImportRequest.autoImport && !remoteImportRequest.initialError) {
          isLoading.set(true);
          error.set(null);
          const imported = await acceptRemoteRuntimeImport();
          if (!imported) {
            activeTabLockReady = true;
            hasActiveTabLock = false;
            isLoading.set(false);
            error.set(null);
          }
          return;
        }
        activeTabLockReady = true;
        hasActiveTabLock = false;
        isLoading.set(false);
        error.set(null);
        return;
      }
      const remoteRequest = readRemoteRuntimeRequestFromUrl();
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
  {#if pendingRemoteRuntimeImport}
    <div class="remote-login-screen" data-testid="remote-runtime-bulk-import-screen">
      <section class="remote-login-card remote-login-card--wide">
        <div class="remote-kicker">Remote runtimes</div>
        <h2>{remoteRuntimeImportError ? 'Runtime import failed' : 'Importing runtime hosts'}</h2>
        <p>Each host is opened, authenticated, and read before it is added.</p>
        {#if remoteRuntimeImportRows.length > 0}
          <div class="remote-import-table" data-testid="remote-runtime-import-status">
            {#each remoteRuntimeImportRows as row (row.index)}
              <div class="remote-import-row" class:error={row.status === 'error'} class:connected={row.status === 'connected'}>
                <span class="remote-import-status-dot {row.status}"></span>
                <span class="remote-import-label">{row.label}</span>
                <span class="remote-import-access">{row.access}</span>
                <span class="remote-import-host" title={row.wsUrl}>{row.wsUrl}</span>
                <span class="remote-import-detail">{row.detail}</span>
              </div>
            {/each}
          </div>
        {/if}
        {#if remoteRuntimeImportStatus}
          <p class="remote-token-info">{remoteRuntimeImportStatus}</p>
        {/if}
        {#if remoteRuntimeImportError}
          <p class="remote-token-error" data-testid="remote-runtime-import-error">{remoteRuntimeImportError}</p>
        {/if}
        {#if remoteRuntimeImportError}
          <div class="remote-actions">
            <a class="primary" href="/radapter/manage">Manage remotes</a>
            <button class="secondary" disabled={remoteRuntimeImporting} onclick={useLocalBrowserRuntime}>Use local runtime</button>
          </div>
        {/if}
      </section>
    </div>
  {:else if pendingRemoteRuntime}
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
        data-testid="inactive-tab-reload"
        onclick={() => {
          clearInactiveTabStandby();
          window.location.reload();
        }}
      >
        Reload to acquire active lock
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
  {#if $appRuntimeAdapterMode === 'remote' && $appRuntimeAdapterPageInfo && ($appRuntimeAdapterPageInfo.accountsHasMore || $appRuntimeAdapterPageInfo.booksHasMore)}
    <div class="remote-page-notice" data-testid="remote-page-notice">
      <span>
        Accounts {$appRuntimeAdapterPageInfo.accountsPageIndex + 1}/{$appRuntimeAdapterPageInfo.accountsPageCount || 1}
        ({$appRuntimeAdapterPageInfo.accountsShown}/{$appRuntimeAdapterPageInfo.accountsTotal})
      </span>
      <button
        type="button"
        disabled={$appRuntimeAdapterPageInfo.accountsPageIndex <= 0}
        onclick={() => changeRemotePage('accounts', $appRuntimeAdapterPageInfo!.accountsPageIndex - 1)}
      >Prev</button>
      <button
        type="button"
        disabled={!$appRuntimeAdapterPageInfo.accountsHasMore}
        onclick={() => changeRemotePage('accounts', $appRuntimeAdapterPageInfo!.accountsPageIndex + 1)}
      >Next</button>
      {#if $appRuntimeAdapterPageInfo.booksTotal > 0}
        <span>
          Books {$appRuntimeAdapterPageInfo.booksPageIndex + 1}/{$appRuntimeAdapterPageInfo.booksPageCount || 1}
          ({$appRuntimeAdapterPageInfo.booksShown}/{$appRuntimeAdapterPageInfo.booksTotal})
        </span>
        <button
          type="button"
          disabled={$appRuntimeAdapterPageInfo.booksPageIndex <= 0}
          onclick={() => changeRemotePage('books', $appRuntimeAdapterPageInfo!.booksPageIndex - 1)}
        >Prev</button>
        <button
          type="button"
          disabled={!$appRuntimeAdapterPageInfo.booksHasMore}
          onclick={() => changeRemotePage('books', $appRuntimeAdapterPageInfo!.booksPageIndex + 1)}
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

  .remote-login-card--wide {
    width: min(880px, 100%);
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

  .remote-import-table {
    display: grid;
    gap: 8px;
    margin: 0 0 16px;
  }

  .remote-import-row {
    display: grid;
    grid-template-columns: 12px minmax(70px, 0.8fr) 58px minmax(180px, 1.3fr) minmax(110px, 1fr);
    gap: 10px;
    align-items: center;
    min-height: 38px;
    padding: 8px 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    font-size: 12px;
  }

  .remote-import-row.connected {
    border-color: rgba(68, 214, 44, 0.22);
  }

  .remote-import-row.error {
    border-color: rgba(255, 107, 107, 0.34);
  }

  .remote-import-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.26);
  }

  .remote-import-status-dot.checking {
    background: #facc15;
  }

  .remote-import-status-dot.connected {
    background: #44d62c;
  }

  .remote-import-status-dot.error {
    background: #ff6b6b;
  }

  .remote-import-label,
  .remote-import-access,
  .remote-import-host,
  .remote-import-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .remote-import-access {
    color: var(--theme-accent, #facc15);
    font-weight: 700;
    text-transform: uppercase;
  }

  .remote-token-info {
    color: var(--theme-text-secondary, rgba(232, 232, 232, 0.72));
    font-size: 13px;
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

  .remote-actions button,
  .remote-actions a {
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

  @media (max-width: 540px) {
    .remote-import-row {
      grid-template-columns: 12px minmax(0, 1fr) 58px;
    }

    .remote-import-host,
    .remote-import-detail {
      grid-column: 2 / 4;
    }
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
