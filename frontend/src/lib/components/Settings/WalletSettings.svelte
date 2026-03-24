<script lang="ts">
  /**
   * WalletSettings - Unified settings panel for EOA wallet
   *
   * Tabs:
   * - Wallet: Seed/mnemonic, signer info, export
   * - J-Machines: Network selection, custom chains, BrowserVM
   * - General: Theme, UI preferences
   */

  import { createEventDispatcher, onDestroy, onMount, type ComponentType } from 'svelte';
  import { ethers } from 'ethers';
  import { activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import { jmachineConfigs, jmachineOperations, parseJMachineConfigJson, stringifyJMachineConfig, type JMachineConfig } from '$lib/stores/jmachineStore';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import { xlnEnvironment } from '$lib/stores/xlnStore';
  import { resetEverything } from '$lib/utils/resetEverything';
  import { THEME_DEFINITIONS } from '$lib/utils/themes';
  import { getBarColors } from '$lib/utils/bar-colors';
  import type { ThemeName, BarColorMode } from '$lib/types/ui';
  import { X, Copy, Check, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-svelte';
  import AddJMachine from '$lib/components/Jurisdiction/AddJMachine.svelte';

  const dispatch = createEventDispatcher();
  export let embedded = false;

  // Tabs
  type Tab = 'wallet' | 'appearance' | 'network' | 'storage' | 'advanced';
  let activeTab: Tab = 'wallet';
  let IndexedDbInspectorComponent: ComponentType | null = null;
  let indexedDbInspectorLoading = false;
  let indexedDbInspectorError = '';

  let seedCopied = false;
  let mnemonic12Copied = false;

  // J-Machines tab state
  let showAddJMachine = false;
  let editingJMachineName: string | null = null;
  let editMachineDraft: JMachineConfig | null = null;
  let editMachineJson = '';
  let editMachineError = '';
  let rpcTestStatus = new Map<string, string>();

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

  // Bar color legend (uses USDC blue as representative token)
  $: barLegendColors = getBarColors($settings.barColorMode, '#2775ca');

  // Wallet functions
function copySeed() {
  if ($activeVault?.seed) {
    navigator.clipboard.writeText($activeVault.seed);
    seedCopied = true;
    setTimeout(() => seedCopied = false, 2000);
  }
}

function copyMnemonic12() {
  if ($activeVault?.mnemonic12) {
    navigator.clipboard.writeText($activeVault.mnemonic12);
    mnemonic12Copied = true;
    setTimeout(() => mnemonic12Copied = false, 2000);
  }
}

  function formatAddress(addr: string): string {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  function openEditJMachine(config: JMachineConfig) {
    editingJMachineName = config.name;
    editMachineDraft = structuredClone(config);
    editMachineJson = stringifyJMachineConfig(config);
    editMachineError = '';
  }

  function cancelEditJMachine() {
    editingJMachineName = null;
    editMachineDraft = null;
    editMachineJson = '';
    editMachineError = '';
  }

  function syncJsonFromDraft() {
    if (!editMachineDraft) return;
    editMachineJson = stringifyJMachineConfig(editMachineDraft);
  }

  function applyJsonToDraft() {
    try {
      const parsed = parseJMachineConfigJson(editMachineJson);
      editMachineDraft = parsed;
      editMachineError = '';
    } catch (error) {
      editMachineError = error instanceof Error ? error.message : String(error);
    }
  }

  function saveEditedJMachine() {
    if (!editMachineDraft || !editingJMachineName) return;
    try {
      const normalized = parseJMachineConfigJson(editMachineJson || stringifyJMachineConfig(editMachineDraft));
      if (normalized.name.toLowerCase() !== editingJMachineName.toLowerCase()) {
        jmachineOperations.remove(editingJMachineName);
      }
      jmachineOperations.upsert(normalized);
      cancelEditJMachine();
    } catch (error) {
      editMachineError = error instanceof Error ? error.message : String(error);
    }
  }

  async function testJMachineRpc(config: JMachineConfig) {
    const key = config.name;
    if (config.mode === 'browservm') {
      rpcTestStatus.set(key, 'BrowserVM local jurisdiction');
      rpcTestStatus = new Map(rpcTestStatus);
      return;
    }
    const rpcUrl = config.rpcs[0];
    if (!rpcUrl) {
      rpcTestStatus.set(key, 'No RPC URL configured');
      rpcTestStatus = new Map(rpcTestStatus);
      return;
    }
    rpcTestStatus.set(key, 'Testing...');
    rpcTestStatus = new Map(rpcTestStatus);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const network = await provider.getNetwork();
      const chainId = Number(network.chainId);
      let message = `Reachable: chain ${chainId}`;
      if (chainId !== config.chainId) {
        message += ` (expected ${config.chainId})`;
      }
      if (config.contracts?.depository && ethers.isAddress(config.contracts.depository)) {
        const code = await provider.getCode(config.contracts.depository);
        message += code && code !== '0x' ? ' • depository ok' : ' • depository missing';
      }
      rpcTestStatus.set(key, message);
    } catch (error) {
      rpcTestStatus.set(key, error instanceof Error ? error.message : String(error));
    }
    rpcTestStatus = new Map(rpcTestStatus);
  }

  async function importConfiguredJMachine(config: JMachineConfig) {
    try {
      const imported = await vaultOperations.importJMachine(config);
      jmachineOperations.upsert(imported);
      rpcTestStatus.set(config.name, 'Imported into active runtime');
      rpcTestStatus = new Map(rpcTestStatus);
    } catch (error) {
      rpcTestStatus.set(config.name, error instanceof Error ? error.message : String(error));
      rpcTestStatus = new Map(rpcTestStatus);
    }
  }

  async function handleJMachineCreate(event: CustomEvent<{
    name: string;
    mode: 'browservm' | 'rpc';
    chainId: number;
    rpcs: string[];
    ticker: string;
    contracts?: JMachineConfig['contracts'];
  }>) {
    const config: JMachineConfig = {
      ...event.detail,
      createdAt: Date.now(),
    };
    jmachineOperations.upsert(config);
    showAddJMachine = false;
    await importConfiguredJMachine(config);
  }

  // General settings
  let selectedTheme: ThemeName = 'dark';
  $: selectedTheme = $settings.theme;

  let checkpointHeights: number[] = [];
  let checkpointRuntimeKey = '';
  let selectedCheckpointHeight = '';
  let checkpointLoadError = '';
  let verifyLoading = false;
  let verifyResult:
    | null
    | {
        latestHeight: number;
        checkpointHeight: number;
        selectedSnapshotHeight: number;
        restoredHeight: number;
      } = null;
  let verifyError = '';

  async function loadCheckpointHeights() {
    const env = $xlnEnvironment;
    const runtimeId = String(env?.runtimeId || '').toLowerCase();
    if (!env || !runtimeId) {
      checkpointHeights = [];
      checkpointRuntimeKey = '';
      selectedCheckpointHeight = '';
      return;
    }
    if (checkpointRuntimeKey === runtimeId && checkpointHeights.length > 0) return;
    checkpointLoadError = '';
    try {
      const heights = await vaultOperations.listPersistedCheckpointHeights(env);
      checkpointHeights = heights;
      checkpointRuntimeKey = runtimeId;
      if (!selectedCheckpointHeight || !heights.includes(Number(selectedCheckpointHeight))) {
        selectedCheckpointHeight = heights.length > 0 ? String(heights[heights.length - 1]) : '';
      }
    } catch (error) {
      checkpointHeights = [];
      checkpointRuntimeKey = runtimeId;
      checkpointLoadError = error instanceof Error ? error.message : String(error);
    }
  }

  async function verifyRuntimeChainNow() {
    const env = $xlnEnvironment;
    const runtimeId = String(env?.runtimeId || '').trim() || null;
    const runtimeSeed = $activeVault?.seed || null;
    if (!runtimeId || !runtimeSeed) return;
    verifyLoading = true;
    verifyError = '';
    verifyResult = null;
    try {
      const selectedHeight = Number(selectedCheckpointHeight || 0);
      const result = await vaultOperations.verifyRuntimeChain(runtimeId, runtimeSeed, {
        fromSnapshotHeight: Number.isFinite(selectedHeight) && selectedHeight > 0 ? selectedHeight : undefined,
      });
      verifyResult = {
        latestHeight: result.latestHeight,
        checkpointHeight: result.checkpointHeight,
        selectedSnapshotHeight: result.selectedSnapshotHeight,
        restoredHeight: result.restoredHeight,
      };
    } catch (error) {
      verifyError = error instanceof Error ? error.message : String(error);
    } finally {
      verifyLoading = false;
    }
  }

  $: if (activeTab === 'advanced' && $xlnEnvironment?.runtimeId) {
    void loadCheckpointHeights();
  }

  $: preferredIndexedDbNames = Array.from(new Set([
    $xlnEnvironment?.dbNamespace ? `level-js-db-${$xlnEnvironment.dbNamespace}` : '',
    $xlnEnvironment?.dbNamespace ? `level-js-db-${$xlnEnvironment.dbNamespace}-infra` : '',
    'level-js-db-default',
    'level-js-db-default-infra',
  ].filter(Boolean)));

  $: if (activeTab === 'storage' && !IndexedDbInspectorComponent && !indexedDbInspectorLoading) {
    indexedDbInspectorLoading = true;
    indexedDbInspectorError = '';
    void import('$lib/components/Settings/IndexedDbInspector.svelte')
      .then((module) => {
        IndexedDbInspectorComponent = module.default;
      })
      .catch((error) => {
        indexedDbInspectorError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        indexedDbInspectorLoading = false;
      });
  }

  function handleThemeChange(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    settingsOperations.setTheme(target.value as ThemeName);
  }

  function close() {
    dispatch('close');
  }

  function confirmResetAllData() {
    const confirmed = confirm('Clear all local XLN data? This resets wallets, runtime state, and caches.');
    if (!confirmed) return;
    void resetEverything();
  }
</script>

<div class="wallet-settings" class:embedded>
  <!-- Header -->
  {#if !embedded}
    <div class="header">
      <h2>Settings</h2>
      <button class="close-btn" on:click={close}>
        <X size={20} />
      </button>
    </div>
  {/if}

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab" class:active={activeTab === 'wallet'} on:click={() => activeTab = 'wallet'}>Wallet</button>
    <button class="tab" class:active={activeTab === 'appearance'} on:click={() => activeTab = 'appearance'}>Appearance</button>
    <button class="tab" class:active={activeTab === 'network'} on:click={() => activeTab = 'network'}>Network</button>
    <button class="tab" class:active={activeTab === 'storage'} on:click={() => activeTab = 'storage'}>Storage</button>
    <button class="tab" class:active={activeTab === 'advanced'} on:click={() => activeTab = 'advanced'}>Advanced</button>
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
            </div>
            <div class="seed-warning">
              Never share your recovery phrase. Anyone with it can access your funds.
            </div>
            {#if $activeVault.mnemonic12}
              <div class="seed-subsection">
                <div class="seed-subhead">
                  <span>12 words</span>
                  <button class="copy-btn" on:click={copyMnemonic12}>
                    {#if mnemonic12Copied}
                      <Check size={14} />
                    {:else}
                      <Copy size={14} />
                    {/if}
                  </button>
                </div>
                <code class="seed-code">{$activeVault.mnemonic12}</code>
              </div>
            {/if}
            <div class="seed-subsection">
              <div class="seed-subhead">
                <span>24 words</span>
                <button class="copy-btn" on:click={copySeed}>
                  {#if seedCopied}
                    <Check size={14} />
                  {:else}
                    <Copy size={14} />
                  {/if}
                </button>
              </div>
              <code class="seed-code">{$activeVault.seed}</code>
            </div>
          </div>
        {:else}
          <div class="empty-state">
            No wallet connected. Create or import a wallet first.
          </div>
        {/if}
      </div>

    {:else if activeTab === 'appearance'}
      <!-- Appearance Tab -->
      <div class="section">
        <h3>Theme</h3>
        <label class="setting-row">
          <span>Color Theme</span>
          <select bind:value={selectedTheme} on:change={handleThemeChange} data-testid="settings-theme-select">
            {#each Object.entries(THEME_DEFINITIONS) as [key, theme]}
              <option value={key}>{theme.name}</option>
            {/each}
          </select>
        </label>
        <label class="setting-row">
          <span>Bar Colors</span>
          <select value={$settings.barColorMode} on:change={(e) => settingsOperations.setBarColorMode(e.currentTarget.value)}>
            <option value="rgy">Traffic Light (RGY)</option>
            <option value="theme">Match Theme</option>
            <option value="token">Per-Token Color</option>
          </select>
        </label>
        <div class="bar-legend-mini">
          <span class="legend-swatch" style="background: {barLegendColors.credit}; opacity: 0.5"></span> Credit
          <span class="legend-swatch" style="background: {barLegendColors.collateral}"></span> Collateral
          <span class="legend-swatch" style="background: {barLegendColors.debt}"></span> Debt
        </div>
      </div>

      <div class="section">
        <h3>Display</h3>
        <label class="setting-row">
          <span>Token Precision</span>
          <div class="slider-row">
            <input type="range" min="2" max="18" step="1" value={$settings.tokenPrecision} on:input={(e) => settingsOperations.setTokenPrecision(Number(e.currentTarget.value))} />
            <span class="slider-value">{$settings.tokenPrecision === 18 ? 'full' : `${$settings.tokenPrecision}d`}</span>
          </div>
        </label>
        <label class="setting-row">
          <span>Show Token Icons</span>
          <input type="checkbox" checked={$settings.showTokenIcons} on:change={(e) => settingsOperations.setShowTokenIcons((e.currentTarget as HTMLInputElement).checked)} />
        </label>
        <label class="setting-row">
          <span>Account Delta View</span>
          <select value={$settings.accountDeltaViewMode} on:change={(e) => settingsOperations.setAccountDeltaViewMode(e.currentTarget.value as 'per-token' | 'aggregated')}>
            <option value="per-token">Per token</option>
            <option value="aggregated">Aggregated</option>
          </select>
        </label>
        <label class="setting-row">
          <span>Portfolio Scale</span>
          <div class="slider-row">
            <input type="range" min="1000" max="10000" step="500" value={$settings.portfolioScale} on:input={(e) => settingsOperations.setPortfolioScale(Number(e.currentTarget.value))} />
            <span class="slider-value">${$settings.portfolioScale.toLocaleString()}</span>
          </div>
        </label>
      </div>

    {:else if activeTab === 'network'}
      <div class="section">
        <h3>Jurisdictions</h3>
        <p class="section-desc">Manage imported jurisdictions for the active runtime. Basic fields stay visible; full config is available through advanced JSON.</p>

        <details class="testnets">
          <summary>Local Dev: second anvil</summary>
          <div class="setting-hint">
            Run <code>bun run dev:anvil2</code> to start a second local jurisdiction with a full XLN stack.
            The script prints an import-ready JSON config you can paste into a custom jurisdiction entry below.
          </div>
        </details>

        <div class="network-list">
          {#each $jmachineConfigs as machine}
            <div class="network-row">
              <div class="network-info">
                <span class="network-icon">{machine.mode === 'browservm' ? '🖥️' : '🌐'}</span>
                <div class="network-details">
                  <span class="network-name">{machine.name}</span>
                  <span class="network-meta">Chain {machine.chainId} · {machine.ticker} · {machine.mode === 'browservm' ? 'BrowserVM' : (machine.rpcs[0] || 'no-rpc')}</span>
                </div>
              </div>
              <div class="network-actions">
                <button class="edit-btn" on:click={() => openEditJMachine(machine)}>
                  Edit
                </button>
                <button class="edit-btn" on:click={() => void testJMachineRpc(machine)}>
                  Test RPC
                </button>
                <button class="edit-btn" on:click={() => void importConfiguredJMachine(machine)}>
                  Import
                </button>
                <button class="remove-btn" on:click={() => jmachineOperations.remove(machine.name)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {#if rpcTestStatus.get(machine.name)}
              <p class="setting-hint">{rpcTestStatus.get(machine.name)}</p>
            {/if}

            {#if editingJMachineName === machine.name && editMachineDraft}
              <div class="rpc-editor">
                <div class="form-row">
                  <label>
                    Name
                    <input type="text" bind:value={editMachineDraft.name} on:input={syncJsonFromDraft} />
                  </label>
                  <label>
                    Chain ID
                    <input type="number" bind:value={editMachineDraft.chainId} on:input={syncJsonFromDraft} />
                  </label>
                </div>
                <div class="form-row">
                  <label>
                    Ticker
                    <input type="text" bind:value={editMachineDraft.ticker} on:input={syncJsonFromDraft} />
                  </label>
                  <label>
                    Mode
                    <select bind:value={editMachineDraft.mode} on:change={syncJsonFromDraft}>
                      <option value="rpc">RPC</option>
                      <option value="browservm">BrowserVM</option>
                    </select>
                  </label>
                </div>
                <label>
                  Primary RPC
                  <input
                    type="text"
                    value={editMachineDraft.rpcs[0] || ''}
                    on:input={(e) => {
                      editMachineDraft = {
                        ...editMachineDraft!,
                        rpcs: e.currentTarget.value.trim() ? [e.currentTarget.value.trim()] : [],
                      };
                      syncJsonFromDraft();
                    }}
                    placeholder="https://rpc.example.com"
                  />
                </label>

                <details class="testnets" open>
                  <summary>Advanced JSON</summary>
                  <textarea bind:value={editMachineJson} rows="12"></textarea>
                  <div class="rpc-actions">
                    <button class="btn secondary" on:click={applyJsonToDraft}>Apply JSON</button>
                    <button class="btn secondary" on:click={syncJsonFromDraft}>Format</button>
                  </div>
                </details>

                {#if editMachineError}
                  <p class="setting-hint error-text">{editMachineError}</p>
                {/if}

                <div class="rpc-actions">
                  <button class="btn secondary" on:click={cancelEditJMachine}>Cancel</button>
                  <button class="btn primary" on:click={saveEditedJMachine}>Save</button>
                </div>
              </div>
            {/if}
          {/each}
        </div>

        {#if $jmachineConfigs.length === 0}
          <p class="setting-hint">No jurisdictions configured yet.</p>
        {/if}

        <div class="local-section">
          <button
            class="add-btn custom"
            on:click={() => showAddJMachine = !showAddJMachine}
            data-testid="settings-network-add-jmachine-toggle"
          >
            {#if showAddJMachine}
              <ChevronUp size={16} />
            {:else}
              <ChevronDown size={16} />
            {/if}
            Add Custom Jurisdiction
          </button>

          {#if showAddJMachine}
            <div class="custom-form">
              <AddJMachine
                on:create={handleJMachineCreate}
                on:cancel={() => showAddJMachine = false}
              />
            </div>
          {/if}
        </div>
      </div>

    {:else if activeTab === 'storage'}
      <div class="section">
        <h3>IndexedDB</h3>
        <p class="section-desc">Inspect core and infra LevelDB blobs directly in the browser. This viewer is frontend-only and loads lazily.</p>

        {#if indexedDbInspectorError}
          <p class="setting-hint error-text">{indexedDbInspectorError}</p>
        {:else if indexedDbInspectorLoading || !IndexedDbInspectorComponent}
          <p class="setting-hint">Loading inspector...</p>
        {:else}
          <svelte:component
            this={IndexedDbInspectorComponent}
            databaseNames={preferredIndexedDbNames}
            databaseNamePrefixes={['level-js-db-']}
            pageSize={40}
          />
        {/if}
      </div>

    {:else if activeTab === 'advanced'}
      <!-- Advanced Tab -->
      <div class="section">
        <h3>Runtime</h3>

        <label class="setting-row">
          <span>Frame Delay</span>
          <div class="slider-row">
            <input
              type="range"
              min="0"
              max="2000"
              step="10"
              value={$settings.runtimeDelay}
              on:input={(e) => {
                const val = Math.max(0, Math.min(2000, Number(e.currentTarget.value) || 0));
                settingsOperations.setRuntimeDelay(val);
                const env = $xlnEnvironment;
                if (env) {
                  if (!env.runtimeConfig) env.runtimeConfig = { minFrameDelayMs: val, loopIntervalMs: 25 };
                  else env.runtimeConfig.minFrameDelayMs = val;
                }
              }}
              data-testid="settings-runtime-delay"
            />
            <span class="slider-value">{$settings.runtimeDelay === 0 ? 'instant' : `${$settings.runtimeDelay}ms`}</span>
          </div>
        </label>
        <p class="setting-hint">Artificial delay between runtime frames. 0 = fastest. Higher = easier to observe state transitions.</p>

        <label class="setting-row">
          <span>Last process() tick</span>
          <span class="mono-value">{processLivenessLabel}</span>
        </label>
      </div>

      <div class="section">
        <h3>Data</h3>

        <button class="btn danger" on:click={confirmResetAllData}>
          Clear All Data
        </button>
        <p class="setting-hint">Removes all wallets, accounts, and runtime state. Cannot be undone.</p>
      </div>

      <div class="section">
        <h3>Runtime Verify</h3>

        <label class="setting-row">
          <span>Start from snapshot</span>
          <select
            bind:value={selectedCheckpointHeight}
            on:focus={() => void loadCheckpointHeights()}
            data-testid="settings-verify-checkpoint"
          >
            {#if checkpointHeights.length === 0}
              <option value="">No snapshots</option>
            {:else}
              {#each checkpointHeights as height}
                <option value={String(height)}>
                  {height === 1 ? 'Genesis snapshot (frame 1)' : `Snapshot ${height}`}
                </option>
              {/each}
            {/if}
          </select>
        </label>
        <p class="setting-hint">Runs isolated replay from the selected snapshot to latest frame and compares the final state hash. Live runtime is untouched.</p>

        <button
          class="btn"
          on:click={verifyRuntimeChainNow}
          disabled={verifyLoading || checkpointHeights.length === 0 || !$xlnEnvironment?.runtimeId || !$activeVault?.seed}
          data-testid="settings-verify-runtime-chain"
        >
          {verifyLoading ? 'Verifying...' : 'Verify Chain'}
        </button>

        {#if checkpointLoadError}
          <p class="setting-hint error-text">{checkpointLoadError}</p>
        {/if}
        {#if verifyError}
          <p class="setting-hint error-text">{verifyError}</p>
        {/if}
        {#if verifyResult}
          <p class="setting-hint">
            Verified through frame {verifyResult.latestHeight} from {verifyResult.selectedSnapshotHeight === 1 ? 'genesis snapshot' : `snapshot ${verifyResult.selectedSnapshotHeight}`}.
            Restored height {verifyResult.restoredHeight}.
          </p>
        {/if}
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
    background: var(--theme-bg-gradient, linear-gradient(180deg, rgba(20, 18, 15, 0.98) 0%, rgba(10, 8, 5, 0.99) 100%));
    border: 1px solid var(--theme-glass-border, rgba(255, 255, 255, 0.08));
    border-radius: 16px;
    overflow: hidden;
    color: var(--theme-text-primary, rgba(255, 255, 255, 0.95));
  }

  .wallet-settings.embedded {
    max-width: none;
    max-height: none;
    border-radius: 12px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.06));
  }

  .header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--theme-text-primary, rgba(255, 255, 255, 0.95));
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: var(--theme-surface-hover, rgba(255, 255, 255, 0.04));
    border: none;
    border-radius: 8px;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.6));
    cursor: pointer;
    transition: all 0.15s;
  }

  .close-btn:hover {
    background: var(--theme-surface, rgba(255, 255, 255, 0.08));
    color: var(--theme-text-primary, rgba(255, 255, 255, 0.9));
  }

  /* Tabs */
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.06));
  }

  .tab {
    flex: 1;
    padding: 12px 16px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.5));
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .tab:hover {
    color: var(--theme-text-primary, rgba(255, 255, 255, 0.8));
    background: var(--theme-surface-hover, rgba(255, 255, 255, 0.02));
  }

  .tab.active {
    color: var(--theme-accent, rgba(255, 200, 100, 1));
    border-bottom-color: var(--theme-accent, rgba(255, 200, 100, 0.8));
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
    color: var(--theme-text-primary, rgba(255, 255, 255, 0.9));
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .section h3.subsection {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--theme-border, rgba(255, 255, 255, 0.06));
  }

  .section-desc {
    margin: 0 0 16px 0;
    font-size: 12px;
    color: var(--theme-text-muted, rgba(255, 255, 255, 0.4));
  }

  /* Info Card */
  .info-card {
    background: var(--theme-surface, rgba(255, 255, 255, 0.03));
    border: 1px solid var(--theme-border, rgba(255, 255, 255, 0.06));
    border-radius: 10px;
    padding: 12px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.04));
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .info-row .label {
    font-size: 12px;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.5));
  }

  .info-row .value {
    font-size: 13px;
    color: var(--theme-text-primary, rgba(255, 255, 255, 0.9));
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

  .seed-warning {
    padding: 10px 12px;
    background: rgba(255, 100, 100, 0.1);
    border-radius: 6px;
    font-size: 11px;
    color: rgba(255, 150, 150, 0.9);
    margin-bottom: 12px;
  }

  .seed-subsection + .seed-subsection {
    margin-top: 12px;
  }

  .seed-subhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.72);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .seed-code {
    display: block;
    width: 100%;
    padding: 12px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 6px;
    font-family: 'SF Mono', monospace;
    font-size: 12px;
    color: rgba(255, 200, 100, 0.9);
    word-break: break-word;
    white-space: normal;
    line-height: 1.6;
    box-sizing: border-box;
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
    -webkit-appearance: none;
    appearance: none;
    height: 2px;
    background: linear-gradient(90deg, rgba(251, 191, 36, 0.7), rgba(113, 113, 122, 0.3));
    border-radius: 1px;
    outline: none;
    cursor: pointer;
  }

  .slider-row input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    background: #fbbf24;
    border: 2px solid #0d0e12;
    border-radius: 2px;
    transform: rotate(45deg);
    cursor: pointer;
    box-shadow: 0 0 4px rgba(251, 191, 36, 0.3);
  }

  .slider-row input[type="range"]::-moz-range-thumb {
    width: 12px;
    height: 12px;
    background: #fbbf24;
    border: 2px solid #0d0e12;
    border-radius: 2px;
    transform: rotate(45deg);
    cursor: pointer;
    box-shadow: 0 0 4px rgba(251, 191, 36, 0.3);
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

  .setting-hint {
    margin: 4px 0 12px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.3);
    line-height: 1.4;
  }

  .setting-hint.error-text {
    color: rgba(255, 120, 120, 0.9);
  }

  /* Empty State */
  .empty-state {
    padding: 40px 20px;
    text-align: center;
    color: rgba(255, 255, 255, 0.4);
    font-size: 13px;
  }

  /* Bar color legend */
  .bar-legend-mini {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    padding: 2px 0 4px 0;
  }

  .legend-swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }
</style>
