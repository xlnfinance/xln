<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';

  export let scenario: string = 'phantom-grid';
  export let width: string = '100%';
  export let height: string = '600px';
  export let autoplay: boolean = true;
  export let loop: boolean = false;
  export let slice: string = '';
  export let speed: number = 1.0;

  // Isolated state (NOT global stores)
  let localEnv: any = null;
  let localHistory: any[] = [];
  let currentFrame = 0;
  let totalFrames = 0;
  let playing = false;
  let loaded = false;
  let error: string | null = null;

  // Three.js objects
  let container: HTMLDivElement;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer;
  let controls: any;  // OrbitControls
  let entities = new Map<string, THREE.Mesh>();

  let playbackInterval: number | null = null;
  let sliceStart = 0;
  let sliceEnd = -1;

  async function loadAndExecuteScenario() {
    try {
      let scenarioText: string;

      if (scenario.includes('\n') || scenario.startsWith('SEED')) {
        scenarioText = scenario;
      } else {
        const response = await fetch(`/worlds/${scenario}.scenario.txt`);
        if (!response.ok) throw new Error(`Scenario not found: ${scenario}`);
        scenarioText = await response.text();
      }

      // Parse slice
      if (slice) {
        const parts = slice.split(':').map(Number);
        sliceStart = parts[0] || 0;
        sliceEnd = parts[1] || -1;
      }

      // Create ISOLATED environment (no global state)
      const runtimeUrl = new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Create fresh environment (NOT from global store)
      localEnv = XLN.createEmptyEnv();

      // Parse and execute scenario
      const parsed = XLN.parseScenario(scenarioText);
      if (parsed.errors.length > 0) {
        throw new Error(`Parse error: ${parsed.errors[0].message}`);
      }

      // Fast execution for embeds (no delays)
      await XLN.executeScenario(localEnv, parsed.scenario, {
        tickInterval: 0,  // Skip setTimeout delays
        maxTimestamp: 1000
      });

      // Capture history snapshots locally
      localHistory = [...(localEnv.history || [])];
      totalFrames = localHistory.length;
      currentFrame = sliceStart;

      loaded = true;

      // Wait for Svelte to render container div, then init Three.js
      await new Promise(resolve => setTimeout(resolve, 50));

      if (container) {
        initThreeJS();
        renderFrame(currentFrame);
        if (autoplay) play();
      } else {
        error = 'Container element not available';
      }

    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load scenario';
      console.error('IsolatedScenarioPlayer error:', err);
    }
  }

  function initThreeJS() {
    if (!container) {
      console.error('Cannot init Three.js - container not ready');
      return;
    }

    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    // Create camera
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000);
    // Position camera for 2x2x2 grid (grid center is at 20,20,20 with 40px spacing)
    camera.position.set(80, 80, 80);  // Pull back further
    camera.lookAt(20, 20, 20);  // Look at grid center, not origin

    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    // Add OrbitControls for dragging
    import('three/examples/jsm/controls/OrbitControls.js').then(module => {
      controls = new module.OrbitControls(camera, renderer.domElement);
      controls.target.set(20, 20, 20);  // Orbit around grid center
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.update();
    });

    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(50, 100, 50);
    scene.add(directionalLight);

    // Start animation loop
    animate();
  }

  function renderFrame(frameIndex: number) {
    if (!localHistory[frameIndex]) return;

    const frameState = localHistory[frameIndex];

    // Clear existing entities
    entities.forEach(mesh => scene.remove(mesh));
    entities.clear();

    // Render entities from frame state
    if (frameState.eReplicas) {
      frameState.eReplicas.forEach((replica: any, key: string) => {
        const [entityId] = key.split(':');

        // CRITICAL: Get position from gossip layer (where grid command stores positions)
        const gossipProfiles = frameState.gossip?.profiles || [];
        const gossipProfile = gossipProfiles.find((p: any) => p.entityId === entityId);

        // Try multiple position sources (grid scenarios put it in metadata.position)
        const position = gossipProfile?.metadata?.position
          || gossipProfile?.position
          || replica.position
          || replica.state?.position;

        const geometry = new THREE.SphereGeometry(4, 32, 32);
        const material = new THREE.MeshLambertMaterial({
          color: gossipProfile?.isHub ? 0x00ff88 : 0x007acc,
          emissive: gossipProfile?.isHub ? 0x00ff88 : 0x000000,
          emissiveIntensity: gossipProfile?.isHub ? 1.0 : 0
        });
        const mesh = new THREE.Mesh(geometry, material);

        if (position) {
          mesh.position.set(position.x, position.y, position.z);
        } else {
          // Fallback: radial layout
          const replicaKeys = Array.from(frameState.eReplicas.keys());
          const index = replicaKeys.indexOf(key);
          const angle = (index / replicaKeys.length) * Math.PI * 2;
          const radius = 30;
          mesh.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        }

        scene.add(mesh);
        entities.set(key, mesh);
      });
    }

    // Render account connections (lines between entities with accounts)
    if (frameState.eReplicas) {
      frameState.eReplicas.forEach((replica: any, key: string) => {
        const entityMesh = entities.get(key);
        if (!entityMesh) return;

        // Get accounts from this entity
        const accounts = replica.state?.accounts;
        if (!accounts) return;

        accounts.forEach((_account: any, counterpartyId: string) => {
          // Find counterparty mesh
          const counterpartyKey = (Array.from(frameState.eReplicas.keys()) as string[]).find(k => k.startsWith(counterpartyId));
          const counterpartyMesh = counterpartyKey ? entities.get(counterpartyKey) : null;

          if (counterpartyMesh && entityMesh) {
            // Draw line between entities
            const geometry = new THREE.BufferGeometry().setFromPoints([
              entityMesh.position,
              counterpartyMesh.position
            ]);
            const material = new THREE.LineBasicMaterial({ color: 0x444444, opacity: 0.3, transparent: true });
            const line = new THREE.Line(geometry, material);
            scene.add(line);
          }
        });
      });
    }
  }

  function animate() {
    if (!renderer) return;
    requestAnimationFrame(animate);
    if (controls) controls.update();
    renderer.render(scene, camera);
  }

  function play() {
    if (playing) return;
    playing = true;

    const frameDelay = 1000 / speed;

    playbackInterval = window.setInterval(() => {
      const end = sliceEnd > 0 ? Math.min(sliceEnd, totalFrames - 1) : totalFrames - 1;

      if (currentFrame >= end) {
        if (loop) {
          currentFrame = sliceStart;
          renderFrame(currentFrame);
        } else {
          pause();
        }
      } else {
        currentFrame++;
        renderFrame(currentFrame);
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
    currentFrame = sliceStart;
    renderFrame(currentFrame);
    if (!playing) play();
  }

  function handleProgressClick(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percentage = x / rect.width;

    const end = sliceEnd > 0 ? Math.min(sliceEnd, totalFrames - 1) : totalFrames - 1;
    const range = end - sliceStart;
    const targetFrame = Math.floor(sliceStart + (percentage * range));

    currentFrame = targetFrame;
    renderFrame(currentFrame);
  }

  $: progress = totalFrames > 0
    ? ((currentFrame - sliceStart) / ((totalFrames - 1) - sliceStart)) * 100
    : 0;

  onMount(() => {
    loadAndExecuteScenario();
  });

  onDestroy(() => {
    pause();
    if (renderer) {
      renderer.dispose();
    }
    entities.forEach(mesh => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
  });
</script>

<div class="scenario-player" style="width: {width}; height: {height};">
  {#if error}
    <div class="error-state">
      <p>⚠️ {error}</p>
    </div>
  {:else if loaded}
    <div class="player-container">
      <!-- 3D Viewport -->
      <div bind:this={container} class="viewport"></div>

      <!-- YouTube-style controls -->
      <div class="controls">
        <div
          class="progress-bar"
          on:click={handleProgressClick}
          role="progressbar"
          aria-valuemin={sliceStart}
          aria-valuemax={totalFrames - 1}
          aria-valuenow={currentFrame}
        >
          <div class="progress-fill" style="width: {progress}%"></div>
        </div>

        <div class="control-row">
          <div class="control-group">
            {#if playing}
              <button class="control-btn" on:click={pause} title="Pause">⏸</button>
            {:else}
              <button class="control-btn" on:click={play} title="Play">▶</button>
            {/if}
            <button class="control-btn" on:click={restart} title="Restart">↻</button>
            <span class="time-display">{currentFrame} / {totalFrames - 1}</span>
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
  }

  .progress-bar:hover {
    height: 6px;
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
    font-size: 1rem;
    transition: all 0.2s;
  }

  .control-btn:hover {
    background: var(--bg);
    border-color: var(--accent);
  }

  .time-display {
    font-family: monospace;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .control-label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--text);
    cursor: pointer;
  }

  .speed-label {
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-family: monospace;
  }

  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 400px;
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
</style>
