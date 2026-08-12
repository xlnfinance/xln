import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';
import {
  defaultAccountDisputeConfigForRoleEvidence,
  type AccountRoleEvidence,
  type AccountRoleEvidenceSource,
} from '@xln/runtime/account/config/dispute-config';

import { normalizeEntityId } from '../../../utils/entityReplica';
import type { HubOpenAccountRebalancePolicy } from './../hub-discovery-profile';

export type OnboardingRuntimeTarget = {
  entityId: string;
  signerId: string;
  /** Exact signer-backed Entity role used to materialize bilateral clocks. */
  isHub: boolean;
  roleSource: AccountRoleEvidenceSource;
  jurisdiction?: string;
  jurisdictionKey?: string;
};

export type OnboardingHubCandidate = {
  entityId: string;
  jurisdiction?: string;
  jurisdictionKey?: string;
  runtimeId?: string | null;
  isHub?: boolean;
  roleSource?: AccountRoleEvidenceSource;
};

export type OnboardingRuntimeProjection = {
  targets: OnboardingRuntimeTarget[];
  suggestedDisplayName?: string;
  activeJurisdictionName?: string;
  hubCandidates: OnboardingHubCandidate[];
  accountCounterpartiesByEntityId: Record<string, string[]>;
  /** Independent committed-role index, including explicit false values. */
  committedRolesByEntityId: Record<string, boolean>;
};

export type BuildOnboardingProfileInputRequest = {
  targets: OnboardingRuntimeTarget[];
  displayName: string;
};

export type BuildOnboardingHubOpenInputRequest = {
  target: OnboardingRuntimeTarget;
  hubEntityIds: string[];
  /** Single authenticated role authority captured for each counterparty. */
  hubRoleEvidenceByEntityId: Record<string, AccountRoleEvidence>;
  committedRolesByEntityId: Record<string, boolean>;
  creditAmount: bigint;
  tokenId?: number;
  rebalancePolicy?: HubOpenAccountRebalancePolicy | null;
};

export type CommittedAutoJoinCount = {
  requestedPerTarget: number;
  targetCount: number;
  committedCount: number;
};

export type AdvertisedAutoJoinSelection = {
  required: boolean;
  hubEntityIds: string[];
};

const normalizeSignerId = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

function normalizeTarget(target: OnboardingRuntimeTarget, context: string): OnboardingRuntimeTarget {
  const entityId = normalizeEntityId(target.entityId);
  const signerId = normalizeSignerId(target.signerId);
  if (!entityId) throw new Error(`${context}: entity is required.`);
  if (!signerId) throw new Error(`${context}: signer is required.`);
  return {
    entityId,
    signerId,
    isHub: target.isHub,
    roleSource: target.roleSource,
    jurisdiction: String(target.jurisdiction || '').trim(),
    jurisdictionKey: String(target.jurisdictionKey || '').trim(),
  };
}

