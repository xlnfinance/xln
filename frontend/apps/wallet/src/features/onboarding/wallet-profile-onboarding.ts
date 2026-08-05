import type {
  RuntimeAdapterViewFrame,
  RuntimeInput,
} from '@xln/runtime/api/public/runtime-module';
import { getJurisdictionStackId } from '@xln/runtime/api/public/runtime-module';

import {
  assertCommittedAutoJoinCount,
  buildOnboardingHubOpenRuntimeInput,
  buildOnboardingProfileRuntimeInput,
  selectAdvertisedAutoJoinCandidates,
  type OnboardingRuntimeTarget,
} from '$lib/components/Entity/onboarding-runtime-input';
import {
  getOpenAccountRebalancePolicyData,
  writeHubJoinPreference,
  writeSavedCollateralPolicy,
  type HubJoinPreference,
} from '$lib/utils/onboardingPreferences';
import { writeOnboardingCompleteForEntities } from '$lib/utils/onboardingState';
import { normalizeEntityId } from '$lib/utils/entityReplica';
import {
  getManualRecoveryTowers,
  isOfficialRecoveryTower,
  normalizeRecoveryDraft,
  normalizeTowerMode,
  resolveOfficialRecoveryTowerUrl,
} from '$lib/utils/recoverySettings';
import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
import {
  buildRuntimeRecoveryConfigForMode,
  vaultOperations,
  type RecoveryTowerSetupMode,
  type Runtime,
} from '$lib/stores/vaultStore';
import {
  refreshRuntimeGossipProfiles,
  resolveConfiguredApiBase,
  submitRuntimeInput,
} from '$lib/stores/xlnStore';
import { xlnInstanceExternalStore } from '$lib/stores/xlnRuntimeLoader';

export type WalletProfileOnboardingInput = Readonly<{
  displayName: string;
  softLimitUsd: number;
  hardLimitUsd: number;
  maxFeeUsd: number;
  hubJoinPreference: HubJoinPreference;
  recoveryMode: RecoveryTowerSetupMode;
  selectedJurisdictions: readonly string[];
}>;

type PublicHub = Readonly<{
  entityId?: string;
  metadata?: Readonly<{
    isHub?: boolean;
    jurisdiction?: Readonly<{
      name?: string;
      chainId?: number | string;
      depositoryAddress?: string;
    }>;
  }>;
}>;

type TargetState = Readonly<{
  target: OnboardingRuntimeTarget;
  counterpartyIds: readonly string[];
}>;

const normalizeName = (value: unknown): string => String(value || '').trim().toLowerCase();

const requireUsdInteger = (value: unknown, field: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`ONBOARDING_${field}_INVALID`);
  return parsed;
};

export const walletProfileOnboardingEntityIds = (runtime: Runtime | null): string[] =>
  Array.from(new Set((runtime?.signers || []).map(signer => normalizeEntityId(signer.entityId || '')).filter(Boolean)));

export const walletProfileOnboardingRequired = (runtime: Runtime | null, completed: boolean): boolean =>
  Boolean(runtime && runtime.requiresOnboarding !== false && !completed);

export const inferWalletRecoveryMode = (runtime: Runtime): RecoveryTowerSetupMode => {
  const officialUrl = resolveOfficialRecoveryTowerUrl();
  const towers = normalizeRecoveryDraft(runtime.recovery?.towers);
  const official = towers.find(tower => isOfficialRecoveryTower(tower, officialUrl));
  if (official) return normalizeTowerMode(official.towerMode) === 'delayed_last_resort' ? 'official' : 'backup_only';
  if (towers.length > 0) return 'local_only';
  return officialUrl ? 'official' : 'local_only';
};

