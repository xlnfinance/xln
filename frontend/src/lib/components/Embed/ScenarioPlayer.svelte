<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import NetworkTopology from '$lib/components/Network/NetworkTopology.svelte';
  import { timeOperations, currentTimeIndex, maxTimeIndex } from '$lib/stores/timeStore';

  export let scenario: string = 'phantom-grid';  // Scenario name or inline
  export let width: string = '100%';
  export let height: string = '600px';
  export let autoplay: boolean = true;
  export let loop: boolean = false;
  export let slice: string = '';  // "0:10" to play frames 0-10
  export let speed: number = 1.0;  // Playback speed multiplier

  let playing = false;
  let scenarioLoaded = false;
  let error: string | null = null;
  let sliceStart = 0;
  let sliceEnd = -1;  // -1 = play to end

  let playbackInterval: number | null = null;

  $: if (scenarioLoaded && autoplay && !playing) {
    play();
  }

  async function loadAndExecuteScenario() {
    try {
      let scenarioText: string;

      // Determine scenario source
      if (scenario.includes('\n') || scenario.startsWith('SEED')) {
        // Inline scenario
        scenarioText = scenario;
      } else {
        // Named scenario - fetch from /worlds/
        const response = await fetch(`/worlds/${scenario}.scenario.txt`);
        if (!response.ok) {
          throw new Error(`Scenario not found: ${scenario}`);
        }
        scenarioText = await response.text();
      }

      // Parse slice if provided
      if (slice) {
        const parts = slice.split(':').map(Number);
        sliceStart = parts[0] || 0;
        sliceEnd = parts[1] || -1;
      }

      // Execute scenario via runtime.js module
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Get environment
      const { getEnv } = await import('$lib/stores/xlnStore');
      const env = getEnv();

      if (!env) {
        throw new Error('Environment not initialized');
      }

      // Parse and execute
      const parsed = XLN.parseScenario(scenarioText);

      if (parsed.errors.length > 0) {
        throw new Error(`Parse error: ${parsed.errors[0].message}`);
      }

      await XLN.executeScenario(env, parsed.scenario);
      scenarioLoaded = true;

      // Jump to slice start if specified
      if (sliceStart > 0) {
        timeOperations.goToTimeIndex(sliceStart);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load scenario';
      console.error('ScenarioPlayer error:', err);
    }
  }

  function play() {
    if (playing) return;
    playing = true;

    const frameDelay = (1000 / speed);  // Adjust by speed

    playbackInterval = window.setInterval(() => {
      const current = $currentTimeIndex;
      const total = $maxTimeIndex;
      const end = sliceEnd > 0 ? Math.min(sliceEnd, total) : total;

      if (current >= end) {
        if (loop) {
          timeOperations.goToTimeIndex(sliceStart);
        } else {
          pause();
        }
      } else {
        timeOperations.stepForward();
      }
    }, frameDelay);
  }

  function pause() {
    playing = false;
    if (playbackInterval) {
      clearInterval(playbackInterval);
      playbackInterval = null;
    }
  }

  function restart() {
    timeOperations.goToTimeIndex(sliceStart);
    if (!playing) play();
  }

  function handleProgressClick(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percentage = x / rect.width;

    const total = $maxTimeIndex;
    const end = sliceEnd > 0 ? Math.min(sliceEnd, total) : total;
    const range = end - sliceStart;
    const targetFrame = Math.floor(sliceStart + (percentage * range));

    timeOperations.goToTimeIndex(targetFrame);
  }

  $: progress = $maxTimeIndex > 0
    ? (($currentTimeIndex - sliceStart) / ($maxTimeIndex - sliceStart)) * 100
    : 0;

  onMount(() => {
    loadAndExecuteScenario();
  });

  onDestroy(() => {
    pause();
  });
</script>

<div class="scenario-player" style="width: {width}; height: {height};">
  {#if error}
    <div class="error-state">
      <p>⚠️ {error}</p>
    </div>
  {:else if scenarioLoaded}
    <div class="player-container">
      <!-- 3D Visualization -->
      <div class="viewport">
        <NetworkTopology
          zenMode={false}
          hideButton={true}
          toggleZenMode={() => {}}
          embedded={true}
        />
      </div>

      <!-- YouTube-style controls -->
      <div class="controls">
        <div class="progress-bar" on:click={handleProgressClick}>
          <div class="progress-fill" style="width: {progress}%"></div>
        </div>

        <div class="control-row">
          <div class="control-group">
            {#if playing}
              <button class="control-btn" on:click={pause} title="Pause">
                ⏸
              </button>
            {:else}
              <button class="control-btn" on:click={play} title="Play">
                ▶
              </button>
            {/if}
            <button class="control-btn" on:click={restart} title="Restart">
              ↻
            </button>
            <span class="time-display">
              {$currentTimeIndex} / {$maxTimeIndex}
            </span>
          </div>

          <div class="control-group">
            <label class="control-label">
              <input type="checkbox" bind:checked={loop} />
              Loop
            </label>
            <span class="speed-label">{speed}x</span>
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading scenario...</p>
    </div>
  {/if}
</div>

<style>
  .scenario-player {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg);
    margin: 1.5rem 0;
  }

  .player-container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .viewport {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  /* Force NetworkTopology to stay contained */
  .viewport :global(canvas) {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    width: 100% !important;
    height: 100% !important;
  }

  .viewport :global(.topology-overlay) {
    display: none !important;  /* Hide sidebar in embedded mode */
  }

  .controls {
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    padding: 0.75rem;
  }

  .progress-bar {
    height: 4px;
    background: var(--bg);
    border-radius: 2px;
    cursor: pointer;
    margin-bottom: 0.75rem;
    position: relative;
    overflow: hidden;
  }

  .progress-bar:hover {
    height: 6px;
    margin-bottom: 0.5rem;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.1s linear;
  }

  .control-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .control-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .control-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    width: 32px;
    height: 32px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
    transition: all 0.2s;
  }

  .control-btn:hover {
    background: var(--bg);
    border-color: var(--accent);
    color: var(--accent);
  }

  .time-display {
    font-family: monospace;
    font-size: 0.875rem;
    color: var(--text-secondary);
    min-width: 80px;
  }

  .control-label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--text);
    cursor: pointer;
  }

  .control-label input {
    cursor: pointer;
  }

  .speed-label {
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-family: monospace;
  }

  /* Loading state */
  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 400px;
    color: var(--text-secondary);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-state {
    color: #ff6b6b;
  }

  .loading-state p,
  .error-state p {
    margin: 0;
    font-size: 0.875rem;
  }
</style>
