import { formatEntityId } from '$lib/utils/format';
import type { EntityReplica } from '$lib/types/ui';
import type {
  BookState,
  CrossJurisdictionSwapRoute,
  EntityState,
  EntityTx,
  Env,
  EnvSnapshot,
  Profile as GossipProfile,
  RuntimeInput,
} from '@xln/runtime/xln-api';

export type TokenKeyedMap<V> = Map<number, V> | Map<string, V>;
export type TokenSymbolFormatter = (tokenIdValue: number) => string;
export type HubCandidatePredicate = (entityIdValue: string) => boolean;
export type CrossSwapSetupStepId = 'target-account' | 'target-credit';
export type SwapPanelReplicaView = {
  key: string;
  entityId: string;
  signerId: string;
  replica: EntityReplica;
};

export type SwapPanelProjectionSource = {
  profiles?: readonly GossipProfile[] | Map<string, GossipProfile> | null;
  entityNames?: Map<string, string> | null;
  replicas?: Map<string, EntityReplica> | readonly EntityReplica[] | null;
};
export type SwapPanelFrame = Env | EnvSnapshot | EntityState | SwapPanelProjectionSource | null | undefined;

type SwapGossipSource = {
  gossip?: {
    getProfiles?: () => GossipProfile[];
    profiles?: GossipProfile[] | Map<string, GossipProfile>;
  };
};

export type SwapPanelRuntimeView = {
  profiles: GossipProfile[];
  entityNames: Map<string, string>;
  localReplicas: EntityReplica[];
  localReplicaEntries: SwapPanelReplicaView[];
  getHubProfile: (entityIdValue: string) => GossipProfile | null;
  isHubEntity: HubCandidatePredicate;
  getPairBook: (hubEntityId: string, pairIdValue: string) => BookState | null;
};

export type CrossSwapSetupStep = {
  id: CrossSwapSetupStepId;
  label: string;
  detail: string;
};

export type CrossTargetSetupTx =
  | {
      type: 'openAccount';
      data: {
        targetEntityId: string;
        tokenId: number;
        creditAmount: bigint;
      };
    }
  | {
      type: 'extendCredit';
      data: {
        counterpartyEntityId: string;
        tokenId: number;
        amount: bigint;
      };
    };

export type CrossSwapRuntimeInputPlan = {
  input: RuntimeInput;
  targetSetupTxs: EntityTx[];
};

