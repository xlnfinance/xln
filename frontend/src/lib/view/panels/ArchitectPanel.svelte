<script lang="ts">
  /**
   * Architect Panel - God-mode controls (extracted from NetworkTopology sidebar)
   * 5 modes: Explore, Build, Economy, Governance, Resolve
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { timeOperations } from '$lib/stores/timeStore';
  import { xlnEnvironment, history } from '$lib/stores/xlnStore';
  import { panelBridge } from '../utils/panelBridge';

  // Receive isolated env as props (passed from View.svelte)
  export let isolatedEnv: any;
  export let isolatedHistory: any;

  type Mode = 'explore' | 'build' | 'economy' | 'governance' | 'resolve';
  let currentMode: Mode = 'economy';
  let loading = false;
  let lastAction = '';

  // Check if env is ready
  $: envReady = $isolatedEnv !== null && $isolatedEnv !== undefined;
  $: if (envReady) {
    console.log('[ArchitectPanel] Env ready with', $isolatedEnv.entities?.length || 0, 'entities');
  }

  /** Execute .scenario.txt file (text-based DSL) */
  async function executeScenarioFile(filename: string) {
    loading = true;
    lastAction = `Loading ${filename}...`;

    try {
      // Fetch scenario text
      const response = await fetch(`/scenarios/${filename}`);
      if (!response.ok) {
        throw new Error(`Failed to load: ${response.statusText}`);
      }

      const scenarioText = await response.text();
      console.log(`[Architect] Loaded: ${filename}`);

      // Import runtime.js
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Parse scenario (text-based DSL)
      const parsed = XLN.parseScenario(scenarioText);

      if (parsed.errors.length > 0) {
        throw new Error(`Parse errors: ${parsed.errors.join(', ')}`);
      }

      console.log(`[Architect] Executing ${parsed.scenario.events.length} events`);

      // Get current env from props
      const currentEnv = $isolatedEnv;
      if (!currentEnv) {
        throw new Error('View environment not initialized');
      }

      console.log('[Architect] Executing on env:', currentEnv);

      // Execute scenario on isolated env
      const result = await XLN.executeScenario(currentEnv, parsed.scenario);

      if (result.success) {
        lastAction = `✅ Success! ${result.framesGenerated} frames generated.`;
        console.log(`[Architect] ${filename}: ${result.framesGenerated} frames`);

        // Env is mutated in-place by executeScenario - trigger reactivity
        isolatedEnv.set(currentEnv);
        isolatedHistory.set(currentEnv.history || [currentEnv]);

        // TEMP: Mirror to global stores so TimeMachine sees changes
        xlnEnvironment.set(currentEnv);
        history.set(currentEnv.history || [currentEnv]);

        console.log('[Architect] Updated env, history length:', currentEnv.history?.length || 0);

        // Reset timeline to start
        timeOperations.goToTimeIndex(0);

        // Notify panels
        panelBridge.emit('entity:created', { entityId: 'scenario', type: 'grid' });
      } else {
        throw new Error(`Execution failed: ${result.errors?.join(', ')}`);
      }
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Error:', err);
    } finally {
      loading = false;
    }
  }

  /** Create 2x2x2 grid (batched, lazy mode) */
  async function runSimnetGrid() {
    loading = true;
    lastAction = 'Creating grid...';

    try {
      const env = $isolatedEnv;
      if (!env) throw new Error('Env not ready');

      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      const spacing = 40;
      const runtimeTxs: any[] = [];

      // Create 8 entities (lazy mode pattern from executor.ts)
      for (let z = 0; z < 2; z++) {
        for (let y = 0; y < 2; y++) {
          for (let x = 0; x < 2; x++) {
            const coord = `${x}_${y}_${z}`;
            const entityId = await XLN.cryptoHash(`grid-${coord}-${Date.now()}`);
            const signerId = `grid_${coord}`;
            const pos = { x: x * spacing, y: y * spacing, z: z * spacing };

            // Announce for visualization
            env.gossip?.announce({
              entityId,
              capabilities: [],
              hubs: [],
              metadata: { name: coord, avatar: '', position: pos }
            });

            // Import replica
            runtimeTxs.push({
              type: 'importReplica',
              entityId,
              signerId,
              data: {
                config: { validators: [signerId], threshold: 1n, mode: 'proposer-based' },
                accounts: new Map(),
                snapshot: { height: 0n, stateHash: new Uint8Array(32), timestamp: BigInt(Date.now()) }
              }
            });
          }
        }
      }

      // Process all in ONE batch
      const newEnv = await XLN.process(env, [], 0, runtimeTxs);

      isolatedEnv.set(newEnv);
      isolatedHistory.update(h => [...h, newEnv]);

      lastAction = `✅ 8 entities (1 frame)!`;
      timeOperations.goToTimeIndex(0);

      panelBridge.emit('entity:created', { entityId: 'grid', type: 'grid' });

    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Error:', err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="architect-panel">
  <div class="header">
    <h3>🎬 Architect</h3>
  </div>

  <div class="mode-selector">
    <button
      class:active={currentMode === 'explore'}
      on:click={() => currentMode = 'explore'}
    >
      🔍 Explore
    </button>
    <button
      class:active={currentMode === 'build'}
      on:click={() => currentMode = 'build'}
    >
      🏗️ Build
    </button>
    <button
      class:active={currentMode === 'economy'}
      on:click={() => currentMode = 'economy'}
    >
      💰 Economy
    </button>
    <button
      class:active={currentMode === 'governance'}
      on:click={() => currentMode = 'governance'}
    >
      ⚖️ Governance
    </button>
    <button
      class:active={currentMode === 'resolve'}
      on:click={() => currentMode = 'resolve'}
    >
      ⚔️ Resolve
    </button>
  </div>

  <div class="mode-content">
    {#if currentMode === 'economy'}
      <h4>Economy Mode</h4>

      {#if !envReady}
        <div class="status loading">
          ⏳ Initializing XLN environment...
        </div>
      {:else}
        <div class="action-section">
          <h5>Quick Scenarios</h5>
          <button class="action-btn" on:click={() => executeScenarioFile('simnet-grid.scenario.txt')} disabled={loading}>
            🎲 Simnet Grid (2x2x2)
          </button>
          <p class="help-text">8 entities, lazy mode (no blockchain)</p>
        </div>

        {#if lastAction}
          <div class="status" class:loading>
            {lastAction}
          </div>
        {/if}
      {/if}

    {:else if currentMode === 'build'}
      <h4>Build Mode</h4>
      <p>• Create entities</p>
      <p>• Place in 3D</p>
      <p>• Topology patterns</p>
    {:else}
      <h4>{currentMode.charAt(0).toUpperCase() + currentMode.slice(1)} Mode</h4>
      <p>Coming soon...</p>
    {/if}
  </div>
</div>

<style>
  .architect-panel {
    width: 100%;
    height: 100%;
    background: #1e1e1e;
    color: #ccc;
    display: flex;
    flex-direction: column;
  }

  .header {
    padding: 12px;
    background: #2d2d30;
    border-bottom: 2px solid #007acc;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
  }

  .mode-selector {
    display: flex;
    gap: 4px;
    padding: 8px;
    background: #252526;
    border-bottom: 1px solid #3e3e3e;
    flex-wrap: wrap;
  }

  .mode-selector button {
    flex: 1;
    min-width: 80px;
    padding: 8px 12px;
    background: #2d2d30;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  .mode-selector button:hover {
    background: #37373d;
    border-color: #007acc;
  }

  .mode-selector button.active {
    background: #0e639c;
    color: white;
    border-color: #1177bb;
  }

  .mode-content {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }

  .mode-content h4 {
    margin: 0 0 12px 0;
    color: #fff;
    font-size: 13px;
  }

  .mode-content p {
    margin: 8px 0;
    font-size: 12px;
    color: #8b949e;
  }

  .action-section {
    margin-bottom: 24px;
    padding: 12px;
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
  }

  .action-section h5 {
    margin: 0 0 12px 0;
    font-size: 12px;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .action-btn {
    width: 100%;
    padding: 12px 16px;
    background: #0e639c;
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .action-btn:hover:not(:disabled) {
    background: #1177bb;
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-btn.secondary {
    background: #2d2d30;
    border: 1px solid #3e3e3e;
  }

  .action-btn.secondary:hover:not(:disabled) {
    background: #37373d;
    border-color: #007acc;
  }

  .help-text {
    margin: 4px 0 0 0;
    font-size: 11px;
    color: #6e7681;
    font-style: italic;
  }

  .status {
    margin-top: 16px;
    padding: 12px;
    background: #1a3a1a;
    border-left: 3px solid #28a745;
    color: #7ee087;
    font-size: 12px;
    border-radius: 4px;
  }

  .status.loading {
    background: #1a2a3a;
    border-left-color: #007acc;
    color: #79c0ff;
  }
</style>
