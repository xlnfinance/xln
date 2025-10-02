<script lang="ts">
  import { timeOperations, timeState } from '../../stores/timeStore';
  import { history, currentHeight } from '../../stores/xlnStore';
  import { onMount, onDestroy, tick } from 'svelte';
  import { SkipBack, ChevronLeft, ChevronRight, Play, Pause, Zap, RotateCcw } from 'lucide-svelte';

  // Player state
  let isPlaying = true; // Start in play mode by default
  let playbackSpeed = 1; // 0.25x, 0.5x, 1x, 2x, 4x
  let loopEnabled = true; // Loop by default
  let playbackInterval: number | null = null;

  // Reactive values
  $: timeInfo = getTimeInfo($timeState, $history);
  $: sliderValue = getSliderValue($timeState);
  $: progressPercent = getProgressPercent($timeState);

  function getTimeInfo(state: any, historyArray: any[]) {
    if (state.isLive) {
      return {
        status: '⚡ LIVE',
        description: 'Current time',
        frameInfo: `Height: ${$currentHeight}`,
        totalFrames: `${historyArray.length} snapshots`
      };
    } else {
      const snapshot = timeOperations.getCurrentSnapshot();
      return {
        status: `📸 ${state.currentTimeIndex + 1}/${historyArray.length}`,
        description: snapshot?.description || 'Historical snapshot',
        frameInfo: `Height: ${snapshot?.height || 0}`,
        totalFrames: snapshot?.description || ''
      };
    }
  }

  function getSliderValue(state: any) {
    if (state.isLive) {
      return state.maxTimeIndex + 1; // Live position
    }
    return state.currentTimeIndex;
  }

  function getProgressPercent(state: any) {
    if (state.isLive) {
      return 100;
    }
    // When at maxTimeIndex, we're at 100% (last historical frame)
    if (state.currentTimeIndex >= state.maxTimeIndex && state.maxTimeIndex > 0) {
      return 100;
    }
    const sliderMax = state.maxTimeIndex + 1;
    return sliderMax > 0 ? (state.currentTimeIndex / sliderMax) * 100 : 0;
  }

  function handleSliderChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value);
    const maxMeaningfulIndex = $timeState.maxTimeIndex;

    if (value > maxMeaningfulIndex) {
      timeOperations.goToLive();
    } else {
      timeOperations.goToTimeIndex(value);
    }
  }

  function handleStepBackward() {
    timeOperations.stepBackward();
  }

  function handleStepForward() {
    timeOperations.stepForward();
  }

  function handleGoToStart() {
    timeOperations.goToHistoryStart();
  }

  function handleGoToLive() {
    timeOperations.goToLive();
    stopPlayback(); // Stop playback when going live
  }

  // Player controls
  function togglePlayPause() {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  async function startPlayback() {
    // If no history, can't play
    if ($history.length === 0) return;

    // If we're live or at the end, jump to start before playing
    if ($timeState.isLive || $timeState.currentTimeIndex >= $timeState.maxTimeIndex) {
      timeOperations.goToHistoryStart();
      // Wait for both DOM and store updates to complete
      await tick();
      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay for store propagation
    }

    isPlaying = true;
    const baseInterval = 1000; // 1 second base interval
    const interval = baseInterval / playbackSpeed;

    playbackInterval = window.setInterval(() => {
      // Allow stepping forward until we're AT maxTimeIndex (inclusive)
      // This ensures the last frame is shown before stopping
      if ($timeState.currentTimeIndex < $timeState.maxTimeIndex) {
        timeOperations.stepForward();
      } else if ($timeState.currentTimeIndex === $timeState.maxTimeIndex) {
        // We're at the last historical frame, take one more step to LIVE
        timeOperations.stepForward(); // This will transition to LIVE
        // Then handle end-of-playback
        if (loopEnabled) {
          timeOperations.goToHistoryStart();
        } else {
          stopPlayback();
        }
      }
    }, interval);
  }

  function stopPlayback() {
    isPlaying = false;
    if (playbackInterval !== null) {
      clearInterval(playbackInterval);
      playbackInterval = null;
    }
  }

  function handleSpeedChange(event: Event) {
    const target = event.target as HTMLInputElement;
    playbackSpeed = parseFloat(target.value);

    // Restart playback with new speed if currently playing
    if (isPlaying) {
      stopPlayback();
      startPlayback();
    }
  }

  function toggleLoop() {
    loopEnabled = !loopEnabled;
  }

  // Auto-start playback on mount
  onMount(() => {
    // Start playback automatically after component mounts and history loads
    setTimeout(() => {
      if ($history.length > 0 && isPlaying) {
        startPlayback();
      }
    }, 500); // Small delay to ensure history is loaded
  });

  // Cleanup on component destroy
  onDestroy(() => {
    stopPlayback();
  });

  // Keyboard shortcuts
  function handleKeydown(event: KeyboardEvent) {
    // Only activate when not typing in inputs
    if (event.target && (event.target as HTMLElement).tagName === 'INPUT') return;
    if (event.target && (event.target as HTMLElement).tagName === 'TEXTAREA') return;

    switch(event.key) {
      case ' ':
      case 'k':
        event.preventDefault();
        togglePlayPause();
        break;
      case 'ArrowLeft':
      case 'j':
        event.preventDefault();
        handleStepBackward();
        break;
      case 'ArrowRight':
      case 'l':
        event.preventDefault();
        handleStepForward();
        break;
      case 'Home':
        event.preventDefault();
        handleGoToStart();
        break;
      case 'End':
        event.preventDefault();
        handleGoToLive();
        break;
      case 'L':
        event.preventDefault();
        toggleLoop();
        break;
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="time-machine">
  <div class="time-machine-main">
    <!-- Left: Time info -->
    <div class="time-info-compact" class:current={$timeState.isLive}>
      <span>{timeInfo.status}</span>
      <span>{timeInfo.frameInfo}</span>
    </div>

    <!-- Center: Navigation controls -->
    <div class="time-nav-controls">
      <button class="icon-btn" on:click={handleGoToStart} title="Go to Start (Home)">
        <SkipBack size={14} />
      </button>
      <button class="icon-btn" on:click={handleStepBackward} title="Step Back (← or J)">
        <ChevronLeft size={14} />
      </button>
      <button class="icon-btn" on:click={handleStepForward} title="Step Forward (→ or L)">
        <ChevronRight size={14} />
      </button>
    </div>

    <!-- Timeline slider -->
    <div class="time-slider-container" style="--progress: {progressPercent}%">
      <input
        type="range"
        id="timeSlider"
        class="time-slider"
        min="0"
        max={$timeState.maxTimeIndex + 1}
        value={sliderValue}
        disabled={$history.length === 0}
        on:input={handleSliderChange}
      />
    </div>

    <!-- Right: Playback controls -->
    <div class="time-playback-controls">
      <button
        class="icon-btn play-btn"
        class:playing={isPlaying}
        on:click={togglePlayPause}
        title="Play/Pause (Space or K)"
        disabled={$history.length === 0}
      >
        {#if isPlaying}
          <Pause size={14} />
        {:else}
          <Play size={14} />
        {/if}
      </button>
      <button
        class="icon-btn loop-btn"
        class:active={loopEnabled}
        on:click={toggleLoop}
        title="Loop Playback (Shift+L)"
      >
        <RotateCcw size={13} />
      </button>
      <div class="speed-control">
        <span class="speed-label">{playbackSpeed}x</span>
        <input
          type="range"
          class="speed-slider"
          min="0.25"
          max="10"
          step="0.25"
          value={playbackSpeed}
          on:input={handleSpeedChange}
          title="Playback Speed"
        />
      </div>
    </div>

    <!-- Far right: LIVE button -->
    <button class="live-btn" on:click={handleGoToLive} title="Go to Live (End)">
      <Zap size={12} />
      <span>LIVE</span>
    </button>
  </div>
</div>

<style>
  .time-machine {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    /* Apple liquid glass ribbon - ultra thin */
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.15) 0%,
      rgba(255, 255, 255, 0.12) 100%
    );
    backdrop-filter: blur(60px) saturate(180%);
    -webkit-backdrop-filter: blur(60px) saturate(180%);
    padding: 6px 20px;
    border-top: 1px solid rgba(255, 255, 255, 0.2);
    z-index: 1000;
    box-shadow:
      0 -8px 32px rgba(0, 0, 0, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.15),
      0 0 0 0.5px rgba(255, 255, 255, 0.1);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .time-machine-main {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    margin: 0 auto;
  }

  .time-info-compact {
    display: flex;
    align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', monospace;
    font-size: 0.7em;
    color: rgba(255, 255, 255, 0.75);
    gap: 8px;
    min-width: 140px;
    font-weight: 500;
    flex-shrink: 0;
  }

  .time-info-compact.current {
    color: #00ff88;
    font-weight: 600;
    text-shadow: 0 0 20px rgba(0, 255, 136, 0.6);
  }

  .time-nav-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .time-playback-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* Icon button base style - ultra minimal */
  .icon-btn {
    background: rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(20px);
    color: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 4px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  }

  .icon-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.3);
    color: rgba(255, 255, 255, 1);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .icon-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  /* Play button - highlighted */
  .icon-btn.play-btn {
    background: linear-gradient(135deg, rgba(0, 122, 255, 0.4), rgba(0, 180, 255, 0.3));
    border-color: rgba(0, 122, 255, 0.5);
    color: #ffffff;
    box-shadow:
      0 2px 10px rgba(0, 122, 255, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }

  .icon-btn.play-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(0, 122, 255, 0.5), rgba(0, 180, 255, 0.4));
    border-color: rgba(0, 122, 255, 0.6);
    transform: translateY(-1px) scale(1.05);
    box-shadow:
      0 4px 16px rgba(0, 122, 255, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }

  .icon-btn.play-btn.playing {
    background: linear-gradient(135deg, rgba(255, 136, 0, 0.4), rgba(204, 102, 0, 0.3));
    border-color: rgba(255, 136, 0, 0.5);
    animation: pulse 1.5s ease-in-out infinite;
  }

  /* Loop button - active state */
  .icon-btn.loop-btn.active {
    background: linear-gradient(135deg, rgba(0, 122, 255, 0.4), rgba(0, 180, 255, 0.3));
    border-color: rgba(0, 122, 255, 0.5);
    color: #ffffff;
    box-shadow:
      0 2px 10px rgba(0, 122, 255, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }

  /* LIVE button */
  .live-btn {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.35), rgba(0, 200, 255, 0.25));
    backdrop-filter: blur(20px);
    color: #ffffff;
    border: 1px solid rgba(0, 255, 136, 0.5);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 0.7em;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    flex-shrink: 0;
    box-shadow:
      0 2px 10px rgba(0, 255, 136, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }

  .live-btn:hover {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.45), rgba(0, 200, 255, 0.35));
    border-color: rgba(0, 255, 136, 0.6);
    transform: translateY(-1px);
    box-shadow:
      0 4px 16px rgba(0, 255, 136, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }

  /* Timeline slider */
  .time-slider-container {
    position: relative;
    flex: 1 1 auto;
    min-width: 150px;
    --progress: 0%;
  }

  .time-slider {
    width: 100%;
    height: 3px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.18);
    outline: none;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
  }

  .time-slider:hover {
    background: rgba(255, 255, 255, 0.22);
  }

  .time-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffffff 0%, rgba(255, 255, 255, 0.95) 100%);
    cursor: pointer;
    box-shadow:
      0 2px 6px rgba(0, 0, 0, 0.3),
      0 0 0 2px rgba(0, 122, 255, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.5);
    border: none;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .time-slider::-webkit-slider-thumb:hover {
    transform: scale(1.2);
    box-shadow:
      0 4px 10px rgba(0, 0, 0, 0.4),
      0 0 0 3px rgba(0, 122, 255, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.6);
  }

  .time-slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffffff 0%, rgba(255, 255, 255, 0.95) 100%);
    cursor: pointer;
    border: none;
    box-shadow:
      0 2px 6px rgba(0, 0, 0, 0.3),
      0 0 0 2px rgba(0, 122, 255, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.5);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .time-slider:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  /* Speed control */
  .speed-control {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .speed-label {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', monospace;
    font-size: 0.65em;
    color: rgba(255, 255, 255, 0.75);
    min-width: 28px;
    text-align: right;
    font-weight: 600;
  }

  .speed-slider {
    width: 50px;
    height: 2px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    outline: none;
    cursor: pointer;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .speed-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffffff 0%, rgba(255, 255, 255, 0.9) 100%);
    cursor: pointer;
    box-shadow:
      0 1px 4px rgba(0, 0, 0, 0.3),
      0 0 0 2px rgba(0, 122, 255, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.5);
    border: none;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .speed-slider::-webkit-slider-thumb:hover {
    transform: scale(1.15);
    box-shadow:
      0 2px 8px rgba(0, 0, 0, 0.4),
      0 0 0 2px rgba(0, 122, 255, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.6);
  }

  .speed-slider::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffffff 0%, rgba(255, 255, 255, 0.9) 100%);
    cursor: pointer;
    border: none;
    box-shadow:
      0 1px 4px rgba(0, 0, 0, 0.3),
      0 0 0 2px rgba(0, 122, 255, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.5);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  @keyframes pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(255, 136, 0, 0.4);
    }
    50% {
      box-shadow: 0 0 0 4px rgba(255, 136, 0, 0);
    }
  }
</style>
