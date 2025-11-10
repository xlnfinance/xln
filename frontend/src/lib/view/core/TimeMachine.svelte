<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { type Writable } from 'svelte/store';
  import FrameSubtitle from '../../components/TimeMachine/FrameSubtitle.svelte';

  // Props: REQUIRED isolated stores (no fallbacks)
  export let history: Writable<any[]>;
  export let timeIndex: Writable<number>;
  export let isLive: Writable<boolean>;
  export let env: Writable<any>; // For state export

  // Direct store usage - no fallback logic
  $: maxTimeIndex = Math.max(0, $history.length - 1);

  // Time operations that work with isolated stores
  let localTimeOperations: any;
  $: localTimeOperations = {
    goToTimeIndex: (index: number) => {
      const max = maxTimeIndex;
      timeIndex.set(Math.max(0, Math.min(index, max)));
      isLive.set(false);  // Exit live mode when scrubbing
    },
    stepForward: () => {
      const current = $timeIndex;
      const max = maxTimeIndex;
      if (current < max) {
        timeIndex.set(current + 1);
        isLive.set(false);
      }
    },
    stepBackward: () => {
      const current = $timeIndex;
      if (current > 0) {
        timeIndex.set(current - 1);
      }
      isLive.set(false);
    },
    goToHistoryStart: () => {
      timeIndex.set(0);
      isLive.set(false);
    },
    goToLive: () => {
      timeIndex.set(-1);
      isLive.set(true);
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
  $: if ($history.length > 0) {
    const now = Date.now();
    frameTimestamps.push(now);
    frameTimestamps = frameTimestamps.filter(t => now - t < 60000); // Keep last minute
    fps = frameTimestamps.length / 60;
  }

  // Format time from frame
  function formatTime(frameIndex: number): string {
    const snapshot = $history[frameIndex];
    if (!snapshot?.timestamp) return '0:00.000';

    const firstTimestamp = $history[0]?.timestamp || 0;
    const elapsed = snapshot.timestamp - firstTimestamp;

    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    const ms = elapsed % 1000;

    return `${minutes}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  // Playback
  function togglePlay() {
    if (playing) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  function startPlayback() {
    if ($history.length === 0) return;

    if ($isLive || $timeIndex >= maxTimeIndex) {
      localTimeOperations.goToHistoryStart();
    }

    playing = true;
    const frameDelay = 1000 / speed;

    playbackInterval = window.setInterval(() => {
      const end = sliceEnd ?? maxTimeIndex;

      if ($timeIndex >= end) {
        if (loopMode === 'all' || loopMode === 'slice') {
          localTimeOperations.goToTimeIndex(sliceStart ?? 0);
        } else {
          stopPlayback();
        }
      } else {
        localTimeOperations.stepForward();
      }
    }, frameDelay);
  }

  function stopPlayback() {
    playing = false;
    if (playbackInterval) {
      clearInterval(playbackInterval);
      playbackInterval = null;
    }
  }

  function setSpeed(newSpeed: number) {
    speed = newSpeed;
    showSpeedMenu = false;
    if (playing) {
      stopPlayback();
      startPlayback(); // Restart with new speed
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
    if (event.target !== document.body) return;

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
    stopPlayback();
    window.removeEventListener('keydown', handleKeyboard);
  });

  $: currentTime = formatTime($timeIndex);
  $: totalTime = formatTime(maxTimeIndex);
  $: progressPercent = maxTimeIndex > 0 ? ($timeIndex / maxTimeIndex) * 100 : 0;
</script>

<div class="time-machine">
  <!-- Navigation -->
  <div class="nav-cluster">
    <button on:click={localTimeOperations.goToHistoryStart} title="Go to start (Home)">
      <SkipBack size={16} />
    </button>
    <button on:click={localTimeOperations.stepBackward} title="Step back (←)">
      <ChevronLeft size={16} />
    </button>
    <button on:click={togglePlay} class="play-btn" title="Play/Pause (Space)">
      {#if playing}
        <Pause size={18} />
      {:else}
        <Play size={18} />
      {/if}
    </button>
    <button on:click={localTimeOperations.stepForward} title="Step forward (→)">
      <ChevronRight size={16} />
    </button>
    <button on:click={localTimeOperations.goToLive} title="Go to live (End)">
      <SkipForward size={16} />
    </button>
  </div>

  <!-- Status Display -->
  <div class="status-display">
    <div class="timestamp">
      <span class="label">Time</span>
      <span class="value">{currentTime} / {totalTime}</span>
    </div>
    <div class="frames">
      <span class="label">Runtime</span>
      <span class="value">{$timeIndex >= 0 ? $timeIndex + 1 : $history.length} / {$history.length}</span>
    </div>
    <div class="fps">
      <span class="label">FPS</span>
      <span class="value">{fps.toFixed(1)}</span>
    </div>
  </div>

  <!-- Progress Scrubber (Native HTML Range) -->
  <input
    type="range"
    class="scrubber"
    min="0"
    max={maxTimeIndex}
    value={$timeIndex >= 0 ? $timeIndex : maxTimeIndex}
    on:input={handleSliderInput}
    disabled={maxTimeIndex === 0}
    style="--progress: {progressPercent}%"
  />

  <!-- Tools -->
  <div class="tools-cluster">
    <!-- Loop -->
    <div class="dropdown">
      <button
        class="tool-btn"
        class:active={loopMode !== 'off'}
        on:click={() => (showLoopMenu = !showLoopMenu)}
        title="Loop mode ([)"
      >
        <Repeat size={16} />
        {#if loopMode === 'slice' && sliceStart !== null && sliceEnd !== null}
          <span class="badge">{sliceStart}-{sliceEnd}</span>
        {:else if loopMode === 'all'}
          <span class="badge">All</span>
        {/if}
        <ChevronDown size={12} />
      </button>
      {#if showLoopMenu}
        <div class="menu">
          <button on:click={() => setLoopMode('off')}>Off</button>
          <button on:click={() => setLoopMode('all')}>Loop All</button>
          <button on:click={() => setLoopMode('slice')} disabled={sliceStart === null || sliceEnd === null}>
            Loop Slice
          </button>
        </div>
      {/if}
    </div>

    <!-- Slice Marker -->
    <button
      class="tool-btn"
      class:active={sliceStart !== null}
      on:click={markSlicePoint}
      title="Mark slice ([)"
    >
      <Scissors size={16} />
      {#if sliceStart !== null && sliceEnd === null}
        <span class="badge">A</span>
      {:else if sliceStart !== null && sliceEnd !== null}
        <span class="badge">A-B</span>
      {/if}
    </button>

    <!-- Export -->
    <div class="dropdown">
      <button class="tool-btn" on:click={() => (showExportMenu = !showExportMenu)} title="Export">
        <Download size={16} />
        <ChevronDown size={12} />
      </button>
      {#if showExportMenu}
        <div class="menu">
          <button on:click={exportFrames}>📥 Export Frames (JSON)</button>
          <button on:click={shareURL}>🔗 Share URL (Data Only)</button>
          <button on:click={shareURLWithUI}>🎨 Share URL (+ UI)</button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Speed -->
  <div class="speed-cluster dropdown">
    <button class="speed-btn" on:click={() => (showSpeedMenu = !showSpeedMenu)}>
      <span class="speed-value">{speed}x</span>
      <ChevronDown size={12} />
    </button>
    {#if showSpeedMenu}
      <div class="menu">
        {#each speedOptions as option}
          <button
            on:click={() => setSpeed(option.value)}
            class:selected={speed === option.value}
          >
            {option.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Mode Badge -->
  <div class="mode-badge" class:live={$isLive}>
    {$isLive ? 'LIVE' : 'HISTORY'}
  </div>
</div>

<!-- Fed Chair Subtitle Overlay (only in history mode) -->
<FrameSubtitle subtitle={currentSubtitle} visible={!$isLive && currentSubtitle !== undefined} />

<style>
  .time-machine {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.5rem;
    background: #252526; /* Solid background to cover 3D scene underneath */
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    border-bottom: 1px solid rgba(0, 0, 0, 0.5);
    box-shadow:
      0 -1px 0 0 rgba(255, 255, 255, 0.05),
      0 8px 32px 0 rgba(0, 0, 0, 0.3);
    height: 60px;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
  }

  /* Navigation Cluster */
  .nav-cluster {
    display: flex;
    gap: 4px;
    padding: 4px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
  }

  .nav-cluster button,
  .tool-btn,
  .speed-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
    width: 32px;
    height: 32px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .nav-cluster button:hover,
  .tool-btn:hover,
  .speed-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(0, 122, 255, 0.5);
    transform: translateY(-1px);
  }

  .play-btn {
    background: rgba(0, 122, 255, 0.2) !important;
    border-color: rgba(0, 122, 255, 0.4) !important;
    width: 36px !important;
    height: 36px !important;
  }

  .play-btn:hover {
    background: rgba(0, 122, 255, 0.3) !important;
    box-shadow: 0 0 12px rgba(0, 122, 255, 0.4);
  }

  .tool-btn.active {
    background: rgba(0, 255, 136, 0.2);
    border-color: rgba(0, 255, 136, 0.4);
  }

  /* Status Display */
  .status-display {
    display: flex;
    gap: 1.5rem;
    font-family: 'SF Mono', 'Monaco', monospace;
    font-size: 0.8125rem;
  }

  .status-display > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 500;
  }

  .value {
    color: rgba(255, 255, 255, 0.95);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* Progress Scrubber (Native Range Input) */
  .scrubber {
    flex: 1;
    min-width: 200px;
    height: 6px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.1); /* Fallback background */
    border-radius: 3px;
    cursor: pointer;
    outline: none;
  }

  /* WebKit (Chrome/Safari) */
  .scrubber::-webkit-slider-track {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.1); /* Gray track as base */
    border-radius: 3px;
  }

  /* Progress fill using ::before pseudo-element (CSS var not supported in gradients on all browsers) */
  .scrubber::-webkit-slider-runnable-track {
    width: 100%;
    height: 6px;
    background: linear-gradient(
      to right,
      rgba(0, 122, 255, 0.8) 0%,
      rgba(0, 122, 255, 0.8) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) 100%
    );
    border-radius: 3px;
  }

  .scrubber::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -4px;  /* Center on track */
    border-radius: 50%;
    background: white;
    border: 2px solid rgba(0, 122, 255, 1);
    cursor: grab;
    box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.2), 0 2px 8px rgba(0, 0, 0, 0.4);
    transition: transform 0.2s;
  }

  .scrubber:active::-webkit-slider-thumb {
    cursor: grabbing;
    transform: scale(1.2);
  }

  /* Firefox */
  .scrubber::-moz-range-track {
    width: 100%;
    height: 6px;
    background: linear-gradient(
      to right,
      rgba(0, 122, 255, 0.8) 0%,
      rgba(0, 122, 255, 0.8) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) var(--progress, 0%),
      rgba(255, 255, 255, 0.1) 100%
    );
    border-radius: 3px;
  }

  .scrubber::-moz-range-progress {
    height: 6px;
    background: rgba(0, 122, 255, 0.8);
    border-radius: 3px 0 0 3px;
  }

  .scrubber::-moz-range-thumb {
    width: 14px;
    height: 14px;
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

  /* Tools Cluster */
  .tools-cluster {
    display: flex;
    gap: 4px;
  }

  .badge {
    font-size: 0.625rem;
    font-weight: 600;
    background: rgba(0, 255, 136, 0.3);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* Dropdown */
  .dropdown {
    position: relative;
  }

  .menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 8px;
    background: rgba(20, 20, 20, 0.95);
    backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    padding: 4px;
    min-width: 120px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    z-index: 1000;
  }

  .menu button {
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.9);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.15s;
  }

  .menu button:hover:not(:disabled) {
    background: rgba(0, 122, 255, 0.2);
  }

  .menu button.selected {
    background: rgba(0, 122, 255, 0.3);
    color: white;
  }

  .menu button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Speed */
  .speed-cluster {
    display: flex;
  }

  .speed-btn {
    width: auto !important;
    padding: 0 12px !important;
    gap: 6px;
  }

  .speed-value {
    font-family: 'SF Mono', monospace;
    font-weight: 600;
    font-size: 0.875rem;
    min-width: 40px;
    text-align: right;
  }

  /* Mode Badge */
  .mode-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 12px;
    height: 32px;
    background: rgba(0, 122, 255, 0.15);
    border: 1px solid rgba(0, 122, 255, 0.3);
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: rgba(0, 122, 255, 1);
    text-shadow: 0 0 8px rgba(0, 122, 255, 0.5);
  }

  .mode-badge.live {
    background: rgba(0, 255, 136, 0.15);
    border-color: rgba(0, 255, 136, 0.3);
    color: rgba(0, 255, 136, 1);
    text-shadow: 0 0 8px rgba(0, 255, 136, 0.5);
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .status-display {
      gap: 1rem;
    }

    .fps {
      display: none;
    }
  }

  @media (max-width: 768px) {
    .time-machine {
      flex-wrap: wrap;
      height: auto;
      padding: 0.5rem 1rem;
    }

    .scrubber {
      order: -1;
      width: 100%;
      margin-bottom: 0.5rem;
    }

    .status-display .timestamp {
      display: none;
    }
  }
</style>
