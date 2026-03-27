<script lang="ts">
  /**
   * UserModePanel - wallet shell for user mode
   *
   * Keeps navigation inside the active panel so wallet mode has one primary
   * content surface instead of a separate global bar plus nested scroll roots.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount } from 'svelte';
  import type { Writable } from 'svelte/store';
  import { writable, get } from 'svelte/store';
  import { activeVault, vaultOperations, allVaults } from '$lib/stores/vaultStore';
  import { entityPositions, xlnFunctions, xlnInstance, getXLN, enqueueAndProcess } from '$lib/stores/xlnStore';
  import { jmachineOperations } from '$lib/stores/jmachineStore';
  import { runtimes, activeRuntimeId } from '$lib/stores/runtimeStore';
  import { showVaultPanel, vaultUiOperations } from '$lib/stores/vaultUiStore';
  import type { Tab } from '$lib/types/ui';
  import type { Env } from '@xln/runtime/xln-api';
  import type { EnvSnapshot, EntityReplica } from '$types';
  import { createSelfEntity } from '$lib/utils/entityFactory';
  import { readOnboardingComplete, writeOnboardingComplete } from '$lib/utils/onboardingState';

  import EntityPanelTabs from '$lib/components/Entity/EntityPanelTabs.svelte';
  import OnboardingPanel from '$lib/components/Entity/OnboardingPanel.svelte';
  import RuntimeCreation from '$lib/components/Views/RuntimeCreation.svelte';
  // Removed WalletView - using EntityPanelTabs for everything (Entity = Wallet)
  import JurisdictionPanel from './panels/JurisdictionPanel.svelte';
  import FormationPanel from '$lib/components/Entity/FormationPanel.svelte';
  import AddJMachine from '$lib/components/Jurisdiction/AddJMachine.svelte';

  type RuntimeFrame = Env | EnvSnapshot;
  type JurisdictionLike = { name: string };
  type JurisdictionEntry = { name?: string; rpcs?: string[] };
  type JMachineCreateDetail = {
    name: string;
    mode: 'browservm' | 'rpc';
    chainId: number;
    rpcs: string[];
    ticker: string;
    contracts?: {
      depository?: string;
      entityProvider?: string;
      account?: string;
      deltaTransformer?: string;
    } | undefined;
  };

  interface Props {
    isolatedEnv: Writable<Env | null>;
    isolatedHistory?: Writable<EnvSnapshot[]>;
    isolatedTimeIndex?: Writable<number>;
    isolatedIsLive?: Writable<boolean>;
  }

  let {
    isolatedEnv,
    isolatedHistory = writable([]),
    isolatedTimeIndex = writable(-1),
    isolatedIsLive = writable(true)
  }: Props = $props();
  onMount(async () => {
    await vaultOperations.initialize();
  });

  // Selection state
  type ViewMode = 'signer' | 'entity' | 'jurisdiction';
  let viewMode = $state<ViewMode>('entity'); // Default to entity view (wallet = entity)
  let selectedEntityId = $state<string | null>(null);
  let selectedSignerId = $state<string | null>(null);
  let selectedAccountId = $state<string | null>(null);
  let selectedJurisdictionName = $state<string | null>(null);
  let isCreatingJMachine = false; // Stays true on failure to prevent retry
  // Inline panels - NO POPUPS! All panels are inline for desktop/mobile
  type InlinePanel = 'none' | 'formation' | 'add-jmachine';
  let activeInlinePanel = $state<InlinePanel>('none');
  const selfEntityChecked = new Set<string>();
  const selfEntityInFlight = new Set<string>();
  let ensureSelfEntitiesEpoch = 0;
  let onboardingComplete = $state(false);

  // Reactive: signer info from vault
  const signer = $derived($activeVault?.signers?.[0] || null);
  const positionsMap = $derived($entityPositions);
  const activeXlnFunctions = $derived($xlnFunctions);
  const xlnReady = $derived(Boolean(activeXlnFunctions?.isReady));

  const signerWalletAddress = $derived(signer?.address || '');
  const signerWalletPrivateKey = $derived(
    signer ? vaultOperations.getSignerPrivateKey(0) : null
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
  const currentFrame: RuntimeFrame | null = $derived.by((): RuntimeFrame | null => {
    const timeIdx = $isolatedTimeIndex;
    const hist = $isolatedHistory;
    const env = $isolatedEnv;

    if (timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return hist[idx] ?? null;
    }
    return env;
  });

  // Available jurisdictions (time-aware)
  const availableJurisdictions = $derived.by(() => {
    const frame = currentFrame;
    if (!frame?.jReplicas) return [];
    if (frame.jReplicas instanceof Map) {
      return Array.from(frame.jReplicas.values()) as JurisdictionLike[];
    }
    if (Array.isArray(frame.jReplicas)) {
      return frame.jReplicas as JurisdictionLike[];
    }
    return Object.values(frame.jReplicas || {}) as JurisdictionLike[];
  });

  function getFrameActiveJurisdiction(frame: RuntimeFrame | null | undefined): string | null {
    if (!frame || !('activeJurisdiction' in frame)) return null;
    return typeof frame.activeJurisdiction === 'string' ? frame.activeJurisdiction : null;
  }

  // Auto-select jurisdiction when available (but NOT when entity is selected)
  $effect(() => {
    if (!availableJurisdictions.length) return;
    // Don't auto-set jurisdiction if user has selected an entity
    if (selectedEntityId) return;
    if (!selectedJurisdictionName) {
      const active = getFrameActiveJurisdiction(currentFrame) || availableJurisdictions[0]?.name;
      if (active) selectedJurisdictionName = active;
      return;
    }
    if (!availableJurisdictions.find((j) => j.name === selectedJurisdictionName)) {
      selectedJurisdictionName = availableJurisdictions[0]?.name || null;
    }
  });

  // Get replica for selected entity
  const selectedReplica = $derived.by<EntityReplica | null>(() => {
    if (!selectedEntityId || !selectedSignerId || !currentFrame?.eReplicas) {
      return null;
    }
    const replicas = currentFrame.eReplicas instanceof Map
      ? currentFrame.eReplicas
      : new Map<string, EntityReplica>(Object.entries(currentFrame.eReplicas || {}) as Array<[string, EntityReplica]>);
    const selectedEntityLower = selectedEntityId.toLowerCase();
    const selectedSignerLower = selectedSignerId.toLowerCase();
    for (const [key, replica] of replicas.entries()) {
      const [entityFromKey, signerFromKey] = String(key).split(':');
      const entityLower = String(entityFromKey || replica?.entityId || '').toLowerCase();
      const signerLower = String(signerFromKey || replica?.signerId || '').toLowerCase();
      if (entityLower === selectedEntityLower && signerLower === selectedSignerLower) {
        return replica || null;
      }
    }
    return null;
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

  function listJMachineNames(env: RuntimeFrame | null | undefined): string[] {
    const jReplicas = env?.jReplicas;
    if (!jReplicas) return [];
    if (jReplicas instanceof Map) return Array.from(jReplicas.keys());
    if (Array.isArray(jReplicas)) return jReplicas.map((jr) => jr?.name).filter(Boolean);
    return Object.keys(jReplicas || {});
  }

  function findReplicaBySigner(env: RuntimeFrame | null | undefined, signerId: string): EntityReplica | null {
    const reps = env?.eReplicas;
    if (!reps) return null;
    const replicas = reps instanceof Map ? reps : new Map<string, EntityReplica>(Object.entries(reps || {}) as Array<[string, EntityReplica]>);
    const signerLower = signerId.toLowerCase();
    for (const [key, replica] of replicas) {
      const [, signerFromKey] = String(key).split(':');
      const replicaSigner = String(replica?.signerId || signerFromKey || '').toLowerCase();
      if (replicaSigner === signerLower) {
        return replica;
      }
    }
    return null;
  }

  async function createJMachineInEnv(env: Env | null): Promise<string | null> {
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
      await enqueueAndProcess(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name,
            chainId: 31337,
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
    const runEpoch = ++ensureSelfEntitiesEpoch;
    const env = get(isolatedEnv);
    const vault = get(activeVault);

    if (!env || !vault?.signers?.length) return;

    const names = listJMachineNames(env);

    // DISABLED: Don't auto-create J-machine (VaultStore imports Testnet)
    // User must explicitly create J-machine via UI if needed
    if (names.length === 0) {
      console.warn('[ensureSelfEntities] No J-machines - VaultStore should import Testnet');
      return; // Don't auto-create xlnomy1
    }

    let jurisdiction: string | null = selectedJurisdictionName && names.includes(selectedJurisdictionName)
      ? selectedJurisdictionName
      : (env.activeJurisdiction ?? null);
    if (!jurisdiction) {
      jurisdiction = names[0] || null;
    }

    const activeRuntimeSigner = typeof env.runtimeId === 'string' ? env.runtimeId.toLowerCase() : '';
    if (!activeRuntimeSigner) {
      console.warn('[ensureSelfEntities] Missing env.runtimeId - skip auto-entity ensure');
      return;
    }

    for (const signerEntry of vault.signers) {
      if (runEpoch !== ensureSelfEntitiesEpoch) return;
      const signerAddress = signerEntry.address;

      if (!signerAddress) continue;
      if (signerAddress.toLowerCase() !== activeRuntimeSigner) continue;
      if (selfEntityChecked.has(signerAddress) || selfEntityInFlight.has(signerAddress)) continue;

      const existing = findReplicaBySigner(env, signerAddress);
      if (existing) {
        if (!signerEntry.entityId && existing.entityId) {
          vaultOperations.setSignerEntity(signerEntry.index, existing.entityId);
        }
        selfEntityChecked.add(signerAddress);

        // Auto-select first entity if none selected
        if (!selectedEntityId && existing.entityId) {
          viewMode = 'entity';
          selectedEntityId = existing.entityId;
          selectedSignerId = signerAddress;
          console.log('[ensureSelfEntities] Auto-selected existing entity:', existing.entityId.slice(0, 10));
        }
        continue;
      }

      selfEntityInFlight.add(signerAddress);
      try {
        // Re-check right before creation to avoid duplicate create on reactive races.
        const alreadyNow = findReplicaBySigner(env, signerAddress);
        if (alreadyNow?.entityId) {
          if (!signerEntry.entityId) {
            vaultOperations.setSignerEntity(signerEntry.index, alreadyNow.entityId);
          }
          selfEntityChecked.add(signerAddress);
          if (!selectedEntityId) {
            viewMode = 'entity';
            selectedEntityId = alreadyNow.entityId;
            selectedSignerId = signerAddress;
          }
          continue;
        }

        const entityId = await createSelfEntity(env, signerAddress, jurisdiction ?? undefined);
        if (runEpoch !== ensureSelfEntitiesEpoch) return;
        if (entityId) {
          // Resolve canonical entity by signer after create to prevent duplicate/late-selection drift.
          const canonical = findReplicaBySigner(env, signerAddress);
          const finalEntityId = canonical?.entityId || entityId;
          console.log(`[ensureSelfEntities] ✅ Entity created: ${finalEntityId.slice(0, 10)} for signer ${signerAddress.slice(0, 10)}`);
          vaultOperations.setSignerEntity(signerEntry.index, finalEntityId);
          isolatedEnv.set(env);
          selfEntityChecked.add(signerAddress);

          // Auto-select entity after creation
          viewMode = 'entity';
          selectedEntityId = finalEntityId;
          selectedSignerId = signerAddress;
          console.log('[ensureSelfEntities] Auto-selected entity:', finalEntityId.slice(0, 10));
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
    const jurisdictionName =
      selectedReplica?.state?.config?.jurisdiction?.name
      || selectedJurisdictionName
      || null;
    if (!jurisdictionName || !currentFrame?.jReplicas) return false;
    const replicas: JurisdictionEntry[] = currentFrame.jReplicas instanceof Map
      ? Array.from(currentFrame.jReplicas.values())
      : Array.isArray(currentFrame.jReplicas)
        ? currentFrame.jReplicas
        : Object.values(currentFrame.jReplicas || {});
    const match = replicas.find((replica) => replica?.name === jurisdictionName);
    return Array.isArray(match?.rpcs) && match.rpcs.some((rpc: string) => !rpc.startsWith('browservm://'));
  });

  const hasSigner = $derived(!!signer?.address);
  const onboardingRequiredForRuntime = $derived($activeVault?.requiresOnboarding !== false);
  const showVaultGate = $derived(!hasSigner);
  const showVaultPanelVisible = $derived(showVaultGate || $showVaultPanel);

  $effect(() => {
    const entityId = selectedEntityId;
    if (!onboardingRequiredForRuntime) {
      onboardingComplete = true;
      return;
    }
    if (!entityId) {
      onboardingComplete = false;
      return;
    }
    onboardingComplete = readOnboardingComplete(entityId);
  });

  // Tab for EntityPanel
  const entityTab: Tab = $derived({
    id: 'user-entity',
    title: selectedEntityId ? `Entity ${selectedEntityId}` : 'Entity',
    entityId: selectedEntityId || '',
    signerId: selectedSignerId || '',
    jurisdiction: 'browservm',
    isActive: true,
  });

  function handleSignerSelect(event: CustomEvent<{ signerId: string }>) {
    viewMode = 'entity';
    selectedEntityId = null;
    selectedSignerId = event.detail.signerId;
    selectedAccountId = null;
  }

  // Handle entity selection from dropdown
  function handleEntitySelect(event: CustomEvent<{ jurisdiction: string; signerId: string; entityId: string }>) {
    const { signerId, entityId } = event.detail;
    viewMode = 'entity';
    selectedEntityId = entityId;
    selectedSignerId = signerId;
    selectedAccountId = null;
    selectedJurisdictionName = null; // Clear filter to allow any entity
  }

  // Handle account selection from dropdown
  function handleAccountSelect(event: CustomEvent<{ accountId: string | null }>) {
    selectedAccountId = event.detail.accountId;
  }

  function handleOnboardingComplete() {
    if (selectedEntityId) {
      writeOnboardingComplete(selectedEntityId, true);
    }
    onboardingComplete = true;
    viewMode = 'entity';
    selectedAccountId = null;
    activeInlinePanel = 'none';
  }

  function handleJurisdictionSelect(event: CustomEvent<{ name: string }>) {
    viewMode = 'entity';
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

    const isLast = get(runtimes).size <= 1;
    const msg = isLast
      ? `Delete "${runtimeLabel}"? This is the last runtime — all data will be wiped and you'll return to the setup screen.`
      : `Delete "${runtimeLabel}"? This will remove all entities and data.`;

    if (!confirm(msg)) return;

    // Full cleanup: P2P, loop, stores
    await vaultOperations.deleteRuntime(runtimeId);

    // Delete runtime from runtimeStore
    runtimes.update(r => {
      r.delete(runtimeId);
      return r;
    });

    console.log('[UserModePanel] ✅ Runtime deleted:', runtimeId);

    // If last runtime, open creation screen
    if (isLast) {
      vaultUiOperations.requestDeriveNewVault();
    }
  }

  function handleAddJurisdiction() {
    activeInlinePanel = 'add-jmachine';
  }

  async function handleJMachineCreate(event: CustomEvent<JMachineCreateDetail>) {
    const { name, mode, chainId, rpcs, ticker, contracts } = event.detail;
    const env = get(isolatedEnv);
    if (!env) return;

    isCreatingJMachine = true;
    try {
      const xln = await getXLN();
      await enqueueAndProcess(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: { name, chainId, ticker, rpcs, ...(contracts ? { contracts } : {}) }
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
        ...(contracts ? { contracts } : {}),
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

</script>

{#if activeInlinePanel === 'formation'}
  <main class="panel-content">
    <!-- Inline: Entity Formation -->
    <div class="inline-panel">
      <div class="inline-panel-header">
        <button class="back-btn" onclick={handleEntityFormationClose}>← Back</button>
        <h3>Create Entity</h3>
      </div>
      <FormationPanel onCreated={() => { activeInlinePanel = 'none'; }} />
    </div>
  </main>
{:else if activeInlinePanel === 'add-jmachine'}
  <main class="panel-content">
    <!-- Inline: Add Jurisdiction -->
    <div class="inline-panel">
      <div class="inline-panel-header">
        <button class="back-btn" onclick={() => activeInlinePanel = 'none'}>← Back</button>
        <h3>Add Jurisdiction</h3>
      </div>
      <AddJMachine
        on:create={(event) => void handleJMachineCreate(event)}
        on:cancel={() => activeInlinePanel = 'none'}
      />
    </div>
  </main>
{:else if showVaultPanelVisible}
  <main class="panel-content">
    <RuntimeCreation embedded={true} />
  </main>
{:else if viewMode === 'entity' && selectedEntityId && selectedSignerId && !onboardingComplete}
  <main class="panel-content">
    <OnboardingPanel
      entityId={selectedEntityId}
      signerId={selectedSignerId}
      on:complete={handleOnboardingComplete}
    />
  </main>
{:else if viewMode === 'entity'}
  <EntityPanelTabs
    tab={entityTab}
    userModeHeader={true}
    showJurisdiction={false}
    selectedJurisdiction={selectedJurisdictionName}
    allowHeaderAddRuntime={true}
    allowHeaderDeleteRuntime={true}
    headerRuntimeAddLabel="+ Add Runtime"
    replicasOverride={currentFrame?.eReplicas instanceof Map ? currentFrame.eReplicas : null}
    envOverride={$isolatedEnv}
    historyOverride={$isolatedHistory}
    timeIndexOverride={$isolatedTimeIndex}
    isLiveOverride={$isolatedIsLive}
    on:signerSelect={handleSignerSelect}
    on:addSigner={handleAddSigner}
    on:entitySelect={handleEntitySelect}
    on:jurisdictionSelect={handleJurisdictionSelect}
    on:addJurisdiction={handleAddJurisdiction}
    on:addEntity={handleAddEntity}
    on:addRuntime={handleAddRuntime}
    on:deleteRuntime={handleRemoveRuntime}
  />
{:else if viewMode === 'jurisdiction'}
  <main class="panel-content">
    <JurisdictionPanel
      {isolatedEnv}
      {isolatedHistory}
      {isolatedTimeIndex}
    />
  </main>
{/if}

<style>
  .panel-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: auto;
    overflow: visible;
    min-height: 0;
    position: relative;
    z-index: 1;
    padding: 0;
    background: transparent;
    color: var(--theme-text-primary, #e5e5e5);
  }

  /* Inline Panels - NO POPUPS! */
  .inline-panel {
    display: block;
    min-height: 0;
    height: auto;
    overflow: visible;
  }

  .inline-panel-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, var(--theme-background, #0a0a0a));
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 88%, transparent);
    box-shadow: 0 12px 30px color-mix(in srgb, var(--theme-background, #0a0a0a) 7%, transparent);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .inline-panel-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--theme-text-primary, #e6edf3);
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: color-mix(in srgb, var(--theme-input-bg, var(--theme-card-bg, #18181b)) 96%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, var(--theme-card-border, #27272a)) 86%, transparent);
    border-radius: 6px;
    color: var(--theme-text-secondary, #8b949e);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .back-btn:hover {
    background: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 96%, transparent);
    color: var(--theme-text-primary, #e6edf3);
    border-color: color-mix(in srgb, var(--theme-card-hover-border, var(--theme-border, #27272a)) 82%, transparent);
  }

  @media (max-width: 768px) {
    .panel-content :global(.header.user-mode-header) {
      position: static;
    }
  }
</style>
