<script lang="ts">
  import { timeOperations, timeState } from '../../stores/timeStore';
  import { history, currentHeight } from '../../stores/xlnStore';
  import { onDestroy } from 'svelte';

  // Player state
  let isPlaying = false;
  let playbackSpeed = 1; // 0.25x, 0.5x, 1x, 2x, 4x
  let loopEnabled = false;
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

  function startPlayback() {
    // If no history, can't play
    if ($history.length === 0) return;

    // If we're live or at the end, jump to start before playing
    if ($timeState.isLive || $timeState.currentTimeIndex >= $timeState.maxTimeIndex) {
      timeOperations.goToHistoryStart();
    }

    isPlaying = true;
    const baseInterval = 1000; // 1 second base interval
    const interval = baseInterval / playbackSpeed;

    playbackInterval = window.setInterval(() => {
      if ($timeState.currentTimeIndex < $timeState.maxTimeIndex) {
        timeOperations.stepForward();
      } else {
        // Reached the end
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
    <div class="time-info-compact" class:current={$timeState.isLive}>
      <span>{timeInfo.status}</span>
      <span>{timeInfo.frameInfo}</span>
      <span>{timeInfo.totalFrames}</span>
    </div>
    <div class="time-nav-controls">
      <button class="time-btn-mini" on:click={handleGoToStart} title="Go to Start (Home key)">
        ⏮️
      </button>
      <button class="time-btn-compact" on:click={handleStepBackward} title="Step Back (← or J)">
        ⏪
      </button>
      <button
        class="time-btn-compact play-pause"
        class:playing={isPlaying}
        on:click={togglePlayPause}
        title="Play/Pause (Space or K)"
        disabled={$history.length === 0}
      >
        {isPlaying ? '⏸' : '▶️'}
      </button>
      <button class="time-btn-compact" on:click={handleStepForward} title="Step Forward (→ or L)">
        ⏩
      </button>
      <button class="time-btn-compact live" on:click={handleGoToLive} title="Go to Current (End key)">
        ⚡ LIVE
      </button>
    </div>
    <div class="time-utility-controls">
      <div class="speed-control">
        <label class="speed-label">{playbackSpeed}x</label>
        <input
          type="range"
          class="speed-slider"
          min="0.25"
          max="10"
          step="0.25"
          value={playbackSpeed}
          on:input={handleSpeedChange}
          title="Playback Speed (0.25x - 10x)"
        />
      </div>
      <button
        class="time-btn-mini loop"
        class:active={loopEnabled}
        on:click={toggleLoop}
        title="Loop Playback (Shift+L)"
      >
        🔁
      </button>
    </div>
  </div>
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
</div>

<style>
  .time-machine {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(15, 15, 15, 0.96);
    backdrop-filter: blur(20px);
    padding: 12px 20px;
    border-top: 1px solid #007bff;
    z-index: 1000;
    box-shadow: 0 -2px 15px rgba(0,0,0,0.4);
  }

  .time-machine-main {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    gap: 15px;
  }

  .time-info-compact {
    display: flex;
    align-items: center;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 0.75em;
    color: #aaa;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .time-info-compact.current {
    color: #00ff88;
    font-weight: bold;
  }

  .time-nav-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .time-utility-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .time-btn-compact {
    background: #2a2a2a;
    color: white;
    border: 1px solid #444;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.75em;
    transition: all 0.15s ease;
    min-width: 28px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .time-btn-compact:hover {
    background: #007bff;
    border-color: #007bff;
    transform: translateY(-1px);
  }


  .time-btn-compact.live {
    background: #00ff88;
    color: #000;
    border-color: #00ff88;
    font-weight: bold;
    padding: 4px 10px;
    min-width: 45px;
  }

  .time-btn-compact.live:hover {
    background: #00cc6a;
    border-color: #00cc6a;
  }

  .time-btn-mini {
    background: #333;
    color: #aaa;
    border: 1px solid #555;
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.7em;
    transition: all 0.15s ease;
    min-width: 22px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .time-btn-mini:hover {
    background: #555;
    color: white;
  }

  .time-slider-container {
    position: relative;
    width: 100%;
    max-width: 100%;
    --progress: 0%;
  }

  .time-slider {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(90deg,
        #007acc 0%,
        #00ff88 var(--progress),
        #404040 var(--progress),
        #555 100%);
    outline: none;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .time-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: linear-gradient(45deg, #007acc, #005a9a);
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0,122,204,0.4);
    transition: all 0.2s ease;
  }

  .time-slider::-webkit-slider-thumb:hover {
    transform: scale(1.1);
    box-shadow: 0 2px 8px rgba(0,122,204,0.6);
  }

  .time-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: linear-gradient(45deg, #007acc, #005a9a);
    cursor: pointer;
    border: none;
    box-shadow: 0 1px 4px rgba(0,122,204,0.4);
  }

  .time-slider:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Player Controls */
  .time-btn-compact.play-pause {
    background: linear-gradient(135deg, #007bff 0%, #0056b3 100%);
    border-color: #007bff;
    font-size: 14px;
    min-width: 32px;
  }

  .time-btn-compact.play-pause:hover {
    background: linear-gradient(135deg, #0056b3 0%, #003d82 100%);
    transform: translateY(-1px) scale(1.05);
  }

  .time-btn-compact.play-pause.playing {
    background: linear-gradient(135deg, #ff8800 0%, #cc6600 100%);
    border-color: #ff8800;
    animation: pulse 1.5s ease-in-out infinite;
  }

  .time-btn-compact.play-pause:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    transform: none !important;
  }

  .speed-control {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .speed-label {
    font-family: monospace;
    font-size: 0.7em;
    color: #aaa;
    min-width: 32px;
    text-align: right;
    font-weight: 600;
  }

  .speed-slider {
    width: 80px;
    height: 3px;
    -webkit-appearance: none;
    appearance: none;
    background: linear-gradient(90deg, #555 0%, #007bff 100%);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }

  .speed-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #007bff;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .speed-slider::-webkit-slider-thumb:hover {
    transform: scale(1.2);
    background: #00a0ff;
  }

  .speed-slider::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #007bff;
    cursor: pointer;
    border: none;
  }

  .time-btn-mini.loop {
    font-size: 14px;
  }

  .time-btn-mini.loop.active {
    background: #007bff;
    color: white;
    border-color: #007bff;
    box-shadow: 0 0 8px rgba(0, 122, 204, 0.4);
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