const runtimeTargets = (runtime: Runtime, selectedJurisdictions: readonly string[]): OnboardingRuntimeTarget[] => {
  const enabled = new Set(selectedJurisdictions.map(normalizeName).filter(Boolean));
  const targets = runtime.signers.flatMap((signer, index) => {
    const entityId = normalizeEntityId(signer.entityId || '');
    const signerId = String(signer.address || '').trim().toLowerCase();
    const jurisdiction = String(signer.jurisdiction || (index === 0 ? 'Primary' : '')).trim();
    if (!entityId || !signerId || !enabled.has(normalizeName(jurisdiction))) return [];
    return [{ entityId, signerId, jurisdiction }];
  });
  if (targets.length === 0) throw new Error('Select at least one jurisdiction to register automatically');
  return targets;
};

const accountCounterparties = (frame: RuntimeAdapterViewFrame, ownerEntityId: string): string[] => {
  const owner = normalizeEntityId(ownerEntityId);
  return Array.from(new Set((frame.activeEntity?.accounts.items || []).flatMap(account => {
    const left = normalizeEntityId(account.state.leftEntity);
    const right = normalizeEntityId(account.state.rightEntity);
    if (left === owner && right) return [right];
    if (right === owner && left) return [left];
    throw new Error(`ONBOARDING_ACCOUNT_OWNER_MISMATCH:${owner}:${left}:${right}`);
  })));
};

const loadTargetState = async (target: OnboardingRuntimeTarget): Promise<TargetState> => {
  const frame = await runtimeQueryClient.readViewFrame({ entityId: target.entityId, accountsLimit: 100, booksLimit: 1 });
  const active = frame.activeEntity;
  if (!active) throw new Error(`ONBOARDING_TARGET_FRAME_MISSING:${target.entityId}`);
  const jurisdiction = active.summary.jurisdiction;
  return {
    target: {
      ...target,
      jurisdiction: String(jurisdiction?.name || target.jurisdiction || '').trim(),
      jurisdictionKey: getJurisdictionStackId(jurisdiction) || '',
    },
    counterpartyIds: accountCounterparties(frame, target.entityId),
  };
};

const fetchPublicHubs = async (): Promise<PublicHub[]> => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 1_200);
  try {
    const apiBase = resolveConfiguredApiBase(window.location.origin);
    const response = await fetch(new URL('/api/hubs', apiBase), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`ONBOARDING_HUB_DISCOVERY_HTTP_${response.status}`);
    const payload = await response.json() as { ok?: boolean; hubs?: PublicHub[] };
    if (payload.ok !== true || !Array.isArray(payload.hubs)) throw new Error('ONBOARDING_HUB_DISCOVERY_INVALID');
    return payload.hubs;
  } finally {
    window.clearTimeout(timer);
  }
};

const hubMatchesTarget = (hub: PublicHub, target: OnboardingRuntimeTarget): boolean => {
  const hubJurisdiction = hub.metadata?.jurisdiction;
  const hubKey = getJurisdictionStackId(hubJurisdiction);
  if (hubKey && target.jurisdictionKey) return hubKey === target.jurisdictionKey;
  return Boolean(normalizeName(hubJurisdiction?.name) && normalizeName(hubJurisdiction?.name) === normalizeName(target.jurisdiction));
};

export const selectWalletOnboardingHubs = (input: Readonly<{
  target: OnboardingRuntimeTarget;
  publicHubs: readonly PublicHub[];
  counterpartyIds: readonly string[];
  requested: number;
}>): string[] => {
  const existing = new Set(input.counterpartyIds.map(normalizeEntityId));
  const advertised = Array.from(new Map(input.publicHubs
    .filter(hub => hub.metadata?.isHub === true && hubMatchesTarget(hub, input.target))
    .map(hub => [normalizeEntityId(hub.entityId || ''), String(hub.entityId || '')] as const)
    .filter(([entityId]) => Boolean(entityId) && entityId !== normalizeEntityId(input.target.entityId))).values());
  return selectAdvertisedAutoJoinCandidates({
    requested: input.requested,
    advertisedHubEntityIds: advertised,
    eligibleHubEntityIds: advertised.filter(entityId => !existing.has(normalizeEntityId(entityId))),
  }).hubEntityIds;
};

