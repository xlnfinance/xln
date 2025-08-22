<script lang="ts">
  import { timeOperations, timeState } from '../../stores/timeStore';
  import { history, currentHeight } from '../../stores/xlnStore';

  // Reactive values
  $: timeInfo = getTimeInfo($timeState, $history);
  $: sliderValue = getSliderValue($timeState, $history);
  $: progressPercent = getProgressPercent($timeState, $history);

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

  function getSliderValue(state: any, historyArray: any[]) {
    if (state.isLive) {
      return historyArray.length; // Live position is beyond last snapshot
    }
    return state.currentTimeIndex;
  }

  function getProgressPercent(state: any, historyArray: any[]) {
    if (state.isLive) {
      return 100;
    }
    const totalSteps = historyArray.length; // Include live position
    return totalSteps > 0 ? (state.currentTimeIndex / (totalSteps - 1)) * 100 : 0;
  }

  function handleSliderChange(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value);
    const historyLength = $history.length;
    
    console.log('🎛️ Time slider changed to:', value, 'History length:', historyLength);
    
    if (value >= historyLength) {
      // Go to live
      timeOperations.goToLive();
    } else {
      // Go to specific historical index
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
  }

  // Keyboard shortcuts
  function handleKeydown(event: KeyboardEvent) {
    // Only activate when not typing in inputs
    if (event.target && (event.target as HTMLElement).tagName === 'INPUT') return;
    if (event.target && (event.target as HTMLElement).tagName === 'TEXTAREA') return;
    
    switch(event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        handleStepBackward();
        break;
      case 'ArrowRight':
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
      <button class="time-btn-compact" on:click={handleStepBackward} title="Step Back (← arrow)">
        ⏪
      </button>
      <button class="time-btn-compact" on:click={handleStepForward} title="Step Forward (→ arrow)">
        ⏩
      </button>
      <button class="time-btn-compact live" on:click={handleGoToLive} title="Go to Current (End key)">
        ⚡ LIVE
      </button>
    </div>
    <div class="time-utility-controls">
      <button class="time-btn-mini" on:click={handleGoToStart} title="Go to Start (Home key)">
        ⏮️
      </button>
    </div>
  </div>
  <div class="time-slider-container" style="--progress: {progressPercent}%">
    <input 
      type="range" 
      class="time-slider" 
      min="0" 
      max={$history.length}
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

  .time-btn-compact.primary {
    background: #007bff;
    border-color: #007bff;
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
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, 
        #007acc 0%, 
        #00ff88 var(--progress), 
        #404040 var(--progress), 
        #555 100%);
    outline: none;
    -webkit-appearance: none;
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
</style>
