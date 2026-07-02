import type { RuntimeInput } from '@xln/runtime/xln-api';

import { normalizeEntityId } from '../../utils/entityReplica';
import type { HubOpenAccountRebalancePolicy } from './hub-discovery-profile';

export type OnboardingRuntimeTarget = {
  entityId: string;
  signerId: string;
  jurisdiction?: string;
  jurisdictionKey?: string;
};

export type OnboardingHubCandidate = {
  entityId: string;
  jurisdiction?: string;
  jurisdictionKey?: string;
  runtimeId?: string | null;
  isHub?: boolean;
};

export type OnboardingRuntimeProjection = {
  targets: OnboardingRuntimeTarget[];
  suggestedDisplayName?: string;
  activeJurisdictionName?: string;
  hubCandidates: OnboardingHubCandidate[];
  accountCounterpartiesByEntityId: Record<string, string[]>;
};

export type BuildOnboardingProfileInputRequest = {
  targets: OnboardingRuntimeTarget[];
  displayName: string;
};

export type BuildOnboardingHubOpenInputRequest = {
  target: OnboardingRuntimeTarget;
  hubEntityIds: string[];
  creditAmount: bigint;
  tokenId?: number;
  rebalancePolicy?: HubOpenAccountRebalancePolicy | null;
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

  return {
    runtimeTxs: [],
    entityInputs: [{
      entityId: target.entityId,
      signerId: target.signerId,
      entityTxs: hubEntityIds.map((hubEntityId) => ({
        type: 'openAccount' as const,
        data: {
          targetEntityId: hubEntityId,
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
});
