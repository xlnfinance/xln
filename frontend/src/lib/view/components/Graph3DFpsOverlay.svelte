<script lang="ts">
  import { createGraph3dFpsOverlayView } from '../../../../packages/runtime-client/src/graph3d-viewport-view';

  export let renderFps = 0;
  export let frameTime = 0;
  export let entityCount = 0;
  export let connectionCount = 0;
  export let particleCount = 0;
  export let barsMode: 'close' | 'spread' = 'close';
  export let onToggleBars: () => void = () => {};

  $: fpsView = createGraph3dFpsOverlayView(renderFps, frameTime, barsMode);
</script>

<div class="fps-overlay">
  <div
    class="fps-stat"
    class:fps-good={fpsView.tone === 'good'}
    class:fps-ok={fpsView.tone === 'ok'}
    class:fps-bad={fpsView.tone === 'bad'}
  >
    <span class="fps-label">Render FPS</span>
    <span class="fps-value">{fpsView.fpsLabel}</span>
  </div>
  <div class="fps-stat-secondary">
    <span>{fpsView.frameTimeLabel}</span>
  </div>

  <div class="stats-divider"></div>

  <div class="network-stat">
    <span class="stat-label">Entities</span>
    <span class="stat-value">{entityCount}</span>
  </div>

  <div class="network-stat">
    <span class="stat-label">Connections</span>
    <span class="stat-value">{connectionCount}</span>
  </div>

  <div class="network-stat">
    <span class="stat-label">Particles</span>
    <span class="stat-value">{particleCount}</span>
  </div>

  <button
    class="bars-mode-toggle"
    on:click={onToggleBars}
    title={fpsView.barsTitle}
  >
    {fpsView.barsLabel}
  </button>
</div>

<style>
  .fps-overlay {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(0, 255, 65, 0.3);
    border-radius: 6px;
    padding: 8px 12px;
    font-family: 'Courier New', monospace;
    pointer-events: none;
    z-index: 100;
  }

  .fps-stat {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }

  .fps-label {
    font-size: 11px;
    color: #888;
    text-transform: uppercase;
  }

  .fps-value {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }

  .fps-good .fps-value {
    color: #00ff41;
  }

  .fps-ok .fps-value {
    color: #ffaa00;
  }

  .fps-bad .fps-value {
    color: #ff4646;
  }

  .fps-stat-secondary {
    font-size: 10px;
    color: #666;
    text-align: right;
  }

  .stats-divider {
    height: 1px;
    background: rgba(0, 255, 65, 0.2);
    margin: 8px 0;
  }

  .network-stat {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .stat-label {
    font-size: 10px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .stat-value {
    font-size: 14px;
    font-weight: 700;
    color: #00ff88;
    font-family: 'Courier New', monospace;
  }
</style>
