<script lang="ts">
  /**
   * Settings Panel - All visual configuration in one place
   * Categories: Scene, Camera, Entities, Visual Effects, Performance
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, onDestroy } from 'svelte';
  import type { Writable } from 'svelte/store';
  import { panelBridge } from '../utils/panelBridge';
  import ConsolePanel from './ConsolePanel.svelte';

  // Props (isolated stores - reserved for future time-travel settings UI)
  export let isolatedEnv: Writable<any>; void isolatedEnv;
  export let isolatedHistory: Writable<any[]>; void isolatedHistory;
  export let isolatedTimeIndex: Writable<number>; void isolatedTimeIndex;

  // Live camera state from Graph3D
  let liveCameraState = {
    position: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    distance: 0,
  };

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
    verboseLogging: boolean; // Master log toggle
    showFpsOverlay: boolean; // Show FPS + network stats overlay

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
    verboseLogging: false, // Logs OFF by default
    showFpsOverlay: false, // FPS overlay hidden by default

    // Camera Presets
    autoRotate: false,
    autoRotateSpeed: 0.5, // RPM (revolutions per minute)
    cameraPreset: 'free',

    // VR Settings
    vrScaleMultiplier: 1.0 // Default 1:1 scale
  };

  let settings: ViewSettings = { ...DEFAULT_SETTINGS };
  let activeCategory: 'scene' | 'camera' | 'entities' | 'effects' | 'performance' | 'console' | 'layout' = 'scene';

  // Layout config state
  let layoutJson = '';
  let layoutError = '';
  let layoutSuccess = '';

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

  // Listen for live camera updates from Graph3D
  onMount(() => {
    const unsubscribe = panelBridge.on('camera:update', (data: any) => {
      liveCameraState = {
        position: data.position || liveCameraState.position,
        target: data.target || liveCameraState.target,
        distance: data.distance || liveCameraState.distance,
      };
    });

    loadSettings();

    return () => {
      unsubscribe?.();
    };
  });

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

  // Layout management functions
  function exportLayout() {
    try {
      // Get dockview instance from window (exposed by View.svelte)
      const dockview = (window as any).__dockview_instance;
      if (!dockview) {
        layoutError = 'Dockview not available';
        return;
      }

      // Export layout + camera settings
      const config = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        dockview: dockview.toJSON(),
        camera: {
          position: liveCameraState.position,
          target: liveCameraState.target,
          distance: liveCameraState.distance,
        },
        settings: settings,
      };

      layoutJson = JSON.stringify(config, null, 2);
      layoutSuccess = '✅ Layout exported! Copy from textarea below.';
      layoutError = '';
    } catch (err) {
      layoutError = `Export failed: ${err}`;
      layoutSuccess = '';
    }
  }

  function importLayout() {
    try {
      const dockview = (window as any).__dockview_instance;
      if (!dockview) {
        layoutError = 'Dockview not available';
        return;
      }

      const config = JSON.parse(layoutJson);

      // Restore dockview layout
      if (config.dockview) {
        dockview.fromJSON(config.dockview);
      }

      // Restore camera
      if (config.camera) {
        panelBridge.emit('camera:restore', config.camera);
      }

      // Restore settings
      if (config.settings) {
        settings = { ...DEFAULT_SETTINGS, ...config.settings };
        saveSettings();
        panelBridge.emit('settings:reset', {});
      }

      layoutSuccess = '✅ Layout imported successfully!';
      layoutError = '';
    } catch (err) {
      layoutError = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
      layoutSuccess = '';
    }
  }

  function saveLayoutToLocalStorage() {
    try {
      const dockview = (window as any).__dockview_instance;
      if (!dockview) {
        layoutError = 'Dockview not available';
        return;
      }

      const config = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        dockview: dockview.toJSON(),
        camera: {
          position: liveCameraState.position,
          target: liveCameraState.target,
          distance: liveCameraState.distance,
        },
        settings: settings,
      };

      localStorage.setItem('xln-workspace-layout', JSON.stringify(config));
      layoutSuccess = '✅ Layout saved to browser storage!';
      layoutError = '';
    } catch (err) {
      layoutError = `Save failed: ${err}`;
    }
  }

  function loadLayoutFromLocalStorage() {
    try {
      const stored = localStorage.getItem('xln-workspace-layout');
      if (!stored) {
        layoutError = 'No saved layout found';
        return;
      }

      layoutJson = stored; // Don't parse - it's already a JSON string
      layoutSuccess = '✅ Layout loaded! Click Import to apply.';
      layoutError = '';
    } catch (err) {
      layoutError = `Load failed: ${err}`;
    }
  }

  // Load on mount
  loadSettings();
</script>

<div class="settings-panel">
  <div class="header">
    <h3> Settings</h3>
    <button class="reset-btn" on:click={resetToDefaults}>Reset All</button>
  </div>

  <!-- Category Tabs -->
  <div class="category-tabs">
    <button
      class:active={activeCategory === 'scene'}
      on:click={() => activeCategory = 'scene'}
    >
       Scene
    </button>
    <button
      class:active={activeCategory === 'camera'}
      on:click={() => activeCategory = 'camera'}
    >
      📷 Camera
    </button>
    <button
      class:active={activeCategory === 'entities'}
      on:click={() => activeCategory = 'entities'}
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
       Performance
    </button>
    <button
      class:active={activeCategory === 'console'}
      on:click={() => activeCategory = 'console'}
    >
      📋 Console
    </button>
    <button
      class:active={activeCategory === 'layout'}
      on:click={() => activeCategory = 'layout'}
    >
      📐 Layout
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
        <label>
          <strong>Live Camera Position (updates as you move):</strong>
          <textarea
            readonly
            rows="8"
            style="width: 100%; font-family: monospace; font-size: 11px; background: #2a2a2a; color: #aaa; padding: 8px; border: 1px solid #444; margin-top: 8px;"
            value={JSON.stringify({
              position: liveCameraState.position,
              target: liveCameraState.target,
              distance: liveCameraState.distance,
              note: 'Copy this and paste to Claude to set default camera position',
              file: 'Graph3DPanel.svelte line ~1639: camera.position.set(x, y, z)'
            }, null, 2)}
            on:click={(e) => e.currentTarget.select()}
          ></textarea>
          <small style="color: #888; display: block; margin-top: 4px;">
            ⚡ Updates live as you drag/zoom camera. Click to select all → Copy → Give to Claude.
          </small>
        </label>
      </div>

      <div class="setting-group">
        <label>Quick View Presets:</label>
        <div class="preset-buttons">
          <button class="preset-btn" on:click={() => { updateSetting('cameraPreset', 'top-down'); panelBridge.emit('camera:focus', { target: { x: 0, y: 150, z: 0 } }); }}>
            Top-Down
          </button>
          <button class="preset-btn" on:click={() => { updateSetting('cameraPreset', 'side'); panelBridge.emit('camera:focus', { target: { x: 0, y: 0, z: 0 } }); }}>
            Side View
          </button>
          <button class="preset-btn" on:click={() => { updateSetting('cameraPreset', 'orbit'); updateSetting('autoRotate', true); }}>
            Beauty Shot
          </button>
        </div>
      </div>

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
              if (typeof window !== 'undefined') {
                // Toggle frontend logs
                if (window.frontendLogs) {
                  settings.verboseLogging ? window.frontendLogs.enableAll() : window.frontendLogs.disableAll();
                }
                // Toggle runtime logs (quietRuntimeLogs is the inverse)
                const xlnEnv = (window as any).xlnEnv;
                if (xlnEnv) {
                  xlnEnv.update((env: any) => {
                    if (env) env.quietRuntimeLogs = !settings.verboseLogging;
                    return env;
                  });
                }
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

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={settings.showFpsOverlay}
            on:change={() => updateSetting('showFpsOverlay', settings.showFpsOverlay)}
          />
          <span>Show FPS & Stats Overlay</span>
        </label>
      </div>

    {:else if activeCategory === 'console'}
      <h4>📋 Console Viewer</h4>
      <p style="font-size: 12px; color: #888; margin-bottom: 16px;">
        Real-time console output viewer (useful for VR browsers without DevTools)
      </p>

      <!-- Embed ConsolePanel content here -->
      <div class="console-embed">
        <ConsolePanel
          {isolatedEnv}
          {isolatedHistory}
          {isolatedTimeIndex}
        />
      </div>

    {:else if activeCategory === 'layout'}
      <h4>📐 Workspace Layout Manager</h4>
      <p style="font-size: 12px; color: #888; margin-bottom: 16px;">
        Export/import complete workspace configuration: panel sizes, tab order, camera position, and all settings.
      </p>

      <!-- Action buttons -->
      <div class="layout-actions">
        <button class="action-btn primary" on:click={exportLayout}>
          📤 Export Current Layout
        </button>
        <button class="action-btn" on:click={saveLayoutToLocalStorage}>
          💾 Save to Browser
        </button>
        <button class="action-btn" on:click={loadLayoutFromLocalStorage}>
          📂 Load from Browser
        </button>
        <button class="action-btn success" on:click={importLayout}>
          📥 Import & Apply
        </button>
      </div>

      <!-- Status messages -->
      {#if layoutSuccess}
        <div class="status-message success">{layoutSuccess}</div>
      {/if}
      {#if layoutError}
        <div class="status-message error">{layoutError}</div>
      {/if}

      <!-- Layout config textarea -->
      <div class="setting-group">
        <label>
          <span style="font-size: 13px; font-weight: 500;">Layout Configuration JSON</span>
          <p style="font-size: 11px; color: #888; margin: 4px 0 8px;">
            Copy this JSON to save your layout. Paste here and click "Import & Apply" to restore.
          </p>
          <textarea
            bind:value={layoutJson}
            placeholder="Exported layout JSON will appear here..."
            rows="20"
            style="width: 100%; font-family: 'Consolas', monospace; font-size: 11px; background: #252526; color: #9cdcfe; border: 1px solid #3e3e3e; border-radius: 4px; padding: 12px;"
          ></textarea>
        </label>
      </div>

      <!-- What's included -->
      <div class="layout-info">
        <h5 style="font-size: 12px; color: #ccc; margin: 16px 0 8px;">Included in Layout:</h5>
        <ul style="font-size: 11px; color: #888; margin: 0; padding-left: 20px;">
          <li>Panel sizes and positions</li>
          <li>Tab order and active tab</li>
          <li>Camera position, target, and distance</li>
          <li>All visual settings (grid, labels, effects, etc.)</li>
          <li>Performance toggles (renderer, anti-alias, etc.)</li>
        </ul>
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

  .console-embed {
    width: 100%;
    height: 500px;
    border: 1px solid #333;
    border-radius: 4px;
    overflow: hidden;
  }

  /* Layout Manager Styles */
  .layout-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
  }

  .action-btn {
    padding: 8px 16px;
    font-size: 12px;
    background: #252526;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .action-btn:hover {
    background: #37373d;
    border-color: #007acc;
  }

  .action-btn.primary {
    background: #0e639c;
    border-color: #1177bb;
    color: #fff;
  }

  .action-btn.success {
    background: #1a7f37;
    border-color: #2ea043;
    color: #fff;
  }

  .status-message {
    padding: 8px 12px;
    margin-bottom: 12px;
    border-radius: 4px;
    font-size: 12px;
  }

  .status-message.success {
    background: rgba(26, 127, 55, 0.2);
    border: 1px solid #2ea043;
    color: #3fb950;
  }

  .status-message.error {
    background: rgba(248, 81, 73, 0.2);
    border: 1px solid #f85149;
    color: #ff7b72;
  }

  .layout-info {
    margin-top: 16px;
    padding: 12px;
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
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

  .preset-buttons {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .preset-btn {
    flex: 1;
    padding: 8px 12px;
    background: rgba(0, 255, 65, 0.1);
    border: 1px solid rgba(0, 255, 65, 0.3);
    border-radius: 6px;
    color: #00ff41;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .preset-btn:hover {
    background: rgba(0, 255, 65, 0.2);
    border-color: #00ff41;
  }
</style>