const waitForTargetHubs = async (state: TargetState, requested: number): Promise<string[]> => {
  const deadline = Date.now() + 3_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return selectWalletOnboardingHubs({ ...state, publicHubs: await fetchPublicHubs(), requested });
    } catch (error) {
      lastError = error;
      await new Promise(resolve => window.setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ONBOARDING_HUB_DISCOVERY_FAILED');
};

const saveRecoveryBeforeAccounts = async (runtime: Runtime, mode: RecoveryTowerSetupMode): Promise<void> => {
  const officialUrl = resolveOfficialRecoveryTowerUrl();
  const currentTowers = normalizeRecoveryDraft(runtime.recovery?.towers);
  const config = buildRuntimeRecoveryConfigForMode(mode, {
    officialTowerUrl: officialUrl,
    manualTowers: getManualRecoveryTowers(currentTowers, officialUrl),
    previous: runtime.recovery || null,
  });
  await vaultOperations.updateRuntimeRecovery(runtime.id, config);
};

const submitHubAccounts = async (
  state: TargetState,
  hubIds: string[],
  policy: NonNullable<ReturnType<typeof getOpenAccountRebalancePolicyData>>,
  decimals: number,
): Promise<void> => {
  await refreshRuntimeGossipProfiles({
    reason: 'wallet-profile-onboarding',
    sourceEntityId: state.target.entityId,
    targetEntities: hubIds,
  });
  const input: RuntimeInput = buildOnboardingHubOpenRuntimeInput({
    target: state.target,
    hubEntityIds: hubIds,
    creditAmount: 10_000n * 10n ** BigInt(decimals),
    tokenId: 1,
    rebalancePolicy: policy,
  });
  await submitRuntimeInput(input);
};

export const completeWalletProfileOnboarding = async (
  runtime: Runtime,
  input: WalletProfileOnboardingInput,
): Promise<{ autoJoinedCount: number; entityIds: string[] }> => {
  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw new Error('Onboarding profile name must be at least 2 characters.');
  const softLimitUsd = requireUsdInteger(input.softLimitUsd, 'SOFT_LIMIT');
  const hardLimitUsd = requireUsdInteger(input.hardLimitUsd, 'HARD_LIMIT');
  const maxFeeUsd = requireUsdInteger(input.maxFeeUsd, 'MAX_FEE');
  if (softLimitUsd <= 0 || hardLimitUsd < softLimitUsd) throw new Error('ONBOARDING_COLLATERAL_POLICY_INVALID');
  const targets = runtimeTargets(runtime, input.selectedJurisdictions);
  writeSavedCollateralPolicy({ mode: 'autopilot', softLimitUsd, hardLimitUsd, maxFeeUsd });
  const preference = writeHubJoinPreference(input.hubJoinPreference);
  await submitRuntimeInput(buildOnboardingProfileRuntimeInput({ targets, displayName }));
  await saveRecoveryBeforeAccounts(runtime, input.recoveryMode);

  const requested = preference === 'manual' ? 0 : Number(preference);
  const xln = xlnInstanceExternalStore.getSnapshot();
  if (!xln) throw new Error('ONBOARDING_RUNTIME_API_NOT_READY');
  const decimals = Number(xln.getTokenInfo(1).decimals);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('ONBOARDING_TOKEN_DECIMALS_INVALID');
  const policy = getOpenAccountRebalancePolicyData(decimals);
  if (!policy) throw new Error('ONBOARDING_REBALANCE_POLICY_INVALID');

  let autoJoinedCount = 0;
  let requiredTargets = 0;
  if (requested > 0) {
    for (const target of targets) {
      const state = await loadTargetState(target);
      const hubIds = await waitForTargetHubs(state, requested);
      if (hubIds.length === 0) continue;
      requiredTargets += 1;
      await submitHubAccounts(state, hubIds, policy, decimals);
      autoJoinedCount += hubIds.length;
    }
  }
  assertCommittedAutoJoinCount({ requestedPerTarget: requested, targetCount: requiredTargets, committedCount: autoJoinedCount });
  const entityIds = targets.map(target => target.entityId);
  writeOnboardingCompleteForEntities(entityIds, true);
  localStorage.setItem('xln-display-name', displayName);
  return { autoJoinedCount, entityIds };
};
