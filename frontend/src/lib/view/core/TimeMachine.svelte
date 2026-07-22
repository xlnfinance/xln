<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { type Writable, type Readable } from 'svelte/store';
  import type { Env, EnvSnapshot, JReplica, RuntimeAdapterViewFrame, XLNModule } from '@xln/runtime/xln-api';
  import type { JAdapter } from '@xln/runtime/jadapter';
  import { DISPLAY, TIME_MACHINE } from '@xln/runtime/constants';
  import FrameSubtitle from '../../components/TimeMachine/FrameSubtitle.svelte';
  import NetworkMachineTimeline from './NetworkMachineTimeline.svelte';
  import { runtimeGraphScope } from '$lib/stores/runtimeGraphControlStore';
  import { panelBridge } from '../utils/panelBridge';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { activeRuntimeId, runtimeOperations, runtimes } from '$lib/stores/runtimeStore';
  import {
    runtimeView,
    runtimeViewActiveEntityId,
    runtimeViewHistoryScan,
    setRuntimeViewAtHeight,
    setRuntimeViewActiveEntityId,
    type RuntimeViewHistoryScanState,
  } from '$lib/stores/runtimeViewStore';
  import { toasts } from '$lib/stores/toastStore';
  import { appState, appStateOperations } from '$lib/stores/appStateStore';
  import {
    getXLN,
    refreshCurrentRuntimeProjection,
  } from '$lib/stores/xlnStore';
  import {
    REMOTE_HISTORY_SCAN_CACHE_LIMIT,
    runtimeHistoryFrames,
    scanRuntimeAdapterHistoryAtHeight,
    type RuntimeHistoryFrame,
  } from '$lib/stores/runtimeHistoryStore';
  // BrowserVM resolved via JAdapter

  // Props: Accept both Writable and Readable stores (for global vs isolated usage)
  export let history: Writable<EnvSnapshot[]> | Readable<EnvSnapshot[]>;
  export let timeIndex: Writable<number> | Readable<number>;
  export let isLive: Writable<boolean> | Readable<boolean>;
  export let env: Writable<Env | null> | Readable<Env | null>; // For state export

  // Type guard to check if store is writable
  function isWritable<T>(store: Writable<T> | Readable<T>): store is Writable<T> {
    return 'set' in store;
  }

  // Safe set helper
  function safeSet<T>(store: Writable<T> | Readable<T>, value: T) {
    if (isWritable(store)) {
      store.set(value);
    }
  }

  const LIVE_TIME_INDEX = -1;

  // Direct store usage - no fallback logic
  $: isRemoteRuntime = $runtimeControllerHandle.mode === 'remote';
  $: maxTimeIndex = Math.max(0, (isRemoteRuntime ? $runtimeHistoryFrames.length : $history.length) - 1);
  $: selectedFrameIndex = $isLive || $timeIndex < 0
    ? maxTimeIndex
    : Math.max(0, Math.min($timeIndex, maxTimeIndex));

  // Canonical contract: -1 means LIVE/current env; >=0 means historical frame.
  $: if ($isLive && $timeIndex !== LIVE_TIME_INDEX) {
    safeSet(timeIndex, LIVE_TIME_INDEX);
  }
  $: if (!$isLive && $timeIndex === LIVE_TIME_INDEX) {
    safeSet(isLive, true);
  }

  // BrowserVM time-travel: restore EVM state when timeIndex changes
  let lastTimeTravelIndex = -1;
  let timeTravelNonce = 0;
  let cachedXLN: XLNModule | null = null;

  type BrowserVMHandle = NonNullable<ReturnType<JAdapter['getBrowserVM']>>;

  async function getBrowserVMFromEnv(envValue: Env | null): Promise<BrowserVMHandle | null> {
    if (!envValue) return null;
    const xln = cachedXLN ?? await getXLN();
    cachedXLN = xln;
    const jadapter: JAdapter | null = xln.getActiveJAdapter?.(envValue) ?? null;
    if (!jadapter || jadapter.mode !== 'browservm') return null;
    return jadapter?.getBrowserVM?.() ?? null;
  }

  $: if ($timeIndex !== lastTimeTravelIndex && $history.length > 0) {
    const targetIndex = $timeIndex < 0 ? $history.length - 1 : Math.max(0, Math.min($timeIndex, $history.length - 1));
    const frame = $history[targetIndex];
    if (frame) {
      const jReplicas = Array.from(frame.jReplicas.values()) as JReplica[];
      const stateRoot = jReplicas[0]?.stateRoot;
      const browserVMState = frame.browserVMState;
      const hasBrowserVMState = !!browserVMState &&
        typeof browserVMState.stateRoot === 'string' &&
        Array.isArray(browserVMState.trieData);
      const nonce = ++timeTravelNonce;

      (async () => {
        const browserVM = await getBrowserVMFromEnv($env);
        if (nonce !== timeTravelNonce) return;

        if (hasBrowserVMState && browserVM?.restoreState) {
          try {
            await browserVM.restoreState(browserVMState);
            if (nonce !== timeTravelNonce) return;
            panelBridge.emit('time:changed', { frame: targetIndex, block: Number(jReplicas[0]?.blockNumber || 0) });
          } catch (e: any) {
            console.warn('[TimeMachine] restoreState failed:', e);
            if (stateRoot && stateRoot.length === 32 && browserVM?.timeTravel) {
              browserVM.timeTravel(new Uint8Array(stateRoot))
                .then(() => {
                  if (nonce !== timeTravelNonce) return;
                  panelBridge.emit('time:changed', { frame: targetIndex, block: Number(jReplicas[0]?.blockNumber || 0) });
                })
                .catch((err: any) => console.warn('[TimeMachine] timeTravel failed:', err));
            }
          }
        } else if (stateRoot && stateRoot.length === 32 && browserVM?.timeTravel) {
          browserVM.timeTravel(new Uint8Array(stateRoot))
            .then(() => {
              if (nonce !== timeTravelNonce) return;
              panelBridge.emit('time:changed', { frame: targetIndex, block: Number(jReplicas[0]?.blockNumber || 0) });
            })
            .catch((e: any) => console.warn('[TimeMachine] timeTravel failed:', e));
        }
      })();
    }
    lastTimeTravelIndex = $timeIndex;
  }

  // Time operations that work with isolated stores
  let localTimeOperations: any;
  $: localTimeOperations = {
    goToTimeIndex: (index: number) => {
      const max = maxTimeIndex;
      safeSet(timeIndex, Math.max(0, Math.min(index, max)));
      safeSet(isLive, false);  // Exit live mode when scrubbing
    },
    stepForward: () => {
      const current = selectedFrameIndex;
      const max = maxTimeIndex;
      if (current < max) {
        safeSet(timeIndex, current + 1);
        safeSet(isLive, false);
      } else {
        localTimeOperations.goToLive();
      }
    },
    stepBackward: () => {
      if ((isRemoteRuntime ? $runtimeHistoryFrames.length : $history.length) === 0) {
        localTimeOperations.goToLive();
        return;
      }
      const current = selectedFrameIndex;
      if (current > 0) {
        safeSet(timeIndex, current - 1);
        safeSet(isLive, false);
        return;
      }
      safeSet(timeIndex, 0);
      safeSet(isLive, false);
    },
    goToHistoryStart: () => {
      safeSet(timeIndex, 0);
      safeSet(isLive, false);
    },
    goToLive: () => {
      safeSet(timeIndex, LIVE_TIME_INDEX);
      safeSet(isLive, true);
    }
  };

  import {
    SkipBack,
    ChevronLeft,
    Play,
    Pause,
    ChevronRight,
    SkipForward,
    Repeat,
    Scissors,
    ChevronDown
  } from 'lucide-svelte';

  // Playback state
  let playing = false;
  let playbackInterval: number | null = null;
  let speed = 1.0;
  let loopMode: 'off' | 'all' | 'slice' = 'off';
  let sliceStart: number | null = null;
  let sliceEnd: number | null = null;

  // Get current frame subtitle (Fed Chair educational content)
  $: currentSubtitle = $history[selectedFrameIndex]?.meta?.subtitle;

  // FPS tracking
  let fps = 0;
  let frameTimestamps: number[] = [];

  // Dropdowns
  let showSpeedMenu = false;
  let showLoopMenu = false;
  let remoteScanHeightDraft = '';
  let remoteScanError = '';
  let remoteEntityChanging = false;
  let pendingDeepLink: { height: number; entityId: string; runtimeId: string } | null = null;
  let deepLinkApplied = false;
  let lastRuntimeViewSelectionKey = '';

  const speedOptions = [
    { value: 0.1, label: '0.1x' },
    { value: 0.25, label: '0.25x' },
    { value: 0.5, label: '0.5x' },
    { value: 1.0, label: '1x' },
    { value: 2.0, label: '2x' },
    { value: 5.0, label: '5x' },
    { value: 10.0, label: '10x' }
  ];

  // Calculate FPS from history updates
  // FIXED: Only update when history length actually changes, not on every reactive cycle
  let lastHistoryLength = 0;
  $: if ($history.length > 0 && $history.length !== lastHistoryLength) {
    const now = Date.now();
    frameTimestamps.push(now);
    frameTimestamps = frameTimestamps.filter(t => now - t < 60000); // Keep last minute
    fps = frameTimestamps.length / 60;
    lastHistoryLength = $history.length;
  }

  // Format time from frame
  function formatTime(frameIndex: number): string {
    const snapshot = $history[frameIndex];
    if (!snapshot?.timestamp) return '0:00.000';

    // CRITICAL: timestamps are bigint in XLN, convert to number for math
    const firstTimestamp = Number($history[0]?.timestamp || 0n);
    const currentTimestamp = Number(snapshot.timestamp);
    const elapsed = currentTimestamp - firstTimestamp;

    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    const ms = elapsed % 1000;

    return `${minutes}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  // Playback - simplified with guard against multiple intervals
  function togglePlay() {
    playing = !playing;

    if (playing) {
      // Start: clear any existing interval first, then create new
      if (playbackInterval) clearInterval(playbackInterval);

      if ($history.length === 0) {
        playing = false;
        return;
      }

      // Reset to start if at end or in live mode
      if ($isLive || selectedFrameIndex >= maxTimeIndex) {
        localTimeOperations.goToHistoryStart();
      }

      playbackInterval = window.setInterval(() => {
        const end = sliceEnd ?? maxTimeIndex;
        if (selectedFrameIndex >= end) {
          if (loopMode === 'all' || loopMode === 'slice') {
            localTimeOperations.goToTimeIndex(sliceStart ?? 0);
          } else {
            playing = false;
            if (playbackInterval) clearInterval(playbackInterval);
            playbackInterval = null;
          }
        } else {
          localTimeOperations.stepForward();
        }
      }, 1000 / speed);
    } else {
      // Stop: clear interval
      if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
      }
    }
  }

  function setSpeed(newSpeed: number) {
    speed = newSpeed;
    showSpeedMenu = false;
    panelBridge.emit('playback:speed', newSpeed);
    // Restart interval with new speed if playing
    if (playing && playbackInterval) {
      clearInterval(playbackInterval);
      playbackInterval = window.setInterval(() => {
        const end = sliceEnd ?? maxTimeIndex;
        if ($timeIndex >= end) {
          if (loopMode === 'all' || loopMode === 'slice') {
            localTimeOperations.goToTimeIndex(sliceStart ?? 0);
          } else {
            playing = false;
            if (playbackInterval) clearInterval(playbackInterval);
            playbackInterval = null;
          }
        } else {
          localTimeOperations.stepForward();
        }
      }, 1000 / speed);
    }
  }

  function setLoopMode(mode: typeof loopMode) {
    loopMode = mode;
    showLoopMenu = false;
  }

  function markSlicePoint() {
    if (sliceStart === null) {
      sliceStart = selectedFrameIndex;
    } else if (sliceEnd === null) {
      sliceEnd = selectedFrameIndex;
      if (sliceEnd < sliceStart) {
        [sliceStart, sliceEnd] = [sliceEnd, sliceStart];
      }
      loopMode = 'slice';
    } else {
      // Reset
      sliceStart = null;
      sliceEnd = null;
      loopMode = 'off';
    }
  }

  function formatShortEndpoint(value: string): string {
    const text = String(value || '').trim().replace(/^wss?:\/\//, '');
    if (!text) return 'remote';
    const maxInline = DISPLAY.ENDPOINT_PREFIX_CHARS + DISPLAY.ENDPOINT_SUFFIX_CHARS + 12;
    return text.length > maxInline
      ? `${text.slice(0, DISPLAY.ENDPOINT_PREFIX_CHARS + 16)}...`
      : text;
  }

  type RemoteTargetOption = {
    id: string;
    label: string;
    accounts: number;
    books: number;
    isHub: boolean;
  };

  type FrameSummary = {
    height: number;
    entities: number;
    accounts: number;
    books: number;
    targetAccounts: number;
    targetBooks: number;
  };

  function normalizeRemoteEntityId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  function projectionFrameEntityId(frame: RuntimeAdapterViewFrame | null | undefined): string {
    return normalizeRemoteEntityId(frame?.activeEntityId || frame?.activeEntity?.summary?.entityId || frame?.activeEntity?.core?.entityId);
  }

  function projectionFrameAccountCount(frame: RuntimeAdapterViewFrame | null | undefined): number {
    const page = frame?.activeEntity?.accounts;
    return Math.max(0, Number(page?.totalItems ?? page?.items?.length ?? 0));
  }

  function projectionFrameBookCount(frame: RuntimeAdapterViewFrame | null | undefined): number {
    const page = frame?.activeEntity?.books;
    return Math.max(0, Number(page?.totalItems ?? page?.items?.length ?? 0));
  }

  function buildRemoteTargetOptions(frame: RuntimeAdapterViewFrame | null | undefined): RemoteTargetOption[] {
    const options = new Map<string, RemoteTargetOption>();
    for (const summary of frame?.entities ?? []) {
      const id = normalizeRemoteEntityId(summary.entityId);
      if (!id) continue;
      options.set(id, {
        id,
        label: String(summary.label || `${id.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS)}...`),
        accounts: 0,
        books: 0,
        isHub: summary.isHub === true,
      });
    }
    const activeId = projectionFrameEntityId(frame);
    if (activeId) {
      const active = frame?.activeEntity;
      const existing = options.get(activeId);
      options.set(activeId, {
        id: activeId,
        label: String(active?.core?.profile?.name || active?.summary?.label || existing?.label || `${activeId.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS)}...`),
        accounts: projectionFrameAccountCount(frame),
        books: projectionFrameBookCount(frame),
        isHub: active?.summary?.isHub === true || active?.core?.profile?.isHub === true || Boolean(active?.core?.orderbookHubProfile),
      });
    }
    return Array.from(options.values()).sort((left, right) => {
      if (left.isHub !== right.isHub) return left.isHub ? -1 : 1;
      return left.label.localeCompare(right.label);
    });
  }

  function findRuntimeHistoryFrame(frames: RuntimeHistoryFrame[], height: number): RuntimeAdapterViewFrame | null {
    const normalizedHeight = Math.max(0, Math.floor(Number(height || 0)));
    if (!normalizedHeight) return null;
    return frames.find((item) => item.height === normalizedHeight)?.frame ?? null;
  }

  function summarizeFrame(frame: RuntimeAdapterViewFrame | null | undefined, targetEntityId: string): FrameSummary {
    const activeEntityId = projectionFrameEntityId(frame);
    const activeAccounts = projectionFrameAccountCount(frame);
    const activeBooks = projectionFrameBookCount(frame);
    const normalizedTarget = targetEntityId.trim().toLowerCase();
    const targetMatchesActive = !!normalizedTarget && activeEntityId === normalizedTarget;
    return {
      height: Math.max(0, Math.floor(Number(frame?.height || 0))),
      entities: frame?.entities?.length ?? 0,
      accounts: activeAccounts,
      books: activeBooks,
      targetAccounts: targetMatchesActive ? activeAccounts : 0,
      targetBooks: targetMatchesActive ? activeBooks : 0,
    };
  }

  function signedDelta(value: number): string {
    if (value > 0) return `+${value}`;
    return String(value);
  }

  function formatRemoteDiff(current: FrameSummary, selected: FrameSummary, targetEntityId: string, isLiveFrame: boolean): string {
    if (isLiveFrame) return `live h${current.height} · e${current.entities} a${current.accounts} b${current.books}`;
    const targetSuffix = targetEntityId
      ? ` · target a${signedDelta(current.targetAccounts - selected.targetAccounts)} b${signedDelta(current.targetBooks - selected.targetBooks)}`
      : '';
    return `Δh ${signedDelta(current.height - selected.height)} · e${signedDelta(current.entities - selected.entities)} · a${signedDelta(current.accounts - selected.accounts)} · b${signedDelta(current.books - selected.books)}${targetSuffix}`;
  }

  function parseHashParams(): { route: string; params: URLSearchParams } {
    if (typeof window === 'undefined') return { route: '', params: new URLSearchParams() };
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hash.trim()) return { route: '', params: new URLSearchParams() };
    const queryIndex = hash.indexOf('?');
    if (queryIndex >= 0) {
      return {
        route: hash.slice(0, queryIndex).trim(),
        params: new URLSearchParams(hash.slice(queryIndex + 1)),
      };
    }
    if (hash.includes('=')) return { route: '', params: new URLSearchParams(hash) };
    return { route: hash.trim(), params: new URLSearchParams() };
  }

  function readTimeMachineDeepLink(): { height: number; entityId: string; runtimeId: string } | null {
    const { params } = parseHashParams();
    const rawHeight = Number(params.get(TIME_MACHINE.HASH_HEIGHT_PARAM) || '');
    const height = Math.max(1, Math.floor(rawHeight));
    if (!Number.isFinite(height) || height < 1) return null;
    return {
      height,
      entityId: String(params.get(TIME_MACHINE.HASH_ENTITY_PARAM) || '').trim().toLowerCase(),
      runtimeId: String(params.get(TIME_MACHINE.HASH_RUNTIME_PARAM) || '').trim().toLowerCase(),
    };
  }

  function writeTimeMachineDeepLink(height: number, entityId: string): void {
    if (typeof window === 'undefined') return;
    const safeHeight = Math.max(1, Math.floor(Number(height || 0)));
    if (!Number.isFinite(safeHeight)) return;
    const { route, params } = parseHashParams();
    params.set(TIME_MACHINE.HASH_HEIGHT_PARAM, String(safeHeight));
    const normalizedEntity = entityId.trim().toLowerCase();
    if (normalizedEntity) params.set(TIME_MACHINE.HASH_ENTITY_PARAM, normalizedEntity);
    else params.delete(TIME_MACHINE.HASH_ENTITY_PARAM);
    const runtimeId = String($activeRuntimeId || $runtimeControllerHandle.id || '').trim().toLowerCase();
    if (runtimeId) params.set(TIME_MACHINE.HASH_RUNTIME_PARAM, runtimeId);
    const query = params.toString();
    const nextHash = route ? `${route}?${query}` : `?${query}`;
    const url = new URL(window.location.href);
    url.hash = nextHash;
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function formatCount(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    return Math.max(0, Math.floor(value)).toLocaleString('en-US');
  }

  function buildRemoteScanStatusLabel(
    state: RuntimeViewHistoryScanState,
    historyLength: number,
    localError: string,
  ): string {
    if (state.loading) return 'scanning';
    if (localError || state.error) return localError || state.error || 'scan failed';
    if (state.scannedHeight) {
      const duration = typeof state.durationMs === 'number' ? `${Math.max(0, Math.round(state.durationMs))}ms` : 'done';
      return `h${state.scannedHeight} · ${duration} · ${state.framesCached}/${REMOTE_HISTORY_SCAN_CACHE_LIMIT}`;
    }
    return `${historyLength}/${REMOTE_HISTORY_SCAN_CACHE_LIMIT} cached`;
  }

  async function scanRemoteHeight() {
    const fallbackHeight = Number($history[selectedFrameIndex]?.height || $runtimeControllerHandle.height || 0);
    const raw = remoteScanHeightDraft.trim() || String(Math.max(1, Math.floor(fallbackHeight || 1)));
    const requestedHeight = Math.max(1, Math.floor(Number(raw)));
    if (!Number.isFinite(requestedHeight) || requestedHeight < 1) {
      remoteScanError = 'height must be positive';
      return;
    }
    remoteScanError = '';
    try {
      const result = await scanRuntimeAdapterHistoryAtHeight(requestedHeight);
      remoteScanHeightDraft = String(result.snapshot.height || requestedHeight);
      safeSet(timeIndex, result.frameIndex);
      safeSet(isLive, false);
      writeTimeMachineDeepLink(Number(result.snapshot.height || requestedHeight), $runtimeViewActiveEntityId);
    } catch (error) {
      remoteScanError = error instanceof Error ? error.message : String(error || 'scan failed');
    }
  }

  async function selectRemoteEntity(entityId: string): Promise<void> {
    const normalized = String(entityId || '').trim().toLowerCase();
    if (!normalized || normalized === $runtimeViewActiveEntityId) return;
    remoteEntityChanging = true;
    remoteScanError = '';
    try {
      setRuntimeViewActiveEntityId(normalized);
      await refreshCurrentRuntimeProjection();
      if (!$isLive && selectedRuntimeHistoryHeight) {
        const height = Number(selectedRuntimeHistoryHeight || 0);
        remoteScanHeightDraft = String(height);
        const result = await scanRuntimeAdapterHistoryAtHeight(height);
        safeSet(timeIndex, result.frameIndex);
        safeSet(isLive, false);
      }
      writeTimeMachineDeepLink(Number(selectedRuntimeHistoryHeight || $runtimeControllerHandle.height || 1), normalized);
    } catch (error) {
      remoteScanError = error instanceof Error ? error.message : String(error || 'target switch failed');
    } finally {
      remoteEntityChanging = false;
    }
  }

  async function selectRemoteRuntime(runtimeId: string): Promise<void> {
    const normalized = String(runtimeId || '').trim().toLowerCase();
    if (!normalized || normalized === $activeRuntimeId) return;
    await runtimeOperations.activateRemoteRuntime(normalized);
  }

  // Handle slider drag/input
  function handleSliderInput(event: Event) {
    const target = event.target as HTMLInputElement;
    const index = parseInt(target.value);
    localTimeOperations.goToTimeIndex(index);
  }

  // Keyboard shortcuts
  function handleKeyboard(event: KeyboardEvent) {
    // Allow shortcuts unless typing in input/textarea
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    switch (event.key) {
      case ' ':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        localTimeOperations.stepBackward();
        break;
      case 'ArrowRight':
        localTimeOperations.stepForward();
        break;
      case 'Home':
        localTimeOperations.goToHistoryStart();
        break;
      case 'End':
        localTimeOperations.goToLive();
        break;
      case '[':
        markSlicePoint();
        break;
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeyboard);
    pendingDeepLink = readTimeMachineDeepLink();
    if (pendingDeepLink?.height) remoteScanHeightDraft = String(pendingDeepLink.height);
  });

  onDestroy(() => {
    // Cleanup: stop playback
    playing = false;
    if (playbackInterval) {
      clearInterval(playbackInterval);
      playbackInterval = null;
    }
    window.removeEventListener('keydown', handleKeyboard);
  });

  $: currentTime = formatTime(selectedFrameIndex);
  $: totalTime = formatTime(maxTimeIndex);
  $: progressPercent = maxTimeIndex > 0 ? (selectedFrameIndex / maxTimeIndex) * 100 : 0;
  $: selectedRuntimeHistoryHeight = isRemoteRuntime
    ? Number($runtimeHistoryFrames[selectedFrameIndex]?.height || 0)
    : Number($history[selectedFrameIndex]?.height || 0);
  $: selectedRuntimeViewHeight = $isLive
    ? null
    : Math.max(0, Math.floor(selectedRuntimeHistoryHeight));
  $: runtimeViewSelectionKey = `${$runtimeControllerHandle.id}|${$isLive ? 'live' : `h:${selectedRuntimeViewHeight}`}`;
  $: if (runtimeViewSelectionKey !== lastRuntimeViewSelectionKey) {
    lastRuntimeViewSelectionKey = runtimeViewSelectionKey;
    if (!$isLive && !selectedRuntimeViewHeight) {
      const message = 'Time Machine selected a frame without a persisted runtime height';
      remoteScanError = message;
      toasts.error(message);
    } else {
      void setRuntimeViewAtHeight(selectedRuntimeViewHeight).catch((error) => {
        const message = error instanceof Error ? error.message : String(error || 'RuntimeView historical read failed');
        remoteScanError = message;
        toasts.error(`Time Machine failed: ${message}`);
      });
    }
  }
  $: selectedRuntimeHistoryFrame = findRuntimeHistoryFrame($runtimeHistoryFrames, selectedRuntimeHistoryHeight);
  $: remoteHistoryFrameCount = Math.max($runtimeHistoryFrames.length, $history.length);
  $: remoteScanPlaceholder = String(Math.max(1, Math.floor(Number(selectedRuntimeHistoryFrame?.height || selectedRuntimeHistoryHeight || $runtimeControllerHandle.height || 1))));
  $: remoteScanStatusText = buildRemoteScanStatusLabel($runtimeViewHistoryScan, remoteHistoryFrameCount, remoteScanError);
  $: remoteTargetOptions = buildRemoteTargetOptions($runtimeView.frame);
  $: selectedRemoteEntityId = $runtimeViewActiveEntityId || remoteTargetOptions[0]?.id || '';
  $: selectedFrameSummary = summarizeFrame(selectedRuntimeHistoryFrame, selectedRemoteEntityId);
  $: liveFrameSummary = summarizeFrame($runtimeView.frame, selectedRemoteEntityId);
  $: remoteDiffText = formatRemoteDiff(liveFrameSummary, selectedFrameSummary, selectedRemoteEntityId, $isLive);
  $: remoteRuntimeOptions = Array.from($runtimes.values()).filter((runtime) => runtime.type === 'remote');
  $: if (
    pendingDeepLink &&
    !deepLinkApplied &&
    $runtimeControllerHandle.mode === 'remote' &&
    $runtimeControllerHandle.endpoint &&
    remoteHistoryFrameCount > 0 &&
    !$runtimeViewHistoryScan.loading
  ) {
    deepLinkApplied = true;
    const request = pendingDeepLink;
    pendingDeepLink = null;
    (async () => {
      const activeRuntimeKey = String($activeRuntimeId || $runtimeControllerHandle.id || '').trim().toLowerCase();
      if (request.runtimeId && request.runtimeId !== activeRuntimeKey) {
        if ($runtimes.has(request.runtimeId)) {
          await runtimeOperations.activateRemoteRuntime(request.runtimeId, { href: window.location.href });
          return;
        }
        throw new Error(`Time Machine runtime is not imported: ${request.runtimeId.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS)}`);
      }
      if (request.entityId) {
        setRuntimeViewActiveEntityId(request.entityId);
        await refreshCurrentRuntimeProjection();
      }
      remoteScanHeightDraft = String(request.height);
      await scanRemoteHeight();
    })().catch((error) => {
      remoteScanError = error instanceof Error ? error.message : String(error || 'deep link scan failed');
    });
  }
</script>

{#if $runtimeGraphScope === 'merged' && $appState.mode === 'dev'}
  <NetworkMachineTimeline />
{:else}
<div class="time-machine">
  <!-- Frame Navigation (LEFT - most used) -->
  <div class="frame-nav">
    <button on:click={localTimeOperations.goToHistoryStart} title="Go to start (Home)">
      <SkipBack size={12} />
    </button>
    <button on:click={localTimeOperations.stepBackward} title="Step back (←)">
      <ChevronLeft size={12} />
    </button>
    <button on:click={localTimeOperations.stepForward} title="Step forward (→)">
      <ChevronRight size={12} />
    </button>
    <button on:click={localTimeOperations.goToLive} title="Go to live (End)">
      <SkipForward size={12} />
    </button>
  </div>

  <!-- Play/Pause -->
  <button on:click={togglePlay} class="play-btn" title="Play/Pause (Space)">
    {#if playing}
      <Pause size={16} />
    {:else}
      <Play size={16} />
    {/if}
  </button>

  <!-- Progress Scrubber with frame info -->
  <div class="scrubber-container">
    <div class="frame-info">
      <div class="dropdown-trigger">
        <button
          class="frame-badge"
          class:live={$isLive}
          data-testid="time-machine-frame-badge"
          on:click={() => { showSpeedMenu = !showSpeedMenu; showLoopMenu = false; }}
          title="Click for playback settings"
        >
          {$isLive ? `LIVE/${$history.length}` : `${selectedFrameIndex + 1}/${$history.length}`}
        </button>
        <!-- Dropdown menu -->
        {#if showSpeedMenu}
      <div class="menu mega">
        <div class="menu-section">Speed</div>
        <div class="speed-grid">
          {#each speedOptions as option}
            <button
              on:click={() => setSpeed(option.value)}
              class:selected={speed === option.value}
            >
              {option.label}
            </button>
          {/each}
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">Loop</div>
        <button on:click={() => setLoopMode('off')} class:selected={loopMode === 'off'}>Off</button>
        <button on:click={() => setLoopMode('all')} class:selected={loopMode === 'all'}>Loop All</button>
        <button on:click={() => setLoopMode('slice')} class:selected={loopMode === 'slice'} disabled={sliceStart === null || sliceEnd === null}>
          Loop Slice {sliceStart !== null && sliceEnd !== null ? `(${sliceStart}-${sliceEnd})` : ''}
        </button>
        <button on:click={markSlicePoint}>
          <Scissors size={12} />
          {#if sliceStart === null}
            Mark Start
          {:else if sliceEnd === null}
            Mark End (A: {sliceStart})
          {:else}
            Clear Slice
          {/if}
        </button>
      </div>
        {/if}
      </div>
      <span class="time-label">{currentTime}</span>
    </div>
    {#if $runtimeControllerHandle.mode === 'remote'}
      <div class="remote-scan" data-testid="time-machine-remote-scan">
        {#if remoteRuntimeOptions.length > 1}
          <select
            class="remote-runtime-select"
            data-testid="time-machine-remote-runtime"
            aria-label="Remote runtime"
            value={$activeRuntimeId}
            on:change={(event) => void selectRemoteRuntime((event.currentTarget as HTMLSelectElement).value)}
          >
            {#each remoteRuntimeOptions as runtime (runtime.id)}
              <option value={runtime.id}>{runtime.label}</option>
            {/each}
          </select>
        {/if}
        <span class="remote-endpoint" title={$runtimeControllerHandle.endpoint}>
          {formatShortEndpoint($runtimeControllerHandle.endpoint)}
        </span>
        {#if remoteTargetOptions.length > 0}
          <select
            class="remote-entity-select"
            data-testid="time-machine-remote-target"
            aria-label="Remote entity target"
            value={selectedRemoteEntityId}
            disabled={remoteEntityChanging || $runtimeViewHistoryScan.loading}
            on:change={(event) => void selectRemoteEntity((event.currentTarget as HTMLSelectElement).value)}
          >
            {#each remoteTargetOptions as target (target.id)}
              <option value={target.id}>
                {target.isHub ? 'hub ' : ''}{target.label} · a{formatCount(target.accounts)} b{formatCount(target.books)}
              </option>
            {/each}
          </select>
        {/if}
        <input
          data-testid="time-machine-remote-height"
          inputmode="numeric"
          pattern="[0-9]*"
          placeholder={`h${remoteScanPlaceholder}`}
          bind:value={remoteScanHeightDraft}
          aria-label="Remote history height"
        />
        <button
          type="button"
          data-testid="time-machine-remote-scan-button"
          disabled={$runtimeViewHistoryScan.loading}
          on:click={() => void scanRemoteHeight()}
        >
          {$runtimeViewHistoryScan.loading ? 'Scan...' : 'Scan'}
        </button>
        <span class="remote-scan-status" data-testid="time-machine-remote-scan-status">
          {remoteScanStatusText}
        </span>
        <span class="remote-diff" data-testid="time-machine-remote-diff" title="Current live frame vs selected historical frame">
          {remoteDiffText}
        </span>
        <button
          type="button"
          class="remote-link-button"
          data-testid="time-machine-remote-deeplink"
          disabled={remoteHistoryFrameCount === 0}
          on:click={() => writeTimeMachineDeepLink(Number(selectedRuntimeHistoryHeight || $runtimeControllerHandle.height || 1), selectedRemoteEntityId)}
        >
          Link
        </button>
        {#if $runtimeViewHistoryScan.accountsTotal !== null}
          <span class="remote-scan-meta" data-testid="time-machine-remote-scan-meta">
            {formatCount($runtimeViewHistoryScan.accountsShown)}/{formatCount($runtimeViewHistoryScan.accountsTotal)} accounts
          </span>
        {/if}
      </div>
    {/if}
    <input
      type="range"
      class="scrubber"
      min="0"
      max={maxTimeIndex}
      value={selectedFrameIndex}
      on:input={handleSliderInput}
      style="--xln-slider-progress: {progressPercent}%"
      disabled={$history.length === 0}
    />
    <span class="time-label end">{totalTime}</span>
    <button
      class="dock-toggle-btn"
      data-testid="network-machine-mode-toggle"
      on:click={() => appStateOperations.setMode($appState.mode === 'dev' ? 'user' : 'dev')}
    >
      {$appState.mode === 'dev' ? 'User' : 'Dock'}
    </button>
  </div>

  <!-- Fed Chair Subtitle (inline, above controls) -->
  <FrameSubtitle subtitle={currentSubtitle} visible={!$isLive && currentSubtitle !== undefined} />
</div>
{/if}

<style>
  .time-machine {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: #1a1a1a;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    height: 48px;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
  }

  /* Play Button (prominent) */
  .play-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 122, 255, 0.15);
    border: none;
    color: rgba(0, 122, 255, 1);
    width: 36px;
    height: 36px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .play-btn:hover {
    background: rgba(0, 122, 255, 0.25);
  }

  /* Scrubber Container */
  .scrubber-container {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .frame-info {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .dropdown-trigger {
    position: relative; /* For dropdown positioning */
  }

  .frame-badge {
    font-family: 'SF Mono', monospace;
    font-size: 0.625rem;
    font-weight: 600;
    padding: 3px 6px;
    background: rgba(0, 122, 255, 0.1);
    border: 1px solid transparent;
    border-radius: 3px;
    color: rgba(0, 122, 255, 0.9);
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .frame-badge:hover {
    background: rgba(0, 122, 255, 0.2);
    border-color: rgba(0, 122, 255, 0.3);
  }

  .frame-badge.live {
    background: rgba(0, 255, 136, 0.1);
    color: rgba(0, 255, 136, 0.9);
    animation: pulse 2s ease-in-out infinite;
  }

  .time-label {
    font-family: 'SF Mono', monospace;
    font-size: 0.625rem;
    color: rgba(255, 255, 255, 0.5);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .time-label.end {
    flex-shrink: 0;
  }

  .remote-scan {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    max-width: min(760px, 58vw);
    padding: 3px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.035);
    color: rgba(255, 255, 255, 0.68);
    font-family: 'SF Mono', monospace;
    font-size: 10px;
  }

  .remote-endpoint {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(132, 204, 255, 0.92);
  }

  .remote-runtime-select,
  .remote-entity-select {
    height: 24px;
    min-width: 0;
    max-width: 132px;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.32);
    color: rgba(255, 255, 255, 0.86);
    padding: 0 18px 0 6px;
    font: inherit;
  }

  .remote-entity-select {
    max-width: 170px;
  }

  .remote-scan input {
    width: 62px;
    height: 24px;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.3);
    color: rgba(255, 255, 255, 0.9);
    padding: 0 6px;
    font: inherit;
  }

  .remote-scan button {
    height: 24px;
    border: 1px solid rgba(0, 122, 255, 0.28);
    border-radius: 4px;
    background: rgba(0, 122, 255, 0.13);
    color: rgba(180, 220, 255, 0.96);
    padding: 0 8px;
    font: inherit;
    cursor: pointer;
  }

  .remote-scan button:disabled {
    cursor: wait;
    opacity: 0.62;
  }

  .remote-scan-status,
  .remote-scan-meta,
  .remote-diff {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .remote-scan-status {
    color: rgba(255, 255, 255, 0.78);
  }

  .remote-scan-meta {
    color: rgba(0, 255, 136, 0.78);
  }

  .remote-diff {
    max-width: 230px;
    color: rgba(255, 214, 128, 0.9);
  }

  .remote-link-button {
    color: rgba(210, 190, 255, 0.96) !important;
    border-color: rgba(168, 85, 247, 0.28) !important;
    background: rgba(168, 85, 247, 0.13) !important;
  }

  .dock-toggle-btn {
    margin-left: 8px;
    padding: 4px 10px;
    background: rgba(168, 85, 247, 0.1);
    border: 1px solid rgba(168, 85, 247, 0.3);
    border-radius: 4px;
    font-size: 11px;
    font-family: 'SF Mono', monospace;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .dock-toggle-btn:hover {
    background: rgba(168, 85, 247, 0.2);
    border-color: rgba(168, 85, 247, 0.5);
  }

  /* Frame Navigation */
  .frame-nav {
    display: flex;
    gap: 1px;
    padding: 2px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 4px;
    flex-shrink: 0;
  }

  .frame-nav button {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    width: 24px;
    height: 24px;
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .frame-nav button:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  /* Progress Scrubber */
  .scrubber {
    flex: 1;
    min-width: 0;
    max-width: 100%;
    cursor: pointer;
  }

  .scrubber:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .menu {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 6px;
    background: var(--dropdown-menu-bg, rgba(20, 20, 20, 0.98));
    backdrop-filter: blur(var(--blur-sm, 12px));
    border: 1px solid var(--dropdown-border, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    padding: 4px;
    min-width: 100px;
    box-shadow: var(--shadow-lg, 0 4px 16px rgba(0, 0, 0, 0.5));
    z-index: 1000;
  }

  .menu-section {
    padding: 4px 8px 2px;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 600;
  }

  .menu-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 4px 0;
  }

  .menu button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    text-align: left;
    padding: 6px 8px;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.8);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.75rem;
    transition: all 0.1s;
  }

  .menu button:hover:not(:disabled) {
    background: var(--dropdown-item-hover, rgba(255, 255, 255, 0.1));
  }

  .menu button.selected {
    background: var(--dropdown-selected, rgba(0, 122, 255, 0.2));
    color: white;
  }

  .menu button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Mega Menu */
  .menu.mega {
    min-width: 180px;
    right: 0;
    left: auto;
    transform: none;
  }

  .speed-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 2px;
    padding: 2px;
  }

  .speed-grid button {
    width: auto;
    padding: 4px 6px;
    font-size: 0.6875rem;
    justify-content: center;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  /* Responsive */
  @media (max-width: 768px) {
    .time-machine {
      flex-wrap: wrap;
      height: auto;
      gap: 0.5rem;
      padding: 0.5rem;
    }

    .scrubber-container {
      order: -1;
      width: 100%;
      flex-wrap: wrap;
    }

    .remote-scan {
      order: 2;
      width: 100%;
      max-width: 100%;
    }

    .remote-endpoint {
      max-width: 32vw;
    }

    .time-label {
      display: none;
    }
  }
</style>
