<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { writable, get } from 'svelte/store';
  import { formatUnits } from 'ethers';
  import { requireTokenDecimals } from '$lib/components/Entity/token-metadata';
  import type { Env } from '@xln/runtime/xln-api';
  import type { EnvSnapshot } from '$types';
  import { toasts } from '$lib/stores/toastStore';
  import { paymentSpotlight } from '$lib/stores/paymentSpotlightStore';
  import UserModePanel from './UserModePanel.svelte';
  import CommandPalette from '../components/shared/CommandPalette.svelte';
  import {
    buildCommandPaletteView,
    buildCommandPaletteViewFromRuntimeView,
    emptyCommandPaletteView,
    type CommandPaletteView,
  } from '$lib/components/shared/command-palette-view';
  import PaymentSpotlight from '$lib/components/PaymentSpotlight.svelte';
  import { errorLog } from '$lib/stores/errorLogStore';
  import { panelBridge } from './utils/panelBridge';
  import { getEnv, getXLN, history as runtimeHistory, xlnEnvironment, xlnInstance } from '$lib/stores/xlnStore';
  import {
    onRuntimeControllerStatus,
    runtimeControllerHandle,
  } from '$lib/stores/runtimeControllerStore';
  import { activeRuntimeId } from '$lib/stores/runtimeStore';
  import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore';
  import { createDetachedRuntimeViewEnv, createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
  import { isLocalDebugSurfaceAllowed, registerDebugSurface } from '$lib/utils/debugSurface';

  let commandPaletteOpen = false;
  let commandPaletteView: CommandPaletteView = emptyCommandPaletteView();

  function handlePaletteCommand(event: CustomEvent<{ type: string; args: Record<string, unknown> }>) {
    const { type, args } = event.detail;
    commandPaletteOpen = false;

    if (type === 'navigate') {
      const tab = String(args['tab'] || '');
      if (tab) panelBridge.emit('settings:update', { key: 'activeTab', value: tab });
    } else if (type === 'pay') {
      panelBridge.emit('settings:update', { key: 'activeTab', value: 'accounts' });
      panelBridge.emit('settings:update', { key: 'payPrefill', value: args });
    } else if (type === 'swap') {
      panelBridge.emit('settings:update', { key: 'activeTab', value: 'accounts' });
      panelBridge.emit('settings:update', { key: 'swapPrefill', value: args });
    } else if (type === 'open') {
      panelBridge.emit('settings:update', { key: 'activeTab', value: 'accounts' });
    } else if (type === 'explore') {
      const entityId = String(args['entityId'] || '');
      if (entityId) panelBridge.emit('openEntityOperations', { entityId, entityName: '' });
    }
  }

  export let layout: string = 'default'; void layout;
  export let networkMode: 'simnet' | 'testnet' | 'mainnet' = 'simnet'; void networkMode;
  export let embedMode = false;
  export let scenarioId = '';
  export let userMode = false;
  export let requestedPanelId: string | null = null;

  type RuntimeLogEntry = {
    id?: number;
    level?: string;
    message?: string;
    data?: Record<string, unknown>;
  };

  const localEnvStore = writable<Env | null>(null);
  const localEnvRevisionStore = writable<number>(0);
  const localHistoryStore = writable<EnvSnapshot[]>([]);
  const localTimeIndex = writable<number>(-1);
  const localIsLive = writable<boolean>(true);

  const unsubLocalEnvSync = () => undefined;

  const LOG_TOAST_COOLDOWN_MS = 12000;
  const RUNTIME_VIEW_REFRESH_MIN_INTERVAL_MS = 250;
  const lastSeenFrameLogIdByRuntime = new Map<string, number>();
  const lastToastAtByKey = new Map<string, number>();
  const PAYMENT_SPOTLIGHT_COOLDOWN_MS = 60000;
  const lastPaymentSpotlightAtByKey = new Map<string, number>();
  const normalizeRuntimeId = (value: unknown): string => String(value || '').trim().toLowerCase();

  const runtimeEnvMatchesActiveSelection = (env: Env | null): boolean => {
    const selectedRuntimeId = normalizeRuntimeId(get(activeRuntimeId));
    if (!selectedRuntimeId) return true;
    return normalizeRuntimeId(env?.runtimeId) === selectedRuntimeId;
  };

  const publishLocalEnv = (env: Env | null) => {
    const runtimeEnv = env ? (unwrapLiveRuntimeEnv(env) ?? env) : null;
    if (runtimeEnv && !runtimeEnvMatchesActiveSelection(runtimeEnv)) {
      const message = `VIEW_RUNTIME_ENV_MISMATCH: refusing local env publish for inactive runtime ${normalizeRuntimeId(runtimeEnv.runtimeId)}`;
      errorLog.log(message, 'Runtime View', {
        runtimeId: normalizeRuntimeId(runtimeEnv.runtimeId),
        activeRuntimeId: normalizeRuntimeId(get(activeRuntimeId)),
      });
      localEnvStore.set(null);
      commandPaletteView = emptyCommandPaletteView();
      localEnvRevisionStore.update((revision) => revision + 1);
      throw new Error(message);
    }
    const viewEnv = runtimeEnv ? createRuntimeViewEnv(runtimeEnv) : null;
    localEnvStore.set(viewEnv);
    commandPaletteView = viewEnv
      ? buildCommandPaletteView(viewEnv)
      : (get(runtimeControllerHandle).mode === 'remote'
        ? buildCommandPaletteViewFromRuntimeView(get(runtimeView).frame)
        : emptyCommandPaletteView());
    localEnvRevisionStore.update((revision) => revision + 1);
  };

  const resolveLocalDebugEnv = (): Env | null => {
    const projectedEnv = get(localEnvStore);
    const projectedRuntimeEnv = projectedEnv ? (unwrapLiveRuntimeEnv(projectedEnv) ?? projectedEnv) : null;
    const activeEnv = getEnv();
    const liveRuntimeEnv = activeEnv ? (unwrapLiveRuntimeEnv(activeEnv) ?? activeEnv) : null;
    const selectedRuntimeId = normalizeRuntimeId(get(activeRuntimeId));
    const projectedRuntimeId = normalizeRuntimeId(projectedRuntimeEnv?.runtimeId);
    const liveRuntimeId = normalizeRuntimeId(liveRuntimeEnv?.runtimeId);
    const liveRuntimeMatchesSelection = Boolean(!selectedRuntimeId || (liveRuntimeId && liveRuntimeId === selectedRuntimeId));
    const projectedRuntimeMatchesSelection = Boolean(projectedRuntimeEnv && (!selectedRuntimeId || projectedRuntimeId === selectedRuntimeId));
    const liveRuntimeMatchesProjection = Boolean(
      liveRuntimeEnv &&
      liveRuntimeId &&
      liveRuntimeMatchesSelection &&
      (!projectedRuntimeId || projectedRuntimeId === liveRuntimeId),
    );
    const liveRuntimeOwnsInfra = Boolean(
      liveRuntimeEnv?.runtimeState?.p2p ||
      liveRuntimeEnv?.runtimeState?.loopActive,
    );
    if (projectedRuntimeEnv && !projectedRuntimeMatchesSelection) return null;
    return liveRuntimeMatchesProjection && liveRuntimeOwnsInfra
      ? liveRuntimeEnv
      : (projectedRuntimeMatchesSelection ? projectedRuntimeEnv : null);
  };

  const forceLiveCursor = () => {
    localIsLive.set(true);
    localTimeIndex.set(-1);
  };

  const setLocalHistoryPreservingCursor = (frames: EnvSnapshot[]) => {
    localHistoryStore.set(frames);
    if (get(localIsLive)) {
      localTimeIndex.set(-1);
      return;
    }
    if (frames.length === 0) {
      forceLiveCursor();
      return;
    }
    const selectedIndex = get(localTimeIndex);
    if (selectedIndex >= frames.length) {
      localTimeIndex.set(frames.length - 1);
    }
  };

  const formatSpotlightAmount = (tokenIdRaw: unknown, amountRaw: unknown): string => {
    const tokenId = Number(tokenIdRaw || 0);
    const amountMinor = String(amountRaw || '').trim();
    if (!tokenId || !amountMinor) return 'Payment settled';
    const token = get(xlnInstance)?.getTokenInfo(tokenId);
    if (!token) throw new Error(`TOKEN_METADATA_READER_UNAVAILABLE:token:${tokenId}`);
    return `${formatUnits(
      BigInt(amountMinor),
      requireTokenDecimals(token.decimals, `token:${tokenId}`),
    )} ${token.symbol}`;
  };

  const shouldSurfaceLogAsToast = (entry: RuntimeLogEntry): boolean => {
    const level = String(entry?.level || '').toLowerCase();
    const message = String(entry?.message || '').toLowerCase();
    if (level === 'error') return true;
    const criticalTokens = [
      'ws_client_error',
      'ws_connect_failed',
      'ws_disconnected',
      'decrypt_fail',
      'frame_consensus_failed',
      'p2p_unencrypted',
      'jsonrpcprovider failed to detect network',
      'testnet j-machine not found',
      'route-defer',
    ];
    return criticalTokens.some((token) => message.includes(token));
  };

  const unsubRuntimeErrorToasts = localEnvStore.subscribe((env) => {
    if (!env?.frameLogs || !Array.isArray(env.frameLogs)) return;
    const runtimeKey = String(env.runtimeId || 'unknown');
    const lastSeen = lastSeenFrameLogIdByRuntime.get(runtimeKey) ?? -1;
    const isInitialPass = lastSeen < 0;
    let newLastSeen = lastSeen;

    for (const entry of env.frameLogs as RuntimeLogEntry[]) {
      const id = Number(entry?.id);
      if (!Number.isFinite(id) || id <= lastSeen) continue;
      if (id > newLastSeen) newLastSeen = id;
      const message = String(entry?.message || '').trim();
      const entryData = entry?.data || {};

      if (!isInitialPass && (message === 'HtlcReceived' || message === 'HtlcFinalized')) {
        const hashlock = String(entryData['hashlock'] || id);
        const dedupeKey = `${runtimeKey}:${message}:${hashlock}`;
        const now = Date.now();
        const lastShownAt = lastPaymentSpotlightAtByKey.get(dedupeKey) ?? 0;
        if (now - lastShownAt >= PAYMENT_SPOTLIGHT_COOLDOWN_MS) {
          const isSender = message === 'HtlcFinalized';
          const elapsedMsRaw = Number(entryData['finalizedInMs'] ?? entryData['elapsedMs'] ?? 0);
          const elapsedMs = Number.isFinite(elapsedMsRaw) && elapsedMsRaw > 0 ? Math.max(1, Math.floor(elapsedMsRaw)) : null;
          lastPaymentSpotlightAtByKey.set(dedupeKey, now);
          paymentSpotlight.show({
            kicker: isSender ? 'Payment Sent' : 'Payment Received',
            title: elapsedMs ? `${isSender ? 'Paid' : 'Received'} in ${elapsedMs}ms` : (isSender ? 'Paid' : 'Received'),
            amountLine: formatSpotlightAmount(entryData['tokenId'], entryData['amount']),
            ...(String(entryData['description'] || '').trim() ? { detail: String(entryData['description'] || '').trim() } : {}),
            duration: 4200,
          });
        }
      }

      if (!shouldSurfaceLogAsToast(entry)) continue;

      const level = String(entry?.level || 'warn').toLowerCase();
      const toastMessage = String(entry?.message || 'Runtime error');
      const dedupeKey = `${runtimeKey}:${toastMessage}`;
      const now = Date.now();
      const lastToastAt = lastToastAtByKey.get(dedupeKey) ?? 0;
      if (now - lastToastAt < LOG_TOAST_COOLDOWN_MS) continue;
      lastToastAtByKey.set(dedupeKey, now);
      if (lastToastAtByKey.size > 1000) lastToastAtByKey.clear();

      const text = `${level === 'error' ? 'Runtime error' : 'Runtime warning'}: ${toastMessage}`;
      if (level === 'error') toasts.error(text, 9000);
      else toasts.warning(text, 7000);
    }

    if (newLastSeen > lastSeen) {
      lastSeenFrameLogIdByRuntime.set(runtimeKey, newLastSeen);
      if (lastSeenFrameLogIdByRuntime.size > 200) lastSeenFrameLogIdByRuntime.clear();
    }
  });

  if (isLocalDebugSurfaceAllowed()) {
    registerDebugSurface('liveRuntimeSnapshot', () => {
      const runtimeEnv = resolveLocalDebugEnv();
      return runtimeEnv ? createDetachedRuntimeViewEnv(runtimeEnv) : null;
    }, { enumerable: true });
    registerDebugSurface('publishLiveRuntimeSnapshot', () => publishLocalEnv, { enumerable: true });
    registerDebugSurface('view', () => get(runtimeView), {
      enumerable: true,
    });
  }

  let unsubRuntimeEnv: (() => void) | null = null;
  let unsubRuntimeHistory: (() => void) | null = null;
  let unsubRuntimeViewPalette: (() => void) | null = null;
  let publishedRuntimeKey: string | null = null;
  let unregisterRuntimeStatus: (() => void) | null = null;
  let runtimeViewRefreshPromise: Promise<unknown> | null = null;
  let runtimeViewRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let runtimeViewRefreshQueued = false;
  let lastRuntimeViewRefreshAt = 0;
  let dockRootPromise: Promise<typeof import('./DockRoot.svelte')> | null = null;

  const surfaceRuntimeViewError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || 'RuntimeView error');
    errorLog.log('RuntimeView projection failed', 'Runtime View', error);
    toasts.error(`Runtime view failed: ${message}`, 9000);
  };

  const refreshCurrentRuntimeView = (immediate = false): Promise<unknown> => {
    if (runtimeViewRefreshPromise) {
      runtimeViewRefreshQueued = true;
      return runtimeViewRefreshPromise;
    }
    const now = Date.now();
    const waitMs = immediate
      ? 0
      : Math.max(0, RUNTIME_VIEW_REFRESH_MIN_INTERVAL_MS - (now - lastRuntimeViewRefreshAt));
    if (waitMs > 0) {
      runtimeViewRefreshQueued = true;
      if (!runtimeViewRefreshTimer) {
        runtimeViewRefreshTimer = setTimeout(() => {
          runtimeViewRefreshTimer = null;
          void refreshCurrentRuntimeView(true);
        }, waitMs);
      }
      return Promise.resolve(null);
    }
    lastRuntimeViewRefreshAt = now;
    runtimeViewRefreshPromise = refreshRuntimeView()
      .catch((error) => {
        surfaceRuntimeViewError(error);
      })
      .finally(() => {
        runtimeViewRefreshPromise = null;
        if (runtimeViewRefreshQueued) {
          runtimeViewRefreshQueued = false;
          void refreshCurrentRuntimeView();
        }
      });
    return runtimeViewRefreshPromise;
  };

  $: if (typeof document !== 'undefined') {
    const isAppRoute = window.location.pathname === '/app' || window.location.pathname.startsWith('/app/');
    document.documentElement.setAttribute('data-xln-route-mode', isAppRoute ? 'app' : 'default');
    document.documentElement.classList.toggle('xln-user-mode', userMode);
    document.body.classList.toggle('xln-user-mode', userMode);
  }

  $: dockRootPromise = userMode ? null : import('./DockRoot.svelte');

  onMount(async () => {
    void scenarioId;
    try {
      xlnInstance.set(await getXLN());

      unsubRuntimeHistory = runtimeHistory.subscribe((frames) => {
        if (!publishedRuntimeKey) {
          localHistoryStore.set(frames);
          return;
        }
        setLocalHistoryPreservingCursor(frames);
      });

      unsubRuntimeEnv = xlnEnvironment.subscribe((env) => {
        try {
          const runtimeEnv = env ? (unwrapLiveRuntimeEnv(env) ?? env) : null;
          const runtimeKey = String(runtimeEnv?.runtimeId || '').trim().toLowerCase() || null;
          publishLocalEnv(runtimeEnv);
          const frames = get(runtimeHistory);
          if (publishedRuntimeKey !== runtimeKey) {
            localHistoryStore.set(frames);
            forceLiveCursor();
            publishedRuntimeKey = runtimeKey;
          } else {
            setLocalHistoryPreservingCursor(frames);
          }
        } catch (error) {
          surfaceRuntimeViewError(error);
        }
      });

      unsubRuntimeViewPalette = runtimeView.subscribe((view) => {
        if (get(runtimeControllerHandle).mode !== 'remote') return;
        commandPaletteView = buildCommandPaletteViewFromRuntimeView(view.frame);
      });

      unregisterRuntimeStatus = onRuntimeControllerStatus((status) => {
        if (status === 'connected') void refreshCurrentRuntimeView();
      });
      void refreshCurrentRuntimeView(true);
    } catch (err) {
      errorLog.log('Failed to initialize XLN view', 'Runtime View', err);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-xln-route-mode', 'default');
      document.documentElement.classList.remove('xln-user-mode');
      document.body.classList.remove('xln-user-mode');
    }
    unsubLocalEnvSync();
    unsubRuntimeErrorToasts();
    unsubRuntimeEnv?.();
    unsubRuntimeHistory?.();
    unsubRuntimeViewPalette?.();
    unregisterRuntimeStatus?.();
    if (runtimeViewRefreshTimer) clearTimeout(runtimeViewRefreshTimer);
    lastSeenFrameLogIdByRuntime.clear();
    lastToastAtByKey.clear();
    lastPaymentSpotlightAtByKey.clear();
  });
