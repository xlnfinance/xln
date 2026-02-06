<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { type Writable, type Readable } from 'svelte/store';
  import type { XLNModule } from '@xln/runtime/xln-api';
  import type { JAdapter, BrowserVMProvider } from '@xln/runtime/jadapter';
  import FrameSubtitle from '../../components/TimeMachine/FrameSubtitle.svelte';
  import { panelBridge } from '../utils/panelBridge';
  import RuntimeDropdown from '$lib/components/Runtime/RuntimeDropdown.svelte';
  import { getXLN } from '$lib/stores/xlnStore';
  // BrowserVM resolved via JAdapter

  // Props: Accept both Writable and Readable stores (for global vs isolated usage)
  export let history: Writable<any[]> | Readable<any[]>;
  export let timeIndex: Writable<number> | Readable<number>;
  export let isLive: Writable<boolean> | Readable<boolean>;
  export let env: Writable<any> | Readable<any>; // For state export
  export let showRuntimeSelector = false;

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

  // Direct store usage - no fallback logic
  $: maxTimeIndex = Math.max(0, $history.length - 1);

  // LIVE auto-advance: when new frames arrive, stay at latest
  $: if ($isLive && maxTimeIndex > 0 && $timeIndex !== maxTimeIndex) {
    safeSet(timeIndex, maxTimeIndex);
  }

  // BrowserVM time-travel: restore EVM state when timeIndex changes
  let lastTimeTravelIndex = -1;
  let timeTravelNonce = 0;
  let cachedXLN: XLNModule | null = null;

  async function getBrowserVMFromEnv(envValue: any): Promise<BrowserVMProvider | null> {
    if (!envValue) return null;
    const xln = cachedXLN ?? await getXLN();
    cachedXLN = xln;
    const jadapter: JAdapter | null = xln.getActiveJAdapter?.(envValue) ?? null;
    return jadapter?.getBrowserVM?.() ?? null;
  }

  $: if ($timeIndex !== lastTimeTravelIndex && $history.length > 0) {
    const targetIndex = $timeIndex < 0 ? $history.length - 1 : $timeIndex;
    const frame = $history[targetIndex];
    if (frame?.jReplicas) {
      const jReplicas = Array.isArray(frame.jReplicas)
        ? frame.jReplicas
        : Object.values(frame.jReplicas);
      const stateRoot = jReplicas[0]?.stateRoot;
      const browserVMState = frame?.browserVMState;
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
            console.log(`[TimeMachine] EVM restored (full state) to frame ${targetIndex}`);
            panelBridge.emit('time:changed', { frame: targetIndex, block: Number(jReplicas[0]?.blockNumber || 0) });
          } catch (e: any) {
            console.warn('[TimeMachine] restoreState failed:', e);
            if (stateRoot && stateRoot.length === 32 && browserVM?.timeTravel) {
              browserVM.timeTravel(new Uint8Array(stateRoot))
                .then(() => {
                  if (nonce !== timeTravelNonce) return;
                  console.log(`[TimeMachine] EVM restored (stateRoot) to frame ${targetIndex}`);
                  panelBridge.emit('time:changed', { frame: targetIndex, block: Number(jReplicas[0]?.blockNumber || 0) });
                })
                .catch((err: any) => console.warn('[TimeMachine] timeTravel failed:', err));
            }
          }
        } else if (stateRoot && stateRoot.length === 32 && browserVM?.timeTravel) {
          browserVM.timeTravel(new Uint8Array(stateRoot))
            .then(() => {
              if (nonce !== timeTravelNonce) return;
              console.log(`[TimeMachine] EVM restored to frame ${targetIndex}`);
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
      const current = $timeIndex;
      const max = maxTimeIndex;
      if (current < max) {
        safeSet(timeIndex, current + 1);
        safeSet(isLive, false);
      }
    },
    stepBackward: () => {
      const current = $timeIndex;
      if (current > 0) {
        safeSet(timeIndex, current - 1);
      }
      safeSet(isLive, false);
    },
    goToHistoryStart: () => {
      safeSet(timeIndex, 0);
      safeSet(isLive, false);
    },
    goToLive: () => {
      safeSet(timeIndex, maxTimeIndex);
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
    Download,
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
  $: currentSubtitle = $history[$timeIndex]?.subtitle;

  // FPS tracking
  let fps = 0;
  let frameTimestamps: number[] = [];

  // Dropdowns
  let showSpeedMenu = false;
  let showLoopMenu = false;
  let showExportMenu = false;

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
      if ($isLive || $timeIndex >= maxTimeIndex) {
        localTimeOperations.goToHistoryStart();
      }

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
      sliceStart = $timeIndex;
    } else if (sliceEnd === null) {
      sliceEnd = $timeIndex;
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

  function exportFrames() {
    const data = JSON.stringify($history, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xln-frames-${Date.now()}.json`;
    a.click();
    showExportMenu = false;
  }

  async function shareURL() {
    try {
      const { generateShareURL } = await import('../utils/stateCodec');
      const shareableURL = generateShareURL($env, false); // Data only, no UI

      // Copy to clipboard
      await navigator.clipboard.writeText(shareableURL);

      console.log('[TimeMachine] ✅ Shareable URL copied to clipboard');
      console.log('[TimeMachine] 🔗', shareableURL);

      // Visual feedback (could add toast notification)
      alert('Shareable URL copied to clipboard!\n\nPaste in new tab to restore xlnomies + entities.');

      showExportMenu = false;
    } catch (err) {
      console.error('[TimeMachine] Failed to generate share URL:', err);
      alert(`Failed to generate URL: ${err}`);
    }
  }

  async function shareURLWithUI() {
    try {
      const { generateShareURL } = await import('../utils/stateCodec');
      const shareableURL = generateShareURL($env, true); // Include UI settings

      await navigator.clipboard.writeText(shareableURL);

      console.log('[TimeMachine] ✅ Shareable URL (with UI) copied');
      alert('Shareable URL (with UI settings) copied to clipboard!');

      showExportMenu = false;
    } catch (err) {
      console.error('[TimeMachine] Failed to generate share URL:', err);
      alert(`Failed: ${err}`);
    }
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

  $: currentTime = formatTime($timeIndex);
  $: totalTime = formatTime(maxTimeIndex);
  $: progressPercent = maxTimeIndex > 0 ? ($timeIndex / maxTimeIndex) * 100 : 0;
</script>

<div class="time-machine">
  {#if showRuntimeSelector}
    <div class="runtime-selector">
      <RuntimeDropdown />
    </div>
  {/if}

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
          on:click={() => { showSpeedMenu = !showSpeedMenu; showLoopMenu = false; showExportMenu = false; }}
          title="Click for playback settings"
        >
          {$isLive ? `LIVE/${$history.length}` : `${$timeIndex + 1}/${$history.length}`}
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
        <div class="menu-divider"></div>
        <div class="menu-section">Export</div>
        <button on:click={exportFrames}>
          <Download size={12} />
          Export JSON
        </button>
        <button on:click={shareURL}>Share URL</button>
        <button on:click={shareURLWithUI}>Share URL + UI</button>
      </div>
        {/if}
      </div>
      <span class="time-label">{currentTime}</span>
    </div>
    <input
      type="range"
      class="scrubber"
      min="0"
      max={maxTimeIndex}
      value={$timeIndex}
      on:input={handleSliderInput}
      style="--progress: {progressPercent}%"
      disabled={$history.length === 0}
    />
    <span class="time-label end">{totalTime}</span>
    <button class="dock-toggle-btn" on:click={() => import('$lib/stores/appStateStore').then(m => m.toggleMode())}>
      Dock
    </button>
  </div>

  <!-- Fed Chair Subtitle (inline, above controls) -->
  <FrameSubtitle subtitle={currentSubtitle} visible={!$isLive && currentSubtitle !== undefined} />
</div>

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

  .settings-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(128, 128, 128, 0.15);
    border: none;
    color: rgba(200, 200, 200, 1);
    width: 32px;
    height: 32px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
    font-size: 14px;
  }

  .settings-btn:hover {
    background: rgba(128, 128, 128, 0.25);
  }

  /* Scrubber Container */
  .scrubber-container {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 200px;
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

  /* Runtime Selector */
  .runtime-selector {
    flex-shrink: 0;
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
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    cursor: pointer;
    outline: none;
  }

  /* WebKit (Chrome/Safari) */
  .scrubber::-webkit-slider-track {
    width: 100%;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
  }

  .scrubber::-webkit-slider-runnable-track {
    width: 100%;
    height: 4px;
    background: linear-gradient(
      to right,
      rgba(0, 122, 255, 0.8) 0%,
      rgba(0, 122, 255, 0.8) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) 100%
    );
    border-radius: 2px;
  }

  .scrubber::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: white;
    border: 2px solid rgba(0, 122, 255, 1);
    cursor: grab;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    transition: transform 0.15s;
  }

  .scrubber:active::-webkit-slider-thumb {
    cursor: grabbing;
    transform: scale(1.15);
  }

  /* Firefox */
  .scrubber::-moz-range-track {
    width: 100%;
    height: 4px;
    background: linear-gradient(
      to right,
      rgba(0, 122, 255, 0.8) 0%,
      rgba(0, 122, 255, 0.8) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) 100%
    );
    border-radius: 2px;
  }

  .scrubber::-moz-range-progress {
    height: 4px;
    background: rgba(0, 122, 255, 0.8);
    border-radius: 2px 0 0 2px;
  }

  .scrubber::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(0, 122, 255, 1);
    border-radius: 50%;
    background: white;
    cursor: grab;
  }

  .scrubber:active::-moz-range-thumb {
    cursor: grabbing;
  }

  .scrubber:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Dropdown */
  .dropdown {
    position: relative;
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

  .menu.wide {
    min-width: 160px;
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

  /* Settings Button */
  .settings-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: rgba(255, 255, 255, 0.05);
    border: none;
    color: rgba(255, 255, 255, 0.7);
    padding: 0 10px;
    height: 28px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .settings-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .speed-value {
    font-family: 'SF Mono', monospace;
    font-size: 0.6875rem;
    font-weight: 500;
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
    }

    .time-label {
      display: none;
    }
  }
</style>
