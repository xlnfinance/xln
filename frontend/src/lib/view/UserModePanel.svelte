<script lang="ts">
  /**
   * UserModePanel - RJEA hierarchical navigation for user mode
   *
   * Uses existing EntityDropdown + AccountDropdown components.
   * No popups, mobile-friendly, unified dropdown system.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount } from 'svelte';
  import type { Writable } from 'svelte/store';
  import { writable, get } from 'svelte/store';
  import { activeVault, vaultOperations, allVaults } from '$lib/stores/vaultStore';
  import { entityPositions, xlnFunctions, xlnInstance, getXLN } from '$lib/stores/xlnStore';
  import { jmachineOperations } from '$lib/stores/jmachineStore';
  import { runtimes, activeRuntimeId } from '$lib/stores/runtimeStore';
  import { appStateOperations } from '$lib/stores/appStateStore';
  import { panelBridge } from '$lib/view/utils/panelBridge';
  import { showVaultPanel, vaultUiOperations } from '$lib/stores/vaultUiStore';
  import { setEntityEnvContext } from './components/entity/shared/EntityEnvContext';
  import type { Tab } from '$lib/types/ui';
  import { createNumberedSelfEntity } from '$lib/utils/entityFactory';

  import EntityDropdown from '$lib/components/Entity/EntityDropdown.svelte';
  import AccountDropdown from '$lib/components/Entity/AccountDropdown.svelte';
  import EntityPanelTabs from '$lib/components/Entity/EntityPanelTabs.svelte';
  import AccountPanel from '$lib/components/Entity/AccountPanel.svelte';
  import RuntimeDropdown from '$lib/components/Runtime/RuntimeDropdown.svelte';
  import RuntimeCreation from '$lib/components/Views/RuntimeCreation.svelte';
  import WalletView from '$lib/components/Wallet/WalletView.svelte';
  import JurisdictionPanel from './panels/JurisdictionPanel.svelte';
  import FormationPanel from '$lib/components/Entity/FormationPanel.svelte';
  import WalletSettings from '$lib/components/Settings/WalletSettings.svelte';
  import AddJMachine from '$lib/components/Jurisdiction/AddJMachine.svelte';
  import { Settings } from 'lucide-svelte';

  interface Props {
    isolatedEnv: Writable<any>;
    isolatedHistory?: Writable<any[]>;
    isolatedTimeIndex?: Writable<number>;
    isolatedIsLive?: Writable<boolean>;
  }

  let {
    isolatedEnv,
    isolatedHistory = writable([]),
    isolatedTimeIndex = writable(-1),
    isolatedIsLive = writable(true)
  }: Props = $props();



  // Set context for EntityPanel/AccountPanel
  setEntityEnvContext({
    isolatedEnv,
    isolatedHistory,
    isolatedTimeIndex,
    isolatedIsLive,
  });

  onMount(async () => {
    await vaultOperations.initialize();
  });

  // Selection state
  type ViewMode = 'signer' | 'entity' | 'jurisdiction';
  let viewMode = $state<ViewMode>('signer');
  let selectedEntityId = $state<string | null>(null);
  let selectedSignerId = $state<string | null>(null);
  let selectedAccountId = $state<string | null>(null);
  let selectedJurisdictionName = $state<string | null>(null);
  let isCreatingJMachine = false; // Stays true on failure to prevent retry
  // Inline panels - NO POPUPS! All panels are inline for desktop/mobile
  type InlinePanel = 'none' | 'formation' | 'add-jmachine' | 'settings';
  let activeInlinePanel = $state<InlinePanel>('none');
  const selfEntityChecked = new Set<string>();
  const selfEntityInFlight = new Set<string>();

  // Reactive: signer info from vault
  const signer = $derived($activeVault?.signers?.[0] || null);
  const positionsMap = $derived($entityPositions);
  const activeXlnFunctions = $derived($xlnFunctions);
  const xlnReady = $derived(!!$xlnInstance);

  const signerWalletAddress = $derived(signer?.address || '');
  const signerWalletPrivateKey = $derived(
    signer ? vaultOperations.getSignerPrivateKey(0) : null
  );
  const signerWalletIdenticon = $derived(
    signerWalletAddress && xlnReady && activeXlnFunctions?.generateSignerAvatar
      ? activeXlnFunctions.generateSignerAvatar(signerWalletAddress)
      : ''
  );

  // Active runtime (optional for multi-runtime setups)
  const activeRuntime = $derived.by(() => $runtimes.get($activeRuntimeId));
  let lastRuntimeId: string | null = null;
  let lastVaultId: string | null = null;

  // Sync selected runtime env into isolated stores (user mode only)
  $effect(() => {
    if (!activeRuntime?.env) return;
    isolatedEnv.set(activeRuntime.env);
    isolatedHistory.set(activeRuntime.env.history || []);
    isolatedTimeIndex.set(-1);
    isolatedIsLive.set(true);
  });

  // Reset selections when switching runtimes
  $effect(() => {
    if (!activeRuntime) return;
    if (lastRuntimeId && lastRuntimeId !== activeRuntime.id) {
      selectedEntityId = null;
      selectedSignerId = null;
      selectedAccountId = null;
      selectedJurisdictionName = null;
      selfEntityChecked.clear();
      selfEntityInFlight.clear();
      isCreatingJMachine = false; // Allow attempt for new runtime
    }
    lastRuntimeId = activeRuntime.id;
  });

  // Reset selections when switching vaults
  $effect(() => {
    const currentVaultId = $activeVault?.id || null;
    if (lastVaultId && lastVaultId !== currentVaultId) {
      selectedEntityId = null;
      selectedSignerId = null;
      selectedAccountId = null;
      selectedJurisdictionName = null;
      selfEntityChecked.clear();
      selfEntityInFlight.clear();
      isCreatingJMachine = false; // Allow attempt for new vault
    }
    lastVaultId = currentVaultId;
  });

  // Current frame (time-aware)
  const currentFrame = $derived.by(() => {
    const timeIdx = $isolatedTimeIndex;
    const hist = $isolatedHistory;
    const env = $isolatedEnv;

    if (timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return hist[idx];
    }
    return env;
  });

  // Available jurisdictions (time-aware)
  const availableJurisdictions = $derived.by(() => {
    const frame = currentFrame;
    if (!frame?.jReplicas) return [];
    if (frame.jReplicas instanceof Map) {
      return Array.from(frame.jReplicas.values());
    }
    if (Array.isArray(frame.jReplicas)) {
      return frame.jReplicas;
    }
    return Object.values(frame.jReplicas || {});
  });

  // Auto-select jurisdiction when available
  $effect(() => {
    if (!availableJurisdictions.length) return;
    if (!selectedJurisdictionName) {
      const active = (currentFrame as any)?.activeJurisdiction || availableJurisdictions[0]?.name;
      if (active) selectedJurisdictionName = active;
      return;
    }
    if (!availableJurisdictions.find((j: any) => j.name === selectedJurisdictionName)) {
      selectedJurisdictionName = availableJurisdictions[0]?.name || null;
    }
  });

  // Get replica for selected entity
  const selectedReplica = $derived.by(() => {
    if (!selectedEntityId || !selectedSignerId || !currentFrame?.eReplicas) return null;
    const key = `${selectedEntityId}:${selectedSignerId}`;
    const replicas = currentFrame.eReplicas instanceof Map
      ? currentFrame.eReplicas
      : new Map(Object.entries(currentFrame.eReplicas || {}));
    return replicas.get(key) || null;
  });

  // Clear entity/account if jurisdiction filter no longer matches
  $effect(() => {
    if (!selectedJurisdictionName || !selectedReplica) return;
    const replicaJurisdiction =
      selectedReplica.position?.jurisdiction ||
      selectedReplica.position?.xlnomy ||
      selectedReplica.state?.config?.jurisdiction?.name ||
      positionsMap?.get?.(selectedEntityId || '')?.jurisdiction;
    if (replicaJurisdiction && replicaJurisdiction !== selectedJurisdictionName) {
      selectedEntityId = null;
      selectedSignerId = null;
      selectedAccountId = null;
    }
  });

  // Get selected account
  const selectedAccount = $derived.by(() => {
    if (!selectedReplica || !selectedAccountId) return null;
    return selectedReplica.state?.accounts?.get(selectedAccountId) || null;
  });

  function listJMachineNames(env: any): string[] {
    const jReplicas = env?.jReplicas;
    if (!jReplicas) return [];
    if (jReplicas instanceof Map) return Array.from(jReplicas.keys());
    if (Array.isArray(jReplicas)) return jReplicas.map((jr: any) => jr?.name).filter(Boolean);
    return Object.keys(jReplicas || {});
  }

  function findReplicaBySigner(env: any, signerId: string) {
    const reps = env?.eReplicas;
    if (!reps) return null;
    const replicas = reps instanceof Map ? reps : new Map(Object.entries(reps || {}));
    for (const [, replica] of replicas) {
      if (replica?.signerId?.toLowerCase?.() === signerId.toLowerCase()) {
        return replica;
      }
    }
    return null;
  }

  async function createJMachineInEnv(env: any): Promise<string | null> {
    if (!env || isCreatingJMachine) return null;

    isCreatingJMachine = true; // Never reset on failure - no retries
    try {
      const names = listJMachineNames(env);
      let index = names.length + 1;
      let name = `xlnomy${index}`;
      while (names.includes(name)) {
        index += 1;
        name = `xlnomy${index}`;
      }

      const xln = await getXLN();
      await xln.applyRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name,
            chainId: 1337,
            ticker: 'SIM',
            rpcs: [],
          }
        }],
        entityInputs: []
      });

      isolatedEnv.set(env);
      isCreatingJMachine = false; // Only reset on success
      return name;
    } catch (err) {
      console.error('[createJMachineInEnv] ❌ ERROR:', err);
      // isCreatingJMachine stays true - no retry
      return null;
    }
  }

  async function ensureSelfEntities() {
    const env = get(isolatedEnv);
    const vault = get(activeVault);

    if (!env || !vault?.signers?.length) return;

    const names = listJMachineNames(env);

    // Create J-machine if missing (one attempt only)
    if (names.length === 0) {
      if (isCreatingJMachine) return;
      const created = await createJMachineInEnv(env);
      if (!created) return;
      names.push(created);
    }

    let jurisdiction = selectedJurisdictionName && names.includes(selectedJurisdictionName)
      ? selectedJurisdictionName
      : env.activeJurisdiction;
    if (!jurisdiction) {
      jurisdiction = names[0] || null;
    }

    for (const signerEntry of vault.signers) {
      const signerAddress = signerEntry.address;

      if (!signerAddress) continue;
      if (selfEntityChecked.has(signerAddress) || selfEntityInFlight.has(signerAddress)) continue;

      const existing = findReplicaBySigner(env, signerAddress);
      if (existing) {
        if (!signerEntry.entityId && existing.entityId) {
          vaultOperations.setSignerEntity(signerEntry.index, existing.entityId);
        }
        selfEntityChecked.add(signerAddress);
        continue;
      }

      selfEntityInFlight.add(signerAddress);
      try {
        const entityId = await createNumberedSelfEntity(env, signerAddress, jurisdiction || undefined);
        if (entityId) {
          console.log(`[ensureSelfEntities] ✅ Entity created: ${entityId.slice(0, 10)} for signer ${signerAddress.slice(0, 10)}`);
          vaultOperations.setSignerEntity(signerEntry.index, entityId);
          isolatedEnv.set(env);
          selfEntityChecked.add(signerAddress);
        } else {
          console.error('[ensureSelfEntities] ❌ NULL entityId for signer:', signerAddress.slice(0, 10));
        }
      } catch (err) {
        console.error('[ensureSelfEntities] ❌ ERROR:', err);
      } finally {
        selfEntityInFlight.delete(signerAddress);
      }
    }
  }

  // Trigger entity creation when env becomes available OR vault changes
  $effect(() => {
    if (!!$isolatedEnv && !!$activeVault) {
      void ensureSelfEntities();
    }
  });

  const signerNetworkEnabled = $derived.by(() => {
    const rpc = selectedReplica?.state?.config?.jurisdiction?.rpc || '';
    if (!rpc) return false;
    return !rpc.startsWith('browservm://');
  });

  const hasSigner = $derived(!!signer?.address);
  const showVaultGate = $derived(!hasSigner);
  const showVaultPanelVisible = $derived(showVaultGate || $showVaultPanel);

  // Tab for EntityPanel
  const entityTab: Tab = $derived({
    id: 'user-entity',
    title: selectedEntityId ? `Entity ${selectedEntityId.slice(0, 8)}` : 'Entity',
    entityId: selectedEntityId || '',
    signerId: selectedSignerId || '',
    jurisdiction: 'browservm',
    isActive: true,
  });

  function handleSignerSelect(event: CustomEvent<{ signerId: string }>) {
    viewMode = 'signer';
    selectedEntityId = null;
    selectedSignerId = null;
    selectedAccountId = null;
  }

  // Handle entity selection from dropdown
  function handleEntitySelect(event: CustomEvent<{ jurisdiction: string; signerId: string; entityId: string }>) {
    const { signerId, entityId } = event.detail;
    viewMode = 'entity';
    selectedEntityId = entityId;
    selectedSignerId = signerId;
    selectedAccountId = null; // Reset account when entity changes
  }

  // Handle account selection from dropdown
  function handleAccountSelect(event: CustomEvent<{ accountId: string | null }>) {
    selectedAccountId = event.detail.accountId;
  }

  function handleJurisdictionSelect(event: CustomEvent<{ name: string }>) {
    viewMode = 'jurisdiction';
    selectedJurisdictionName = event.detail.name;
    selectedAccountId = null;
  }

  async function handleAddRuntime() {
    vaultUiOperations.requestDeriveNewVault();
  }

  async function handleAddSigner() {
    const newSigner = vaultOperations.addSigner();
    if (!newSigner) {
      console.error('[UserModePanel] ❌ Failed to add signer (no active vault)');
    }
  }

  async function handleRemoveRuntime(event: CustomEvent<{ runtimeId: string }>) {
    const runtimeId = event.detail.runtimeId;
    const runtime = get(allVaults).find(v => v.id === runtimeId);
    const runtimeLabel = runtime?.label || runtimeId;

    if (!confirm(`Delete "${runtimeLabel}"? This will remove all entities and data.`)) {
      return;
    }

    // Delete runtime
    vaultOperations.deleteRuntime(runtimeId);

    // Delete runtime from runtimeStore
    runtimes.update(r => {
      r.delete(runtimeId);
      return r;
    });

    console.log('[UserModePanel] ✅ Runtime deleted:', runtimeId);
  }

  function focusDockPanel(panelId: string) {
    appStateOperations.setMode('dev');
    setTimeout(() => {
      panelBridge.emit('focusPanel', { panelId });
    }, 150);
  }

  function handleAddJurisdiction() {
    activeInlinePanel = 'add-jmachine';
  }

  async function handleJMachineCreate(event: CustomEvent<{ name: string; mode: 'browservm' | 'rpc'; chainId: number; rpcs: string[]; ticker: string }>) {
    const { name, mode, chainId, rpcs, ticker } = event.detail;
    const env = get(isolatedEnv);
    if (!env) return;

    isCreatingJMachine = true;
    try {
      const xln = await getXLN();
      await xln.applyRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: { name, chainId, ticker, rpcs }
        }],
        entityInputs: []
      });

      // Persist config for reconnection on reload
      jmachineOperations.upsert({
        name,
        mode,
        chainId,
        ticker,
        rpcs,
        createdAt: Date.now(),
      });

      isolatedEnv.set(env);
      selectedJurisdictionName = name;
      activeInlinePanel = 'none';
      isCreatingJMachine = false;
    } catch (err) {
      console.error('[handleJMachineCreate] ERROR:', err);
      isCreatingJMachine = false;
      // Don't close form on error - let user retry
    }
  }

  function handleAddEntity() {
    activeInlinePanel = 'formation';
  }

  function handleEntityFormationClose() {
    activeInlinePanel = 'none';
  }

  function handleAddAccount() {
    const entityId = selectedEntityId;
    const signerId = selectedSignerId;
    if (entityId && signerId) {
      appStateOperations.setMode('dev');
      setTimeout(() => {
        panelBridge.emit('openEntityOperations', {
          entityId,
          entityName: entityId.slice(0, 10),
          signerId
        });
      }, 150);
      return;
    }
    focusDockPanel('architect');
  }

</script>

<div class="user-panel">
  <!-- Single-line RJEA cascade -->
  <div class="rjea-bar">
    <div class="rjea-primary">
      <div class="rjea-slot runtime-slot">
        <RuntimeDropdown
          allowAdd={true}
          addLabel="+ Add Runtime"
          allowDelete={$runtimes.size > 1}
          on:addRuntime={handleAddRuntime}
          on:deleteRuntime={handleRemoveRuntime}
        />
      </div>
      <div class="rjea-slot entity-slot">
        <EntityDropdown
          tab={entityTab}
          jurisdictionFilter={selectedJurisdictionName}
          selectedJurisdiction={selectedJurisdictionName}
          on:signerSelect={handleSignerSelect}
          on:addSigner={handleAddSigner}
          on:entitySelect={handleEntitySelect}
          on:jurisdictionSelect={handleJurisdictionSelect}
          allowAddJurisdiction={true}
          on:addJurisdiction={handleAddJurisdiction}
          allowAdd={true}
          on:addEntity={handleAddEntity}
        />
      </div>
      {#if viewMode === 'entity'}
        <div class="rjea-slot account-slot">
          <AccountDropdown
            replica={selectedReplica}
            {selectedAccountId}
            on:accountSelect={handleAccountSelect}
            allowAdd={true}
            on:addAccount={handleAddAccount}
          />
        </div>
      {/if}
    </div>
    <button class="settings-btn" on:click={() => activeInlinePanel = 'settings'} title="Settings">
      <Settings size={18} />
    </button>
  </div>

  <!-- Content - NO POPUPS! All panels are inline -->
  <main class="panel-content">
    {#if activeInlinePanel === 'formation'}
      <!-- Inline: Entity Formation -->
      <div class="inline-panel">
        <div class="inline-panel-header">
          <button class="back-btn" on:click={handleEntityFormationClose}>← Back</button>
          <h3>Create Entity</h3>
        </div>
        <FormationPanel onCreated={() => { activeInlinePanel = 'none'; }} />
      </div>
    {:else if activeInlinePanel === 'add-jmachine'}
      <!-- Inline: Add Jurisdiction -->
      <div class="inline-panel">
        <div class="inline-panel-header">
          <button class="back-btn" on:click={() => activeInlinePanel = 'none'}>← Back</button>
          <h3>Add Jurisdiction</h3>
        </div>
        <AddJMachine
          on:create={handleJMachineCreate}
          on:cancel={() => activeInlinePanel = 'none'}
        />
      </div>
    {:else if activeInlinePanel === 'settings'}
      <!-- Inline: Settings -->
      <div class="inline-panel">
        <div class="inline-panel-header">
          <button class="back-btn" on:click={() => activeInlinePanel = 'none'}>← Back</button>
          <h3>Settings</h3>
        </div>
        <WalletSettings on:close={() => activeInlinePanel = 'none'} />
      </div>
    {:else if showVaultPanelVisible}
      <RuntimeCreation embedded={true} />
    {:else if viewMode === 'signer'}
      <WalletView
        privateKey={signerWalletPrivateKey || ''}
        walletAddress={signerWalletAddress}
        entityId={selectedEntityId || ''}
        identiconSrc={signerWalletIdenticon}
        networkEnabled={signerNetworkEnabled}
      />
    {:else if viewMode === 'entity' && selectedEntityId && selectedReplica}
      {#if selectedAccountId && selectedAccount}
        <AccountPanel
          account={selectedAccount}
          entityId={selectedEntityId}
          counterpartyId={selectedAccountId}
        />
      {:else}
        <EntityPanelTabs tab={entityTab} isLast={true} hideHeader={true} />
      {/if}
    {:else if viewMode === 'jurisdiction'}
      <JurisdictionPanel
        {isolatedEnv}
        {isolatedHistory}
        {isolatedTimeIndex}
      />
    {/if}
  </main>
</div>

<style>
  .user-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary, #0d1117);
    color: var(--text-primary, #e6edf3);
  }

  .rjea-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: linear-gradient(180deg, #1a1f26 0%, #161b22 100%);
    border-bottom: 1px solid var(--border-primary, #30363d);
    position: relative;
    z-index: 100;
    flex-wrap: nowrap;
    overflow: hidden;
  }

  .rjea-primary {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: nowrap;
    flex: 1;
    min-width: 0;
  }

  .rjea-slot {
    min-width: 0;
    flex: 1;
  }

  .runtime-slot {
    flex: 0 0 190px;
  }

  .entity-slot,
  .account-slot {
    min-width: 220px;
  }

  .rjea-bar :global(.dropdown-trigger) {
    height: 36px;
    min-height: 36px;
    padding: 0 12px;
  }

  /* Content - below nav z-index so dropdowns overlay */
  .panel-content {
    flex: 1;
    overflow: auto;
    min-height: 0;
    position: relative;
    z-index: 1;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .wallet-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.7);
  }

  .section-address {
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 300px;
    text-align: center;
    padding: 2rem;
  }

  .empty-state h2 {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
    color: var(--text-primary, #e6edf3);
  }

  .empty-state p {
    color: var(--text-secondary, #8b949e);
    margin-bottom: 1rem;
  }

  .action-btn {
    padding: 10px 20px;
    background: var(--accent-blue, #1f6feb);
    border: none;
    border-radius: 6px;
    color: white;
    font-size: 14px;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .action-btn:hover {
    background: #388bfd;
  }

  /* Inline Panels - NO POPUPS! */
  .inline-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .inline-panel-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .inline-panel-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary, #e6edf3);
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: var(--text-secondary, #8b949e);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .back-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary, #e6edf3);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .settings-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .settings-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 200, 100, 0.3);
    color: rgba(255, 200, 100, 0.9);
  }

  /* Mobile responsive */
  @media (max-width: 768px) {
    .rjea-bar {
      padding: 6px 10px;
      gap: 8px;
    }

    .runtime-slot {
      flex: 0 0 160px;
    }

    .jurisdiction-slot,
    .entity-slot,
    .account-slot {
      min-width: 180px;
    }

  }
</style>