</script>

<CommandPalette
  bind:isOpen={commandPaletteOpen}
  {commandPaletteView}
  on:command={handlePaletteCommand}
  on:close={() => commandPaletteOpen = false}
/>
<PaymentSpotlight />

{#if userMode}
  <UserModePanel
    runtimeFrameEnv={localEnvStore}
    runtimeFrameRevision={localEnvRevisionStore}
    runtimeFrameHistory={localHistoryStore}
    runtimeFrameTimeIndex={localTimeIndex}
    runtimeFrameIsLive={localIsLive}
    liveEnvResolver={resolveLocalDebugEnv}
  />
{:else if dockRootPromise}
  {#await dockRootPromise then module}
    <svelte:component
      this={module.default}
      {embedMode}
      runtimeFrameEnv={localEnvStore}
      runtimeFrameHistory={localHistoryStore}
      runtimeFrameTimeIndex={localTimeIndex}
      runtimeFrameIsLive={localIsLive}
      {requestedPanelId}
    />
  {:catch err}
    <div class="view-error">
      <h2>Dock workspace failed to load</h2>
      <p>{(err as Error)?.message || 'Unknown error'}</p>
    </div>
  {/await}
{/if}

<style>
  .view-error {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    gap: 8px;
    padding: 24px;
    background: var(--theme-bg-gradient, #0a0a0a);
    color: var(--theme-text-primary, #e4e4e7);
    text-align: center;
  }

  .view-error h2 {
    margin: 0;
    font-size: 20px;
  }

  .view-error p {
    margin: 0;
    color: var(--theme-text-secondary, #a1a1aa);
  }
</style>