export function normalizeEntityId(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function readProjectionProfiles(frame: SwapPanelFrame): GossipProfile[] | null {
  const profiles = (frame as SwapPanelProjectionSource | null | undefined)?.profiles;
  if (profiles instanceof Map) return Array.from(profiles.values());
  if (Array.isArray(profiles)) return [...profiles];
  return null;
}

function readSwapGossipProfiles(frame: SwapPanelFrame): GossipProfile[] {
  const projectionProfiles = readProjectionProfiles(frame);
  if (projectionProfiles !== null) return projectionProfiles;
  const source = frame as SwapGossipSource | null | undefined;
  if (!source?.gossip) return [];
  if (typeof source.gossip.getProfiles === 'function') return source.gossip.getProfiles();
  if (source.gossip.profiles instanceof Map) return Array.from(source.gossip.profiles.values());
  return Array.isArray(source.gossip.profiles) ? source.gossip.profiles : [];
}

function replicaMapFromArray(replicas: readonly EntityReplica[]): Map<string, EntityReplica> {
  const mapped = new Map<string, EntityReplica>();
  for (const replica of replicas) {
    const entityId = normalizeEntityId(replica?.entityId || replica?.state?.entityId || '');
    if (!entityId) continue;
    const signerId = normalizeEntityId(replica?.signerId || '');
    mapped.set(signerId ? `${entityId}:${signerId}` : entityId, replica);
  }
  return mapped;
}

function readSwapReplicaMap(frame: SwapPanelFrame): Map<string, EntityReplica> | null {
  const projectionReplicas = (frame as SwapPanelProjectionSource | null | undefined)?.replicas;
  if (projectionReplicas instanceof Map) return projectionReplicas as Map<string, EntityReplica>;
  if (Array.isArray(projectionReplicas)) return replicaMapFromArray(projectionReplicas);
  const source = frame as { eReplicas?: unknown } | null | undefined;
  return source?.eReplicas instanceof Map ? source.eReplicas as Map<string, EntityReplica> : null;
}

function materializeSwapReplica(candidate: EntityReplica): EntityReplica {
  const replica: EntityReplica = { ...candidate };
  if (candidate.state) {
    replica.state = { ...candidate.state };
    if (candidate.state.accounts instanceof Map) replica.state.accounts = new Map(candidate.state.accounts);
    const orderbookExt = candidate.state.orderbookExt;
    const books = orderbookExt?.books;
    if (orderbookExt && books instanceof Map) {
      replica.state.orderbookExt = {
        ...orderbookExt,
        books: new Map(books),
      };
    }
  }
  if (candidate.position) replica.position = { ...candidate.position };
  return replica;
}

function buildSwapReplicaViews(frame: SwapPanelFrame): SwapPanelReplicaView[] {
  const replicas = readSwapReplicaMap(frame);
  if (!replicas) return [];
  const seen = new Set<string>();
  const out: SwapPanelReplicaView[] = [];
  for (const [key, candidate] of replicas.entries()) {
    if (!candidate?.state) continue;
    const entityId = normalizeEntityId(candidate.entityId || String(key || '').split(':')[0] || candidate.state.entityId || '');
    if (!entityId || seen.has(entityId)) continue;
    seen.add(entityId);
    out.push({
      key: String(key || ''),
      entityId,
      signerId: normalizeEntityId(candidate.signerId || ''),
      replica: materializeSwapReplica(candidate),
    });
  }
  return out;
}

function buildSwapEntityNames(profiles: GossipProfile[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const profile of profiles) {
    const entityId = normalizeEntityId(profile?.entityId || '');
    const name = String(profile?.name || '').trim();
    if (entityId && name) names.set(entityId, name);
  }
  return names;
}

function buildSwapProjectionEntityNames(frame: SwapPanelFrame, profiles: GossipProfile[]): Map<string, string> {
  const names = buildSwapEntityNames(profiles);
  const sourceNames = (frame as SwapPanelProjectionSource | null | undefined)?.entityNames;
  if (!(sourceNames instanceof Map)) return names;

  for (const [key, value] of sourceNames.entries()) {
    const entityId = normalizeEntityId(key);
    const name = String(value || '').trim();
    if (entityId && name) names.set(entityId, name);
  }
  return names;
}

export function buildSwapPanelRuntimeView(frame: SwapPanelFrame): SwapPanelRuntimeView {
  const profiles = readSwapGossipProfiles(frame);
  const entityNames = buildSwapProjectionEntityNames(frame, profiles);
  const localReplicaEntries = buildSwapReplicaViews(frame);
  const replicaMap = readSwapReplicaMap(frame);

  const getHubProfile = (entityIdValue: string): GossipProfile | null => {
    const normalized = normalizeEntityId(entityIdValue);
    if (!normalized) return null;
    return profiles.find((profile) =>
      profile?.metadata?.isHub === true
      && normalizeEntityId(profile?.entityId || '') === normalized
    ) || null;
  };

  const getPairBook = (hubEntityId: string, pairIdValue: string): BookState | null => {
    if (!replicaMap) return null;
    const normalizedHubId = normalizeEntityId(hubEntityId);
    const normalizedPairId = String(pairIdValue || '').trim();
    if (!normalizedHubId || !normalizedPairId) return null;
    for (const [key, replica] of replicaMap.entries()) {
      const entityId = normalizeEntityId(String(key || '').split(':')[0] || replica?.entityId || replica?.state?.entityId || '');
      if (entityId !== normalizedHubId) continue;
      return replica?.state?.orderbookExt?.books?.get?.(normalizedPairId) || null;
    }
    return null;
  };

  return {
    profiles,
    entityNames,
    localReplicas: localReplicaEntries.map((entry) => entry.replica),
    localReplicaEntries,
    getHubProfile,
    isHubEntity: (entityIdValue: string) => getHubProfile(entityIdValue) !== null,
    getPairBook,
  };
}

export function resolveHubIdCandidate(
  candidate: string,
  knownHubIds: string[],
  isHubCandidate: HubCandidatePredicate,
): string {
  const normalized = normalizeEntityId(candidate);
  if (!normalized) return '';

  const matchedAccount = knownHubIds.find((id) => normalizeEntityId(id) === normalized);
  if (matchedAccount) return matchedAccount;

  return isHubCandidate(normalized) ? normalized : '';
}

export function firstAvailableHubId(
  knownHubIds: string[],
  candidates: string[],
  isHubCandidate: HubCandidatePredicate,
): string {
  for (const candidate of candidates) {
    const resolved = resolveHubIdCandidate(candidate, knownHubIds, isHubCandidate);
    if (resolved) return resolved;
  }
  return knownHubIds[0] || '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeJurisdictionDisplayName(value: unknown): string {
  return String(value || '').trim();
}

export function stripJurisdictionSuffix(name: string, jurisdiction: string): string {
  const cleanName = String(name || '').trim();
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  if (!cleanName || !cleanJurisdiction) return cleanName;

  return cleanName
    .replace(new RegExp(`\\s*\\(${escapeRegExp(cleanJurisdiction)}\\)\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s+${escapeRegExp(cleanJurisdiction)}\\s*$`, 'i'), '')
    .trim() || cleanName;
}

export function formatEntityNetworkLabel(name: string, jurisdiction: string): string {
  const cleanName = stripJurisdictionSuffix(String(name || '').trim() || 'Unknown', jurisdiction);
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  return cleanJurisdiction ? `${cleanName} (${cleanJurisdiction})` : cleanName;
}

export function parseCrossAssetKey(value: string): { jurisdictionRef: string; tokenId: number } | null {
  const match = String(value || '').trim().match(/^(.+):(\d+)$/);
  if (!match) return null;

  const tokenIdValue = Number(match[2]);
  if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return null;

  return {
    jurisdictionRef: String(match[1] || '').trim(),
    tokenId: Math.floor(tokenIdValue),
  };
}

export function tokenNetworkLabel(
  tokenIdValue: number,
  jurisdiction: string,
  tokenSymbol: TokenSymbolFormatter,
): string {
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  return cleanJurisdiction ? `${tokenSymbol(tokenIdValue)} (${cleanJurisdiction})` : tokenSymbol(tokenIdValue);
}

export function sameOrderbookPairLabel(
  baseTokenIdValue: number,
  quoteTokenIdValue: number,
  jurisdiction: string,
  tokenSymbol: TokenSymbolFormatter,
): string {
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  const pair = `${tokenSymbol(baseTokenIdValue)}-${tokenSymbol(quoteTokenIdValue)}`;
  return cleanJurisdiction ? `${pair} (${cleanJurisdiction})` : pair;
}

export function crossOrderbookPairLabel(
  baseTokenIdValue: number,
  baseJurisdiction: string,
  quoteTokenIdValue: number,
  quoteJurisdiction: string,
  tokenSymbol: TokenSymbolFormatter,
): string {
  return `${tokenNetworkLabel(baseTokenIdValue, baseJurisdiction, tokenSymbol)} - ${tokenNetworkLabel(quoteTokenIdValue, quoteJurisdiction, tokenSymbol)}`;
}

export function entityInitials(entityIdValue: string, fallbackLabel = ''): string {
  const label = String(fallbackLabel || '').trim();
  if (label) return label.slice(0, 2).toUpperCase();
  return formatEntityId(entityIdValue).slice(0, 2).toUpperCase();
}

export function jurisdictionBadgeText(jurisdiction: string): string {
  const clean = normalizeJurisdictionDisplayName(jurisdiction).replace(/[^a-zA-Z0-9\s._-]/g, ' ');
  if (!clean) return 'J';

  const words = clean
    .split(/[\s._-]+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean);
  if (words.length >= 2) return `${words[0]?.[0] || ''}${words[1]?.[0] || ''}`.toUpperCase();
  return (words[0] || clean).slice(0, 2).toUpperCase();
}

export function getTokenMapValue<V>(map: TokenKeyedMap<V> | undefined, tokenIdValue: number): V | undefined {
  if (!(map instanceof Map) || !Number.isFinite(tokenIdValue)) return undefined;
  const byNumber = (map as Map<number, V>).get(tokenIdValue);
  if (byNumber !== undefined) return byNumber;
  return (map as Map<string, V>).get(String(tokenIdValue));
}

export function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

export function buildCrossSwapSetupSteps(input: {
  routeMode: 'same' | 'cross';
  targetAccountReady: boolean;
  canOpenTargetAccount: boolean;
  needsCreditLimit: boolean;
  targetHubLabel: string;
  targetJurisdictionLabel: string;
  creditLimitLabel: string;
  creditIncreaseLabel: string;
  tokenSymbol: string;
}): CrossSwapSetupStep[] {
  if (input.routeMode !== 'cross') return [];

  const steps: CrossSwapSetupStep[] = [];
  const hubLabel = String(input.targetHubLabel || '').trim() || 'target hub';
  const jurisdictionLabel = String(input.targetJurisdictionLabel || '').trim() || 'target network';
  const tokenSymbol = String(input.tokenSymbol || '').trim() || 'token';

  if (!input.targetAccountReady && input.canOpenTargetAccount) {
    steps.push({
      id: 'target-account',
      label: 'Create target account',
      detail: `Open ${jurisdictionLabel} account with ${hubLabel}.`,
    });
  }

  if (input.needsCreditLimit && (input.targetAccountReady || input.canOpenTargetAccount)) {
    const limit = String(input.creditLimitLabel || '').trim();
    const increase = String(input.creditIncreaseLabel || '').trim();
    const detail = limit
      ? `Set inbound ${tokenSymbol} credit to ${limit}${increase ? ` (${increase})` : ''}.`
      : `Set enough inbound ${tokenSymbol} credit for this swap.`;
    steps.push({
      id: 'target-credit',
      label: 'Set inbound credit limit',
      detail,
    });
  }

  return steps;
}

export function buildCrossTargetSetupTxs(input: {
  shouldOpenAccount: boolean;
  shouldExtendCredit: boolean;
  targetHubEntityId: string;
  tokenId: number;
  requiredCreditLimit: bigint | null;
}): CrossTargetSetupTx[] {
  const targetHubEntityId = String(input.targetHubEntityId || '').trim();
  if (!targetHubEntityId) return [];

  if (input.shouldOpenAccount) {
    if (input.requiredCreditLimit === null || input.requiredCreditLimit <= 0n) {
      throw new Error('Target account setup requires a positive inbound credit limit.');
    }
    return [{
      type: 'openAccount',
      data: {
        targetEntityId: targetHubEntityId,
        tokenId: input.tokenId,
        creditAmount: input.requiredCreditLimit,
      },
    }];
  }

  if (!input.shouldExtendCredit || input.requiredCreditLimit === null) return [];
  return [{
    type: 'extendCredit',
    data: {
      counterpartyEntityId: targetHubEntityId,
      tokenId: input.tokenId,
      amount: input.requiredCreditLimit,
    },
  }];
}

export function buildCrossSwapRuntimeInputPlan(input: {
  sourceEntityId: string;
  sourceSignerId: string;
  route: CrossJurisdictionSwapRoute;
  targetEntityId: string;
  targetSignerId: string;
  targetHubEntityId: string;
  tokenId: number;
  requiredCreditLimit: bigint | null;
  shouldOpenTargetAccount: boolean;
  shouldExtendTargetCredit: boolean;
}): CrossSwapRuntimeInputPlan {
  const sourceEntityId = normalizeEntityId(input.sourceEntityId);
  const sourceSignerId = String(input.sourceSignerId || '').trim();
  const targetEntityId = normalizeEntityId(input.targetEntityId);
  const targetSignerId = String(input.targetSignerId || '').trim();
  if (!sourceEntityId) throw new Error('Cross swap source entity is required.');
  if (!sourceSignerId) throw new Error('Cross swap source signer is required.');
  if (!targetEntityId) throw new Error('Cross swap target entity is required.');
  if (!targetSignerId) throw new Error('Cross swap target signer is required.');

  const targetSetupTxs = buildCrossTargetSetupTxs({
    shouldOpenAccount: input.shouldOpenTargetAccount,
    shouldExtendCredit: input.shouldExtendTargetCredit,
    targetHubEntityId: input.targetHubEntityId,
    tokenId: input.tokenId,
    requiredCreditLimit: input.requiredCreditLimit,
  }) as EntityTx[];

  const setupInput: RuntimeInput | null = targetSetupTxs.length > 0
    ? {
        runtimeTxs: [],
        entityInputs: [{
          entityId: targetEntityId,
          signerId: targetSignerId,
          entityTxs: targetSetupTxs,
        }],
      }
    : null;

  const requestInput: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [{
      entityId: sourceEntityId,
      signerId: sourceSignerId,
      entityTxs: [{
        type: 'requestCrossJurisdictionSwap',
        data: { route: input.route },
      }],
    }],
  };

  return {
    input: {
      runtimeTxs: [],
      entityInputs: [
        ...(setupInput?.entityInputs ?? []),
        ...requestInput.entityInputs,
      ],
    },
    targetSetupTxs,
  };
}
