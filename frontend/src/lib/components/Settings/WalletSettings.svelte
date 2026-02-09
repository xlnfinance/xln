<script lang="ts">
  /**
   * WalletSettings - Unified settings panel for EOA wallet
   *
   * Tabs:
   * - Wallet: Seed/mnemonic, signer info, export
   * - J-Machines: Network selection, custom chains, BrowserVM
   * - General: Theme, UI preferences
   */

  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import { xlnEnvironment } from '$lib/stores/xlnStore';
  import { POPULAR_NETWORKS, BROWSERVM_CHAIN_START, type NetworkConfig } from '$lib/config/networks';
  import { THEME_DEFINITIONS } from '$lib/utils/themes';
  import type { ThemeName } from '$lib/types/ui';
  import { X, Eye, EyeOff, Copy, Check, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-svelte';

  const dispatch = createEventDispatcher();

  // Tabs
  type Tab = 'wallet' | 'jmachines' | 'general';
  let activeTab: Tab = 'wallet';

  // Wallet tab state
  let showSeed = false;
  let seedCopied = false;

  // J-Machines tab state
  let enabledChains = new Set<number>();
  let customRpcs = new Map<number, string[]>();
  let editingChainId: number | null = null;
  let editRpcs: string[] = [];
  let showCustomForm = false;
  let browserVmCount = 0;

  // Custom J-machine form
  let customForm = {
    chainId: '',
    name: '',
    ticker: 'ETH',
    rpcs: '',
  };

  // Load saved J-machine settings
  const JMACHINE_STORAGE_KEY = 'xln-jmachines';

  interface JMachineSettings {
    enabled: number[];
    customRpcs: Record<number, string[]>;
    browserVmCount: number;
  }

  function loadJMachineSettings() {
    try {
      const saved = localStorage.getItem(JMACHINE_STORAGE_KEY);
      if (saved) {
        const data: JMachineSettings = JSON.parse(saved);
        enabledChains = new Set(data.enabled || []);
        customRpcs = new Map(Object.entries(data.customRpcs || {}).map(([k, v]) => [Number(k), v]));
        browserVmCount = data.browserVmCount || 0;
      }
    } catch (e) {
      console.warn('[WalletSettings] Failed to load J-machine settings:', e);
    }
  }

  function saveJMachineSettings() {
    try {
      const data: JMachineSettings = {
        enabled: Array.from(enabledChains),
        customRpcs: Object.fromEntries(customRpcs),
        browserVmCount,
      };
      localStorage.setItem(JMACHINE_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[WalletSettings] Failed to save J-machine settings:', e);
    }
  }

  // Initialize
  loadJMachineSettings();

  let nowMs = Date.now();
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    livenessTimer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });
  onDestroy(() => {
    if (livenessTimer) clearInterval(livenessTimer);
  });

  $: processEnteredAt = $xlnEnvironment?.lastProcessEnteredAt || 0;
  $: processLagMs = processEnteredAt > 0 ? Math.max(0, nowMs - processEnteredAt) : null;
  $: processLivenessLabel = processEnteredAt > 0
    ? `${new Date(processEnteredAt).toLocaleTimeString()} (${Math.round((processLagMs || 0) / 1000)}s ago)`
    : 'never';

  // Wallet functions
  function copySeed() {
    if ($activeVault?.seed) {
      navigator.clipboard.writeText($activeVault.seed);
      seedCopied = true;
      setTimeout(() => seedCopied = false, 2000);
    }
  }

  function formatAddress(addr: string): string {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // J-Machine functions
  async function toggleNetwork(chainId: number, enabled: boolean) {
    if (enabled) {
      enabledChains.add(chainId);
      await importJMachine(chainId);
    } else {
      enabledChains.delete(chainId);
      // TODO: Remove J-machine from runtime
    }
    enabledChains = enabledChains; // Trigger reactivity
    saveJMachineSettings();
  }

  async function importJMachine(chainId: number) {
    const network = POPULAR_NETWORKS.find(n => n.chainId === chainId);
    if (!network) return;

    const rpcs = customRpcs.get(chainId) || network.rpcs;

    console.log(`[WalletSettings] Importing J-machine: ${network.name} (${chainId})`);
    // TODO: Call runtime.apply({ runtimeTxs: [{ type: 'importJ', ... }] })
  }

  function startEditRpcs(network: NetworkConfig) {
    editingChainId = network.chainId;
    editRpcs = [...(customRpcs.get(network.chainId) || network.rpcs)];
  }

  function saveRpcs() {
    if (editingChainId !== null) {
      customRpcs.set(editingChainId, editRpcs.filter(r => r.trim()));
      customRpcs = customRpcs;
      saveJMachineSettings();
      editingChainId = null;
    }
  }

  function cancelEditRpcs() {
    editingChainId = null;
    editRpcs = [];
  }

  function addRpcField() {
    editRpcs = [...editRpcs, ''];
  }

  function removeRpcField(index: number) {
    editRpcs = editRpcs.filter((_, i) => i !== index);
  }

  async function addBrowserVM() {
    browserVmCount++;
    const chainId = BROWSERVM_CHAIN_START + browserVmCount - 1; // 1001, 1002, 1003...

    console.log(`[WalletSettings] Adding BrowserVM: Simnet ${browserVmCount} (chain ${chainId})`);
    // TODO: Call runtime.apply({ runtimeTxs: [{ type: 'importJ', name: `Simnet ${browserVmCount}`, chainId, ticker: 'SIM', rpcs: [] }] })

    saveJMachineSettings();
  }

  function submitCustomJMachine() {
    const chainId = parseInt(customForm.chainId);
    if (isNaN(chainId) || !customForm.name || !customForm.rpcs) {
      return;
    }

    const rpcs = customForm.rpcs.split('\n').map(r => r.trim()).filter(Boolean);

    console.log(`[WalletSettings] Adding custom J-machine:`, { chainId, name: customForm.name, rpcs });
    // TODO: Call runtime.apply({ runtimeTxs: [{ type: 'importJ', ... }] })

    customRpcs.set(chainId, rpcs);
    enabledChains.add(chainId);
    saveJMachineSettings();

    // Reset form
    showCustomForm = false;
    customForm = { chainId: '', name: '', ticker: 'ETH', rpcs: '' };
  }

  // General settings
  function handleThemeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    settingsOperations.setTheme(target.value as ThemeName);
  }

  function close() {
    dispatch('close');
  }
