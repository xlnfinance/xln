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
  import { activeRuntime as activeRuntimeStore, vaultOperations, allRuntimes } from '$lib/stores/vaultStore';
  import {
    appRuntimeAdapterMode,
    entityPositions,
    xlnFunctions,
    xlnInstance,
    getXLN,
    enqueueAndProcess,
    refreshRuntimeAdapterEnvironment,
    setRuntimeAdapterActiveEntityId,
  } from '$lib/stores/xlnStore';
  import { jmachineOperations } from '$lib/stores/jmachineStore';
  import { runtimes, activeRuntimeId } from '$lib/stores/runtimeStore';
  import { showVaultPanel, vaultUiOperations } from '$lib/stores/vaultUiStore';
  import type { Tab } from '$lib/types/ui';
  import type { Env } from '@xln/runtime/xln-api';
  import type { EnvSnapshot, EntityReplica } from '$types';
  import { createSelfEntity } from '$lib/utils/entityFactory';
  import { readOnboardingComplete, writeOnboardingComplete } from '$lib/utils/onboardingState';
  import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';

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
    blockTimeMs: number;
    ticker: string;
    contracts?: {
      depository?: string;
      entityProvider?: string;
      account?: string;
      deltaTransformer?: string;
    } | undefined;
    deploy?: boolean;
  };

  interface Props {
    isolatedEnv: Writable<Env | null>;
    isolatedRevision?: Writable<number>;
    isolatedHistory?: Writable<EnvSnapshot[]>;
    isolatedTimeIndex?: Writable<number>;
    isolatedIsLive?: Writable<boolean>;
  }

  let {
    isolatedEnv,
    isolatedRevision = writable(0),
    isolatedHistory = writable([]),
    isolatedTimeIndex = writable(-1),
    isolatedIsLive = writable(true)
  }: Props = $props();

  function publishIsolatedEnv(env: Env | null) {
    isolatedEnv.set(env ? createRuntimeViewEnv(unwrapLiveRuntimeEnv(env) ?? env) : null);
    isolatedRevision.update((revision) => revision + 1);
  }

  function isLiveRuntimeFrame(frame: RuntimeFrame): frame is Env {
    return frame.jReplicas instanceof Map;
  }

  function cloneLiveEnv(frame: Env): Env {
    return createRuntimeViewEnv(unwrapLiveRuntimeEnv(frame) ?? frame);
  }

  function cloneEnvSnapshot(frame: EnvSnapshot): EnvSnapshot {
    return {
      ...frame,
      eReplicas: new Map(frame.eReplicas),
      jReplicas: new Map(frame.jReplicas),
    };
  }

  function cloneRuntimeFrame(frame: RuntimeFrame | null | undefined): RuntimeFrame | null {
    if (!frame) return null;
    return isLiveRuntimeFrame(frame) ? cloneLiveEnv(frame) : cloneEnvSnapshot(frame);
  }

  function runtimeFrameRevision(frame: RuntimeFrame | null | undefined): string {
    if (!frame) return 'none';
    let accountCount = 0;
    let accountHeightTotal = 0;
    let pendingFrameCount = 0;
    for (const replica of frame.eReplicas?.values?.() || []) {
      for (const account of replica?.state?.accounts?.values?.() || []) {
        accountCount += 1;
        accountHeightTotal += Number(account.currentHeight ?? account.currentFrame?.height ?? 0);
        if (account.pendingFrame) pendingFrameCount += 1;
      }
    }
    return [
      String(frame.runtimeId || ''),
      String(frame.height || 0),
      String(frame.timestamp || 0),
      String(frame.eReplicas?.size || 0),
      String(accountCount),
      String(accountHeightTotal),
      String(pendingFrameCount),
      String('frameLogs' in frame ? frame.frameLogs?.length || 0 : 0),
    ].join(':');
  }

  onMount(async () => {
    isolatedTimeIndex.set(-1);
    isolatedIsLive.set(true);
    if (get(appRuntimeAdapterMode) !== 'remote') {
      await vaultOperations.initialize();
    }
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
  const signer = $derived.by(() => {
    const vault = $activeRuntimeStore;
    const activeSignerIndex = Number(vault?.activeSignerIndex ?? 0);
    return vault?.signers?.[activeSignerIndex] || vault?.signers?.[0] || null;
  });
  const positionsMap = $derived($entityPositions);
  const activeXlnFunctions = $derived($xlnFunctions);
  const xlnReady = $derived(Boolean(activeXlnFunctions?.isReady));

  const signerWalletAddress = $derived(signer?.address || '');
  const signerWalletPrivateKey = $derived(
    signer ? vaultOperations.getSignerPrivateKey(0) : null
  );

  // Active runtime (optional for multi-runtime setups)
  const activeRuntime = $derived.by(() => $runtimes.get($activeRuntimeId));
  const isRemoteRuntime = $derived(activeRuntime?.type === 'remote' || $appRuntimeAdapterMode === 'remote');
  let lastRuntimeId: string | null = null;
  let lastVaultId: string | null = null;

  // Reset selections when switching runtimes
  $effect(() => {
    if (!activeRuntime) return;
    if (lastRuntimeId && lastRuntimeId !== activeRuntime.id) {
      isolatedTimeIndex.set(-1);
      isolatedIsLive.set(true);
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
    const currentVaultId = $activeRuntimeStore?.id || null;
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

  // Current frame follows isolated time controls, but user mode should boot LIVE by default.
  const currentFrame: RuntimeFrame | null = $derived.by((): RuntimeFrame | null => {
    const isLive = $isolatedIsLive;
    const timeIdx = $isolatedTimeIndex;
    const hist = $isolatedHistory;
    const env = $isolatedEnv;
    const revision = $isolatedRevision;
    void revision;

    if (!isLive && timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return cloneRuntimeFrame(hist[idx] ?? null);
    }
    // Publish a fresh frame object for Svelte on every runtime revision, while
    // retaining a hidden live-env handle for runtime actions.
    return cloneRuntimeFrame(env);
  });
  const currentFrameRevision = $derived.by(() => `${$isolatedRevision}:${runtimeFrameRevision(currentFrame)}`);

  // Available jurisdictions (time-aware)
  const availableJurisdictions = $derived.by(() => {
    const frame = currentFrame;
    if (!frame?.jReplicas) return [];
    return Array.from(frame.jReplicas.values()) as JurisdictionLike[];
  });

  function getFrameActiveJurisdiction(frame: RuntimeFrame | null | undefined): string | null {
    if (!frame || !('activeJurisdiction' in frame)) return null;
    return typeof frame.activeJurisdiction === 'string' ? frame.activeJurisdiction : null;
  }

  function getActiveSignerJurisdictionName(names: string[]): string | null {
    const vault = $activeRuntimeStore;
    const activeSignerIndex = Number(vault?.activeSignerIndex ?? 0);
    const activeSigner = vault?.signers?.[activeSignerIndex] || vault?.signers?.[0] || null;
    return resolveJMachineName(names, activeSigner?.jurisdiction) || null;
  }

  // Auto-select jurisdiction when available (but NOT when entity is selected)
  $effect(() => {
    if (!availableJurisdictions.length) return;
    // Don't auto-set jurisdiction if user has selected an entity
    if (selectedEntityId) return;
    const names = availableJurisdictions.map((j) => j.name).filter(Boolean);
    const activeSignerJurisdiction = getActiveSignerJurisdictionName(names);
    if (!selectedJurisdictionName) {
      const primary = activeSignerJurisdiction || resolveJMachineName(names, getFrameActiveJurisdiction(currentFrame)) || availableJurisdictions[0]?.name;
      if (primary) selectedJurisdictionName = primary;
      return;
    }
    if (!availableJurisdictions.find((j) => j.name === selectedJurisdictionName)) {
      selectedJurisdictionName = activeSignerJurisdiction || availableJurisdictions[0]?.name || null;
    }
  });

  // Get replica for selected entity
  const selectedReplica = $derived.by<EntityReplica | null>(() => {
    if (!selectedEntityId || !selectedSignerId || !currentFrame?.eReplicas) {
      return null;
    }
    const replicas = currentFrame.eReplicas;
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

  function firstReplicaInFrame(frame: RuntimeFrame | null | undefined): EntityReplica | null {
    const replicas = frame?.eReplicas;
    if (!replicas) return null;
    for (const replica of replicas.values()) {
      if (replica?.entityId && replica?.signerId) return replica;
    }
    return null;
  }

  $effect(() => {
    if (!isRemoteRuntime || !currentFrame?.eReplicas) return;
    if (selectedEntityId && selectedReplica) return;
    const replica = firstReplicaInFrame(currentFrame);
    if (!replica?.entityId || !replica?.signerId) return;
    viewMode = 'entity';
    selectedEntityId = String(replica.entityId).toLowerCase();
    selectedSignerId = String(replica.signerId).toLowerCase();
    selectedAccountId = null;
    selectedJurisdictionName = null;
  });

  $effect(() => {
    if (isRemoteRuntime || !currentFrame?.eReplicas) return;
    if (selectedEntityId && selectedReplica) return;

    const vault = $activeRuntimeStore;
    const activeSignerIndex = Number(vault?.activeSignerIndex ?? 0);
    const activeSigner =
      vault?.signers?.[activeSignerIndex]
      || vault?.signers?.[0]
      || null;
    const activeSignerId = String(activeSigner?.address || '').trim().toLowerCase();
    const preferredReplica = activeSignerId
      ? findReplicaBySigner(currentFrame, activeSignerId, null)
      : null;
    const replica = preferredReplica || firstReplicaInFrame(currentFrame);
    if (!replica?.entityId || !replica?.signerId) return;

    // After full device wipe the runtime can be restored from a tower before the
    // old tab selection exists. Defaulting to the active local signer replica
    // keeps wallet boot deterministic instead of landing on an empty "Select Entity" shell.
    viewMode = 'entity';
    selectedEntityId = String(replica.entityId).toLowerCase();
    selectedSignerId = String(replica.signerId).toLowerCase();
    if (selectedJurisdictionName && selectedReplicaJurisdiction && selectedJurisdictionName !== selectedReplicaJurisdiction) {
      selectedJurisdictionName = selectedReplicaJurisdiction;
    }
  });

  $effect(() => {
    if (isRemoteRuntime) return;
    if (selectedEntityId && selectedSignerId) return;

    const vault = $activeRuntimeStore;
    const activeSignerIndex = Number(vault?.activeSignerIndex ?? 0);
    const activeSigner =
      vault?.signers?.[activeSignerIndex]
      || vault?.signers?.[0]
      || null;
    const fallbackEntityId = String(activeSigner?.entityId || '').trim().toLowerCase();
    const fallbackSignerId = String(activeSigner?.address || '').trim().toLowerCase();
    if (!fallbackEntityId || !fallbackSignerId) return;

    // Runtime restore can hydrate signer metadata before env-derived replica selection catches up.
    // Seeding the visible entity from signer metadata avoids booting into an empty shell after
    // device wipe + watchtower restore while still converging to the same replica once env sync finishes.
    viewMode = 'entity';
    selectedEntityId = fallbackEntityId;
    selectedSignerId = fallbackSignerId;
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

	  const selectedReplicaJurisdiction = $derived.by(() => String(
	    selectedReplica?.state?.config?.jurisdiction?.name
	      || selectedReplica?.position?.jurisdiction
	      || selectedJurisdictionName
	      || '',
	  ).trim());

  function listJMachineNames(env: RuntimeFrame | null | undefined): string[] {
    const jReplicas = env?.jReplicas;
    if (!jReplicas) return [];
    return Array.from(jReplicas.keys());
  }

  function resolveJMachineName(names: string[], candidate: string | null | undefined): string | null {
    const normalized = String(candidate || '').trim().toLowerCase();
    if (!normalized) return null;
    return names.find((name) => name.trim().toLowerCase() === normalized) || null;
  }

  function getReplicaJurisdiction(replica: EntityReplica | null | undefined): string {
    return String(replica?.state?.config?.jurisdiction?.name || '').trim().toLowerCase();
  }

  function findReplicaBySigner(
    env: RuntimeFrame | null | undefined,
    signerId: string,
    jurisdictionName?: string | null,
  ): EntityReplica | null {
    const reps = env?.eReplicas;
    if (!reps) return null;
    const replicas = reps instanceof Map ? reps : new Map<string, EntityReplica>(Object.entries(reps || {}) as Array<[string, EntityReplica]>);
    const signerLower = signerId.toLowerCase();
    const jurisdictionLower = String(jurisdictionName || '').trim().toLowerCase();
    for (const [key, replica] of replicas) {
      const [, signerFromKey] = String(key).split(':');
      const replicaSigner = String(replica?.signerId || signerFromKey || '').toLowerCase();
      if (replicaSigner === signerLower && (!jurisdictionLower || getReplicaJurisdiction(replica) === jurisdictionLower)) {
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
            blockTimeMs: 1_000,
          }
        }],
        entityInputs: []
      });

      publishIsolatedEnv(env);
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
    const vault = get(activeRuntimeStore);

    if (!env || !vault?.signers?.length) return;

    const names = listJMachineNames(env);

    // VaultStore imports the default jurisdiction set; user-created jurisdictions stay explicit.
    if (names.length === 0) {
      console.warn('[ensureSelfEntities] No J-machines - VaultStore should import default jurisdictions');
      return; // Don't auto-create xlnomy1
    }

    const selectedSignerLower = String(selectedSignerId || '').trim().toLowerCase();
    const activeSignerIndex = Number(vault.activeSignerIndex ?? 0);
    const selectedJurisdictionKey = String(selectedJurisdictionName || '').trim().toLowerCase();
    const jurisdictionSigner = selectedJurisdictionKey
      ? vault.signers.find((entry) => String(entry?.jurisdiction || '').trim().toLowerCase() === selectedJurisdictionKey)
      : null;
    const targetSigners = selectedSignerLower
      ? vault.signers.filter((entry) => String(entry.address || '').trim().toLowerCase() === selectedSignerLower)
      : [jurisdictionSigner || vault.signers[activeSignerIndex] || vault.signers[0]].filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      );

    for (const signerEntry of targetSigners) {
      if (runEpoch !== ensureSelfEntitiesEpoch) return;
      const signerAddress = signerEntry.address;
      const selectedJurisdiction = resolveJMachineName(names, selectedJurisdictionName);
      const signerJurisdiction = resolveJMachineName(names, signerEntry.jurisdiction);
      const activeJurisdiction = resolveJMachineName(names, env.activeJurisdiction);
      const jurisdiction = signerJurisdiction || selectedJurisdiction || names[0] || activeJurisdiction;

      if (!signerAddress || !jurisdiction) continue;
      const selfEntityKey = `${signerAddress.toLowerCase()}:${jurisdiction}`;
      if (selfEntityChecked.has(selfEntityKey) || selfEntityInFlight.has(selfEntityKey)) continue;

      const existing = findReplicaBySigner(env, signerAddress, jurisdiction);
      if (existing) {
        if (!signerEntry.entityId && existing.entityId) {
          vaultOperations.setSignerEntity(signerEntry.index, existing.entityId);
        }
        selfEntityChecked.add(selfEntityKey);

        // Auto-select first entity if none selected
        if (!selectedEntityId && existing.entityId) {
          viewMode = 'entity';
          selectedEntityId = existing.entityId;
          selectedSignerId = signerAddress;
        }
        continue;
      }

      selfEntityInFlight.add(selfEntityKey);
      try {
        // Re-check right before creation to avoid duplicate create on reactive races.
        const alreadyNow = findReplicaBySigner(env, signerAddress, jurisdiction);
        if (alreadyNow?.entityId) {
          if (!signerEntry.entityId) {
            vaultOperations.setSignerEntity(signerEntry.index, alreadyNow.entityId);
          }
          selfEntityChecked.add(selfEntityKey);
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
          const canonical = findReplicaBySigner(env, signerAddress, jurisdiction);
          const finalEntityId = canonical?.entityId || entityId;
          vaultOperations.setSignerEntity(signerEntry.index, finalEntityId);
          publishIsolatedEnv(env);
          selfEntityChecked.add(selfEntityKey);

          // Auto-select entity after creation
          viewMode = 'entity';
          selectedEntityId = finalEntityId;
          selectedSignerId = signerAddress;
        } else {
          console.error('[ensureSelfEntities] ❌ NULL entityId for signer:', signerAddress.slice(0, 10));
        }
      } catch (err) {
        console.error('[ensureSelfEntities] ❌ ERROR:', err);
      } finally {
        selfEntityInFlight.delete(selfEntityKey);
      }
    }
  }

  // Trigger entity creation when env becomes available OR vault changes
  $effect(() => {
    if (!isRemoteRuntime && !!$isolatedEnv && !!$activeRuntimeStore) {
      void ensureSelfEntities();
    }
  });

  const signerNetworkEnabled = $derived.by(() => {
    const jurisdictionName =
      selectedReplica?.state?.config?.jurisdiction?.name
      || selectedJurisdictionName
      || null;
    if (!jurisdictionName || !currentFrame?.jReplicas) return false;
    const replicas: JurisdictionEntry[] = Array.from(currentFrame.jReplicas.values());
    const match = replicas.find((replica) => replica?.name === jurisdictionName);
    return Array.isArray(match?.rpcs) && match.rpcs.some((rpc: string) => !rpc.startsWith('browservm://'));
  });

  const hasSigner = $derived(isRemoteRuntime || !!signer?.address);
  const onboardingRequiredForRuntime = $derived(!isRemoteRuntime && $activeRuntimeStore?.requiresOnboarding !== false);
  const showVaultGate = $derived(!isRemoteRuntime && !hasSigner);
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
	    title: (selectedEntityId || signer?.entityId) ? `Entity ${selectedEntityId || signer?.entityId}` : 'Entity',
	    entityId: selectedEntityId || String(signer?.entityId || '').trim().toLowerCase(),
	    signerId: selectedSignerId || String(signer?.address || '').trim().toLowerCase(),
	    jurisdiction: selectedReplicaJurisdiction || selectedJurisdictionName || 'browservm',
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
    if (isRemoteRuntime) {
      setRuntimeAdapterActiveEntityId(entityId);
      void refreshRuntimeAdapterEnvironment();
    }
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
    const runtime = get(allRuntimes).find(v => v.id === runtimeId);
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

    // If last runtime, open creation screen
    if (isLast) {
      vaultUiOperations.requestDeriveNewVault();
    }
  }

  function handleAddJurisdiction() {
    activeInlinePanel = 'add-jmachine';
  }

  async function handleJMachineCreate(event: CustomEvent<JMachineCreateDetail>) {
    const { name, mode, chainId, rpcs, blockTimeMs, ticker, contracts } = event.detail;
    const env = get(isolatedEnv);
    if (!env) return;

    isCreatingJMachine = true;
    try {
      const xln = await getXLN();
      await enqueueAndProcess(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: { name, chainId, ticker, rpcs, blockTimeMs, ...(contracts ? { contracts } : {}) }
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
	        blockTimeMs,
	        ...(contracts ? { contracts } : {}),
        createdAt: Date.now(),
      });

      publishIsolatedEnv(env);
      selectedJurisdictionName = name;
      const signerForJurisdiction = vaultOperations.addSigner(`${name} signer`, name);
      if (signerForJurisdiction?.address) {
        vaultOperations.selectSigner(signerForJurisdiction.index);
        selectedSignerId = signerForJurisdiction.address;
        selectedEntityId = null;
      }
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

  function handleGoToLiveOverride(): void {
    isolatedTimeIndex.set(-1);
    isolatedIsLive.set(true);
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
{:else if viewMode === 'entity' && currentFrame}
  <EntityPanelTabs
    tab={entityTab}
    userModeHeader={true}
    showJurisdiction={false}
    selectedJurisdiction={selectedJurisdictionName}
    allowHeaderAddRuntime={true}
    allowHeaderDeleteRuntime={true}
    headerRuntimeAddLabel="+ Add Runtime"
    env={currentFrame}
    envRevision={currentFrameRevision}
    history={$isolatedHistory}
    timeIndex={$isolatedTimeIndex}
    isLive={$isolatedIsLive}
    onGoToLive={handleGoToLiveOverride}
    on:signerSelect={handleSignerSelect}
    on:addSigner={handleAddSigner}
    on:entitySelect={handleEntitySelect}
    on:jurisdictionSelect={handleJurisdictionSelect}
    on:addJurisdiction={handleAddJurisdiction}
    on:addEntity={handleAddEntity}
    on:addRuntime={handleAddRuntime}
    on:deleteRuntime={handleRemoveRuntime}
  />
{:else if viewMode === 'entity'}
  <main class="panel-content"></main>
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
