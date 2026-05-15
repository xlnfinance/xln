<!--
  AddJMachine.svelte - Configure and create a new J-Machine (Jurisdiction)

  Supports:
  - BrowserVM mode (local simulation, chainId 31337)
  - RPC mode (real chain via RPC URLs)
  - Network presets from networks.ts
  - Custom RPC URLs (textarea, one per line)
  - Auto-deploy contracts if not found
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import {
    parseJMachineConfigJson,
    stringifyJMachineConfig,
    type JMachineConfig,
  } from '$lib/stores/jmachineStore';
  import { POPULAR_NETWORKS, isBrowserVMChainId, BROWSERVM_CHAIN_START, type NetworkConfig } from '$lib/config/networks';

  const dispatch = createEventDispatcher<{
    create: {
      name: string;
      mode: 'browservm' | 'rpc';
      chainId: number;
      rpcs: string[];
      ticker: string;
      contracts?: JMachineConfig['contracts'];
      deploy?: boolean;
    };
    cancel: void;
  }>();

  // Form state
  let mode: 'browservm' | 'rpc' = 'browservm';
  let selectedNetworkId: number | 'custom' = 'custom';
  let customChainId = 31337;
  let rpcTextarea = '';
  let name = '';
  let isCreating = false;
  let error = '';
  let advancedJson = '';
  let advancedError = '';
  let advancedJsonDirty = false;
  let advancedContracts: JMachineConfig['contracts'] | undefined;
  let deploySelectedNetworkId: number | null = null;
  let deployNotice = '';

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

  const buildDraftConfig = (): JMachineConfig => ({
    name: name.trim() || defaultName,
    mode,
    chainId,
    ticker,
    rpcs,
    ...(advancedContracts ? { contracts: advancedContracts } : {}),
    createdAt: Date.now(),
  });

  $: if (!advancedJsonDirty) {
    advancedJson = stringifyJMachineConfig(buildDraftConfig());
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
      if (net?.disabledReason) {
        error = net.disabledReason;
        return;
      }
      if (net) {
        error = '';
        deployNotice = '';
        deploySelectedNetworkId = null;
        rpcTextarea = net.rpcs.join('\n');
        name = net.name.toLowerCase().replace(/\s+/g, '-');
      }
    } else {
      error = '';
      deployNotice = '';
      deploySelectedNetworkId = null;
    }
  }

  function requestDeployNetwork(chainIdValue: number) {
    const net = POPULAR_NETWORKS.find(n => n.chainId === chainIdValue);
    if (!net) return;
    mode = 'rpc';
    selectedNetworkId = net.chainId;
    rpcTextarea = net.rpcs.join('\n');
    name = net.name.toLowerCase().replace(/\s+/g, '-');
    advancedContracts = undefined;
    deploySelectedNetworkId = net.chainId;
    advancedJsonDirty = false;
    error = '';
    deployNotice = `Deploy XLN contracts to ${net.name}. Requires DEPLOYER_PRIVATE_KEY or JADAPTER_DEPLOYER_PRIVATE_KEY in the runtime environment.`;
  }

  function applyAdvancedJson() {
    try {
      const parsed = parseJMachineConfigJson(advancedJson);
      mode = parsed.mode;
      selectedNetworkId = 'custom';
      customChainId = parsed.chainId;
      rpcTextarea = parsed.rpcs.join('\n');
      name = parsed.name;
      advancedContracts = parsed.contracts;
      advancedError = '';
      advancedJsonDirty = false;
    } catch (err) {
      advancedError = err instanceof Error ? err.message : 'Invalid jurisdiction JSON';
    }
  }

  async function handleCreate() {
    error = '';
    advancedError = '';

    let config: JMachineConfig;
    try {
      config = parseJMachineConfigJson(advancedJson);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Invalid jurisdiction JSON';
      return;
    }

    // Validation
    if (config.mode === 'rpc' && config.rpcs.length === 0) {
      error = 'At least one RPC URL is required';
      return;
    }
    if (!config.name.trim()) {
      error = 'Name is required';
      return;
    }
    const preset = POPULAR_NETWORKS.find(net => net.chainId === config.chainId);
    const deployRequested = Boolean(
      config.mode === 'rpc'
      && preset?.disabledReason
      && !config.contracts?.depository
      && deploySelectedNetworkId === config.chainId,
    );
    if (config.mode === 'rpc' && preset?.disabledReason && !config.contracts?.depository && !deployRequested) {
      error = preset.disabledReason;
      return;
    }

    isCreating = true;
    try {
      dispatch('create', {
        name: config.name,
        mode: config.mode,
        chainId: config.chainId,
        rpcs: config.rpcs,
        ticker: config.ticker,
        ...(config.contracts ? { contracts: config.contracts } : {}),
        ...(deployRequested ? { deploy: true } : {}),
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
        data-testid="add-jmachine-mode-browservm"
      >
        <span class="mode-icon">🖥️</span>
        <span class="mode-label">Browser VM</span>
        <span class="mode-desc">Local simulation</span>
      </button>
      <button
        class="mode-btn"
        class:active={mode === 'rpc'}
        on:click={() => mode = 'rpc'}
        data-testid="add-jmachine-mode-rpc"
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
          <div class="network-card" class:selected={selectedNetworkId === net.chainId}>
            <button
              class="network-btn"
              class:selected={selectedNetworkId === net.chainId}
              class:disabled={!!net.disabledReason}
              disabled={!!net.disabledReason}
              title={net.disabledReason || net.name}
              on:click={() => selectNetwork(net.chainId)}
            >
              <span class="net-icon">{net.icon}</span>
              <span class="net-name">{net.name}</span>
            </button>
            {#if net.disabledReason}
              <button class="network-deploy-btn" type="button" on:click={() => requestDeployNetwork(net.chainId)}>
                Deploy
              </button>
            {/if}
          </div>
        {/each}
        <button
          class="network-btn custom"
          class:selected={selectedNetworkId === 'custom'}
          on:click={() => selectNetwork('custom')}
          data-testid="add-jmachine-network-custom"
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
            <div class="network-card" class:selected={selectedNetworkId === net.chainId}>
              <button
                class="network-btn testnet"
                class:selected={selectedNetworkId === net.chainId}
                class:disabled={!!net.disabledReason}
                disabled={!!net.disabledReason}
                title={net.disabledReason || net.name}
                on:click={() => selectNetwork(net.chainId)}
              >
                <span class="net-icon">{net.icon}</span>
                <span class="net-name">{net.name}</span>
              </button>
              {#if net.disabledReason}
                <button class="network-deploy-btn" type="button" on:click={() => requestDeployNetwork(net.chainId)}>
                  Deploy
                </button>
              {/if}
            </div>
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
          data-testid="add-jmachine-chain-id"
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
        data-testid="add-jmachine-rpcs"
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
      data-testid="add-jmachine-name"
    />
  </div>

  <details class="advanced-json">
    <summary data-testid="add-jmachine-advanced-toggle">Advanced JSON</summary>
    <textarea
      bind:value={advancedJson}
      rows="10"
      on:input={() => {
        advancedJsonDirty = true;
        advancedError = '';
      }}
      data-testid="add-jmachine-json"
    ></textarea>
    <div class="actions advanced-actions">
      <button class="btn secondary" type="button" on:click={applyAdvancedJson} data-testid="add-jmachine-json-apply">
        Apply JSON
      </button>
      <button class="btn secondary" type="button" on:click={() => { advancedJsonDirty = false; advancedError = ''; }}>
        Format from Fields
      </button>
    </div>
    {#if advancedError}
      <div class="error">{advancedError}</div>
    {/if}
  </details>

  {#if error}
    <div class="error">{error}</div>
  {/if}
  {#if deployNotice}
    <div class="deploy-notice">{deployNotice}</div>
  {/if}

  <!-- Actions -->
  <div class="actions">
    <button class="btn secondary" on:click={() => dispatch('cancel')} disabled={isCreating}>
      Cancel
    </button>
    <button class="btn primary" on:click={handleCreate} disabled={isCreating} data-testid="add-jmachine-create">
      {#if isCreating}
        {deploySelectedNetworkId === chainId ? 'Deploying...' : 'Creating...'}
      {:else}
        {deploySelectedNetworkId === chainId ? 'Deploy Contracts' : 'Create J-Machine'}
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

  .network-card {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
  }

  .network-card.selected {
    outline: 1px solid var(--accent, #6366f1);
    outline-offset: 2px;
    border-radius: 8px;
  }

  .network-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    min-height: 62px;
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

  .network-btn:disabled,
  .network-btn.disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .network-btn:disabled:hover,
  .network-btn.disabled:hover {
    border-color: var(--border-color, #333);
  }

  .network-btn.selected {
    border-color: var(--accent, #6366f1);
    background: var(--accent-bg, rgba(99, 102, 241, 0.1));
  }

  .network-btn.testnet {
    opacity: 0.8;
  }

  .network-deploy-btn {
    width: 100%;
    height: 28px;
    border: 1px solid rgba(99, 102, 241, 0.45);
    border-radius: 6px;
    background: rgba(99, 102, 241, 0.12);
    color: #c7d2fe;
    font-size: 0.72rem;
    font-weight: 700;
    cursor: pointer;
  }

  .network-deploy-btn:hover {
    border-color: rgba(129, 140, 248, 0.75);
    background: rgba(99, 102, 241, 0.18);
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

  .deploy-notice {
    background: rgba(99, 102, 241, 0.1);
    border: 1px solid rgba(99, 102, 241, 0.3);
    color: #c7d2fe;
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

  .advanced-json {
    margin-bottom: 1rem;
  }

  .advanced-json summary {
    font-size: 0.75rem;
    color: var(--text-secondary, #888);
    cursor: pointer;
    margin-bottom: 0.4rem;
  }

  .advanced-json textarea {
    min-height: 12rem;
  }

  .advanced-actions {
    justify-content: flex-start;
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