</script>

<div class="wallet-settings">
  <!-- Header -->
  <div class="header">
    <h2>Settings</h2>
    <button class="close-btn" on:click={close}>
      <X size={20} />
    </button>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'wallet'}
      on:click={() => activeTab = 'wallet'}
    >
      Wallet
    </button>
    <button
      class="tab"
      class:active={activeTab === 'jmachines'}
      on:click={() => activeTab = 'jmachines'}
    >
      J-Machines
    </button>
    <button
      class="tab"
      class:active={activeTab === 'general'}
      on:click={() => activeTab = 'general'}
    >
      General
    </button>
  </div>

  <!-- Content -->
  <div class="content">
    {#if activeTab === 'wallet'}
      <!-- Wallet Tab -->
      <div class="section">
        <h3>Signer Information</h3>

        {#if $activeVault}
          <div class="info-card">
            <div class="info-row">
              <span class="label">Label</span>
              <span class="value">{$activeVault.label}</span>
            </div>
            <div class="info-row">
              <span class="label">Address</span>
              <code class="value mono">{$activeVault.signers[0]?.address || 'N/A'}</code>
            </div>
            <div class="info-row">
              <span class="label">Signers</span>
              <span class="value">{$activeVault.signers.length}</span>
            </div>
            <div class="info-row">
              <span class="label">Created</span>
              <span class="value">{new Date($activeVault.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          <!-- Seed Section -->
          <div class="seed-section">
            <div class="seed-header">
              <h4>Recovery Phrase</h4>
              <button class="icon-btn" on:click={() => showSeed = !showSeed}>
                {#if showSeed}
                  <EyeOff size={16} />
                {:else}
                  <Eye size={16} />
                {/if}
              </button>
            </div>

            {#if showSeed}
              <div class="seed-warning">
                Never share your recovery phrase. Anyone with it can access your funds.
              </div>
              <div class="seed-display">
                <code>{$activeVault.seed}</code>
                <button class="copy-btn" on:click={copySeed}>
                  {#if seedCopied}
                    <Check size={14} />
                  {:else}
                    <Copy size={14} />
                  {/if}
                </button>
              </div>
            {:else}
              <div class="seed-hidden">
                Click the eye icon to reveal your recovery phrase
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty-state">
            No wallet connected. Create or import a wallet first.
          </div>
        {/if}
      </div>

    {:else if activeTab === 'jmachines'}
      <!-- J-Machines Tab -->
      <div class="section">
        <h3>Popular Networks</h3>
        <p class="section-desc">Enable networks to create entities and transact</p>

        <div class="network-list">
          {#each POPULAR_NETWORKS.filter(n => !n.testnet) as network}
            <div class="network-row">
              <div class="network-info">
                <span class="network-icon">{network.icon}</span>
                <div class="network-details">
                  <span class="network-name">{network.name}</span>
                  <span class="network-meta">Chain {network.chainId} · {network.ticker}</span>
                </div>
              </div>
              <div class="network-actions">
                <button class="edit-btn" on:click={() => startEditRpcs(network)}>
                  Edit
                </button>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={enabledChains.has(network.chainId)}
                    on:change={(e) => toggleNetwork(network.chainId, e.currentTarget.checked)}
                  />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>

            {#if editingChainId === network.chainId}
              <div class="rpc-editor">
                <h4>RPC Endpoints for {network.name}</h4>
                {#each editRpcs as rpc, i}
                  <div class="rpc-row">
                    <input
                      type="text"
                      bind:value={editRpcs[i]}
                      placeholder="https://..."
                    />
                    <button class="remove-btn" on:click={() => removeRpcField(i)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                {/each}
                <button class="add-rpc-btn" on:click={addRpcField}>
                  <Plus size={14} /> Add RPC
                </button>
                <div class="rpc-actions">
                  <button class="btn secondary" on:click={cancelEditRpcs}>Cancel</button>
                  <button class="btn primary" on:click={saveRpcs}>Save</button>
                </div>
              </div>
            {/if}
          {/each}
        </div>

        <!-- Testnets -->
        <h3 class="subsection">Testnets</h3>
        <div class="network-list">
          {#each POPULAR_NETWORKS.filter(n => n.testnet) as network}
            <div class="network-row">
              <div class="network-info">
                <span class="network-icon">{network.icon}</span>
                <div class="network-details">
                  <span class="network-name">{network.name}</span>
                  <span class="network-meta">Chain {network.chainId} · {network.ticker}</span>
                </div>
              </div>
              <div class="network-actions">
                <button class="edit-btn" on:click={() => startEditRpcs(network)}>
                  Edit
                </button>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={enabledChains.has(network.chainId)}
                    on:change={(e) => toggleNetwork(network.chainId, e.currentTarget.checked)}
                  />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>
          {/each}
        </div>

        <!-- Local/Custom Section -->
        <div class="local-section">
          <button class="add-btn browservm" on:click={addBrowserVM}>
            <Plus size={16} />
            Add BrowserVM (Local Test)
          </button>

          <button class="add-btn custom" on:click={() => showCustomForm = !showCustomForm}>
            {#if showCustomForm}
              <ChevronUp size={16} />
            {:else}
              <ChevronDown size={16} />
            {/if}
            Add Custom J-Machine
          </button>

          {#if showCustomForm}
            <div class="custom-form">
              <div class="form-row">
                <label>
                  Chain ID
                  <input type="number" bind:value={customForm.chainId} placeholder="e.g. 1337" />
                </label>
                <label>
                  Ticker
                  <input type="text" bind:value={customForm.ticker} placeholder="ETH" />
                </label>
              </div>
              <label>
                Network Name
                <input type="text" bind:value={customForm.name} placeholder="My Network" />
              </label>
              <label>
                RPC URLs (one per line)
                <textarea bind:value={customForm.rpcs} rows="3" placeholder="https://rpc.example.com"></textarea>
              </label>
              <button class="btn primary" on:click={submitCustomJMachine}>
                Add Network
              </button>
            </div>
          {/if}
        </div>
      </div>

    {:else if activeTab === 'general'}
      <!-- General Tab -->
      <div class="section">
        <h3>Appearance</h3>

        <label class="setting-row">
          <span>Theme</span>
          <select value={$settings.theme} on:change={handleThemeChange}>
            {#each Object.entries(THEME_DEFINITIONS) as [key, theme]}
              <option value={key}>{theme.name}</option>
            {/each}
          </select>
        </label>

        <label class="setting-row">
          <span>Portfolio Scale</span>
          <div class="slider-row">
            <input
              type="range"
              min="1000"
              max="10000"
              step="500"
              value={$settings.portfolioScale}
              on:input={(e) => settingsOperations.setPortfolioScale(Number(e.currentTarget.value))}
            />
            <span class="slider-value">${$settings.portfolioScale.toLocaleString()}</span>
          </div>
        </label>
      </div>

      <div class="section">
        <h3>Developer</h3>

        <label class="setting-row">
          <span>process() frame delay</span>
          <div class="slider-row">
            <input
              type="range"
              min="0"
              max="10000"
              step="100"
              value={$settings.runtimeDelay}
              on:input={(e) => settingsOperations.setServerDelay(Number(e.currentTarget.value))}
            />
            <span class="slider-value">{$settings.runtimeDelay}ms</span>
          </div>
        </label>

        <label class="setting-row">
          <span>Last process() entry</span>
          <span class="mono-value">{processLivenessLabel}</span>
        </label>
      </div>

      <div class="section">
        <h3>Data</h3>

        <button class="btn danger" on:click={async () => {
          if (confirm('Clear all data? This cannot be undone.')) {
            localStorage.clear();
            sessionStorage.clear();
            // Clear IndexedDB
            try {
              const listDatabases = (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases;
              const dbs = listDatabases ? await listDatabases.call(indexedDB) : [];
              for (const db of dbs) {
                if (db.name) indexedDB.deleteDatabase(db.name);
              }
            } catch {
              // Browser does not support indexedDB.databases() - best effort clear only.
            }
            await vaultOperations.clearAll();
            window.location.reload();
          }
        }}>
          Clear All Data
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .wallet-settings {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 600px;
    max-height: 80vh;
    background: linear-gradient(180deg, rgba(20, 18, 15, 0.98) 0%, rgba(10, 8, 5, 0.99) 100%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    overflow: hidden;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: rgba(255, 255, 255, 0.04);
    border: none;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.15s;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.9);
  }

  /* Tabs */
  .tabs {
    display: flex;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .tab {
    flex: 1;
    padding: 12px 16px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: rgba(255, 255, 255, 0.5);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .tab:hover {
    color: rgba(255, 255, 255, 0.8);
    background: rgba(255, 255, 255, 0.02);
  }

  .tab.active {
    color: rgba(255, 200, 100, 1);
    border-bottom-color: rgba(255, 200, 100, 0.8);
  }

  /* Content */
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .section {
    margin-bottom: 24px;
  }

  .section h3 {
    margin: 0 0 8px 0;
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .section h3.subsection {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .section-desc {
    margin: 0 0 16px 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
  }

  /* Info Card */
  .info-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 12px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .info-row .label {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }

  .info-row .value {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.9);
  }

  .info-row .value.mono {
    font-family: 'SF Mono', monospace;
    font-size: 11px;
  }

  /* Seed Section */
  .seed-section {
    margin-top: 20px;
    background: rgba(255, 100, 100, 0.05);
    border: 1px solid rgba(255, 100, 100, 0.15);
    border-radius: 10px;
    padding: 16px;
  }

  .seed-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .seed-header h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: rgba(255, 200, 100, 0.9);
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: rgba(255, 255, 255, 0.06);
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
  }

  .seed-warning {
    padding: 10px 12px;
    background: rgba(255, 100, 100, 0.1);
    border-radius: 6px;
    font-size: 11px;
    color: rgba(255, 150, 150, 0.9);
    margin-bottom: 12px;
  }

  .seed-display {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }

  .seed-display code {
    flex: 1;
    padding: 12px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 6px;
    font-family: 'SF Mono', monospace;
    font-size: 12px;
    color: rgba(255, 200, 100, 0.9);
    word-break: break-all;
    line-height: 1.6;
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: rgba(255, 255, 255, 0.06);
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    flex-shrink: 0;
  }

  .copy-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
  }

  .seed-hidden {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    font-style: italic;
  }

  /* Network List */
  .network-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .network-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
    transition: background 0.15s;
  }

  .network-row:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .network-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .network-icon {
    font-size: 20px;
    width: 32px;
    text-align: center;
  }

  .network-details {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .network-name {
    font-size: 13px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
  }

  .network-meta {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
  }

  .network-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .edit-btn {
    padding: 4px 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.5);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .edit-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.8);
  }

  /* Toggle */
  .toggle {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 22px;
    transition: 0.2s;
  }

  .toggle-slider:before {
    position: absolute;
    content: "";
    height: 16px;
    width: 16px;
    left: 3px;
    bottom: 3px;
    background: rgba(255, 255, 255, 0.6);
    border-radius: 50%;
    transition: 0.2s;
  }

  input:checked + .toggle-slider {
    background: rgba(100, 200, 100, 0.6);
  }

  input:checked + .toggle-slider:before {
    transform: translateX(18px);
    background: rgba(255, 255, 255, 0.95);
  }

  /* RPC Editor */
  .rpc-editor {
    padding: 16px;
    margin: 8px 0;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
  }

  .rpc-editor h4 {
    margin: 0 0 12px 0;
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.7);
  }

  .rpc-row {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }

  .rpc-row input {
    flex: 1;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.9);
    font-family: monospace;
    font-size: 12px;
  }

  .rpc-row input:focus {
    outline: none;
    border-color: rgba(255, 200, 100, 0.4);
  }

  .remove-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    background: rgba(255, 100, 100, 0.1);
    border: 1px solid rgba(255, 100, 100, 0.2);
    border-radius: 6px;
    color: rgba(255, 100, 100, 0.8);
    cursor: pointer;
  }

  .remove-btn:hover {
    background: rgba(255, 100, 100, 0.2);
  }

  .add-rpc-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.5);
    font-size: 12px;
    cursor: pointer;
    margin-bottom: 12px;
  }

  .add-rpc-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.7);
  }

  .rpc-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  /* Buttons */
  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn.primary {
    background: rgba(255, 200, 100, 0.9);
    color: #000;
  }

  .btn.primary:hover {
    background: rgba(255, 200, 100, 1);
  }

  .btn.secondary {
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.7);
  }

  .btn.secondary:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .btn.danger {
    background: rgba(255, 100, 100, 0.2);
    color: rgba(255, 150, 150, 0.9);
    border: 1px solid rgba(255, 100, 100, 0.3);
  }

  .btn.danger:hover {
    background: rgba(255, 100, 100, 0.3);
  }

  /* Local Section */
  .local-section {
    margin-top: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.6);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .add-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.25);
    color: rgba(255, 255, 255, 0.8);
  }

  .add-btn.browservm {
    border-color: rgba(100, 200, 255, 0.3);
    color: rgba(100, 200, 255, 0.8);
  }

  .add-btn.browservm:hover {
    background: rgba(100, 200, 255, 0.1);
  }

  /* Custom Form */
  .custom-form {
    padding: 16px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .custom-form label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
  }

  .custom-form input,
  .custom-form textarea {
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
  }

  .custom-form textarea {
    font-family: monospace;
    resize: vertical;
  }

  .custom-form input:focus,
  .custom-form textarea:focus {
    outline: none;
    border-color: rgba(255, 200, 100, 0.4);
  }

  .form-row {
    display: flex;
    gap: 12px;
  }

  .form-row label {
    flex: 1;
  }

  /* General Tab */
  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
  }

  .setting-row.checkbox {
    justify-content: flex-start;
    gap: 12px;
    cursor: pointer;
  }

  .setting-row select {
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    cursor: pointer;
  }

  .slider-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .slider-row input[type="range"] {
    width: 120px;
  }

  .slider-value {
    font-size: 12px;
    color: rgba(255, 200, 100, 0.9);
    font-family: monospace;
    min-width: 60px;
    text-align: right;
  }

  .mono-value {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.82);
    font-family: monospace;
    text-align: right;
  }

  /* Empty State */
  .empty-state {
    padding: 40px 20px;
    text-align: center;
    color: rgba(255, 255, 255, 0.4);
    font-size: 13px;
  }
</style>
