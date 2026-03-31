<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { writable, get } from 'svelte/store';
  import { formatUnits } from 'ethers';
  import type { Env } from '@xln/runtime/xln-api';
  import type { EnvSnapshot } from '$types';
  import { toasts } from '$lib/stores/toastStore';
  import { paymentSpotlight } from '$lib/stores/paymentSpotlightStore';
  import UserModePanel from './UserModePanel.svelte';
  import CommandPalette from '../components/shared/CommandPalette.svelte';
  import PaymentSpotlight from '$lib/components/PaymentSpotlight.svelte';
  import { parseURLHash } from './utils/stateCodec';
  import { panelBridge } from './utils/panelBridge';
  import { activeRuntimeId, runtimeOperations, runtimes } from '$lib/stores/runtimeStore';
  import { getXLN, xlnInstance } from '$lib/stores/xlnStore';

  let commandPaletteOpen = false;

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

  type RuntimeLogEntry = {
    id?: number;
    level?: string;
    message?: string;
    data?: Record<string, unknown>;
  };

  const localEnvStore = writable<Env | null>(null);
  const localHistoryStore = writable<EnvSnapshot[]>([]);
  const localTimeIndex = writable<number>(-1);
  const localIsLive = writable<boolean>(true);

  const unsubLocalEnvSync = localEnvStore.subscribe((env) => {
    if (env) runtimeOperations.updateLocalEnv(env);
  });

  const LOG_TOAST_COOLDOWN_MS = 12000;
  const lastSeenFrameLogIdByRuntime = new Map<string, number>();
  const lastToastAtByKey = new Map<string, number>();
  const PAYMENT_SPOTLIGHT_COOLDOWN_MS = 60000;
  const lastPaymentSpotlightAtByKey = new Map<string, number>();

  const formatSpotlightAmount = (tokenIdRaw: unknown, amountRaw: unknown): string => {
    const tokenId = Number(tokenIdRaw || 0);
    const amountMinor = String(amountRaw || '').trim();
    if (!tokenId || !amountMinor) return 'Payment settled';
    try {
      const token = get(xlnInstance)?.getTokenInfo?.(tokenId) ?? { symbol: `T${tokenId}`, decimals: 18 };
      return `${formatUnits(BigInt(amountMinor), token.decimals ?? 18)} ${token.symbol || `T${tokenId}`}`;
    } catch {
      return 'Payment settled';
    }
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

  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    Object.defineProperty(window, 'isolatedEnv', {
      get() {
        return get(localEnvStore);
      },
      configurable: true,
      enumerable: true,
    });
  }

  let unsubActiveRuntime: (() => void) | null = null;
  let envChangeRegisteredFor: string | null = null;
  let unregisterEnvChange: (() => void) | null = null;
  let dockRootPromise: Promise<typeof import('./DockRoot.svelte')> | null = null;

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
      const XLN = await getXLN();
      xlnInstance.set(XLN);

      const urlImport = parseURLHash();
      let env;

      if (urlImport) {
        env = XLN.createEmptyEnv();
        env.quietRuntimeLogs = true;
        env.jReplicas = urlImport.state.x as unknown as typeof env.jReplicas;
        env.activeJurisdiction = urlImport.state.a;
        env.eReplicas = urlImport.state.e as unknown as typeof env.eReplicas;
      } else {
        const runtimeId = get(activeRuntimeId);
        if (runtimeId) {
          const runtime = get(runtimes).get(runtimeId);
          if (runtime?.env) env = runtime.env;
        }
      }

      const registerEnvChanges = (envToRegister: Env | null) => {
        if (!envToRegister || !XLN.registerEnvChangeCallback) return;
        const runtimeKey = envToRegister.runtimeId || null;
        if (envChangeRegisteredFor === runtimeKey) return;
        if (unregisterEnvChange) {
          unregisterEnvChange();
          unregisterEnvChange = null;
        }
        unregisterEnvChange = XLN.registerEnvChangeCallback(envToRegister, (nextEnv: Env) => {
          localEnvStore.set(nextEnv);
          localHistoryStore.set(nextEnv.history || []);
        });
        envChangeRegisteredFor = runtimeKey;
      };

      if (env) {
        localEnvStore.set(env);
        localHistoryStore.set(env.history || []);
        const histLen = (env.history || []).length;
        const importedTimeIndex = urlImport?.state.ui?.ti;
        const importedIsLive = userMode ? true : importedTimeIndex === undefined;
        localIsLive.set(importedIsLive);
        const nextTimeIndex = importedIsLive || importedTimeIndex === undefined
          ? -1
          : Math.min(importedTimeIndex, Math.max(0, histLen - 1));
        localTimeIndex.set(nextTimeIndex);
        registerEnvChanges(env);
      }

      unsubActiveRuntime = activeRuntimeId.subscribe((runtimeId) => {
        if (!runtimeId) return;
        const allRuntimes = get(runtimes);
        const runtime = allRuntimes.get(runtimeId);
        if (!runtime?.env) return;

        localEnvStore.set(runtime.env);
        localHistoryStore.set(runtime.env.history || []);
        localIsLive.set(true);
        localTimeIndex.set(-1);
        registerEnvChanges(runtime.env);
      });
    } catch (err) {
      console.error('[View] Failed to initialize XLN:', err);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-xln-route-mode', 'default');
      document.documentElement.classList.remove('xln-user-mode');
      document.body.classList.remove('xln-user-mode');
    }
    unregisterEnvChange?.();
    unsubLocalEnvSync();
    unsubRuntimeErrorToasts();
    unsubActiveRuntime?.();
    lastSeenFrameLogIdByRuntime.clear();
    lastToastAtByKey.clear();
    lastPaymentSpotlightAtByKey.clear();
  });
</script>

<CommandPalette bind:isOpen={commandPaletteOpen} on:command={handlePaletteCommand} on:close={() => commandPaletteOpen = false} />
<PaymentSpotlight />

{#if userMode}
  <UserModePanel
    isolatedEnv={localEnvStore}
    isolatedHistory={localHistoryStore}
    isolatedTimeIndex={localTimeIndex}
    isolatedIsLive={localIsLive}
  />
{:else if dockRootPromise}
  {#await dockRootPromise then module}
    <svelte:component
      this={module.default}
      {embedMode}
      isolatedEnv={localEnvStore}
      isolatedHistory={localHistoryStore}
      isolatedTimeIndex={localTimeIndex}
      isolatedIsLive={localIsLive}
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
