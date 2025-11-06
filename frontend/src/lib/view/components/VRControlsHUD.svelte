<script lang="ts">
  /**
   * VR Controls HUD - For First-Time Vision Pro Users
   * Simple, large, always visible
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  export let isVRActive = false;
</script>

{#if isVRActive}
  <div class="vr-hud">
    <!-- Instructions Panel (Top-Left) -->
    <div class="vr-panel instructions">
      <h2>👋 Привет!</h2>
      <div class="instruction">
        <span class="icon">👆</span>
        <span class="text">Нажми на банк → увидишь детали</span>
      </div>
      <div class="instruction">
        <span class="icon">🔄</span>
        <span class="text">Pinch + drag → вращай сцену</span>
      </div>
      <div class="instruction">
        <span class="icon">🤏</span>
        <span class="text">Pinch → zoom in/out</span>
      </div>
    </div>

    <!-- Quick Actions (Bottom) -->
    <div class="vr-panel actions">
      <button class="vr-btn big-green">
        🚀 Start Payments
      </button>
      <button class="vr-btn big-blue">
        🌀 Auto-Rotate
      </button>
      <button class="vr-btn big-red">
        ❌ Exit VR
      </button>
    </div>

    <!-- Stats Overlay (Top-Right) -->
    <div class="vr-panel stats">
      <div class="stat-item">
        <span class="stat-label">Entities</span>
        <span class="stat-value">3</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">FPS</span>
        <span class="stat-value">60</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .vr-hud {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 9999;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }

  .vr-panel {
    position: absolute;
    background: rgba(0, 0, 0, 0.85);
    border: 3px solid rgba(0, 255, 65, 0.6);
    border-radius: 24px;
    padding: 32px;
    pointer-events: all;
    backdrop-filter: blur(20px);
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  }

  .instructions {
    top: 40px;
    left: 40px;
    max-width: 400px;
  }

  .instructions h2 {
    margin: 0 0 24px 0;
    font-size: 36px;
    color: #00ff41;
    font-weight: 800;
  }

  .instruction {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 20px;
  }

  .icon {
    font-size: 40px;
    flex-shrink: 0;
  }

  .text {
    font-size: 20px;
    color: #fff;
    font-weight: 600;
    line-height: 1.4;
  }

  .actions {
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 20px;
  }

  .vr-btn {
    padding: 24px 40px;
    font-size: 24px;
    font-weight: 800;
    border: none;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.3s;
    box-shadow: 0 6px 20px rgba(0,0,0,0.4);
  }

  .big-green {
    background: linear-gradient(135deg, #00ff41, #00dd38);
    color: #000;
  }

  .big-blue {
    background: linear-gradient(135deg, #0088ff, #0066dd);
    color: #fff;
  }

  .big-red {
    background: linear-gradient(135deg, #ff4646, #dd3333);
    color: #fff;
  }

  .vr-btn:hover {
    transform: scale(1.1);
    box-shadow: 0 10px 30px rgba(0,255,65,0.4);
  }

  .stats {
    top: 40px;
    right: 40px;
    min-width: 200px;
  }

  .stat-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .stat-label {
    font-size: 16px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .stat-value {
    font-size: 32px;
    font-weight: 900;
    color: #00ff41;
    font-family: 'Courier New', monospace;
  }
</style>
