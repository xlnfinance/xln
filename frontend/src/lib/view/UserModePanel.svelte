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
  import { activeRuntime as activeRuntimeStore, vaultOperations } from '$lib/stores/vaultStore';
  import { errorLog } from '$lib/stores/errorLogStore';
  import { settings } from '$lib/stores/settingsStore';
  import {
    entityPositions,
    xlnFunctions,
    xlnInstance,
    refreshCurrentRuntimeProjection,
  } from '$lib/stores/xlnStore';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeView, setRuntimeViewActiveEntityId } from '$lib/stores/runtimeViewStore';
  import { runtimes, activeRuntimeId, runtimeOperations } from '$lib/stores/runtimeStore';
  import { showVaultPanel, vaultUiOperations } from '$lib/stores/vaultUiStore';
  import type { Tab } from '$lib/types/ui';
  import type { Env } from '@xln/runtime/xln-api';
  import type { EnvSnapshot, EntityReplica } from '$types';
  import {
    readAnyOnboardingComplete,
    readOnboardingComplete,
    writeOnboardingCompleteForEntities,
  } from '$lib/utils/onboardingState';
  import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
  import { panelBridge } from './utils/panelBridge';

  import EntityWorkspace from '$lib/components/Entity/EntityWorkspace.svelte';
  import { runtimeProjectionMatchesRuntime } from '$lib/components/Entity/entity-workspace';
  import type { EntityWorkspaceRuntimeFrameContext } from '$lib/components/Entity/runtime-frame-context';
  import type { EntityWorkspaceEmbeddedRuntimeContext } from '$lib/components/Entity/embedded-runtime-context';
  import OnboardingPanel from '$lib/components/Entity/OnboardingPanel.svelte';
  import RuntimeCreation from '$lib/components/Views/RuntimeCreation.svelte';
  import JurisdictionPanel from './panels/JurisdictionPanel.svelte';
  import FormationPanel from '$lib/components/Entity/FormationPanel.svelte';
  import AddJMachine from '$lib/components/Jurisdiction/AddJMachine.svelte';
  import {
    importJMachineViaRuntime,
    type JMachineCreateDetail,
  } from '$lib/components/Jurisdiction/import-jmachine-runtime';
  import TimeMachine from './core/TimeMachine.svelte';
  import {
    type OnboardingHubCandidate,
    type OnboardingRuntimeProjection,
    type OnboardingRuntimeTarget,
  } from '$lib/components/Entity/onboarding-runtime-input';
  import {
    type FormationRuntimeProjection,
  } from '$lib/components/Entity/formation-runtime-projection';
  import { hubDiscoveryJurisdictionKey } from '$lib/components/Entity/hub-discovery-profile';

  type RuntimeFrame = Env | EnvSnapshot;
  type JurisdictionLike = { name: string };
  type JurisdictionEntry = { name?: string; rpcs?: string[] };
  interface Props {
    runtimeFrameEnv: Writable<Env | null>;
    runtimeFrameRevision?: Writable<number>;
    runtimeFrameHistory?: Writable<EnvSnapshot[]>;
    runtimeFrameTimeIndex?: Writable<number>;
    runtimeFrameIsLive?: Writable<boolean>;
    liveEnvResolver?: () => Env | null;
    dockMode?: boolean;
  }

  let {
    runtimeFrameEnv,
    runtimeFrameRevision = writable(0),
    runtimeFrameHistory = writable([]),
    runtimeFrameTimeIndex = writable(-1),
    runtimeFrameIsLive = writable(true),
    liveEnvResolver = () => null,
    dockMode = false,
  }: Props = $props();

  function publishRuntimeFrameEnv(env: Env | null) {
    const runtimeEnv = env ? (unwrapLiveRuntimeEnv(env) ?? env) : null;
    runtimeFrameEnv.set(runtimeEnv ? createRuntimeViewEnv(runtimeEnv) : null);
    if (runtimeEnv) runtimeOperations.updateLocalEnv(runtimeEnv);
    runtimeFrameRevision.update((revision) => revision + 1);
  }

  const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

  function logUserModeDiagnostic(message: string, details?: unknown): void {
    errorLog.log(message, 'User Mode', details);
  }

  function isLiveRuntimeFrame(frame: RuntimeFrame): frame is Env {
    return unwrapLiveRuntimeEnv(frame) !== null;
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

  function runtimeFrameFingerprint(frame: RuntimeFrame | null | undefined): string {
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
    if (!dockMode) {
      runtimeFrameTimeIndex.set(-1);
      runtimeFrameIsLive.set(true);
    }
    if (get(runtimeControllerHandle).mode !== 'remote') {
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
  let isCreatingJMachine = $state(false);
  let jMachineCreateError = $state('');
  // Inline panels - NO POPUPS! All panels are inline for desktop/mobile
  type InlinePanel = 'none' | 'formation' | 'add-jmachine';
  let activeInlinePanel = $state<InlinePanel>('none');
  let onboardingComplete = $state(false);

  let selectedInitialAction = $state<import('$lib/view/utils/panelBridge').EntityOpenAction | undefined>(undefined);
  let workspaceActionRevision = $state(0);

  onMount(() => panelBridge.on('dock:selectEntity', ({ entityId, signerId, action }) => {
    const nextEntityId = normalizeId(entityId);
    const nextSignerId = normalizeId(signerId);
    if (!dockMode || !nextEntityId) return;
    viewMode = 'entity';
    activeInlinePanel = 'none';
    selectedEntityId = nextEntityId;
    selectedSignerId = nextSignerId || null;
    selectedAccountId = null;
    selectedJurisdictionName = null;
    selectedInitialAction = action;
    workspaceActionRevision += 1;
    setRuntimeViewActiveEntityId(nextEntityId);
    if ($runtimeControllerHandle.mode === 'remote') void refreshCurrentRuntimeProjection();
  }));

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
  const isRemoteRuntime = $derived(activeRuntime?.type === 'remote' || $runtimeControllerHandle.mode === 'remote');
  const currentLiveRuntimeEnv = $derived.by(() => {
    void $runtimeFrameRevision;
    void $runtimeControllerHandle.height;
    if (isRemoteRuntime) return null;
    const live = liveEnvResolver?.() ?? null;
    return live ? (unwrapLiveRuntimeEnv(live) ?? live) : null;
  });
  let lastRuntimeId: string | null = null;
  let lastVaultId: string | null = null;

  // Reset selections when switching runtimes
  $effect(() => {
    if (!activeRuntime) return;
    if (lastRuntimeId && lastRuntimeId !== activeRuntime.id) {
      runtimeFrameTimeIndex.set(-1);
      runtimeFrameIsLive.set(true);
      selectedEntityId = null;
      selectedSignerId = null;
      selectedAccountId = null;
      selectedJurisdictionName = null;
      isCreatingJMachine = false;
      jMachineCreateError = '';
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
      isCreatingJMachine = false;
      jMachineCreateError = '';
    }
    lastVaultId = currentVaultId;
  });

  // Current frame follows isolated time controls, but user mode should boot LIVE by default.
  const currentFrame: RuntimeFrame | null = $derived.by((): RuntimeFrame | null => {
    const isLive = $runtimeFrameIsLive;
    const timeIdx = $runtimeFrameTimeIndex;
    const hist = $runtimeFrameHistory;
    const env = $runtimeFrameEnv;
    const revision = $runtimeFrameRevision;
    const liveRuntimeEnv = currentLiveRuntimeEnv;
    void revision;

    if (!isLive && timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return cloneRuntimeFrame(hist[idx] ?? null);
    }
    // Publish a fresh frame object for Svelte on every runtime revision, while
    // retaining a hidden live-env handle for runtime actions.
    const frame = !isRemoteRuntime && liveRuntimeEnv ? createRuntimeViewEnv(liveRuntimeEnv) : env;
    return cloneRuntimeFrame(frame);
  });
  const currentFrameRevision = $derived.by(() => `${$runtimeFrameRevision}:${runtimeFrameFingerprint(currentFrame)}`);

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

  function findReplicaByEntityInFrame(frame: RuntimeFrame | null | undefined, entityId: string): EntityReplica | null {
    const normalized = String(entityId || '').trim().toLowerCase();
    const replicas = frame?.eReplicas;
    if (!normalized || !replicas) return null;
    for (const replica of replicas.values()) {
      if (String(replica?.entityId || '').trim().toLowerCase() === normalized && replica?.signerId) {
        return replica;
      }
    }
    return null;
  }

  function firstReplicaWithRelationshipsInFrame(frame: RuntimeFrame | null | undefined): EntityReplica | null {
    const replicas = frame?.eReplicas;
    if (!replicas) return null;
    let best: { replica: EntityReplica; score: number } | null = null;
    for (const replica of replicas.values()) {
      if (!replica?.entityId || !replica?.signerId) continue;
      const accountCount = Number(replica.state?.accounts?.size || 0);
      const bookCount = Number(replica.state?.orderbookExt?.books?.size || 0);
      const score = accountCount * 1_000_000 + bookCount * 1_000 + Number(replica.state?.height || 0);
      if (!best || score > best.score) best = { replica, score };
    }
    return best?.replica ?? null;
  }

  $effect(() => {
    if (!isRemoteRuntime) return;
    if (!runtimeProjectionMatchesRuntime($runtimeView.runtimeId, $activeRuntimeId)) return;
    const frame = $runtimeView.frame;
    const active = frame?.activeEntity ?? null;
    const entityId = normalizeId($runtimeView.activeEntityId || frame?.activeEntityId || active?.summary?.entityId || active?.core?.entityId);
    const signerId = normalizeId(active?.core?.signerId || selectedSignerId);
    if (!entityId) return;
    if (selectedEntityId === entityId && (!signerId || selectedSignerId === signerId)) return;
    viewMode = 'entity';
    selectedEntityId = entityId;
    selectedSignerId = signerId || null;
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

  function normalizeProjectionId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  function replicaProjectionEntityId(key: unknown, replica: EntityReplica | null | undefined): string {
    const [keyEntityId] = String(key || '').split(':');
    return normalizeProjectionId(replica?.entityId || replica?.state?.entityId || keyEntityId);
  }

  function replicaProjectionSignerId(key: unknown, replica: EntityReplica | null | undefined): string {
    const [, keySignerId] = String(key || '').split(':');
    return normalizeProjectionId(replica?.signerId || keySignerId);
  }

  function replicaProjectionJurisdictionName(replica: EntityReplica | null | undefined): string {
    return String(
      replica?.state?.config?.jurisdiction?.name
        || replica?.position?.jurisdiction
        || replica?.position?.xlnomy
        || '',
    ).trim();
  }

  function replicaProjectionJurisdictionKey(replica: EntityReplica | null | undefined): string {
    return hubDiscoveryJurisdictionKey(replica?.state?.config?.jurisdiction)
      || hubDiscoveryJurisdictionKey(replica?.position?.jurisdiction);
  }

  function frameReplicas(frame: RuntimeFrame | null | undefined): Map<string, EntityReplica> {
    const replicas = frame?.eReplicas;
    return replicas instanceof Map
      ? replicas as Map<string, EntityReplica>
      : new Map<string, EntityReplica>();
  }

  function accountProjectionCounterpartyId(ownerEntityId: string, key: unknown, account: unknown): string {
    const record = account as { leftEntity?: unknown; rightEntity?: unknown } | null | undefined;
    const owner = normalizeProjectionId(ownerEntityId);
    const left = normalizeProjectionId(record?.leftEntity);
    const right = normalizeProjectionId(record?.rightEntity);
    if (left === owner && right) return right;
    if (right === owner && left) return left;
    return normalizeProjectionId(key);
  }

  function collectProjectionCounterparties(ownerEntityId: string, replica: EntityReplica | null | undefined): string[] {
    const accounts = replica?.state?.accounts;
    if (!(accounts instanceof Map)) return [];
    const ids = new Set<string>();
    for (const [key, account] of accounts.entries()) {
      const counterpartyId = accountProjectionCounterpartyId(ownerEntityId, key, account);
      if (counterpartyId && counterpartyId !== ownerEntityId) ids.add(counterpartyId);
    }
    return Array.from(ids);
  }

  const formationRuntimeProjection = $derived.by((): FormationRuntimeProjection => {
    const jurisdictions = Array.from(currentFrame?.jReplicas?.values?.() || []).map((replica) => ({
      name: String(replica?.name || ''),
      address: String(replica?.depositoryAddress || ''),
      entityProviderAddress: String(replica?.entityProviderAddress || ''),
      depositoryAddress: String(replica?.depositoryAddress || ''),
      ...(typeof replica?.chainId === 'number' ? { chainId: replica.chainId } : {}),
    }));
    const existingEntityIds = new Set<string>();
    for (const [key, replica] of frameReplicas(currentFrame).entries()) {
      const entityId = replicaProjectionEntityId(key, replica);
      if (entityId) existingEntityIds.add(entityId);
    }
    return {
      jurisdictions,
      existingEntityIds: Array.from(existingEntityIds),
    };
  });

  const onboardingRuntimeProjection = $derived.by((): OnboardingRuntimeProjection => {
    const replicas = frameReplicas(currentFrame);
    const targets: OnboardingRuntimeTarget[] = [];
    const targetKeys = new Set<string>();
    const accountCounterpartiesByEntityId: Record<string, string[]> = {};
    const addTarget = (
      rawEntityId: unknown,
      rawSignerId: unknown,
      rawJurisdiction: unknown = '',
      rawJurisdictionKey: unknown = '',
    ): void => {
      const entityId = normalizeProjectionId(rawEntityId);
      const signerId = normalizeProjectionId(rawSignerId);
      if (!entityId || !signerId) return;
      const key = `${entityId}:${signerId}`;
      if (targetKeys.has(key)) return;
      targetKeys.add(key);
      const jurisdiction = String(rawJurisdiction || '').trim();
      const jurisdictionKey = String(rawJurisdictionKey || '').trim();
      targets.push({
        entityId,
        signerId,
        ...(jurisdiction ? { jurisdiction } : {}),
        ...(jurisdictionKey ? { jurisdictionKey } : {}),
      });
    };

    for (const [key, replica] of replicas.entries()) {
      const entityId = replicaProjectionEntityId(key, replica);
      const signerId = replicaProjectionSignerId(key, replica);
      if (!entityId) continue;
      accountCounterpartiesByEntityId[entityId] = collectProjectionCounterparties(entityId, replica);
      addTarget(entityId, signerId, replicaProjectionJurisdictionName(replica), replicaProjectionJurisdictionKey(replica));
    }

    addTarget(
      selectedEntityId,
      selectedSignerId,
      selectedReplicaJurisdiction,
      replicaProjectionJurisdictionKey(selectedReplica),
    );

    for (const runtimeSigner of $activeRuntimeStore?.signers || []) {
      const signerEntityId = normalizeProjectionId(runtimeSigner.entityId);
      const signerAddress = normalizeProjectionId(runtimeSigner.address);
      const matchingReplica = signerEntityId
        ? findReplicaByEntityInFrame(currentFrame, signerEntityId)
        : signerAddress
          ? findReplicaBySigner(currentFrame, signerAddress, runtimeSigner.jurisdiction)
          : null;
      addTarget(
        signerEntityId || matchingReplica?.entityId,
        signerAddress || matchingReplica?.signerId,
        runtimeSigner.jurisdiction || replicaProjectionJurisdictionName(matchingReplica),
        replicaProjectionJurisdictionKey(matchingReplica),
      );
    }

    const hubCandidates: OnboardingHubCandidate[] = [];
    const hubIds = new Set<string>();
    for (const [key, replica] of replicas.entries()) {
      const state = replica?.state;
      if (state?.profile?.isHub !== true) continue;
      const entityId = replicaProjectionEntityId(key, replica);
      if (!entityId || hubIds.has(entityId)) continue;
      hubIds.add(entityId);
      hubCandidates.push({
        entityId,
        isHub: true,
        jurisdiction: replicaProjectionJurisdictionName(replica),
        jurisdictionKey: replicaProjectionJurisdictionKey(replica),
        runtimeId: String(currentFrame?.runtimeId || ''),
      });
    }

    return {
      targets,
      suggestedDisplayName: String(selectedReplica?.state?.profile?.name || ''),
      activeJurisdictionName: getFrameActiveJurisdiction(currentFrame) || selectedReplicaJurisdiction,
      hubCandidates,
      accountCounterpartiesByEntityId,
    };
  });

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
  const activeVaultLocked = $derived(
    !isRemoteRuntime
    && Boolean($activeRuntimeStore?.protectedSecrets)
    && !$activeRuntimeStore?.seed,
  );
  const onboardingRequiredForRuntime = $derived(!isRemoteRuntime && $activeRuntimeStore?.requiresOnboarding !== false);
  const showVaultGate = $derived(!isRemoteRuntime && (!hasSigner || activeVaultLocked));
  const showVaultPanelVisible = $derived(showVaultGate || $showVaultPanel);
  const remoteWorkspaceAvailable = $derived(
    isRemoteRuntime && $runtimeControllerHandle.status === 'connected',
  );
  const workspaceEnv = $derived.by<RuntimeFrame | null>(() =>
    isRemoteRuntime ? null : currentFrame,
  );
  const workspaceLiveEnv = $derived.by<Env | null>(() =>
    isRemoteRuntime ? null : (currentLiveRuntimeEnv ?? $runtimeFrameEnv),
  );

  function resolveWorkspaceLiveEnv(): Env | null {
    return isRemoteRuntime ? null : (currentLiveRuntimeEnv ?? $runtimeFrameEnv);
  }

  const workspaceRuntimeFrameContext = $derived.by<EntityWorkspaceRuntimeFrameContext>(() => ({
    envRevision: currentFrameRevision,
    timeIndex: $runtimeFrameTimeIndex,
    isLive: $runtimeFrameIsLive,
    onGoToLive: handleGoToLiveOverride,
  }));

  const workspaceEmbeddedRuntimeContext = $derived.by<EntityWorkspaceEmbeddedRuntimeContext>(() => ({
    env: workspaceEnv,
    liveEnv: workspaceLiveEnv,
    liveEnvResolver: resolveWorkspaceLiveEnv,
    history: $runtimeFrameHistory,
  }));

  function getRuntimeOnboardingEntityIds(): string[] {
    const ids = new Set<string>();
    const add = (value: string | null | undefined) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized) ids.add(normalized);
    };
    const signerEntityIds = new Set<string>();
    for (const runtimeSigner of $activeRuntimeStore?.signers || []) {
      const normalized = String(runtimeSigner.entityId || '').trim().toLowerCase();
      if (normalized) signerEntityIds.add(normalized);
    }
    const activeSignerEntityId = String(signer?.entityId || '').trim().toLowerCase();
    if (activeSignerEntityId) signerEntityIds.add(activeSignerEntityId);
    if (signerEntityIds.size > 0) {
      for (const entityId of signerEntityIds) add(entityId);
      return [...ids];
    }
    add(selectedEntityId);
    for (const runtimeSigner of $activeRuntimeStore?.signers || []) {
      add(runtimeSigner.entityId);
    }
    return [...ids];
  }

  $effect(() => {
    const entityId = selectedEntityId;
    if (!onboardingRequiredForRuntime) {
      onboardingComplete = true;
      return;
    }
    const runtimeEntityIds = getRuntimeOnboardingEntityIds();
    if (!entityId && runtimeEntityIds.length === 0) {
      onboardingComplete = false;
      return;
    }
    if (readAnyOnboardingComplete(runtimeEntityIds)) {
      // Onboarding is runtime-level: one seed creates all local signer/entity lanes
      // (for example Testnet + Tron). Never show signup again for a sibling lane.
      writeOnboardingCompleteForEntities(runtimeEntityIds, true);
      onboardingComplete = true;
      return;
    }
    onboardingComplete = entityId ? readOnboardingComplete(entityId) : false;
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
      setRuntimeViewActiveEntityId(entityId);
      void refreshCurrentRuntimeProjection();
    }
  }

  // Handle account selection from dropdown
  function handleAccountSelect(event: CustomEvent<{ accountId: string | null }>) {
    selectedAccountId = event.detail.accountId;
  }

  function handleOnboardingComplete() {
    const runtimeEntityIds = getRuntimeOnboardingEntityIds();
    writeOnboardingCompleteForEntities(runtimeEntityIds.length > 0 ? runtimeEntityIds : [selectedEntityId || ''], true);
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
    const newSigner = await vaultOperations.addSigner();
    if (!newSigner) {
      logUserModeDiagnostic('Failed to add signer: no active vault');
    }
  }

  function handleAddJurisdiction() {
    activeInlinePanel = 'add-jmachine';
  }

  async function handleJMachineCreate(event: CustomEvent<JMachineCreateDetail>) {
    const env = get(runtimeFrameEnv);
    if (!env) {
      jMachineCreateError = 'Embedded runtime workspace is not available';
      return;
    }

    isCreatingJMachine = true;
    jMachineCreateError = '';
    try {
      const result = await importJMachineViaRuntime(env, event.detail);
      publishRuntimeFrameEnv(result.env);
      selectedJurisdictionName = result.config.name;
      const signerForJurisdiction = await vaultOperations.addSigner(`${result.config.name} signer`, result.config.name);
      if (signerForJurisdiction?.address) {
        vaultOperations.selectSigner(signerForJurisdiction.index);
        selectedSignerId = signerForJurisdiction.address;
        selectedEntityId = null;
      }
      activeInlinePanel = 'none';
      isCreatingJMachine = false;
    } catch (err) {
      logUserModeDiagnostic('J-Machine import failed', {
        detail: event.detail,
        err,
      });
      jMachineCreateError = err instanceof Error ? err.message : String(err);
      isCreatingJMachine = false;
    }
  }

  function handleAddEntity() {
    activeInlinePanel = 'formation';
  }

  function handleEntityFormationClose() {
    activeInlinePanel = 'none';
  }

  function handleGoToLiveOverride(): void {
    runtimeFrameTimeIndex.set(-1);
    runtimeFrameIsLive.set(true);
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
      <FormationPanel runtimeProjection={formationRuntimeProjection} onCreated={() => { activeInlinePanel = 'none'; }} />
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
        busy={isCreatingJMachine}
        on:create={(event) => void handleJMachineCreate(event)}
        on:cancel={() => activeInlinePanel = 'none'}
      />
      {#if jMachineCreateError}
        <p class="inline-error" data-testid="user-mode-jmachine-error">{jMachineCreateError}</p>
      {/if}
    </div>
  </main>
{:else if showVaultPanelVisible}
  <main class="panel-content">
    <!-- Onboarding Screen 1: derive/import seed and atomically create/select runtime. -->
    <RuntimeCreation embedded={true} />
  </main>
{:else if viewMode === 'entity' && selectedEntityId && selectedSignerId && !onboardingComplete}
  <main class="panel-content">
    <!-- Onboarding Screen 2: configure account only; wallet/seed state already exists. -->
    <OnboardingPanel
      entityId={selectedEntityId}
      signerId={selectedSignerId}
      runtimeProjection={onboardingRuntimeProjection}
      on:complete={handleOnboardingComplete}
    />
  </main>
{:else if viewMode === 'entity' && (currentFrame || remoteWorkspaceAvailable)}
  {#key `${selectedEntityId || ''}:${workspaceActionRevision}`}
  <EntityWorkspace
    tab={entityTab}
    userModeHeader={true}
    showJurisdiction={false}
    selectedJurisdiction={selectedJurisdictionName}
    allowHeaderAddRuntime={true}
    headerRuntimeAddLabel="+ Add Runtime"
    initialAction={selectedInitialAction}
    runtimeFrameContext={workspaceRuntimeFrameContext}
    embeddedRuntimeContext={workspaceEmbeddedRuntimeContext}
    on:signerSelect={handleSignerSelect}
    on:addSigner={handleAddSigner}
    on:entitySelect={handleEntitySelect}
    on:jurisdictionSelect={handleJurisdictionSelect}
    on:addJurisdiction={handleAddJurisdiction}
    on:addEntity={handleAddEntity}
    on:addRuntime={handleAddRuntime}
  />
  {/key}
{:else if viewMode === 'entity'}
  <main class="panel-content"></main>
{:else if viewMode === 'jurisdiction'}
  <main class="panel-content">
    <JurisdictionPanel
      {runtimeFrameEnv}
      {runtimeFrameHistory}
      {runtimeFrameTimeIndex}
    />
  </main>
{/if}

{#if $settings.showTimeMachine && !dockMode}
  <TimeMachine
    history={runtimeFrameHistory}
    timeIndex={runtimeFrameTimeIndex}
    isLive={runtimeFrameIsLive}
    env={runtimeFrameEnv}
  />
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

  .inline-error {
    margin: 10px 16px 0;
    color: #fb7185;
    font-size: 13px;
    font-weight: 700;
  }

  @media (max-width: 768px) {
    .panel-content :global(.header.user-mode-header) {
      position: static;
    }
  }
</style>
