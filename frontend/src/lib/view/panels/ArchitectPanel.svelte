<script lang="ts">
  /**
   * Architect Panel - God-mode controls (extracted from NetworkTopology sidebar)
   * 5 modes: Explore, Build, Economy, Governance, Resolve
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { panelBridge } from '../utils/panelBridge';
  import { shortAddress } from '$lib/utils/format';

  // Receive isolated env as props (passed from View.svelte) - REQUIRED
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;

  type Mode = 'explore' | 'build' | 'economy' | 'governance' | 'resolve';
  let currentMode: Mode = 'economy';
  let loading = false;
  let lastAction = '';

  // Reserve operations state
  let selectedEntityForMint = '';
  let mintAmount = '1000000'; // 1M units
  let r2rFromEntity = '';
  let r2rToEntity = '';
  let r2rAmount = '500000'; // 500K units

  // Entity registration mode
  let numberedEntities = false; // Default: lazy (in-memory only, no blockchain needed)

  // Xlnomy state
  let showCreateXlnomyModal = false;
  let newXlnomyName = '';
  let newXlnomyEvmType: 'browservm' | 'reth' | 'erigon' | 'monad' = 'browservm';
  let newXlnomyRpcUrl = 'http://localhost:8545';
  let newXlnomyBlockTime = '1000';
  let newXlnomyAutoGrid = true;

  // Get available Xlnomies from env
  $: xlnomies = $isolatedEnv?.xlnomies ? Array.from($isolatedEnv.xlnomies.keys()) : [];
  $: activeXlnomy = $isolatedEnv?.activeXlnomy || '';

  // Check if env is ready
  $: envReady = $isolatedEnv !== null && $isolatedEnv !== undefined;
  $: if (envReady) {
    console.log('[ArchitectPanel] Env ready with', $isolatedEnv.entities?.length || 0, 'entities');
  }

  // Get entity IDs for dropdowns (extract entityId from replica keys)
  let entityIds: string[] = [];
  $: entityIds = $isolatedEnv?.replicas
    ? Array.from($isolatedEnv.replicas.keys() as Iterable<string>).map((key: string) => key.split(':')[0] || key).filter((id: string, idx: number, arr: string[]) => arr.indexOf(id) === idx)
    : [];

  /** Mint reserves to selected entity */
  async function mintReservesToEntity() {
    if (!selectedEntityForMint || !$isolatedEnv) {
      lastAction = '❌ Select an entity first';
      return;
    }

    loading = true;
    lastAction = `Minting ${mintAmount} to ${shortAddress(selectedEntityForMint)}...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Get the replica to find the signerId
      const replicaKeys = Array.from($isolatedEnv.replicas.keys()) as string[];
      const replicaKey = replicaKeys.find(k => k.startsWith(selectedEntityForMint + ':'));
      const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

      if (!replica) {
        throw new Error(`No replica found for entity ${shortAddress(selectedEntityForMint)}`);
      }

      // Mint via payToReserve entity transaction (creates runtime frame)
      await XLN.process($isolatedEnv, [{
        entityId: selectedEntityForMint,
        signerId: replica.signerId,
        entityTxs: [{
          type: 'payToReserve',
          data: {
            tokenId: 0, // Default token
            amount: BigInt(mintAmount)
          }
        }]
      }]);

      lastAction = `✅ Minted ${mintAmount} to entity`;

      // Update stores to trigger reactivity
      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);

      // Advance to latest frame
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] Mint complete, new frame created');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Mint error:', err);
    } finally {
      loading = false;
    }
  }

  /** Send R2R (Reserve-to-Reserve) transaction */
  async function sendR2RTransaction() {
    if (!r2rFromEntity || !r2rToEntity || r2rFromEntity === r2rToEntity) {
      lastAction = '❌ Select different FROM and TO entities';
      return;
    }

    if (!$isolatedEnv) {
      lastAction = '❌ Environment not ready';
      return;
    }

    loading = true;
    lastAction = `Sending R2R: ${shortAddress(r2rFromEntity)} → ${shortAddress(r2rToEntity)}...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Get the replica to find the signerId
      const replicaKeys = Array.from($isolatedEnv.replicas.keys()) as string[];
      const replicaKey = replicaKeys.find(k => k.startsWith(r2rFromEntity + ':'));
      const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

      if (!replica) {
        throw new Error(`No replica found for entity ${shortAddress(r2rFromEntity)}`);
      }

      // R2R transaction via process() - creates runtime frame
      await XLN.process($isolatedEnv, [{
        entityId: r2rFromEntity,
        signerId: replica.signerId,
        entityTxs: [{
          type: 'payFromReserve',
          data: {
            targetEntityId: r2rToEntity,
            tokenId: 0,
            amount: BigInt(r2rAmount)
          }
        }]
      }]);

      lastAction = `✅ R2R sent: ${r2rAmount} units`;

      // Update stores to trigger reactivity
      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);

      // Advance to latest frame
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] R2R complete, new frame created');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] R2R error:', err);
    } finally {
      loading = false;
    }
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

      let scenarioText = await response.text();
      console.log(`[Architect] Loaded: ${filename}`);

      // Inject entity registration type (numbered or lazy) into grid commands
      const entityType = numberedEntities ? 'numbered' : 'lazy';
      scenarioText = scenarioText.replace(
        /^(grid\s+\d+(?:\s+\d+)?(?:\s+\d+)?)(\s+.*)?$/gm,
        (match, gridCmd, rest) => {
          // Remove existing type= parameter
          const cleanRest = rest ? rest.replace(/\s+type=\w+/, '') : '';
          return `${gridCmd}${cleanRest} type=${entityType}`;
        }
      );

      console.log(`[Architect] Entity registration mode: ${entityType}`);

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

      // Capture BEFORE state (clean slate) for frame 0
      const emptyFrame = {
        height: 0,
        timestamp: Date.now(),
        replicas: new Map(),
        runtimeInput: { runtimeTxs: [], entityInputs: [] },
        runtimeOutputs: [],
        description: 'Frame 0: Clean slate (before scenario)',
        title: 'Initial State'
      };

      console.log('[Architect] Executing on env:', currentEnv);

      // Execute scenario on isolated env
      const result = await XLN.executeScenario(currentEnv, parsed.scenario);

      if (result.success) {
        lastAction = `✅ Success! ${result.framesGenerated} frames generated.`;
        console.log(`[Architect] ${filename}: ${result.framesGenerated} frames`);

        // Prepend frame 0 (clean slate) to show progression from empty
        const historyWithCleanSlate = [emptyFrame, ...(currentEnv.history || [])];

        // Env is mutated in-place by executeScenario - trigger reactivity
        isolatedEnv.set(currentEnv);
        isolatedHistory.set(historyWithCleanSlate);

        console.log('[Architect] History: Frame 0 (empty) + Frames 1-' + currentEnv.history.length + ' (scenario)');

        // Start at frame 0 to show clean slate
        isolatedTimeIndex.set(0);

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

  async function createNewXlnomy() {
    if (!newXlnomyName.trim()) {
      lastAction = '❌ Enter a name for the Xlnomy';
      return;
    }

    loading = true;
    lastAction = `Creating Xlnomy "${newXlnomyName}"...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Step 1: Create Xlnomy (queues grid entity RuntimeTxs)
      await XLN.applyRuntimeInput($isolatedEnv, {
        runtimeTxs: [{
          type: 'createXlnomy',
          data: {
            name: newXlnomyName,
            evmType: newXlnomyEvmType,
            rpcUrl: newXlnomyEvmType !== 'browservm' ? newXlnomyRpcUrl : undefined,
            blockTimeMs: parseInt(newXlnomyBlockTime),
            autoGrid: newXlnomyAutoGrid
          }
        }],
        entityInputs: []
      });

      // Step 2: Process the queued importReplica transactions
      await XLN.applyRuntimeInput($isolatedEnv, {
        runtimeTxs: [],
        entityInputs: []
      });

      console.log('[Architect] Created Xlnomy with', $isolatedEnv.replicas.size, 'total entities');

      // Success message BEFORE clearing name
      lastAction = `✅ Xlnomy "${newXlnomyName}" created!`;

      // Close modal and reset form
      showCreateXlnomyModal = false;
      newXlnomyName = '';

      // Update stores to trigger reactivity
      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Xlnomy creation error:', err);
    } finally {
      loading = false;
    }
  }

  async function switchXlnomy(name: string) {
    if (!$isolatedEnv || name === $isolatedEnv.activeXlnomy) return;

    loading = true;
    lastAction = `Switching to "${name}"...`;

    try {
      $isolatedEnv.activeXlnomy = name;
      const xlnomy = $isolatedEnv.xlnomies?.get(name);

      if (xlnomy) {
        // TODO: Load xlnomy's replicas and history into env
        // For now, just update the active name
        lastAction = `✅ Switched to "${name}"`;
      }

      isolatedEnv.set($isolatedEnv);
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
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
          <h5>🌍 Xlnomy (Economy)</h5>
          <div class="xlnomy-selector">
            <select bind:value={activeXlnomy} on:change={(e) => switchXlnomy(e.currentTarget.value)} disabled={xlnomies.length === 0}>
              {#if xlnomies.length === 0}
                <option value="">No Xlnomies created</option>
              {:else}
                {#each xlnomies as name}
                  <option value={name}>{name}</option>
                {/each}
              {/if}
            </select>
            <button class="action-btn secondary" on:click={() => showCreateXlnomyModal = true}>+ New</button>
          </div>
          <p class="help-text">Self-contained economies with isolated J-Machine + contracts</p>
        </div>

        <div class="action-section">
          <h5>Entity Registration</h5>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={numberedEntities} />
            <span>Numbered Entities (on-chain via EntityProvider.sol)</span>
          </label>
          <p class="help-text">
            {#if numberedEntities}
              ⚙️ Numbered: Entities registered on blockchain (slower, sequential numbers)
            {:else}
              ⚡ Lazy: In-browser only entities (faster, hash-based IDs, no gas)
            {/if}
          </p>
        </div>

        <div class="action-section">
          <h5>Quick Scenarios</h5>
          <button class="action-btn" on:click={() => {numberedEntities = true; executeScenarioFile('auto-demo.scenario.txt');}} disabled={loading}>
            🚀 Auto Demo (Numbered Grid + $1M + R2R)
          </button>
          <p class="help-text">
            Full demo: Register 8 entities, fund $1M each, 13 random R2R transfers
          </p>

          <button class="action-btn" on:click={() => executeScenarioFile('simnet-grid.scenario.txt')} disabled={loading}>
            🎲 Simnet Grid (2x2x2)
          </button>
          <p class="help-text">
            {#if numberedEntities}
              8 numbered entities (on-chain registration)
            {:else}
              8 lazy entities (instant, no blockchain)
            {/if}
          </p>
        </div>

        <div class="action-section">
          <h5>💸 Mint Reserves</h5>
          <div class="form-group">
            <label for="mint-entity">Entity:</label>
            <select id="mint-entity" bind:value={selectedEntityForMint} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="mint-amount">Amount:</label>
            <input id="mint-amount" type="text" bind:value={mintAmount} placeholder="1000000" />
          </div>
          <button class="action-btn" on:click={mintReservesToEntity} disabled={loading || !selectedEntityForMint}>
            💸 Mint to Reserve
          </button>
          <p class="help-text">Deposit tokens to entity reserve (triggers J-Machine)</p>
        </div>

        <div class="action-section">
          <h5>🔄 Reserve-to-Reserve (R2R)</h5>
          <div class="form-group">
            <label for="r2r-from">From Entity:</label>
            <select id="r2r-from" bind:value={r2rFromEntity} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="r2r-to">To Entity:</label>
            <select id="r2r-to" bind:value={r2rToEntity} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="r2r-amount">Amount:</label>
            <input id="r2r-amount" type="text" bind:value={r2rAmount} placeholder="500000" />
          </div>
          <button class="action-btn" on:click={sendR2RTransaction} disabled={loading || !r2rFromEntity || !r2rToEntity}>
            🔄 Send R2R Transaction
          </button>
          <p class="help-text">Send reserve-to-reserve payment (shows broadcast ripple)</p>
        </div>

        <div class="action-section">
          <h5>VR Mode</h5>
          <button class="action-btn" on:click={() => panelBridge.emit('vr:toggle', {})}>
            🥽 Enter VR
          </button>
          <p class="help-text">Quest 3 / WebXR headsets</p>
        </div>

        <div class="action-section">
          <h5>Broadcast Visualization</h5>
          <label class="checkbox-label">
            <input type="checkbox" checked on:change={(e) => panelBridge.emit('broadcast:toggle', { enabled: e.currentTarget.checked })} />
            Enable J-Machine Broadcast
          </label>
          <p class="help-text">Show O(n) broadcast from J-Machine to all entities</p>

          <h5 style="margin-top: 16px;">Broadcast Style</h5>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="raycast" checked on:change={() => panelBridge.emit('broadcast:style', { style: 'raycast' })} />
            Ray-Cast (shows each individual broadcast)
          </label>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="wave" on:change={() => panelBridge.emit('broadcast:style', { style: 'wave' })} />
            Expanding Wave (organic propagation)
          </label>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="particles" on:change={() => panelBridge.emit('broadcast:style', { style: 'particles' })} />
            Particle Swarm (flies to each entity)
          </label>
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

{#if showCreateXlnomyModal}
  <div class="modal-overlay" on:click={() => showCreateXlnomyModal = false}>
    <div class="modal" on:click|stopPropagation>
      <h3>Create New Xlnomy</h3>

      <div class="form-group">
        <label for="xlnomy-name">Name:</label>
        <input id="xlnomy-name" type="text" bind:value={newXlnomyName} placeholder="My Economy" />
      </div>

      <div class="form-group">
        <label>EVM Type:</label>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="browservm" />
            <span>BrowserVM (Simnet)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="reth" />
            <span>Reth (RPC)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="erigon" />
            <span>Erigon (RPC)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="monad" />
            <span>Monad (RPC)</span>
          </label>
        </div>
      </div>

      {#if newXlnomyEvmType !== 'browservm'}
        <div class="form-group">
          <label for="xlnomy-rpc">RPC URL:</label>
          <input id="xlnomy-rpc" type="text" bind:value={newXlnomyRpcUrl} placeholder="http://localhost:8545" />
        </div>
      {/if}

      <div class="form-group">
        <label for="xlnomy-blocktime">Block Time (ms):</label>
        <input id="xlnomy-blocktime" type="text" bind:value={newXlnomyBlockTime} placeholder="1000" />
      </div>

      <label class="checkbox-label">
        <input type="checkbox" bind:checked={newXlnomyAutoGrid} />
        <span>Auto-create 2×2×2 grid with $1M reserves each</span>
      </label>

      <div class="modal-actions">
        <button class="action-btn secondary" on:click={() => showCreateXlnomyModal = false}>Cancel</button>
        <button class="action-btn" on:click={createNewXlnomy}>Create</button>
      </div>
    </div>
  </div>
{/if}

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

  .checkbox-label, .radio-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    font-size: 12px;
    color: #ccc;
    cursor: pointer;
  }

  .checkbox-label:hover, .radio-label:hover {
    color: #fff;
  }

  .checkbox-label input[type="checkbox"],
  .radio-label input[type="radio"] {
    cursor: pointer;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-group label {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .form-group select,
  .form-group input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
  }

  .form-group select:focus,
  .form-group input[type="text"]:focus {
    outline: none;
    border-color: #007acc;
  }

  .form-group select:disabled,
  .form-group input[type="text"]:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkbox-label span {
    font-weight: 500;
  }

  .xlnomy-selector {
    display: flex;
    gap: 8px;
  }

  .xlnomy-selector select {
    flex: 1;
  }

  .xlnomy-selector .action-btn {
    flex: 0 0 auto;
    width: auto;
    padding: 8px 16px;
    margin: 0;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  }

  .modal {
    background: #2d2d30;
    border: 1px solid #007acc;
    border-radius: 8px;
    padding: 24px;
    max-width: 500px;
    width: 90%;
  }

  .modal h3 {
    margin: 0 0 20px 0;
    color: #fff;
    font-size: 16px;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .modal-actions {
    display: flex;
    gap: 12px;
    margin-top: 24px;
  }

  .modal-actions .action-btn {
    flex: 1;
  }
</style>