function uniqueTargets(targets: OnboardingRuntimeTarget[], context: string): OnboardingRuntimeTarget[] {
  const seen = new Set<string>();
  const out: OnboardingRuntimeTarget[] = [];
  for (const target of targets) {
    const normalized = normalizeTarget(target, context);
    const key = `${normalized.entityId}:${normalized.signerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  if (out.length === 0) throw new Error(`${context}: at least one runtime target is required.`);
  return out;
}

export function assertCommittedAutoJoinCount(counts: CommittedAutoJoinCount): number {
  const requestedPerTarget = Math.max(0, Math.floor(Number(counts.requestedPerTarget)));
  const targetCount = Math.max(0, Math.floor(Number(counts.targetCount)));
  const committedCount = Math.max(0, Math.floor(Number(counts.committedCount)));
  const expectedCount = requestedPerTarget * targetCount;
  if (committedCount !== expectedCount) {
    throw new Error(
      `ONBOARDING_AUTO_JOIN_INCOMPLETE:requested=${expectedCount}:committed=${committedCount}`,
    );
  }
  return committedCount;
}

export function selectAdvertisedAutoJoinCandidates(input: {
  requested: number;
  advertisedHubEntityIds: string[];
  eligibleHubEntityIds: string[];
}): AdvertisedAutoJoinSelection {
  const requested = Math.max(0, Math.floor(Number(input.requested)));
  const advertised = new Set(
    input.advertisedHubEntityIds.map(normalizeEntityId).filter(Boolean),
  );
  if (requested === 0 || advertised.size === 0) {
    return { required: false, hubEntityIds: [] };
  }

  const eligible = Array.from(new Map(
    input.eligibleHubEntityIds
      .map((entityId) => [normalizeEntityId(entityId), entityId] as const)
      .filter(([entityId]) => Boolean(entityId) && advertised.has(entityId)),
  ).values());
  if (eligible.length < requested) {
    throw new Error(
      `ONBOARDING_HUB_CAPACITY_INSUFFICIENT:requested=${requested}:found=${eligible.length}`,
    );
  }
  return { required: true, hubEntityIds: eligible.slice(0, requested) };
}

export function buildOnboardingProfileRuntimeInput(
  request: BuildOnboardingProfileInputRequest,
): RuntimeInput {
  const displayName = String(request.displayName || '').trim();
  if (displayName.length < 2) throw new Error('Onboarding profile name must be at least 2 characters.');

  return {
    runtimeTxs: [],
    entityInputs: uniqueTargets(request.targets, 'onboarding profile').map((target) => ({
      entityId: target.entityId,
      signerId: target.signerId,
      entityTxs: [{
        type: 'profile-update' as const,
        data: {
          profile: {
            entityId: target.entityId,
            name: displayName,
            bio: '',
            website: '',
          },
        },
      }],
    })),
  };
}

export function buildOnboardingHubOpenRuntimeInput(
  request: BuildOnboardingHubOpenInputRequest,
): RuntimeInput {
  const target = normalizeTarget(request.target, 'onboarding hub setup');
  const creditAmount = BigInt(request.creditAmount);
  const tokenId = Math.max(1, Math.floor(Number(request.tokenId ?? 1)));
  if (creditAmount <= 0n) throw new Error('Onboarding hub credit amount must be positive.');
  if (!Number.isFinite(tokenId) || tokenId <= 0) throw new Error('Onboarding hub token id must be positive.');

  const seen = new Set<string>();
  const hubEntityIds = request.hubEntityIds
    .map((hubId) => normalizeEntityId(hubId))
    .filter((hubId) => {
      if (!hubId || hubId === target.entityId || seen.has(hubId)) return false;
      seen.add(hubId);
      return true;
    });
  if (hubEntityIds.length === 0) throw new Error('Onboarding hub setup requires at least one hub.');
  const hubRoleEvidence = new Map(
    Object.entries(request.hubRoleEvidenceByEntityId).map(([entityId, evidence]) => [normalizeEntityId(entityId), evidence] as const),
  );
  const targetRoleEvidence: AccountRoleEvidence = {
    entityId: target.entityId,
    isHub: target.isHub,
    source: target.roleSource,
  };
  // Never manufacture committed authority from caller-supplied evidence. This
  // index comes from the independently projected Entity replicas and includes
  // false, so stale Hub gossip cannot override a committed User profile.
  const committedRoles = new Map(
    Object.entries(request.committedRolesByEntityId).map(([entityId, isHub]) => [normalizeEntityId(entityId), isHub] as const),
  );

  return {
    runtimeTxs: [],
    entityInputs: [{
      entityId: target.entityId,
      signerId: target.signerId,
      entityTxs: hubEntityIds.map((hubEntityId) => ({
        type: 'openAccount' as const,
        data: {
          targetEntityId: hubEntityId,
          disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
            targetRoleEvidence,
            (() => {
              const evidence = hubRoleEvidence.get(hubEntityId);
              if (!evidence) throw new Error(`Onboarding hub role missing: ${hubEntityId}`);
              if (normalizeEntityId(evidence.entityId) !== hubEntityId || evidence.isHub !== true) {
                throw new Error(`Onboarding hub role invalid: ${hubEntityId}`);
              }
              return evidence;
            })(),
            committedRoles,
          ),
          creditAmount,
          tokenId,
          ...(request.rebalancePolicy ? { rebalancePolicy: request.rebalancePolicy } : {}),
        },
      })),
    }],
  };
}

export const emptyOnboardingRuntimeProjection = (): OnboardingRuntimeProjection => ({
  targets: [],
  suggestedDisplayName: '',
  activeJurisdictionName: '',
  hubCandidates: [],
  accountCounterpartiesByEntityId: {},
  committedRolesByEntityId: {},
});
