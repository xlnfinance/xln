<script lang="ts">
  /**
   * Settings Panel - All visual configuration in one place
   * Categories: Scene, Camera, Entities, Visual Effects, Performance
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { panelBridge } from '../utils/panelBridge';

  // Props (isolated stores - not used here but could be)
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;

  // Settings state (loaded from localStorage on mount)
  interface ViewSettings {
    // Scene
    gridSize: number;          // Grid extends ±gridSize in X/Z
    gridDivisions: number;     // Number of grid lines
    gridOpacity: number;       // 0.0-1.0
    gridColor: string;         // Hex color

    // Camera
    cameraDistance: number;    // Distance from target
    cameraTarget: { x: number; y: number; z: number }; // Rotation center
    fov: number;              // Field of view (degrees)

    // Entities
    entityLabelScale: number;  // Label size multiplier
    entitySizeMultiplier: number; // Mesh size

    // Visual Effects
    lightningSpeed: number;    // Animation speed (ms per hop)
    lightningEnabled: boolean;
    broadcastEnabled: boolean;
    broadcastStyle: 'raycast' | 'wave' | 'particles';

    // Performance
    rendererMode: 'webgl' | 'webgpu';
    forceLayoutEnabled: boolean;
    antiAlias: boolean;
    verboseLogging: boolean; // NEW: Master log toggle

    // Camera Presets
    autoRotate: boolean;
    autoRotateSpeed: number; // RPM
    cameraPreset: 'free' | 'top-down' | 'side' | 'orbit';

    // VR Settings
    vrScaleMultiplier: number; // 0.1-10x for comfortable VR viewing
  }

  const DEFAULT_SETTINGS: ViewSettings = {
    // Scene
    gridSize: 300,
    gridDivisions: 12, // PERF: Reduced from 60 (5x less visual noise)
    gridOpacity: 0.4,
    gridColor: '#00ff41',

    // Camera
    cameraDistance: 500,
    cameraTarget: { x: 0, y: 0, z: 0 },
    fov: 75,

    // Entities
    entityLabelScale: 2.0,
    entitySizeMultiplier: 1.0,

    // Visual Effects
    lightningSpeed: 100,
    lightningEnabled: false,
    broadcastEnabled: true,
    broadcastStyle: 'raycast',

    // Performance
    rendererMode: 'webgl',
    forceLayoutEnabled: true,
    antiAlias: true,
    verboseLogging: false, // DEFAULT: Logs OFF for performance

    // Camera Presets
    autoRotate: false,
    autoRotateSpeed: 0.5, // RPM (revolutions per minute)
    cameraPreset: 'free',

    // VR Settings
    vrScaleMultiplier: 1.0 // Default 1:1 scale
  };

  let settings: ViewSettings = { ...DEFAULT_SETTINGS };
  let activeCategory: 'scene' | 'camera' | 'entities' | 'effects' | 'performance' = 'scene';

  // Load settings from localStorage on mount
  async function loadSettings() {
    try {
      const stored = localStorage.getItem('xln-view-settings');
      if (stored) {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
        console.log('[Settings] Loaded from localStorage:', settings);
      }

      // Auto-detect WebGPU if not explicitly set by user
      if (!stored || !JSON.parse(stored).rendererMode) {
        if (typeof navigator !== 'undefined' && navigator.gpu) {
          settings.rendererMode = 'webgpu';
          saveSettings();
          console.log('[Settings] ✅ WebGPU detected - enabled by default');
        }
      }
    } catch (err) {
      console.error('[Settings] Failed to load:', err);
    }
  }

  // Save settings to localStorage
  function saveSettings() {
    try {
      localStorage.setItem('xln-view-settings', JSON.stringify(settings));
      console.log('[Settings] Saved to localStorage');
    } catch (err) {
      console.error('[Settings] Failed to save:', err);
    }
  }

  // Apply setting change (real-time update via panelBridge)
  function updateSetting(key: keyof ViewSettings, value: any) {
    (settings as any)[key] = value;
    saveSettings();

    // Notify Graph3DPanel
    panelBridge.emit('settings:update', { key, value });
  }

  // Reset to defaults
  function resetToDefaults() {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    panelBridge.emit('settings:reset', {});
  }

  // Focus camera on center J-Machine
  function focusCenter() {
    panelBridge.emit('camera:focus', { target: { x: 0, y: 0, z: 0 } });
  }

  // Load on mount
  loadSettings();
</script>

<div class="settings-panel">
  <div class="header">
    <h3>⚙️ Settings</h3>
    <button class="reset-btn" on:click={resetToDefaults}>Reset All</button>
  </div>

  <!-- Category Tabs -->
  <div class="category-tabs">
    <button
      class:active={activeCategory === 'scene'}
      on:click={() => activeCategory = 'scene'}
    >
      🌍 Scene
    </button>
    <button
      class:active={activeCategory === 'camera'}
      on:click={() => activeCategory = 'camera'}
    >
      📷 Camera
    </button>
    <button
      class:active={activeCategory === 'entities'}
      on:click={() => activeCategory === 'entities'}
    >
      🔮 Entities
    </button>
    <button
      class:active={activeCategory === 'effects'}
      on:click={() => activeCategory = 'effects'}
    >
      ✨ Effects
    </button>
    <button
      class:active={activeCategory === 'performance'}
      on:click={() => activeCategory = 'performance'}
    >
      ⚡ Performance
    </button>
  </div>

  <!-- Settings Content -->
  <div class="settings-content">
    {#if activeCategory === 'scene'}
      <h4>Scene Configuration</h4>

      <div class="setting-group">
        <label>
          Grid Size: ±{settings.gridSize}px
          <input
            type="range"
            min="100"
            max="2000"
            step="50"
            bind:value={settings.gridSize}
            on:input={() => updateSetting('gridSize', settings.gridSize)}
          />
        </label>
      </div>

      <div class="setting-group">
        <label>
          Grid Divisions: {settings.gridDivisions}
          <input
            type="range"
            min="20"
            max="200"
            step="10"
            bind:value={settings.gridDivisions}
            on:input={() => updateSetting('gridDivisions', settings.gridDivisions)}
          />
        </label>
      </div>

      <div class="setting-group">
        <label>
          Grid Opacity: {settings.gridOpacity.toFixed(2)}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            bind:value={settings.gridOpacity}
            on:input={() => updateSetting('gridOpacity', settings.gridOpacity)}
          />
        </label>
      </div>

      <div class="setting-group">
        <label>
          Grid Color:
          <input
            type="color"
            bind:value={settings.gridColor}
            on:input={() => updateSetting('gridColor', settings.gridColor)}
          />
          <span class="color-preview" style="background: {settings.gridColor}"></span>
        </label>
      </div>

    {:else if activeCategory === 'camera'}
      <h4>Camera Configuration</h4>

      <div class="setting-group">
        <label>
          Distance: {settings.cameraDistance}px
          <input
            type="range"
            min="100"
            max="2000"
            step="50"
            bind:value={settings.cameraDistance}
            on:input={() => updateSetting('cameraDistance', settings.cameraDistance)}
          />
        </label>
      </div>

      <div class="setting-group">
        <label>
          Field of View: {settings.fov}°
          <input
            type="range"
            min="30"
            max="120"
            step="5"
            bind:value={settings.fov}
            on:input={() => updateSetting('fov', settings.fov)}
          />
        </label>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={settings.autoRotate}
            on:change={() => updateSetting('autoRotate', settings.autoRotate)}
          />
          <span>Auto-Rotate Camera</span>
        </label>
      </div>

      {#if settings.autoRotate}
        <div class="setting-group">
          <label>
            Rotation Speed: {settings.autoRotateSpeed} RPM
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.1"
              bind:value={settings.autoRotateSpeed}
              on:input={() => updateSetting('autoRotateSpeed', settings.autoRotateSpeed)}
            />
          </label>
        </div>
      {/if}

      <div class="setting-group">
        <label>Rotation Center X:</label>
        <input
          type="number"
          bind:value={settings.cameraTarget.x}
          on:input={() => updateSetting('cameraTarget', settings.cameraTarget)}
        />
      </div>

      <div class="setting-group">
        <label>Rotation Center Y:</label>
        <input
          type="number"
          bind:value={settings.cameraTarget.y}
          on:input={() => updateSetting('cameraTarget', settings.cameraTarget)}
        />
      </div>

      <div class="setting-group">
        <label>Rotation Center Z:</label>
        <input
          type="number"
          bind:value={settings.cameraTarget.z}
          on:input={() => updateSetting('cameraTarget', settings.cameraTarget)}
        />
      </div>

      <button class="action-btn" on:click={focusCenter}>
        🎯 Focus Center (0, 0, 0)
      </button>

    {:else if activeCategory === 'entities'}
      <h4>Entity Visualization</h4>

      <div class="setting-group">
        <label>
          Label Scale: {settings.entityLabelScale.toFixed(1)}x
          <input
            type="range"
            min="0.5"
            max="4.0"
            step="0.1"
            bind:value={settings.entityLabelScale}
            on:input={() => updateSetting('entityLabelScale', settings.entityLabelScale)}
          />
        </label>
      </div>

      <div class="setting-group">
        <label>
          Entity Size: {settings.entitySizeMultiplier.toFixed(1)}x
          <input
            type="range"
            min="0.5"
            max="3.0"
            step="0.1"
            bind:value={settings.entitySizeMultiplier}
            on:input={() => updateSetting('entitySizeMultiplier', settings.entitySizeMultiplier)}
          />
        </label>
      </div>

    {:else if activeCategory === 'effects'}
      <h4>Visual Effects</h4>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={settings.lightningEnabled}
            on:change={() => updateSetting('lightningEnabled', settings.lightningEnabled)}
          />
          <span>Enable Lightning Animation</span>
        </label>
      </div>

      <div class="setting-group">
        <label>
          Lightning Speed: {settings.lightningSpeed}ms
          <input
            type="range"
            min="50"
            max="500"
            step="10"
            bind:value={settings.lightningSpeed}
            on:input={() => updateSetting('lightningSpeed', settings.lightningSpeed)}
          />
        </label>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={settings.broadcastEnabled}
            on:change={() => updateSetting('broadcastEnabled', settings.broadcastEnabled)}
          />
          <span>Enable J-Machine Broadcast</span>
        </label>
      </div>

      <div class="setting-group">
        <label>Broadcast Style:</label>
        <div class="radio-group">
          <label class="radio-label">
            <input
              type="radio"
              bind:group={settings.broadcastStyle}
              value="raycast"
              on:change={() => updateSetting('broadcastStyle', 'raycast')}
            />
            <span>Ray-Cast</span>
          </label>
          <label class="radio-label">
            <input
              type="radio"
              bind:group={settings.broadcastStyle}
              value="wave"
              on:change={() => updateSetting('broadcastStyle', 'wave')}
            />
            <span>Wave</span>
          </label>
          <label class="radio-label">
            <input
              type="radio"
              bind:group={settings.broadcastStyle}
              value="particles"
              on:change={() => updateSetting('broadcastStyle', 'particles')}
            />
            <span>Particles</span>
          </label>
        </div>
      </div>

    {:else if activeCategory === 'performance'}
      <h4>Performance Settings</h4>

      <div class="setting-group">
        <label>Renderer Mode:</label>
        <div class="radio-group">
          <label class="radio-label">
            <input
              type="radio"
              bind:group={settings.rendererMode}
              value="webgl"
              on:change={() => updateSetting('rendererMode', 'webgl')}
            />
            <span>WebGL (Compatible)</span>
          </label>
          <label class="radio-label">
            <input
              type="radio"
              bind:group={settings.rendererMode}
              value="webgpu"
              on:change={() => updateSetting('rendererMode', 'webgpu')}
            />
            <span>WebGPU (Faster, Chrome/Edge)</span>
          </label>
        </div>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={settings.forceLayoutEnabled}
            on:change={() => updateSetting('forceLayoutEnabled', settings.forceLayoutEnabled)}
          />
          <span>Force-Directed Layout</span>
        </label>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={settings.antiAlias}
            on:change={() => updateSetting('antiAlias', settings.antiAlias)}
          />
          <span>Anti-Aliasing (Restart Required)</span>
        </label>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={settings.verboseLogging}
            on:change={() => {
              updateSetting('verboseLogging', settings.verboseLogging);
              if (typeof window !== 'undefined' && window.frontendLogs) {
                settings.verboseLogging ? window.frontendLogs.enableAll() : window.frontendLogs.disableAll();
              }
            }}
          />
          <span>Verbose Console Logging</span>
        </label>
        <p style="font-size: 11px; color: #888; margin: 4px 0 0 24px;">
          {#if settings.verboseLogging}
            ⚠️ Logs ON - may cause lag
          {:else}
            ✅ Logs OFF - errors only (recommended)
          {/if}
        </p>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #1a1a1a;
    color: #e0e0e0;
    overflow-y: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    border-bottom: 1px solid #333;
  }

  .header h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .reset-btn {
    padding: 6px 12px;
    background: rgba(255, 70, 70, 0.2);
    border: 1px solid #ff4646;
    border-radius: 4px;
    color: #ff4646;
    cursor: pointer;
    font-size: 12px;
  }

  .reset-btn:hover {
    background: rgba(255, 70, 70, 0.3);
  }

  .category-tabs {
    display: flex;
    border-bottom: 1px solid #333;
    background: #0d0d0d;
  }

  .category-tabs button {
    flex: 1;
    padding: 12px 8px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #888;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
  }

  .category-tabs button:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.05);
  }

  .category-tabs button.active {
    color: #00ff41;
    border-bottom-color: #00ff41;
  }

  .settings-content {
    padding: 16px;
    flex: 1;
    overflow-y: auto;
  }

  .settings-content h4 {
    margin: 0 0 16px 0;
    font-size: 14px;
    font-weight: 600;
    color: #00ff41;
  }

  .setting-group {
    margin-bottom: 20px;
  }

  .setting-group label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: #ccc;
  }

  .setting-group input[type="range"] {
    width: 100%;
    cursor: pointer;
  }

  .setting-group input[type="number"] {
    padding: 6px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #fff;
    font-size: 12px;
  }

  .setting-group input[type="color"] {
    width: 50px;
    height: 30px;
    border: none;
    cursor: pointer;
  }

  .color-preview {
    display: inline-block;
    width: 30px;
    height: 20px;
    border: 1px solid #666;
    border-radius: 4px;
    margin-left: 8px;
  }

  .checkbox-label {
    flex-direction: row !important;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .checkbox-label input[type="checkbox"] {
    cursor: pointer;
  }

  .checkbox-label:hover {
    color: #fff;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }

  .radio-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    color: #aaa;
  }

  .radio-label:hover {
    color: #fff;
  }

  .radio-label input[type="radio"] {
    cursor: pointer;
  }

  .action-btn {
    width: 100%;
    padding: 10px;
    background: #007acc;
    border: none;
    border-radius: 4px;
    color: #fff;
    font-weight: 600;
    cursor: pointer;
    margin-top: 12px;
  }

  .action-btn:hover {
    background: #005a9e;
  }

  .action-btn:disabled {
    background: #333;
    color: #666;
    cursor: not-allowed;
  }
</style>
