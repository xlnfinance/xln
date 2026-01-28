<!--
  AddJMachine.svelte - Configure and create a new J-Machine (Jurisdiction)

  Supports:
  - BrowserVM mode (local simulation, chainId 1337)
  - RPC mode (real chain via RPC URLs)
  - Network presets from networks.ts
  - Custom RPC URLs (textarea, one per line)
  - Auto-deploy contracts if not found
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { POPULAR_NETWORKS, isBrowserVMChainId, BROWSERVM_CHAIN_START, type NetworkConfig } from '$lib/config/networks';

  const dispatch = createEventDispatcher<{
    create: { name: string; mode: 'browservm' | 'rpc'; chainId: number; rpcs: string[]; ticker: string };
    cancel: void;
  }>();

  // Form state
  let mode: 'browservm' | 'rpc' = 'browservm';
  let selectedNetworkId: number | 'custom' = 'custom';
  let customChainId = 1337;
  let rpcTextarea = '';
  let name = '';
  let isCreating = false;
  let error = '';

  // Separate mainnets and testnets
  $: mainnets = POPULAR_NETWORKS.filter(n => !n.testnet);
  $: testnets = POPULAR_NETWORKS.filter(n => n.testnet);

  // Derived values based on selection
  $: selectedNetwork = typeof selectedNetworkId === 'number'
    ? POPULAR_NETWORKS.find(n => n.chainId === selectedNetworkId)
    : null;

  $: chainId = mode === 'browservm'
    ? BROWSERVM_CHAIN_START
    : (selectedNetwork?.chainId ?? customChainId);

  $: ticker = mode === 'browservm'
    ? 'SIM'
    : (selectedNetwork?.ticker ?? 'ETH');

  $: rpcs = mode === 'browservm'
    ? []
    : (selectedNetwork?.rpcs ?? parseRpcList(rpcTextarea));

  $: defaultName = mode === 'browservm'
    ? 'local-sim'
    : (selectedNetwork?.name.toLowerCase().replace(/\s+/g, '-') ?? `chain-${chainId}`);

  // Auto-fill name when network changes
  $: if (!name || name === defaultName) {
    name = defaultName;
  }

  function parseRpcList(text: string): string[] {
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && (line.startsWith('http://') || line.startsWith('https://')));
  }

  function selectNetwork(networkOrCustom: number | 'custom') {
    selectedNetworkId = networkOrCustom;
    if (typeof networkOrCustom === 'number') {
      const net = POPULAR_NETWORKS.find(n => n.chainId === networkOrCustom);
      if (net) {
        rpcTextarea = net.rpcs.join('\n');
        name = net.name.toLowerCase().replace(/\s+/g, '-');
      }
    }
  }

  async function handleCreate() {
    error = '';

    // Validation
    if (mode === 'rpc' && rpcs.length === 0) {
      error = 'At least one RPC URL is required';
      return;
    }
    if (!name.trim()) {
      error = 'Name is required';
      return;
    }

    isCreating = true;
    try {
      dispatch('create', {
        name: name.trim(),
        mode,
        chainId,
        rpcs,
        ticker,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create J-Machine';
      isCreating = false;
    }
  }
</script>

<div class="add-jmachine">
  <h3>Add Jurisdiction</h3>

  <!-- Mode Selection -->
  <div class="field">
    <label>Mode</label>
    <div class="mode-toggle">
      <button
        class="mode-btn"
        class:active={mode === 'browservm'}
        on:click={() => mode = 'browservm'}
      >
        <span class="mode-icon">🖥️</span>
        <span class="mode-label">Browser VM</span>
        <span class="mode-desc">Local simulation</span>
      </button>
      <button
        class="mode-btn"
        class:active={mode === 'rpc'}
        on:click={() => mode = 'rpc'}
      >
        <span class="mode-icon">🌐</span>
        <span class="mode-label">RPC</span>
        <span class="mode-desc">Real chain</span>
      </button>
    </div>
  </div>

  {#if mode === 'rpc'}
    <!-- Network Selection -->
    <div class="field">
      <label>Network</label>
      <div class="network-grid">
        {#each mainnets as net}
          <button
            class="network-btn"
            class:selected={selectedNetworkId === net.chainId}
            on:click={() => selectNetwork(net.chainId)}
          >
            <span class="net-icon">{net.icon}</span>
            <span class="net-name">{net.name}</span>
          </button>
        {/each}
        <button
          class="network-btn custom"
          class:selected={selectedNetworkId === 'custom'}
          on:click={() => selectNetwork('custom')}
        >
          <span class="net-icon">⚙️</span>
          <span class="net-name">Custom</span>
        </button>
      </div>

      <!-- Testnets collapsible -->
      <details class="testnets">
        <summary>Testnets</summary>
        <div class="network-grid">
          {#each testnets as net}
            <button
              class="network-btn testnet"
              class:selected={selectedNetworkId === net.chainId}
              on:click={() => selectNetwork(net.chainId)}
            >
              <span class="net-icon">{net.icon}</span>
              <span class="net-name">{net.name}</span>
            </button>
          {/each}
        </div>
      </details>
    </div>

    <!-- Chain ID (editable for custom) -->
    <div class="field">
      <label>Chain ID</label>
      {#if selectedNetworkId === 'custom'}
        <input
          type="number"
          bind:value={customChainId}
          placeholder="Chain ID"
        />
      {:else}
        <input type="text" value={chainId} disabled />
      {/if}
    </div>

    <!-- RPC URLs -->
    <div class="field">
      <label>RPC URLs <span class="hint">(one per line)</span></label>
      <textarea
        bind:value={rpcTextarea}
        placeholder="https://rpc.example.com&#10;https://backup.example.com"
        rows="4"
      ></textarea>
      {#if rpcs.length > 0}
        <span class="rpc-count">{rpcs.length} valid URL{rpcs.length > 1 ? 's' : ''}</span>
      {/if}
    </div>
  {:else}
    <!-- BrowserVM Info -->
    <div class="browservm-info">
      <p>Local EVM simulation in your browser.</p>
      <ul>
        <li>Chain ID: {BROWSERVM_CHAIN_START}</li>
        <li>Instant blocks (no mining delay)</li>
        <li>Contracts auto-deployed</li>
        <li>State persists in browser storage</li>
      </ul>
    </div>
  {/if}

  <!-- Name -->
  <div class="field">
    <label>Name</label>
    <input
      type="text"
      bind:value={name}
      placeholder="my-jurisdiction"
    />
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <!-- Actions -->
  <div class="actions">
    <button class="btn secondary" on:click={() => dispatch('cancel')} disabled={isCreating}>
      Cancel
    </button>
    <button class="btn primary" on:click={handleCreate} disabled={isCreating}>
      {#if isCreating}
        Creating...
      {:else}
        Create J-Machine
      {/if}
    </button>
  </div>
</div>

<style>
  .add-jmachine {
    padding: 1rem;
    max-width: 480px;
  }

  h3 {
    margin: 0 0 1rem;
    font-size: 1.1rem;
    color: var(--text-primary, #fff);
  }

  .field {
    margin-bottom: 1rem;
  }

  label {
    display: block;
    font-size: 0.8rem;
    color: var(--text-secondary, #888);
    margin-bottom: 0.4rem;
  }

  .hint {
    opacity: 0.6;
    font-weight: normal;
  }

  /* Mode Toggle */
  .mode-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .mode-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.75rem;
    background: var(--bg-secondary, #1a1a2e);
    border: 2px solid var(--border-color, #333);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .mode-btn:hover {
    border-color: var(--accent-dim, #4a4a6a);
  }

  .mode-btn.active {
    border-color: var(--accent, #6366f1);
    background: var(--accent-bg, rgba(99, 102, 241, 0.1));
  }

  .mode-icon {
    font-size: 1.5rem;
    margin-bottom: 0.25rem;
  }

  .mode-label {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary, #fff);
  }

  .mode-desc {
    font-size: 0.7rem;
    color: var(--text-secondary, #888);
  }

  /* Network Grid */
  .network-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 0.4rem;
  }

  .network-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.5rem;
    background: var(--bg-secondary, #1a1a2e);
    border: 1px solid var(--border-color, #333);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .network-btn:hover {
    border-color: var(--accent-dim, #4a4a6a);
  }

  .network-btn.selected {
    border-color: var(--accent, #6366f1);
    background: var(--accent-bg, rgba(99, 102, 241, 0.1));
  }

  .network-btn.testnet {
    opacity: 0.8;
  }

  .net-icon {
    font-size: 1.2rem;
  }

  .net-name {
    font-size: 0.7rem;
    color: var(--text-primary, #fff);
    margin-top: 0.2rem;
  }

  .testnets {
    margin-top: 0.5rem;
  }

  .testnets summary {
    font-size: 0.75rem;
    color: var(--text-secondary, #888);
    cursor: pointer;
    margin-bottom: 0.4rem;
  }

  /* Inputs */
  input, textarea {
    width: 100%;
    padding: 0.5rem;
    background: var(--bg-tertiary, #0d0d1a);
    border: 1px solid var(--border-color, #333);
    border-radius: 4px;
    color: var(--text-primary, #fff);
    font-family: inherit;
    font-size: 0.85rem;
  }

  input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  textarea {
    resize: vertical;
    min-height: 80px;
    font-family: monospace;
  }

  .rpc-count {
    font-size: 0.7rem;
    color: var(--text-secondary, #888);
    margin-top: 0.2rem;
    display: block;
  }

  /* BrowserVM Info */
  .browservm-info {
    background: var(--bg-secondary, #1a1a2e);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .browservm-info p {
    margin: 0 0 0.5rem;
    color: var(--text-primary, #fff);
  }

  .browservm-info ul {
    margin: 0;
    padding-left: 1.2rem;
    color: var(--text-secondary, #888);
    font-size: 0.8rem;
  }

  .browservm-info li {
    margin: 0.2rem 0;
  }

  /* Error */
  .error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #ef4444;
    padding: 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-bottom: 1rem;
  }

  /* Actions */
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color, #333);
  }

  .btn {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn.secondary {
    background: transparent;
    border: 1px solid var(--border-color, #333);
    color: var(--text-secondary, #888);
  }

  .btn.secondary:hover:not(:disabled) {
    border-color: var(--text-secondary, #888);
  }

  .btn.primary {
    background: var(--accent, #6366f1);
    border: none;
    color: white;
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--accent-hover, #5558e3);
  }
</style>
