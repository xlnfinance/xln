<!--
  OnboardingPanel.svelte

  Screen 2 of onboarding: runtime/seed already exists, only account configuration
  belongs here. Do not derive, rehydrate, or create wallet state in this component.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { resolveConfiguredApiBase, submitRuntimeInput, xlnFunctions } from '../../stores/xlnStore';
  import {
    activeRuntime,
    buildRuntimeRecoveryConfigForMode,
    parseRuntimeRecoveryCandidateFile,
    vaultOperations,
    type RecoveryTowerConfig,
    type RecoveryTowerSetupMode,
  } from '../../stores/vaultStore';
  import { entityAvatar } from '../../utils/avatar';
  import {
    type HubJoinPreference,
    hydrateJurisdictionPolicyDefaults,
    readHubJoinPreference,
    readSavedCollateralPolicy,
    writeHubJoinPreference,
    writeSavedCollateralPolicy,
    getOpenAccountRebalancePolicyData,
  } from '../../utils/onboardingPreferences';
  import {
    readOnboardingComplete,
    writeOnboardingCompleteForEntities,
  } from '../../utils/onboardingState';
  import { normalizeEntityId } from '../../utils/entityReplica';
  import {
    getManualRecoveryTowers,
    isOfficialRecoveryTower,
    normalizeRecoveryDraft,
    normalizeRecoveryUrl,
    normalizeTowerMode,
    resolveOfficialRecoveryTowerUrl,
    type RecoveryServiceMode,
  } from '../../utils/recoverySettings';
  import {
    clearRuntimeRecoveryDiscoveryStatus,
    formatRuntimeRecoveryDiscoveryFailure,
    readRuntimeRecoveryDiscoveryStatus,
    type RuntimeRecoveryDiscoveryStatus,
  } from '../../utils/recoveryDiscoveryStatus';
  import {
    assertCommittedAutoJoinCount,
    buildOnboardingHubOpenRuntimeInput,
    buildOnboardingProfileRuntimeInput,
    emptyOnboardingRuntimeProjection,
    selectAdvertisedAutoJoinCandidates,
    type OnboardingHubCandidate,
    type OnboardingRuntimeTarget,
    type OnboardingRuntimeProjection,
  } from './onboarding-runtime-input';
  import { hubDiscoveryJurisdictionKey } from './hub-discovery-profile';

  export let entityId: string = '';
  export let signerId: string = '';
  export let runtimeProjection: OnboardingRuntimeProjection = emptyOnboardingRuntimeProjection();

  const dispatch = createEventDispatcher();

  let termsAccepted = true;
  let displayName = '';
  let softLimitUsd = 500;
  let hardLimitUsd = 10_000;
  let maxFeeUsd = 15;
  let defaultSoftLimitUsd = 500;
  let defaultHardLimitUsd = 10_000;
  let defaultMaxFeeUsd = 15;
  let autoJoinHubs: HubJoinPreference = '1';
  let submitting = false;
  let error = '';
  let policyDefaultsNotice = '';
  let hasPersistedPolicy = false;
  let avatar = '';
  let revealBrainVaultSeed = false;
  let copiedBrainVaultField = '';
  let recoveryMode: RecoveryTowerSetupMode = 'official';
  let recoveryTowerDraft: RecoveryTowerConfig[] = [];
  let recoveryDraftLoadedFor = '';
  let recoveryManualUrl = '';
  let recoveryManualKind: RecoveryServiceMode = 'blind_backup';
  let recoveryMessage = '';
  let recoveryMessageTone: 'neutral' | 'error' = 'neutral';
  let recoveryDiscoveryStatus: RuntimeRecoveryDiscoveryStatus | null = null;
  let recoveryDiscoveryLoadedFor = '';
  let recoveryDiscoveryFailureLabels: string[] = [];
  let recoveryBackupFileInput: HTMLInputElement | null = null;
  let recoveryUploadMessage = '';
  let recoveryUploadTone: 'neutral' | 'error' = 'neutral';
  let recoveryUploadBusy = false;
  let selectedJurisdictions: Record<string, boolean> = {};
  let jurisdictionSelectionLoadedFor = '';

  const HUB_JOIN_OPTIONS: Array<{ value: HubJoinPreference; label: string }> = [
    { value: 'manual', label: 'Join hubs manually' },
    { value: '1', label: 'Auto-join 1 hub' },
    { value: '2', label: 'Auto-join 2 hubs' },
    { value: '3', label: 'Auto-join 3 hubs' },
  ];

  const HUB_JOIN_STORAGE_KEY = 'xln-hub-join-preference';

  const toUsdInt = (value: number, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.floor(parsed));
  };

  const parseJoinCount = (pref: HubJoinPreference): number =>
    pref === 'manual' ? 0 : Number(pref);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  type PublicHubResponse = {
    ok: boolean;
    hubs?: Array<{
      entityId?: string;
      metadata?: {
        isHub?: boolean;
        jurisdiction?: { name?: string; chainId?: number | string; depositoryAddress?: string };
      };
    }>;
  };

  type OnboardingTarget = OnboardingRuntimeTarget & { jurisdiction: string };

  function getRuntimeOnboardingTargets(): OnboardingTarget[] {
    const targets: OnboardingTarget[] = [];
    const seen = new Set<string>();
    const add = (
      rawEntityId: unknown,
      rawSignerId: unknown,
      rawJurisdiction: unknown = '',
      rawJurisdictionKey: unknown = '',
    ) => {
      const nextEntityId = normalizeEntityId(String(rawEntityId || ''));
      const nextSignerId = String(rawSignerId || '').trim().toLowerCase();
      if (!nextEntityId || !nextSignerId) return;
      const key = `${nextEntityId}:${nextSignerId}`;
      if (seen.has(key)) return;
      const runtimeSigner = ($activeRuntime?.signers || []).find((signer) =>
        normalizeEntityId(signer.entityId || '') === nextEntityId
        || String(signer.address || '').trim().toLowerCase() === nextSignerId
      );
      const jurisdiction = String(rawJurisdiction || runtimeSigner?.jurisdiction || 'Primary').trim() || 'Primary';
      const jurisdictionKey = String(rawJurisdictionKey || '').trim();
      const target = { entityId: nextEntityId, signerId: nextSignerId, jurisdiction, ...(jurisdictionKey ? { jurisdictionKey } : {}) };
      seen.add(key);
      targets.push(target);
    };

    for (const target of runtimeProjection.targets || []) {
      add(target.entityId, target.signerId, target.jurisdiction, target.jurisdictionKey);
    }
    add(entityId, signerId);
    for (const runtimeSigner of $activeRuntime?.signers || []) {
      add(runtimeSigner.entityId, runtimeSigner.address, runtimeSigner.jurisdiction);
    }
    return targets;
  }

  function hasAnyCounterpartyAccount(targetEntityId: string): boolean {
    const normalizedEntityId = normalizeEntityId(targetEntityId);
    if (!normalizedEntityId) return false;
    return (runtimeProjection.accountCounterpartiesByEntityId[normalizedEntityId] || []).length > 0;
  }

  const hasSavedHubJoinPreference = (): boolean =>
    typeof localStorage !== 'undefined' && localStorage.getItem(HUB_JOIN_STORAGE_KEY) !== null;

  const getRuntimeSuggestedName = (): string => {
    const projectedName = String(runtimeProjection.suggestedDisplayName || '').trim();
    if (projectedName) return projectedName;
    const vaultLabel = String($activeRuntime?.label || '').trim();
    if (vaultLabel) return vaultLabel;
    if (typeof localStorage !== 'undefined') {
      const savedName = String(localStorage.getItem('xln-display-name') || '').trim();
      if (savedName) return savedName;
    }
    return '';
  };

  $: avatar = entityAvatar($xlnFunctions, entityId);
  $: brainVaultSeed = String($activeRuntime?.seed || '').trim();
  $: brainVaultMnemonic12 = String($activeRuntime?.mnemonic12 || '').trim();
  $: brainVaultSigner = $activeRuntime?.signers?.[0] ?? null;
  $: brainVaultSignerAddress = String(brainVaultSigner?.address || '').trim();
  $: brainVaultWordCount = brainVaultSeed ? brainVaultSeed.split(/\s+/).filter(Boolean).length : 0;
  $: brainVaultRuntimeLabel = String($activeRuntime?.label || 'BrainVault').trim();
  $: hasBrainVaultRecovery = Boolean(brainVaultSeed || brainVaultMnemonic12);
  $: recoveryOfficialUrl = resolveOfficialRecoveryTowerUrl();
  $: recoveryRuntimeSyncKey = `${$activeRuntime?.id || 'none'}:${JSON.stringify($activeRuntime?.recovery?.towers || [])}:${$activeRuntime?.recovery?.useDefaultTowers === true}`;
  $: {
    const runtimeId = String($activeRuntime?.id || '').trim().toLowerCase();
    if (recoveryDiscoveryLoadedFor !== runtimeId) {
      recoveryDiscoveryStatus = readRuntimeRecoveryDiscoveryStatus(runtimeId);
      recoveryDiscoveryLoadedFor = runtimeId;
      recoveryUploadMessage = '';
      recoveryUploadTone = 'neutral';
    }
  }
  $: recoveryDiscoveryFailureLabels = (recoveryDiscoveryStatus?.failures || [])
    .map(formatRuntimeRecoveryDiscoveryFailure)
    .slice(-2);
  $: jurisdictionOptions = ($activeRuntime?.signers || [])
    .map((signer, index) => {
      const name = String(signer.jurisdiction || (index === 0 ? 'Primary' : `Jurisdiction ${index + 1}`)).trim();
      const key = name.toLowerCase() || `jurisdiction-${index}`;
      return {
        key,
        name,
        entityId: String(signer.entityId || '').trim(),
        signerId: String(signer.address || '').trim().toLowerCase(),
      };
    })
    .filter((option) => option.entityId && option.signerId);
  $: {
    const key = jurisdictionOptions.map((option) => `${option.key}:${option.entityId}:${option.signerId}`).join('|');
    if (key && jurisdictionSelectionLoadedFor !== key) {
      const next: Record<string, boolean> = {};
      for (const option of jurisdictionOptions) {
        next[option.key] = selectedJurisdictions[option.key] !== false;
      }
      selectedJurisdictions = next;
      jurisdictionSelectionLoadedFor = key;
    }
  }
  $: selectedJurisdictionCount = jurisdictionOptions.filter((option) => selectedJurisdictions[option.key] !== false).length;

  const shortValue = (value: string): string => {
    const text = String(value || '').trim();
    if (text.length <= 18) return text || '-';
    return `${text.slice(0, 10)}...${text.slice(-6)}`;
  };

  async function copyBrainVaultValue(value: string, field: string): Promise<void> {
    const text = String(value || '').trim();
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text);
    copiedBrainVaultField = field;
    setTimeout(() => {
      if (copiedBrainVaultField === field) copiedBrainVaultField = '';
    }, 1200);
  }

  function downloadBrainVaultSheet(): void {
    if (typeof window === 'undefined') return;
    const lines = [
      'XLN BrainVault recovery sheet',
      '',
      `Wallet: ${brainVaultRuntimeLabel || '-'}`,
      `Runtime ID: ${$activeRuntime?.id || '-'}`,
      `Entity ID: ${entityId || '-'}`,
      `Signer: ${brainVaultSignerAddress || '-'}`,
      `Seed words: ${brainVaultWordCount || '-'}`,
      '',
      '24-word recovery phrase:',
      brainVaultSeed || '-',
      '',
      ...(brainVaultMnemonic12 ? ['12-word compatibility phrase:', brainVaultMnemonic12, ''] : []),
      'Store offline. Anyone with these words can control this wallet.',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'xln-brainvault-recovery.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  function inferRecoveryMode(): RecoveryTowerSetupMode {
    const runtime = $activeRuntime;
    const officialUrl = resolveOfficialRecoveryTowerUrl();
    const towers = normalizeRecoveryDraft(runtime?.recovery?.towers);
    const officialTower = towers.find((tower) => isOfficialRecoveryTower(tower, officialUrl));
    if (officialTower) {
      return normalizeTowerMode(officialTower.towerMode) === 'delayed_last_resort'
        ? 'official'
        : 'backup_only';
    }
    if (!officialUrl && towers.length === 0) return 'local_only';
    if (towers.length === 0) return 'official';
    return 'local_only';
  }

  function syncRecoveryDraftFromRuntime(force = false): void {
    const runtime = $activeRuntime;
    const key = `${runtime?.id || 'none'}:${JSON.stringify(runtime?.recovery?.towers || [])}:${runtime?.recovery?.useDefaultTowers === true}`;
    if (!force && recoveryDraftLoadedFor === key) return;
    recoveryMode = inferRecoveryMode();
    recoveryTowerDraft = normalizeRecoveryDraft(runtime?.recovery?.towers);
    recoveryDraftLoadedFor = key;
    recoveryMessage = '';
    recoveryMessageTone = 'neutral';
  }

  function applyRecoveryModeDraft(mode: RecoveryTowerSetupMode): void {
    const officialUrl = resolveOfficialRecoveryTowerUrl();
    if (mode !== 'local_only' && !officialUrl) return;
    recoveryMode = mode;
    const config = buildRuntimeRecoveryConfigForMode(mode, {
      officialTowerUrl: officialUrl,
      manualTowers: getManualRecoveryTowers(recoveryTowerDraft, officialUrl),
      previous: $activeRuntime?.recovery || null,
    });
    recoveryTowerDraft = normalizeRecoveryDraft(config.towers);
    recoveryMessage = '';
    recoveryMessageTone = 'neutral';
  }

  function addManualRecoveryTower(): void {
    recoveryMessage = '';
    recoveryMessageTone = 'neutral';
    try {
      const url = normalizeRecoveryUrl(recoveryManualUrl);
      const nextTower: RecoveryTowerConfig = {
        id: `manual-${recoveryTowerDraft.length + 1}`,
        url,
        towerMode: recoveryManualKind,
        enabled: true,
      };
      recoveryTowerDraft = normalizeRecoveryDraft([
        ...recoveryTowerDraft.filter((tower) => tower.url !== url),
        nextTower,
      ]);
      recoveryManualUrl = '';
    } catch (error) {
      recoveryMessage = error instanceof Error ? error.message : String(error);
      recoveryMessageTone = 'error';
    }
  }

  function updateRecoveryTowerMode(url: string, mode: RecoveryServiceMode): void {
    recoveryTowerDraft = normalizeRecoveryDraft(recoveryTowerDraft.map((tower) =>
      tower.url === url
        ? { ...tower, towerMode: mode }
        : tower
    ));
  }

  function removeRecoveryTower(url: string): void {
    recoveryTowerDraft = recoveryTowerDraft.filter((tower) => tower.url !== url);
  }

  function setJurisdictionEnabled(key: string, enabled: boolean): void {
    selectedJurisdictions = {
      ...selectedJurisdictions,
      [key]: enabled,
    };
  }

  function isTargetJurisdictionEnabled(target: OnboardingTarget): boolean {
    const key = String(target.jurisdiction || '').trim().toLowerCase();
    if (!key) return true;
    return selectedJurisdictions[key] !== false;
  }

  async function saveRecoveryConfig(): Promise<void> {
    const runtime = $activeRuntime;
    if (!runtime?.id) throw new Error('Runtime is required before configuring recovery services');
    const officialUrl = resolveOfficialRecoveryTowerUrl();
    const config = buildRuntimeRecoveryConfigForMode(recoveryMode, {
      officialTowerUrl: officialUrl,
      manualTowers: getManualRecoveryTowers(recoveryTowerDraft, officialUrl),
      previous: runtime.recovery || null,
    });
    const updatedRuntime = await vaultOperations.updateRuntimeRecovery(runtime.id, config);
    recoveryTowerDraft = normalizeRecoveryDraft(updatedRuntime.recovery?.towers);
    recoveryDraftLoadedFor = '';
    syncRecoveryDraftFromRuntime(true);
  }

  function triggerRecoveryBackupFilePicker(): void {
    recoveryBackupFileInput?.click();
  }

  async function handleRecoveryBackupFileSelected(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const runtime = $activeRuntime;
    recoveryUploadMessage = '';
    recoveryUploadTone = 'neutral';
    recoveryUploadBusy = true;
    try {
      if (!runtime?.id || !runtime.seed) throw new Error('Runtime seed is required before restoring a backup file');
      const candidate = await parseRuntimeRecoveryCandidateFile(runtime.seed, await file.text(), {
        sourceLabel: file.name || 'Local backup file',
      });
      await vaultOperations.restoreRuntimeFromRecoveryCandidate(runtime.id, candidate);
      clearRuntimeRecoveryDiscoveryStatus(runtime.id);
      recoveryDiscoveryStatus = null;
      recoveryDiscoveryLoadedFor = String(runtime.id || '').trim().toLowerCase();
      recoveryUploadMessage = 'Runtime restored from uploaded backup.';
      recoveryUploadTone = 'neutral';
    } catch (err) {
      recoveryUploadMessage = err instanceof Error ? err.message : String(err);
      recoveryUploadTone = 'error';
    } finally {
      recoveryUploadBusy = false;
      input.value = '';
    }
  }

  $: {
    recoveryRuntimeSyncKey;
    syncRecoveryDraftFromRuntime();
  }

  $: canFinish =
    termsAccepted &&
    displayName.trim().length >= 2 &&
    softLimitUsd > 0 &&
    hardLimitUsd >= softLimitUsd &&
    maxFeeUsd >= 0 &&
    selectedJurisdictionCount > 0;

  {
    const savedPolicy = readSavedCollateralPolicy();
    softLimitUsd = savedPolicy.softLimitUsd;
    hardLimitUsd = savedPolicy.hardLimitUsd;
    maxFeeUsd = savedPolicy.maxFeeUsd;
    hasPersistedPolicy = savedPolicy.timestamp > 0;
    autoJoinHubs = hasSavedHubJoinPreference() ? readHubJoinPreference() : '1';
  }

  onMount(async () => {
    const suggestedName = getRuntimeSuggestedName();
    if (!displayName.trim() && suggestedName) {
      displayName = suggestedName.slice(0, 32);
    }

    try {
      const activeJurisdiction = String(runtimeProjection.activeJurisdictionName || '').trim().toLowerCase();
      const defaults = await hydrateJurisdictionPolicyDefaults(activeJurisdiction);
      defaultSoftLimitUsd = defaults.softLimitUsd;
      defaultHardLimitUsd = defaults.hardLimitUsd;
      defaultMaxFeeUsd = defaults.maxFeeUsd;

      if (!hasPersistedPolicy) {
        softLimitUsd = defaults.softLimitUsd;
        hardLimitUsd = defaults.hardLimitUsd;
        maxFeeUsd = defaults.maxFeeUsd;
      }
    } catch (policyError) {
      const reason = policyError instanceof Error ? policyError.message : String(policyError);
      policyDefaultsNotice = `Jurisdiction defaults unavailable; using built-in safe defaults. ${reason}`;
    }
  });

  function targetJurisdictionMatches(target: OnboardingTarget, candidate: OnboardingHubCandidate): boolean {
    const targetKey = String(target.jurisdictionKey || '').trim();
    const candidateKey = String(candidate.jurisdictionKey || hubDiscoveryJurisdictionKey(candidate.jurisdiction)).trim();
    if (targetKey && candidateKey) return targetKey === candidateKey;
    const targetName = String(target.jurisdiction || '').trim().toLowerCase();
    const candidateName = String(candidate.jurisdiction || '').trim().toLowerCase();
    return Boolean(targetName && candidateName && targetName === candidateName);
  }

  function hasProjectedCounterpartyAccount(targetEntityId: string, counterpartyEntityId: string): boolean {
    const normalizedEntityId = normalizeEntityId(targetEntityId);
    const normalizedCounterpartyId = normalizeEntityId(counterpartyEntityId);
    if (!normalizedEntityId || !normalizedCounterpartyId) return false;
    return (runtimeProjection.accountCounterpartiesByEntityId[normalizedEntityId] || [])
      .some((candidate) => normalizeEntityId(candidate) === normalizedCounterpartyId);
  }

  type HubDiscovery = {
    advertisedHubEntityIds: string[];
    eligibleHubEntityIds: string[];
  };

  function getProjectedHubDiscovery(target: OnboardingTarget): HubDiscovery {
    const advertisedHubEntityIds: string[] = [];
    const eligibleHubEntityIds: string[] = [];
    const add = (value: unknown) => {
      const id = String(value || '').trim();
      if (!id) return;
      if (normalizeEntityId(id) === normalizeEntityId(target.entityId)) return;
      if (!advertisedHubEntityIds.some(existing => normalizeEntityId(existing) === normalizeEntityId(id))) {
        advertisedHubEntityIds.push(id);
      }
      if (
        !hasProjectedCounterpartyAccount(target.entityId, id)
        && !eligibleHubEntityIds.some(existing => normalizeEntityId(existing) === normalizeEntityId(id))
      ) {
        eligibleHubEntityIds.push(id);
      }
    };

    for (const candidate of runtimeProjection.hubCandidates || []) {
      if (candidate.isHub === false) continue;
      if (!targetJurisdictionMatches(target, candidate)) continue;
      add(candidate.entityId);
    }

    return { advertisedHubEntityIds, eligibleHubEntityIds };
  }

  async function fetchPublicHubDiscovery(target: OnboardingTarget): Promise<HubDiscovery> {
    if (typeof window === 'undefined') {
      return { advertisedHubEntityIds: [], eligibleHubEntityIds: [] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const apiBase = resolveConfiguredApiBase(window.location.origin);
      const url = new URL('/api/hubs', apiBase);
      url.searchParams.set('ts', String(Date.now()));
      const response = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = await response.json() as PublicHubResponse;
      if (payload.ok !== true) throw new Error('RESPONSE_NOT_OK');
      const advertisedHubEntityIds: string[] = [];
      const eligibleHubEntityIds: string[] = [];
      for (const hub of payload.hubs || []) {
        if (!hub?.entityId || hub.metadata?.isHub !== true) continue;
        const normalized = normalizeEntityId(hub.entityId);
        if (!normalized || normalized === normalizeEntityId(target.entityId)) continue;
        const jurisdiction = String(hub.metadata?.jurisdiction?.name || '').trim();
        const jurisdictionKey = hubDiscoveryJurisdictionKey(hub.metadata?.jurisdiction);
        const candidate: OnboardingHubCandidate = {
          entityId: hub.entityId,
          isHub: true,
          ...(jurisdiction ? { jurisdiction } : {}),
          ...(jurisdictionKey ? { jurisdictionKey } : {}),
        };
        if (!targetJurisdictionMatches(target, candidate)) continue;
        if (!advertisedHubEntityIds.some(existing => normalizeEntityId(existing) === normalized)) {
          advertisedHubEntityIds.push(hub.entityId);
        }
        if (
          !hasProjectedCounterpartyAccount(target.entityId, hub.entityId)
          && !eligibleHubEntityIds.some(existing => normalizeEntityId(existing) === normalized)
        ) {
          eligibleHubEntityIds.push(hub.entityId);
        }
      }
      return { advertisedHubEntityIds, eligibleHubEntityIds };
    } finally {
      clearTimeout(timer);
    }
  }

  async function queueAutoHubJoinsForTarget(
    joinCount: number,
    target: OnboardingTarget,
  ): Promise<{ joined: number; required: boolean }> {
    if (joinCount <= 0 || !target.entityId || !target.signerId) {
      return { joined: 0, required: false };
    }

    const waitForCandidates = async (): Promise<{
      required: boolean;
      hubEntityIds: string[];
    }> => {
      const timeoutMs = 3_000;
      const pollMs = 100;
      const startedAt = Date.now();
      let best: HubDiscovery = {
        advertisedHubEntityIds: [],
        eligibleHubEntityIds: [],
      };
      let discoveryFailure = '';

      while (Date.now() - startedAt < timeoutMs) {
        const projected = getProjectedHubDiscovery(target);
        let publicDiscovery: HubDiscovery | null = null;
        try {
          publicDiscovery = await fetchPublicHubDiscovery(target);
          discoveryFailure = '';
        } catch (discoveryError) {
          discoveryFailure = discoveryError instanceof Error
            ? discoveryError.message
            : String(discoveryError);
        }

        const mergeIds = (...groups: string[][]): string[] =>
          Array.from(new Map(groups.flat().map(id => [normalizeEntityId(id), id])).values());
        const current: HubDiscovery = {
          advertisedHubEntityIds: mergeIds(
            projected.advertisedHubEntityIds,
            publicDiscovery?.advertisedHubEntityIds || [],
          ),
          eligibleHubEntityIds: mergeIds(
            projected.eligibleHubEntityIds,
            publicDiscovery?.eligibleHubEntityIds || [],
          ).filter((hubId) => !hasProjectedCounterpartyAccount(target.entityId, hubId)),
        };
        best = {
          advertisedHubEntityIds: mergeIds(
            best.advertisedHubEntityIds,
            current.advertisedHubEntityIds,
          ),
          eligibleHubEntityIds: current.eligibleHubEntityIds.length > best.eligibleHubEntityIds.length
            ? current.eligibleHubEntityIds
            : best.eligibleHubEntityIds,
        };

        // A successful public discovery with no hub for this jurisdiction is
        // authoritative availability, not an onboarding failure. The sibling
        // Entity was already created and profiled above; there is simply no
        // bilateral hub account to open yet.
        if (publicDiscovery && current.advertisedHubEntityIds.length === 0) {
          return { required: false, hubEntityIds: [] };
        }
        if (current.eligibleHubEntityIds.length >= joinCount) {
          return selectAdvertisedAutoJoinCandidates({
            requested: joinCount,
            advertisedHubEntityIds: current.advertisedHubEntityIds,
            eligibleHubEntityIds: current.eligibleHubEntityIds,
          });
        }
        await sleep(pollMs);
      }

      if (best.eligibleHubEntityIds.length < joinCount) {
        if (discoveryFailure) {
          throw new Error(
            `ONBOARDING_HUB_DISCOVERY_FAILED:requested=${joinCount}:found=${best.eligibleHubEntityIds.length}:cause=${discoveryFailure}`,
          );
        }
      }
      return selectAdvertisedAutoJoinCandidates({
        requested: joinCount,
        advertisedHubEntityIds: best.advertisedHubEntityIds,
        eligibleHubEntityIds: best.eligibleHubEntityIds,
      });
    };

    const tokenDecimals = $xlnFunctions.getTokenInfo(1).decimals;
    const rebalancePolicy = getOpenAccountRebalancePolicyData(tokenDecimals);
    if (!rebalancePolicy) return { joined: 0, required: false };

    const selection = await waitForCandidates();
    if (!selection.required) return { joined: 0, required: false };
    const readyCandidates = selection.hubEntityIds
      .filter((hubId) => !hasProjectedCounterpartyAccount(target.entityId, hubId));

    const creditAmount = 10_000n * 10n ** BigInt(tokenDecimals);
    await submitRuntimeInput(buildOnboardingHubOpenRuntimeInput({
      target,
      hubEntityIds: readyCandidates,
      creditAmount,
      tokenId: 1,
      rebalancePolicy,
    }));

    return { joined: readyCandidates.length, required: true };
  }

  async function queueAutoHubJoins(
    joinCount: number,
    targets: OnboardingTarget[],
  ): Promise<{ joined: number; requiredTargets: number }> {
    // Each lane owns an independent bilateral account set. Primary and cross-j
    // sibling entities must both open committed hub accounts during onboarding;
    // otherwise the UI can select a sibling that exists but cannot route.
    let joined = 0;
    let requiredTargets = 0;
    for (const target of targets) {
      const result = await queueAutoHubJoinsForTarget(joinCount, target);
      joined += result.joined;
      if (result.required) requiredTargets += 1;
    }
    return { joined, requiredTargets };
  }

  async function waitForEnabledOnboardingTargets(): Promise<{
    allTargets: OnboardingTarget[];
    targets: OnboardingTarget[];
  }> {
    const deadline = Date.now() + 3_000;
    let allTargets: OnboardingTarget[] = [];
    let targets: OnboardingTarget[] = [];
    while (Date.now() < deadline) {
      allTargets = getRuntimeOnboardingTargets();
      targets = allTargets.filter(isTargetJurisdictionEnabled);
      if (targets.length > 0) return { allTargets, targets };
      await sleep(100);
    }
    return { allTargets, targets };
  }

  async function finish() {
    if (!canFinish || submitting) return;
    submitting = true;
    error = '';

    try {
      const cleanDisplayName = displayName.trim();
      let allTargets = getRuntimeOnboardingTargets();
      let targets = allTargets.filter(isTargetJurisdictionEnabled);
      if (targets.length === 0) {
        ({ allTargets, targets } = await waitForEnabledOnboardingTargets());
      }
      if (targets.length === 0) {
        throw new Error('Select at least one jurisdiction to register automatically');
      }

      const policyData = writeSavedCollateralPolicy({
        mode: 'autopilot',
        softLimitUsd: toUsdInt(softLimitUsd, defaultSoftLimitUsd),
        hardLimitUsd: toUsdInt(hardLimitUsd, defaultHardLimitUsd),
        maxFeeUsd: toUsdInt(maxFeeUsd, defaultMaxFeeUsd),
      });
      const savedJoinPreference = writeHubJoinPreference(autoJoinHubs);

      await submitRuntimeInput(buildOnboardingProfileRuntimeInput({
        targets,
        displayName: cleanDisplayName,
      }));

      // Recovery must be committed before opening hub accounts. Account opens create
      // usable bilateral state; with a configured tower, the runtime backup barrier
      // must already be installed before those committed frames can leave the device.
      await saveRecoveryConfig();

      const autoJoinCount = parseJoinCount(savedJoinPreference);
      const autoJoinTargets = autoJoinCount > 0
        ? targets.filter((target) => !hasAnyCounterpartyAccount(target.entityId))
        : targets;
      const autoJoinResult = await queueAutoHubJoins(autoJoinCount, autoJoinTargets);
      const autoJoinedCount = autoJoinResult.joined;
      assertCommittedAutoJoinCount({
        requestedPerTarget: autoJoinCount,
        targetCount: autoJoinResult.requiredTargets,
        committedCount: autoJoinedCount,
      });

      const completedEntityIds = allTargets.map((target) => target.entityId);
      writeOnboardingCompleteForEntities(completedEntityIds.length > 0 ? completedEntityIds : [entityId], true);
      localStorage.setItem('xln-display-name', cleanDisplayName);

      dispatch('complete', {
        displayName: cleanDisplayName,
        softLimitUsd: policyData.softLimitUsd,
        hardLimitUsd: policyData.hardLimitUsd,
        maxFeeUsd: policyData.maxFeeUsd,
        autoJoinHubs: savedJoinPreference,
        autoJoinedCount,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Setup failed';
      submitting = false;
    }
  }

  export function isOnboardingComplete(checkEntityId: string): boolean {
    return readOnboardingComplete(checkEntityId);
  }

  export function getSavedPolicy(): {
    mode: string;
    softLimitUsd: number;
    hardLimitUsd: number;
    maxFeeUsd: number;
  } | null {
    return readSavedCollateralPolicy();
  }

  export function getSavedDisplayName(): string {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem('xln-display-name') || '';
  }
</script>

<div class="onboarding">
  <div class="setup-header">
    <h2>Configure account</h2>
    <p>Set the public profile, default limits, and first hub account.</p>
  </div>
  <div class="setup-card">
    {#if recoveryDiscoveryStatus}
      <section class="setup-section recovery-check-compact" data-testid="runtime-recovery-check-status">
        <div class="recovery-check-copy">
          <span>
            Checked {recoveryDiscoveryStatus.checkedTowers} watchtower{recoveryDiscoveryStatus.checkedTowers === 1 ? '' : 's'},
            found {recoveryDiscoveryStatus.backupCount} backup{recoveryDiscoveryStatus.backupCount === 1 ? '' : 's'} for this seed.
          </span>
          {#if recoveryDiscoveryStatus.errors.length > 0}
            <small>{recoveryDiscoveryStatus.errors.length} warning{recoveryDiscoveryStatus.errors.length === 1 ? '' : 's'} during check</small>
          {/if}
          {#if recoveryDiscoveryFailureLabels.length > 0}
            <div class="recovery-check-failures" data-testid="runtime-recovery-check-failures">
              {#each recoveryDiscoveryFailureLabels as failureLabel}
                <small>{failureLabel}</small>
              {/each}
            </div>
          {/if}
        </div>
        <button
          type="button"
          class="mini-action"
          disabled={recoveryUploadBusy}
          on:click={triggerRecoveryBackupFilePicker}
        >
          {recoveryUploadBusy ? 'Loading backup...' : 'I have a runtime backup file'}
        </button>
        <input
          bind:this={recoveryBackupFileInput}
          class="backup-file-input"
          type="file"
          accept=".json,application/json,text/plain"
          on:change={handleRecoveryBackupFileSelected}
        />
        {#if recoveryUploadMessage}
          <div class={recoveryUploadTone === 'error' ? 'error-msg compact' : 'recovery-note compact'}>
            {recoveryUploadMessage}
          </div>
        {/if}
      </section>
    {/if}

    <section class="setup-section">
      <label class="form-label" for="display-name">Display name</label>
      <input
        id="display-name"
        type="text"
        class="form-input"
        placeholder="e.g. Alice, CryptoShop, MyExchange"
        bind:value={displayName}
        maxlength="32"
      />
      <p class="form-hint compact">Visible in gossip, account lists, and routing flows.</p>
      <div class="profile-preview-card">
        {#if avatar}
          <img src={avatar} alt="Entity avatar" class="profile-preview-avatar" />
        {:else}
          <div class="profile-preview-avatar placeholder">?</div>
        {/if}
        <div class="profile-preview-copy">
          <strong>{displayName.trim() || 'Your public name'}</strong>
          <code>{entityId}</code>
        </div>
      </div>
    </section>

    <section class="setup-section jurisdiction-section">
      <div class="section-headline">
        <h3>Jurisdictions</h3>
        <p>Choose where profile registration and first hub setup run automatically.</p>
      </div>
      {#if jurisdictionOptions.length === 0}
        <div class="empty-recovery-card">Runtime lanes are still loading.</div>
      {:else}
        <div class="jurisdiction-toggle-grid">
          {#each jurisdictionOptions as option (option.key)}
            <label class="jurisdiction-toggle" class:selected={selectedJurisdictions[option.key] !== false}>
              <input
                type="checkbox"
                checked={selectedJurisdictions[option.key] !== false}
                on:change={(event) => setJurisdictionEnabled(option.key, event.currentTarget.checked)}
              />
              <span class="jurisdiction-toggle-copy">
                <strong>{option.name}</strong>
                <code>{shortValue(option.entityId)}</code>
              </span>
            </label>
          {/each}
        </div>
        <p class="form-hint compact">
          All jurisdictions are enabled by default. Disabled lanes stay in the runtime, but onboarding will not auto-publish a profile or open hub accounts there.
        </p>
      {/if}
    </section>

    <section class="setup-section">
      <div class="section-headline">
        <h3>Default limits</h3>
        <p>These values are used when new hub accounts are opened.</p>
      </div>
      <div class="policy-grid">
        <label class="policy-field">
          <span class="form-label">Soft limit (USD)</span>
          <input
            type="number"
            min="1"
            step="1"
            class="form-input policy-input"
            bind:value={softLimitUsd}
            on:input={() => softLimitUsd = toUsdInt(softLimitUsd, defaultSoftLimitUsd)}
          />
        </label>

        <label class="policy-field">
          <span class="form-label">Hard limit (USD)</span>
          <input
            type="number"
            min="1"
            step="1"
            class="form-input policy-input"
            bind:value={hardLimitUsd}
            on:input={() => hardLimitUsd = toUsdInt(hardLimitUsd, defaultHardLimitUsd)}
          />
        </label>

        <label class="policy-field">
          <span class="form-label">Max fee (USD)</span>
          <input
            type="number"
            min="0"
            step="1"
            class="form-input policy-input"
            bind:value={maxFeeUsd}
            on:input={() => maxFeeUsd = toUsdInt(maxFeeUsd, defaultMaxFeeUsd)}
          />
        </label>
      </div>
      <p class="form-hint">
        Default for this jurisdiction: soft <strong>{defaultSoftLimitUsd.toLocaleString()}</strong>,
        hard <strong>{defaultHardLimitUsd.toLocaleString()}</strong>,
        fee <strong>{defaultMaxFeeUsd.toLocaleString()}</strong>.
      </p>
      {#if policyDefaultsNotice}
        <div class="recovery-note compact" data-testid="onboarding-policy-defaults-notice">
          {policyDefaultsNotice}
        </div>
      {/if}
      <div class="hub-join-inline">
        <label class="form-label" for="hub-join-select">Initial hub join</label>
        <select id="hub-join-select" class="hub-join-select" bind:value={autoJoinHubs}>
          {#each HUB_JOIN_OPTIONS as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
        <p class="form-hint compact">Open your first bilateral account automatically right after setup.</p>
      </div>
    </section>

    {#if hasBrainVaultRecovery}
      <section class="setup-section brainvault-section">
        <details class="brainvault-details" data-testid="brainvault-onboarding-recovery">
          <summary data-testid="brainvault-onboarding-recovery-toggle">
            <span class="brainvault-summary-copy">
              <strong>Seed safety</strong>
              <small>Save the offline recovery sheet before relying on the account.</small>
            </span>
            <span class="brainvault-summary-meta">
              <span>{brainVaultWordCount ? `${brainVaultWordCount} words` : 'Seed ready'}</span>
              {#if brainVaultSignerAddress}
                <code title={brainVaultSignerAddress}>{shortValue(brainVaultSignerAddress)}</code>
              {/if}
            </span>
            <span class="brainvault-chevron" aria-hidden="true">⌄</span>
          </summary>

          <div class="brainvault-panel">
            <div class="brainvault-actions">
              <button type="button" class="mini-action" on:click={downloadBrainVaultSheet}>
                Download sheet
              </button>
              <a class="mini-action" href="/docs-static/faq.md" target="_blank" rel="noreferrer">
                Read safety notes
              </a>
              <button
                type="button"
                class="mini-action"
                disabled={!brainVaultSeed}
                on:click={() => revealBrainVaultSeed = !revealBrainVaultSeed}
              >
                {revealBrainVaultSeed ? 'Hide seed' : 'Show seed'}
              </button>
              <button
                type="button"
                class="mini-action"
                disabled={!brainVaultSeed}
                on:click={() => copyBrainVaultValue(brainVaultSeed, 'seed')}
              >
                {copiedBrainVaultField === 'seed' ? 'Copied' : 'Copy seed'}
              </button>
            </div>
            <div class="brainvault-row">
              <span>Wallet</span>
              <code>{brainVaultRuntimeLabel || '-'}</code>
            </div>
            <div class="brainvault-row">
              <span>Signer</span>
              <code>{brainVaultSignerAddress || '-'}</code>
            </div>
            {#if revealBrainVaultSeed}
              <div class="seed-box">
                {#each brainVaultSeed.split(/\s+/) as word, index}
                  {#if word}
                    <span><b>{index + 1}</b>{word}</span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        </details>
      </section>
    {/if}

    <section class="setup-section recovery-section">
      <div class="section-headline">
        <h3>Encrypted backup and last-resort dispute protection</h3>
        <p>Choose which tower services store encrypted runtime backups and delayed dispute rescue appointments.</p>
      </div>

      <div class="recovery-mode-grid" role="radiogroup" aria-label="Runtime recovery mode">
        <button
          type="button"
          class="recovery-mode-option"
          class:selected={recoveryMode === 'official'}
          disabled={!recoveryOfficialUrl}
          on:click={() => applyRecoveryModeDraft('official')}
        >
          <span class="recovery-mode-title">Backup + disputer</span>
          <span class="recovery-mode-copy">
            {recoveryOfficialUrl
              ? 'Official tower stores encrypted backups and last-resort appointments.'
              : 'No official tower for this local runtime.'}
          </span>
        </button>

        <button
          type="button"
          class="recovery-mode-option"
          class:selected={recoveryMode === 'backup_only'}
          disabled={!recoveryOfficialUrl}
          on:click={() => applyRecoveryModeDraft('backup_only')}
        >
          <span class="recovery-mode-title">Backup only</span>
          <span class="recovery-mode-copy">Encrypted runtime backup, no dispute rescue.</span>
        </button>

        <button
          type="button"
          class="recovery-mode-option"
          class:selected={recoveryMode === 'local_only'}
          on:click={() => applyRecoveryModeDraft('local_only')}
        >
          <span class="recovery-mode-title">Local only</span>
          <span class="recovery-mode-copy">No remote backup unless you add a service URL.</span>
        </button>
      </div>

      <div class="recovery-service-list">
        {#if recoveryTowerDraft.length === 0}
          <div class="empty-recovery-card">No remote recovery service configured.</div>
        {:else}
          {#each recoveryTowerDraft as tower (tower.url)}
            {@const isOfficial = isOfficialRecoveryTower(tower, recoveryOfficialUrl)}
            <div class="recovery-service-row">
              <div class="recovery-service-main">
                <strong>{isOfficial ? 'Official XLN tower' : 'Manual service'}</strong>
                <code>{tower.url}</code>
              </div>
              <div class="recovery-service-actions">
                <select
                  value={normalizeTowerMode(tower.towerMode)}
                  disabled={isOfficial}
                  aria-label="Recovery service mode"
                  on:change={(event) => updateRecoveryTowerMode(tower.url, (event.currentTarget as HTMLSelectElement).value as RecoveryServiceMode)}
                >
                  <option value="blind_backup">Backup</option>
                  <option value="delayed_last_resort">Last resort</option>
                </select>
                {#if !isOfficial}
                  <button type="button" class="mini-action danger" on:click={() => removeRecoveryTower(tower.url)}>
                    Remove
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <details class="manual-recovery-details">
        <summary>Advanced recovery service</summary>
        <div class="manual-recovery-grid">
          <label>
            <span class="form-label">Service URL</span>
            <input
              type="url"
              class="form-input"
              bind:value={recoveryManualUrl}
              placeholder="https://tower.example.com"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label>
            <span class="form-label">Role</span>
            <select class="hub-join-select" bind:value={recoveryManualKind}>
              <option value="blind_backup">Backup service</option>
              <option value="delayed_last_resort">Last-resort disputer</option>
            </select>
          </label>
          <button type="button" class="mini-action manual-add" on:click={addManualRecoveryTower}>
            Add service
          </button>
        </div>
      </details>

      <p class="form-hint compact">
        Towers never get spend authority. Last-resort disputers can only answer an already-open dispute in the final delay window.
      </p>
      {#if recoveryMessage}
        <div class={recoveryMessageTone === 'error' ? 'error-msg' : 'recovery-note'}>
          {recoveryMessage}
        </div>
      {/if}
    </section>

    <section class="setup-section confirm-section">
      <div class="confirm-row">
        <label class="checkbox-row">
          <input type="checkbox" bind:checked={termsAccepted} />
          <span>I understand this is testnet software and I accept the associated risks.</span>
        </label>
        <button class="btn-primary" disabled={!canFinish || submitting} on:click={finish}>
          {submitting ? 'Starting...' : 'Start'}
        </button>
      </div>
      {#if error}
        <div class="error-msg">{error}</div>
      {/if}
    </section>
  </div>
</div>

<style>
  .onboarding {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 8px 16px 24px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    color: #e7e5e4;
  }

  .setup-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .setup-header {
    margin-bottom: 14px;
  }

  .setup-header h2 {
    margin: 0 0 6px;
    color: rgba(255, 255, 255, 0.94);
    font-size: 24px;
    line-height: 1.15;
    letter-spacing: 0;
  }

  .setup-header p {
    margin: 0;
    color: rgba(255, 255, 255, 0.58);
    font-size: 13px;
    line-height: 1.45;
  }

  .setup-section {
    background: linear-gradient(180deg, #16120f 0%, #100d0b 100%);
    border: 1px solid #2f2620;
    border-radius: 14px;
    padding: 16px;
  }

  .recovery-check-compact {
    min-height: 0;
    padding: 10px 12px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    background: rgba(120, 113, 108, 0.08);
  }

  .recovery-check-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: #d6d3d1;
    font-size: 12px;
    line-height: 1.35;
  }

  .recovery-check-copy small {
    color: #a8a29e;
    font-size: 11px;
  }

  .recovery-check-failures {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .backup-file-input {
    display: none;
  }

  .brainvault-section {
    padding: 0;
    overflow: hidden;
    background: linear-gradient(180deg, #18130f 0%, #100d0b 100%);
  }

  .brainvault-details summary {
    min-height: 58px;
    padding: 14px 16px 12px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(120px, auto) auto;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    list-style: none;
  }

  .brainvault-details summary::-webkit-details-marker {
    display: none;
  }

  .brainvault-summary-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .brainvault-details summary strong {
    color: #f5f5f4;
    font-size: 15px;
    line-height: 1.2;
  }

  .brainvault-details summary small {
    color: #a8a29e;
    font-size: 12px;
    line-height: 1.35;
  }

  .brainvault-summary-meta {
    min-width: 0;
    color: #78716c;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    text-align: right;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .brainvault-summary-meta span,
  .brainvault-summary-meta code {
    min-width: 0;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .brainvault-chevron {
    color: #a8a29e;
    transition: transform 0.15s ease;
  }

  .brainvault-details[open] .brainvault-chevron {
    transform: rotate(180deg);
  }

  .brainvault-panel {
    padding: 14px 16px 16px;
    border-top: 1px solid #27211c;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: rgba(0, 0, 0, 0.16);
  }

  .brainvault-row {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    color: #78716c;
    font-size: 12px;
  }

  .brainvault-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .mini-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 9px;
    border: 1px solid #322821;
    background: #0f0b09;
    color: #e7e5e4;
    font-size: 12px;
    font-weight: 700;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    line-height: 1.25;
  }

  .mini-action:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .seed-box {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    padding: 10px;
    border-radius: 10px;
    background: #0f0b09;
    border: 1px solid #322821;
  }

  .seed-box span {
    min-width: 0;
    display: flex;
    gap: 5px;
    align-items: baseline;
    color: #f5f5f4;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .seed-box b {
    color: #78716c;
    font-size: 10px;
  }

  .recovery-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .recovery-mode-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .recovery-mode-option {
    min-height: 86px;
    padding: 12px;
    border: 1px solid #322821;
    border-radius: 12px;
    background: #0f0b09;
    color: #e7e5e4;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    text-align: left;
    cursor: pointer;
  }

  .recovery-mode-option.selected {
    border-color: rgba(251, 191, 36, 0.65);
    background: rgba(251, 191, 36, 0.08);
  }

  .recovery-mode-option:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .recovery-mode-title {
    color: #f5f5f4;
    font-size: 13px;
    font-weight: 800;
  }

  .recovery-mode-copy {
    color: #a8a29e;
    font-size: 12px;
    line-height: 1.35;
  }

  .recovery-service-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .empty-recovery-card,
  .recovery-service-row {
    border: 1px solid #322821;
    border-radius: 12px;
    background: #0f0b09;
    padding: 12px;
  }

  .empty-recovery-card {
    color: #78716c;
    font-size: 13px;
  }

  .recovery-service-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
  }

  .recovery-service-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .recovery-service-main strong {
    color: #f5f5f4;
    font-size: 13px;
  }

  .recovery-service-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .recovery-service-actions select {
    min-height: 34px;
    border: 1px solid #322821;
    border-radius: 9px;
    background: #080605;
    color: #e7e5e4;
    padding: 0 10px;
    color-scheme: dark;
  }

  .mini-action.danger {
    color: #fda4af;
    border-color: rgba(244, 63, 94, 0.28);
  }

  .manual-recovery-details {
    border-top: 1px solid #27211c;
    padding-top: 12px;
  }

  .manual-recovery-details summary {
    color: #fbbf24;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
  }

  .manual-recovery-grid {
    margin-top: 12px;
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(150px, 0.7fr) auto;
    gap: 10px;
    align-items: end;
  }

  .manual-add {
    min-height: 48px;
  }

  .recovery-note {
    padding: 10px 14px;
    border: 1px solid rgba(251, 191, 36, 0.2);
    border-radius: 10px;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.06);
    font-size: 12px;
  }

  .recovery-note.compact,
  .error-msg.compact {
    grid-column: 1 / -1;
    padding: 8px 10px;
    font-size: 11px;
  }

  .profile-preview-avatar {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .profile-preview-avatar.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
    color: #09090b;
    font-weight: 700;
  }

  h3 {
    margin: 0;
  }

  .section-headline p {
    margin: 0;
    color: #a8a29e;
    font-size: 14px;
    line-height: 1.55;
  }

  code {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #f5f5f4;
  }

  .form-label {
    display: block;
    margin-bottom: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .form-input,
  .hub-join-select {
    width: 100%;
    box-sizing: border-box;
    min-height: 48px;
    padding: 12px 14px;
    background: #0f0b09;
    border: 1px solid #322821;
    border-radius: 10px;
    color: #e7e5e4;
    font-size: 15px;
    color-scheme: dark;
  }

  .hub-join-select option {
    background: #0f0b09;
    color: #e7e5e4;
  }

  .form-input:focus,
  .hub-join-select:focus {
    outline: none;
    border-color: #fbbf24;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.08);
  }

  .profile-preview-card {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px;
    border-radius: 12px;
    background: #11100f;
    border: 1px solid #27272a;
  }

  .profile-preview-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .profile-preview-copy strong {
    font-size: 17px;
    color: #fafaf9;
  }

  .jurisdiction-toggle-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .jurisdiction-toggle {
    min-height: 72px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    cursor: pointer;
    box-sizing: border-box;
  }

  .jurisdiction-toggle.selected {
    border-color: rgba(76, 175, 80, 0.34);
    background: rgba(76, 175, 80, 0.08);
  }

  .jurisdiction-toggle input {
    margin: 2px 0 0;
    width: 16px;
    height: 16px;
    accent-color: #4caf50;
  }

  .jurisdiction-toggle-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .jurisdiction-toggle-copy strong {
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
  }

  .jurisdiction-toggle-copy code {
    color: rgba(255, 255, 255, 0.48);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .policy-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  @media (max-width: 640px) {
    .brainvault-details summary {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .brainvault-summary-meta {
      grid-column: 1 / -1;
      justify-content: flex-start;
      text-align: left;
    }

    .brainvault-actions,
    .jurisdiction-toggle-grid,
    .policy-grid,
    .recovery-mode-grid,
    .manual-recovery-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .brainvault-row,
    .recovery-service-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 4px;
    }

    .recovery-service-actions {
      align-items: stretch;
      flex-direction: column;
    }
  }

  .policy-field {
    min-width: 0;
  }

  .policy-input {
    margin-top: 4px;
  }

  .form-hint {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: #78716c;
  }

  .form-hint strong {
    color: #fbbf24;
  }

  .form-hint.compact {
    margin-top: 8px;
  }

  .hub-join-inline {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid #27211c;
  }

  .checkbox-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1.5;
    color: #a8a29e;
  }

  .checkbox-row input[type='checkbox'] {
    margin-top: 2px;
    flex-shrink: 0;
  }

  .confirm-section {
    gap: 14px;
  }

  .confirm-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .error-msg {
    padding: 10px 14px;
    background: rgba(244, 63, 94, 0.08);
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: 10px;
    color: #f43f5e;
    font-size: 12px;
  }

  .btn-primary {
    padding: 13px 24px;
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
    border: none;
    border-radius: 10px;
    color: #09090b;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (max-width: 720px) {
    .onboarding {
      padding-top: 0;
      padding-left: 12px;
      padding-right: 12px;
    }

    .setup-section {
      padding: 14px;
      border-radius: 12px;
    }

    .profile-preview-card {
      align-items: flex-start;
    }

    .policy-grid {
      grid-template-columns: 1fr;
    }

    .recovery-mode-grid,
    .manual-recovery-grid,
    .recovery-service-row {
      grid-template-columns: 1fr;
    }

    .recovery-service-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .brainvault-row {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .brainvault-details summary {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .brainvault-summary-meta {
      grid-column: 1 / -1;
      max-width: none;
      text-align: left;
    }

    .brainvault-actions {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .seed-box {
      grid-template-columns: 1fr;
    }

    .btn-primary {
      width: 100%;
    }

    .confirm-row {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
