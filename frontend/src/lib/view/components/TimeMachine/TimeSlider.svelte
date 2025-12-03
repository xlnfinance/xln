<script lang="ts">
  /**
   * TimeSlider - Compact time-travel controls for panel headers
   *
   * Lightweight version of TimeMachine for embedding in dockview panels.
   * Shows: slider + frame counter + LIVE/HISTORY badge + step buttons
   */

  import { type Writable } from 'svelte/store';
  import { ChevronLeft, ChevronRight, Radio } from 'lucide-svelte';

  // Props: REQUIRED isolated stores
  export let history: Writable<any[]>;
  export let timeIndex: Writable<number>;
  export let isLive: Writable<boolean>;

  $: maxTimeIndex = Math.max(0, $history.length - 1);
  $: progressPercent = maxTimeIndex > 0 ? ($timeIndex / maxTimeIndex) * 100 : 0;

  // Time operations
  function goToTimeIndex(index: number) {
    const max = maxTimeIndex;
    timeIndex.set(Math.max(0, Math.min(index, max)));
    isLive.set(false);
  }

  function stepForward() {
    if ($timeIndex < maxTimeIndex) {
      timeIndex.set($timeIndex + 1);
      isLive.set(false);
    }
  }

  function stepBackward() {
    if ($timeIndex > 0) {
      timeIndex.set($timeIndex - 1);
    }
    isLive.set(false);
  }

  function goToLive() {
    timeIndex.set(-1);
    isLive.set(true);
  }

  function handleSliderInput(event: Event) {
    const target = event.target as HTMLInputElement;
    goToTimeIndex(parseInt(target.value));
  }
</script>

<div class="time-slider">
  <!-- Step controls -->
  <button class="step-btn" on:click={stepBackward} title="Step back" disabled={$timeIndex <= 0}>
    <ChevronLeft size={14} />
  </button>

  <!-- Scrubber -->
  <input
    type="range"
    class="scrubber"
    min="0"
    max={maxTimeIndex}
    value={$timeIndex >= 0 ? $timeIndex : maxTimeIndex}
    on:input={handleSliderInput}
    disabled={maxTimeIndex === 0}
    style="--progress: {progressPercent}%"
    title="Drag to time-travel"
  />

  <button class="step-btn" on:click={stepForward} title="Step forward" disabled={$timeIndex >= maxTimeIndex}>
    <ChevronRight size={14} />
  </button>

  <!-- Frame counter -->
  <span class="frame-counter" title="Current frame / Total frames">
    {$timeIndex >= 0 ? $timeIndex + 1 : $history.length}/{$history.length}
  </span>

  <!-- Live button -->
  <button
    class="live-btn"
    class:active={$isLive}
    on:click={goToLive}
    title={$isLive ? 'Currently live' : 'Go to live'}
  >
    <Radio size={12} />
    <span>{$isLive ? 'LIVE' : 'GO LIVE'}</span>
  </button>
</div>

<style>
  .time-slider {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    font-size: 0.75rem;
  }

  .step-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    transition: all 0.15s;
  }

  .step-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(0, 122, 255, 0.5);
  }

  .step-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .scrubber {
    flex: 1;
    min-width: 80px;
    max-width: 200px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    cursor: pointer;
    outline: none;
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
    width: 10px;
    height: 10px;
    margin-top: -3px;
    border-radius: 50%;
    background: white;
    border: 1px solid rgba(0, 122, 255, 0.8);
    cursor: grab;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }

  .scrubber:active::-webkit-slider-thumb {
    cursor: grabbing;
    transform: scale(1.2);
  }

  .scrubber:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .frame-counter {
    font-family: 'SF Mono', monospace;
    font-size: 0.6875rem;
    color: rgba(255, 255, 255, 0.6);
    min-width: 45px;
    text-align: center;
  }

  .live-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    cursor: pointer;
    transition: all 0.15s;
  }

  .live-btn:hover {
    background: rgba(0, 255, 136, 0.15);
    border-color: rgba(0, 255, 136, 0.3);
    color: rgba(0, 255, 136, 0.9);
  }

  .live-btn.active {
    background: rgba(0, 255, 136, 0.2);
    border-color: rgba(0, 255, 136, 0.4);
    color: #00ff88;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
</style>
