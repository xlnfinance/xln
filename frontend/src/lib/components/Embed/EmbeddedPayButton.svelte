<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import type { Env, EntityReplica } from '@xln/runtime/xln-api';
  import PaymentPanel from '$lib/components/Entity/PaymentPanel.svelte';
  import { activeVault, runtimesState, vaultOperations, vaultStorageLoaded } from '$lib/stores/vaultStore';
  import { error, isLoading, xlnEnvironment, xlnFunctions } from '$lib/stores/xlnStore';
  import { activeTabId, tabs } from '$lib/stores/tabStore';
  import { createSelfEntity } from '$lib/utils/entityFactory';

  let checkoutEntityId = '';
  let ensuringEntity = false;
  let activated = false;
  let progress = 0;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let successResetTimer: ReturnType<typeof setTimeout> | null = null;
  let clickStartedAt = 0;
  let elapsedMs = 0;
  let uiState: 'idle' | 'processing' | 'success' | 'error' = 'idle';
  let statusText = '';
  let paymentPanelRef: {
    embeddedPrepareFirstRoute?: () => Promise<string>;
    embeddedPayUsingFirstRoute?: () => Promise<void>;
  } | null = null;
  let embeddedAction: 'pay' = 'pay';
  let embeddedSegment: 'left' | 'right' | 'full' = 'full';
  let lastDebugSignature = '';
  let pendingClick = false;
  let routeStatus: 'booting' | 'connecting-relay' | 'finding-routes' | 'route-ready' | 'route-error' = 'booting';
  let routeLabel = '';
  let lastPostedStateSignature = '';
  let preparingRouteKey = '';
  let preparedRouteKey = '';
  let paymentIntentNonce = 0;
  const PREPARE_ROUTE_TIMEOUT_MS = 15_000;
  const PREPARE_ROUTE_RETRY_MS = 750;

  function getParentOrigin(): string {
    const params = getHashParams();
    const explicitOrigin = String(params.get('parentOrigin') || '').trim();
    if (explicitOrigin) return explicitOrigin;
    if (typeof document === 'undefined') return '';
    const referrer = String(document.referrer || '').trim();
    if (!referrer) return '';
    try {
      return new URL(referrer).origin;
    } catch {
      return '';
    }
  }

  function postParentState(): void {
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
    const targetOrigin = getParentOrigin();
    if (!targetOrigin) return;
    const payload = {
      source: 'xln-embedded-pay',
      event: 'state',
      label: buttonLabel,
      disabled,
      readyToPay,
      routeStatus,
      routeLabel,
      uiState,
      statusText,
      hasVaultRuntime,
      hasSenderEntity,
      hasPaymentParams,
      isLoading: $isLoading,
      error: $error || '',
      ensuringEntity,
      timestamp: Date.now(),
    };
    window.parent.postMessage(payload, targetOrigin);
  }

  function postParentEvent(event: string, details: Record<string, unknown> = {}): void {
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
    const targetOrigin = getParentOrigin();
    if (!targetOrigin) return;
    window.parent.postMessage({
      source: 'xln-embedded-pay',
      event,
      timestamp: Date.now(),
      ...details,
    }, targetOrigin);
  }

  function getActiveSignerEntityId(): string {
    const vault = get(activeVault);
    const signer = vault?.signers?.[vault?.activeSignerIndex ?? 0] || vault?.signers?.[0];
    return String(signer?.entityId || '').trim();
  }

  function getFirstEnvEntityId(): string {
    const env = get(xlnEnvironment);
    if (!env?.eReplicas) return '';
    const replicas = env.eReplicas instanceof Map
      ? Array.from(env.eReplicas.values())
      : Object.values(env.eReplicas as Record<string, EntityReplica>);
    for (const rawReplica of replicas) {
      const replica = rawReplica as EntityReplica;
      const entityId = String(replica?.entityId || '').trim();
      if (entityId) return entityId;
    }
    return '';
  }

  function getActiveTabEntityId(): string {
    const currentActiveTabId = get(activeTabId);
    const currentTabs = get(tabs);
    const activeTab = currentTabs.find((tab) => tab.id === currentActiveTabId) || null;
    return String(activeTab?.entityId || '').trim();
  }

  function normalizeId(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
  }

  function getHashRoute(): string {
    if (typeof window === 'undefined') return '';
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const qIndex = raw.indexOf('?');
    return qIndex >= 0 ? raw.slice(0, qIndex).trim().toLowerCase() : raw.trim().toLowerCase();
  }

  function getHashParams(): URLSearchParams {
    if (typeof window === 'undefined') return new URLSearchParams();
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const qIndex = raw.indexOf('?');
    if (qIndex >= 0) {
      return new URLSearchParams(raw.slice(qIndex + 1));
    }
    return raw.includes('=') ? new URLSearchParams(raw) : new URLSearchParams();
  }

  function rebuildEmbeddedHash(nextParams: Record<string, string>): void {
    if (typeof window === 'undefined') return;
    const currentParams = getHashParams();
    for (const [key, value] of Object.entries(nextParams)) {
      if (value) currentParams.set(key, value);
      else currentParams.delete(key);
    }
    currentParams.set('mode', 'embed');
    currentParams.set('segment', 'left');
    const parentOrigin = getParentOrigin();
    if (parentOrigin) currentParams.set('parentOrigin', parentOrigin);
    const nextHash = `#pay?${currentParams.toString()}`;
    if (window.location.hash === nextHash) return;
    history.replaceState(null, '', nextHash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    paymentIntentNonce += 1;
  }

  function resetPreparedRouteState(): void {
    routeStatus = 'booting';
    routeLabel = '';
    preparingRouteKey = '';
    preparedRouteKey = '';
    pendingClick = false;
    activated = false;
    clickStartedAt = 0;
    progress = 0;
    elapsedMs = 0;
    uiState = 'idle';
    statusText = '';
    clearProgressTimer();
    clearElapsedTimer();
    clearSuccessResetTimer();
  }

  function hasValidPaymentParams(): boolean {
    const route = getHashRoute();
    const params = getHashParams();
    return route === 'pay' && Boolean(params.get('id') && params.get('amt') && params.get('token'));
  }

  function getEmbeddedAction(): 'pay' {
    return 'pay';
  }

  function getEmbeddedSegment(): 'left' | 'right' | 'full' {
    const params = getHashParams();
    const raw = String(params.get('segment') || '').trim().toLowerCase();
    if (raw === 'left' || raw === 'right') return raw;
    return 'full';
  }

  function findEntityBySigner(env: Env | null, signerAddress: string | null | undefined): string {
    if (!env?.eReplicas || !signerAddress) return '';
    const signerLower = normalizeId(signerAddress);
    const replicas = env.eReplicas instanceof Map
      ? Array.from(env.eReplicas.values())
      : Object.values(env.eReplicas as Record<string, EntityReplica>);
    for (const rawReplica of replicas) {
      const replica = rawReplica as EntityReplica;
      if (normalizeId(replica?.signerId) !== signerLower) continue;
      const entityId = String(replica?.entityId || '').trim();
      if (entityId) return entityId;
    }
    return '';
  }

  async function ensureCheckoutEntity(): Promise<void> {
    if (ensuringEntity) return;
    const activeTabEntityId = getActiveTabEntityId();
    if (activeTabEntityId) {
      checkoutEntityId = activeTabEntityId;
      return;
    }
    const env = get(xlnEnvironment);
    const vault = get(activeVault);
    const signer = vault?.signers?.[vault?.activeSignerIndex ?? 0] || vault?.signers?.[0];
    const signerEntityId = String(signer?.entityId || '').trim();
    if (signerEntityId) {
      checkoutEntityId = signerEntityId;
      return;
    }
    const firstEnvEntityId = getFirstEnvEntityId();
    if (firstEnvEntityId) {
      checkoutEntityId = firstEnvEntityId;
      return;
    }
    if (!env || !vault || !signer?.address) return;

    const existingEntityId = findEntityBySigner(env, signer.address);
    if (existingEntityId) {
      checkoutEntityId = existingEntityId;
      if (signer.entityId !== existingEntityId) {
        vaultOperations.setSignerEntity(signer.index, existingEntityId);
      }
      return;
    }

    ensuringEntity = true;
    try {
      const createdEntityId = await createSelfEntity(env, signer.address, env.activeJurisdiction || undefined);
      const finalEntityId = findEntityBySigner(env, signer.address) || String(createdEntityId || '').trim();
      if (!finalEntityId) throw new Error('Failed to create payment entity');
      vaultOperations.setSignerEntity(signer.index, finalEntityId);
      checkoutEntityId = finalEntityId;
    } finally {
      ensuringEntity = false;
    }
  }

  function clearProgressTimer(): void {
    if (!progressTimer) return;
    clearInterval(progressTimer);
    progressTimer = null;
  }

  function clearElapsedTimer(): void {
    if (!elapsedTimer) return;
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  function clearSuccessResetTimer(): void {
    if (!successResetTimer) return;
    clearTimeout(successResetTimer);
    successResetTimer = null;
  }

  function startProgress(): void {
    clearProgressTimer();
    clearElapsedTimer();
    clearSuccessResetTimer();
    progress = 8;
    elapsedMs = 0;
    progressTimer = setInterval(() => {
      progress = Math.min(progress + (progress < 72 ? 6 : 2), 92);
    }, 140);
    elapsedTimer = setInterval(() => {
      if (clickStartedAt <= 0) return;
      elapsedMs = Math.max(1, Math.round(performance.now() - clickStartedAt));
      statusText = `Authorizing payment... ${elapsedMs} ms`;
    }, 40);
  }

  function finishSuccess(): void {
    console.info('[EmbedPayButton.finishSuccess]', { elapsedMs, clickStartedAt, uiState });
    clearProgressTimer();
    clearElapsedTimer();
    clearSuccessResetTimer();
    progress = 100;
    pendingClick = false;
    uiState = 'success';
    elapsedMs = clickStartedAt > 0 ? Math.max(1, Math.round(performance.now() - clickStartedAt)) : elapsedMs;
    statusText = 'Paid';
    postParentEvent('payment-success');
    successResetTimer = setTimeout(() => {
      uiState = 'idle';
      statusText = '';
      progress = 0;
      elapsedMs = 0;
      activated = false;
      clickStartedAt = 0;
    }, 1000);
  }

  function finishError(message: string): void {
    clearProgressTimer();
    clearElapsedTimer();
    clearSuccessResetTimer();
    progress = 0;
    elapsedMs = 0;
    pendingClick = false;
    uiState = 'error';
    statusText = message;
    activated = false;
    postParentEvent('payment-error', { message });
  }

  function mapRouteStatusMessage(message: string): string {
    const raw = String(message || '').trim();
    const lower = raw.toLowerCase();
    if (lower.includes('no route has enough real capacity') || lower.includes('enough real capacity')) {
      return 'No outbound';
    }
    if (lower.includes('no route found') || lower.includes('no route available')) {
      return 'No route found';
    }
    if (
      (lower.includes('profile') && lower.includes('missing')) ||
      lower.includes('has no downloaded gossip profile') ||
      lower.includes('profile has no encryption key')
    ) {
      return 'No route found';
    }
    return 'No outbound';
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function shouldRetryRoutePreparation(message: string): boolean {
    const raw = String(message || '').trim().toLowerCase();
    if (!raw) return true;
    if (raw.includes('no route has enough real capacity') || raw.includes('enough real capacity')) return false;
    if (raw.includes('no outbound')) return false;
    return true;
  }

  function normalizeRouteLabel(label: string): string {
    const raw = String(label || '').trim();
    if (!raw) return 'Pay';
    if (/^pay via /i.test(raw)) return raw;
    if (/^pay$/i.test(raw)) return 'Pay';
    return raw;
  }

  async function startPayment(): Promise<void> {
    if (
      !hasPaymentParams ||
      uiState === 'processing' ||
      uiState === 'success' ||
      embeddedAction !== 'pay' ||
      routeStatus !== 'route-ready' ||
      !readyToPay
    ) return;
    activated = true;
    pendingClick = true;
    uiState = 'processing';
    statusText = 'Preparing wallet...';
    clickStartedAt = performance.now();
    startProgress();
    await tick();
    const readyDeadline = Date.now() + 15_000;
    while (Date.now() < readyDeadline) {
      if (readyToPay && paymentPanelRef) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!readyToPay || !paymentPanelRef) {
      pendingClick = false;
      finishError('Wallet still loading');
      return;
    }
    statusText = 'Authorizing payment...';
    try {
      console.info('[EmbedPayButton.startPayment] invoking embeddedPayUsingFirstRoute');
      await paymentPanelRef.embeddedPayUsingFirstRoute?.();
      console.info('[EmbedPayButton.startPayment] embeddedPayUsingFirstRoute resolved');
      finishSuccess();
    } catch (error) {
      console.error('[EmbedPayButton.startPayment] failed', error);
      const message = error instanceof Error ? error.message : String(error);
      pendingClick = false;
      finishError(message || 'Payment failed');
    }
  }

  function getPrepareKey(): string {
    const params = getHashParams();
    return [
      checkoutEntityId,
      String(params.get('id') || ''),
      String(params.get('token') || ''),
      String(params.get('amt') || ''),
      String(params.get('desc') || ''),
    ].join('|');
  }

  async function prepareRoute(): Promise<void> {
    const key = getPrepareKey();
    if (!key || preparingRouteKey === key || preparedRouteKey === key || !paymentPanelRef?.embeddedPrepareFirstRoute) return;
    preparingRouteKey = key;
    routeStatus = 'finding-routes';
    routeLabel = '';
    const startedAt = Date.now();
    let lastMappedError = 'No route found';
    try {
      while (preparingRouteKey === key && Date.now() - startedAt < PREPARE_ROUTE_TIMEOUT_MS) {
        try {
          const label = await paymentPanelRef.embeddedPrepareFirstRoute();
          if (preparingRouteKey !== key) return;
          routeStatus = 'route-ready';
          routeLabel = normalizeRouteLabel(label);
          preparedRouteKey = key;
          statusText = '';
          return;
        } catch (error) {
          if (preparingRouteKey !== key) return;
          const message = error instanceof Error ? error.message : String(error);
          lastMappedError = mapRouteStatusMessage(message);
          if (!shouldRetryRoutePreparation(message)) {
            routeStatus = 'route-error';
            routeLabel = lastMappedError;
            preparedRouteKey = '';
            statusText = '';
            return;
          }
          routeStatus = 'finding-routes';
          routeLabel = '';
          statusText = '';
          await sleep(PREPARE_ROUTE_RETRY_MS);
        }
      }
      if (preparingRouteKey !== key) return;
      routeStatus = 'route-error';
      routeLabel = lastMappedError;
      preparedRouteKey = '';
      statusText = '';
    } finally {
      if (preparingRouteKey === key) {
        preparingRouteKey = '';
      }
    }
  }

  function handleParentMessage(event: MessageEvent): void {
    const payload = event.data as {
      source?: string;
      command?: string;
      amount?: string | number;
      tokenId?: string | number;
      entityId?: string;
      userId?: string;
      jurisdictionId?: string;
      description?: string;
    } | null;
    if (!payload || payload.source !== 'xln-custody') return;
    if (payload.command === 'pay-now') {
      void startPayment();
      return;
    }
    if (payload.command === 'update-intent') {
      rebuildEmbeddedHash({
        id: String(payload.entityId ?? '').trim(),
        amt: String(payload.amount ?? '').trim(),
        token: String(payload.tokenId ?? '').trim(),
        u: String(payload.userId ?? '').trim(),
        jId: String(payload.jurisdictionId ?? '').trim(),
        desc: String(payload.description ?? '').trim(),
      });
      resetPreparedRouteState();
    }
  }

  onMount(() => {
    window.addEventListener('message', handleParentMessage);
  });

  onDestroy(() => {
    window.removeEventListener('message', handleParentMessage);
    clearProgressTimer();
    clearElapsedTimer();
    clearSuccessResetTimer();
  });

  $: if ($activeVault && $xlnEnvironment && !checkoutEntityId && !$error) {
    void ensureCheckoutEntity();
  }
  $: if (!checkoutEntityId) {
    const activeTabEntityId = getActiveTabEntityId();
    const signerEntityId = getActiveSignerEntityId();
    const firstEnvEntityId = getFirstEnvEntityId();
    if (activeTabEntityId) checkoutEntityId = activeTabEntityId;
    else if (signerEntityId) checkoutEntityId = signerEntityId;
    else if (firstEnvEntityId) checkoutEntityId = firstEnvEntityId;
  }

  $: embeddedAction = getEmbeddedAction();
  $: embeddedSegment = getEmbeddedSegment();
  $: appReadyForPaymentPanel =
    !$isLoading &&
    !$error &&
    Boolean($xlnFunctions?.isReady) &&
    Boolean($xlnEnvironment && String($xlnEnvironment.runtimeId || '').trim());
  $: hasStoredRuntime = Object.keys($runtimesState?.runtimes || {}).length > 0;
  $: hasVaultRuntime = Boolean($activeVault) || hasStoredRuntime;
  $: hasSelectedRuntime =
    Boolean($activeVault) ||
    Boolean(
      $runtimesState?.activeRuntimeId &&
      $runtimesState?.runtimes?.[$runtimesState.activeRuntimeId],
    );
  $: hasPaymentParams = hasValidPaymentParams();
  $: bootResolved = !$isLoading && !$error && Boolean($xlnFunctions?.isReady) && $vaultStorageLoaded;
  $: runtimeSelectionSettled =
    !hasStoredRuntime ||
    hasSelectedRuntime ||
    appReadyForPaymentPanel ||
    ensuringEntity ||
    hasSenderEntity;
  $: readyToPay = hasPaymentParams && appReadyForPaymentPanel && Boolean(checkoutEntityId);
  $: if (paymentIntentNonce >= 0 && hasPaymentParams && appReadyForPaymentPanel && checkoutEntityId && paymentPanelRef && uiState === 'idle' && routeStatus === 'booting') {
    void prepareRoute();
  }
  $: idleLabel = (() => {
    if (!hasPaymentParams) return 'Missing params';
    if (!$vaultStorageLoaded) return 'Loading wallet...';
    if (!hasVaultRuntime) return 'No runtimes';
    if (!bootResolved) return 'Loading wallet...';
    if (!runtimeSelectionSettled) return 'Loading wallet...';
    if (ensuringEntity) return 'Loading profile...';
    if (routeStatus === 'booting') return hasSenderEntity ? 'Finding routes...' : 'Loading wallet...';
    if (routeStatus === 'finding-routes') return 'Finding routes...';
    if (routeStatus === 'route-ready' && routeLabel) return routeLabel;
    if (routeStatus === 'route-error' && routeLabel) return routeLabel;
    return 'Loading wallet...';
  })();
  $: buttonLabel = uiState === 'success'
    ? 'Paid'
    : uiState === 'processing'
      ? (pendingClick && !readyToPay
          ? 'Preparing...'
          : (elapsedMs > 0 ? `Paying... ${elapsedMs} ms` : 'Paying...'))
      : uiState === 'error'
        ? idleLabel
        : idleLabel;
  $: disabled =
    uiState === 'processing' ||
    uiState === 'success' ||
    !hasPaymentParams ||
    embeddedAction !== 'pay' ||
    routeStatus !== 'route-ready' ||
    !readyToPay;
  $: hasSenderEntity = Boolean(checkoutEntityId);
  $: if (uiState === 'idle') {
    statusText = $error
      ? $error
      : !hasPaymentParams
        ? 'Missing payment parameters'
        : !$vaultStorageLoaded
          ? 'Loading wallet...'
          : !hasVaultRuntime
            ? 'No runtimes'
            : !bootResolved
          ? 'Loading wallet...'
          : !runtimeSelectionSettled
            ? 'Loading wallet...'
          : ensuringEntity
            ? 'Loading profile...'
            : routeStatus === 'finding-routes'
              ? 'Finding routes...'
              : routeStatus === 'route-error' && routeLabel
                ? routeLabel
                : routeStatus === 'route-ready'
                  ? ''
                  : hasSenderEntity
                    ? 'Finding routes...'
                    : 'Loading wallet...';
  }
  $: {
    const signature = [
      embeddedAction,
      embeddedSegment,
      readyToPay ? '1' : '0',
      hasVaultRuntime ? '1' : '0',
      hasSenderEntity ? '1' : '0',
      hasPaymentParams ? '1' : '0',
      $isLoading ? '1' : '0',
      $error ? '1' : '0',
      ensuringEntity ? '1' : '0',
      statusText,
    ].join('|');
    if (signature !== lastDebugSignature) {
      lastDebugSignature = signature;
      console.log('[EmbedPayButton]', {
        action: embeddedAction,
        segment: embeddedSegment,
        routeStatus,
        routeLabel,
        readyToPay,
        hasVaultRuntime,
        hasSenderEntity,
        hasPaymentParams,
        isLoading: $isLoading,
        error: $error,
        ensuringEntity,
        statusText,
        checkoutEntityId,
      });
    }
  }
  $: {
    const stateSignature = [
      buttonLabel,
      disabled ? '1' : '0',
      readyToPay ? '1' : '0',
      routeStatus,
      routeLabel,
      uiState,
      statusText,
      hasVaultRuntime ? '1' : '0',
      hasSenderEntity ? '1' : '0',
      hasPaymentParams ? '1' : '0',
      $isLoading ? '1' : '0',
      $error ? '1' : '0',
      ensuringEntity ? '1' : '0',
    ].join('|');
    if (stateSignature !== lastPostedStateSignature) {
      lastPostedStateSignature = stateSignature;
      postParentState();
    }
  }
</script>

<div class="embedded-pay-shell">
  <button
    class="paybutton"
    class:pay-action={embeddedAction === 'pay'}
    class:segment-left={embeddedSegment === 'left'}
    class:segment-right={embeddedSegment === 'right'}
    class:segment-full={embeddedSegment === 'full'}
    type="button"
    on:click={startPayment}
    disabled={disabled}
    data-ready-to-pay={readyToPay ? '1' : '0'}
    data-has-vault-runtime={hasVaultRuntime ? '1' : '0'}
    data-has-sender-entity={hasSenderEntity ? '1' : '0'}
    data-has-payment-params={hasPaymentParams ? '1' : '0'}
    data-is-loading={$isLoading ? '1' : '0'}
    data-has-error={$error ? '1' : '0'}
    data-ensuring-entity={ensuringEntity ? '1' : '0'}
  >
    <span class="logo-mark" aria-hidden="true">
      <img src="/img/logo.png" alt="" />
    </span>
    <span>{buttonLabel}</span>
    <span class="progress-fill" style={`width:${progress}%`}></span>
  </button>

  {#if checkoutEntityId && appReadyForPaymentPanel}
    <div class="hidden-payment-panel" aria-hidden="true">
      <PaymentPanel bind:this={paymentPanelRef} entityId={checkoutEntityId} />
    </div>
  {/if}
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .embedded-pay-shell {
    width: 100%;
    display: grid;
    gap: 8px;
    padding: 0;
  }

  .paybutton {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    width: 100%;
    min-height: 64px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 24px;
    border-radius: 0;
    border: 1px solid rgba(244, 216, 151, 0.24);
    background: linear-gradient(180deg, #2f2a24 0%, #241f1a 100%);
    color: #fff;
    font: 700 18px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    letter-spacing: -0.01em;
    cursor: pointer;
    box-shadow:
      0 18px 40px rgba(7, 7, 7, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
    transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease, opacity 0.18s ease;
  }

  .paybutton.segment-full {
    border-radius: 24px;
  }

  .paybutton.segment-left {
    border-radius: 24px 0 0 24px;
    border-right: 0;
  }

  .paybutton.segment-right {
    border-radius: 0 24px 24px 0;
    border-left: 0;
  }

  .paybutton > :not(.progress-fill) {
    position: relative;
    z-index: 1;
  }

  .progress-fill {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 0;
    background: linear-gradient(90deg, rgba(242, 211, 122, 0.22), rgba(242, 211, 122, 0.4));
    transition: width 0.18s ease;
  }

  .paybutton:hover:not(:disabled) {
    background: linear-gradient(180deg, #3a332c 0%, #2a241f 100%);
    box-shadow:
      0 22px 44px rgba(7, 7, 7, 0.24),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
    transform: translateY(-1px);
  }

  .paybutton.pay-action:hover:not(:disabled) {
    background: linear-gradient(180deg, #463a2a 0%, #34291d 100%);
  }

  .paybutton:disabled {
    cursor: default;
    opacity: 0.9;
  }

  .logo-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.98;
  }

  .logo-mark img {
    width: 24px;
    height: 24px;
    display: block;
    object-fit: contain;
    filter: brightness(1.14) contrast(1.05);
  }

  .hidden-payment-panel {
    position: fixed;
    left: -10000px;
    top: -10000px;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
  }
</style>
