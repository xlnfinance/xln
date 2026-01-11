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
  import { activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import { entityPositions, xlnFunctions, xlnInstance, getXLN } from '$lib/stores/xlnStore';
  import { runtimes, activeRuntimeId } from '$lib/stores/runtimeStore';
  import { appStateOperations } from '$lib/stores/appStateStore';
  import { panelBridge } from '$lib/view/utils/panelBridge';
  import { showVaultPanel, vaultUiOperations } from '$lib/stores/vaultUiStore';
  import { setEntityEnvContext } from './components/entity/shared/EntityEnvContext';
  import type { Tab } from '$lib/types/ui';
  import { createNumberedSelfEntity } from '$lib/utils/entityFactory';

  import EntityDropdown from '$lib/components/Entity/EntityDropdown.svelte';
  import AccountDropdown from '$lib/components/Entity/AccountDropdown.svelte';
  import EntityPanel from '$lib/components/Entity/EntityPanel.svelte';
  import AccountPanel from '$lib/components/Entity/AccountPanel.svelte';
  import RuntimeDropdown from '$lib/components/Runtime/RuntimeDropdown.svelte';
  import BrainVaultView from '$lib/components/Views/BrainVaultView.svelte';
  import WalletView from '$lib/components/Wallet/WalletView.svelte';

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

  onMount(() => {
    vaultOperations.initialize();
  });

  // Selection state
  let selectedEntityId = $state<string | null>(null);
  let selectedSignerId = $state<string | null>(null);
  let selectedAccountId = $state<string | null>(null);
  let selectedJurisdictionName = $state<string | null>(null);
  let isCreatingJMachine = false;
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
    isCreatingJMachine = true;
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
          type: 'createXlnomy',
          data: {
            name,
            evmType: 'browservm',
            blockTimeMs: 1000,
            autoGrid: false
          }
        }],
        entityInputs: []
      });

      isolatedEnv.set(env);
      return name;
    } catch (err) {
      console.warn('[UserModePanel] Failed to create J-Machine:', err);
      return null;
    } finally {
      isCreatingJMachine = false;
    }
  }

  async function ensureSelfEntities() {
    const env = get(isolatedEnv);
    const vault = get(activeVault);
    if (!env || !vault?.signers?.length) return;

    const names = listJMachineNames(env);
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
          vaultOperations.setSignerEntity(signerEntry.index, entityId);
          isolatedEnv.set(env);
          selfEntityChecked.add(signerAddress);
        }
      } finally {
        selfEntityInFlight.delete(signerAddress);
      }
    }
  }

  $effect(() => {
    void ensureSelfEntities();
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

  // Handle entity selection from dropdown
  function handleEntitySelect(event: CustomEvent<{ jurisdiction: string; signerId: string; entityId: string }>) {
    const { signerId, entityId } = event.detail;
    selectedEntityId = entityId;
    selectedSignerId = signerId;
    selectedAccountId = null; // Reset account when entity changes
    console.log('[UserModePanel] Entity selected:', entityId.slice(0, 10), signerId.slice(0, 10));
  }

  // Handle account selection from dropdown
  function handleAccountSelect(event: CustomEvent<{ accountId: string | null }>) {
    selectedAccountId = event.detail.accountId;
    console.log('[UserModePanel] Account selected:', selectedAccountId?.slice(0, 10));
  }

  function handleJurisdictionSelect(event: CustomEvent<{ name: string }>) {
    selectedJurisdictionName = event.detail.name;
    selectedAccountId = null;
  }

  async function handleAddRuntime() {
    vaultUiOperations.requestDeriveNewVault();
  }

  function focusDockPanel(panelId: string) {
    appStateOperations.setMode('dev');
    setTimeout(() => {
      panelBridge.emit('focusPanel', { panelId });
    }, 150);
  }

  async function handleAddJurisdiction() {
    const env = get(isolatedEnv);
    if (!env) return;
    const name = await createJMachineInEnv(env);
    if (name) selectedJurisdictionName = name;
  }

  function handleAddEntity() {
    focusDockPanel('architect');
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
          on:addRuntime={handleAddRuntime}
        />
      </div>
      <div class="rjea-slot entity-slot">
        <EntityDropdown
          tab={entityTab}
          jurisdictionFilter={selectedJurisdictionName}
          selectedJurisdiction={selectedJurisdictionName}
          on:entitySelect={handleEntitySelect}
          on:jurisdictionSelect={handleJurisdictionSelect}
          allowAddJurisdiction={true}
          on:addJurisdiction={handleAddJurisdiction}
          allowAdd={true}
          on:addEntity={handleAddEntity}
        />
      </div>
      <div class="rjea-slot account-slot">
        <AccountDropdown
          replica={selectedReplica}
          {selectedAccountId}
          on:accountSelect={handleAccountSelect}
          allowAdd={true}
          on:addAccount={handleAddAccount}
        />
      </div>
    </div>
  </div>

  <!-- Content -->
  <main class="panel-content">
    {#if showVaultPanelVisible}
      <BrainVaultView embedded={true} />
    {:else}
      <section class="wallet-section signer-wallet">
        <div class="section-header">
          <div class="section-title">Signer Wallet</div>
          <code class="section-address">
            {signerWalletAddress ? signerWalletAddress : 'No signer'}
          </code>
        </div>
        <WalletView
          privateKey={signerWalletPrivateKey || ''}
          walletAddress={signerWalletAddress}
          entityId={selectedEntityId || ''}
          identiconSrc={signerWalletIdenticon}
          networkEnabled={signerNetworkEnabled}
        />
      </section>
      {#if selectedEntityId && selectedReplica}
        <section class="wallet-section entity-wallet">
          <div class="section-header">
            <div class="section-title">Entity Wallet</div>
            <code class="section-address">
              {selectedEntityId}
            </code>
          </div>
          {#if selectedAccountId && selectedAccount}
            <AccountPanel
              account={selectedAccount}
              entityId={selectedEntityId}
              counterpartyId={selectedAccountId}
            />
          {:else}
            <EntityPanel tab={entityTab} isLast={true} hideHeader={true} />
          {/if}
        </section>
      {/if}
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
    overflow-x: auto;
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
