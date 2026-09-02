import type {
  AccountReplica,
  EntityState,
  RuntimeReplica,
  EnvSnapshot,
  Profile as GossipProfile,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';
import { PersistentAccountStateMap } from '@xln/core/account/state/persistent-state-map';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '@xln/core/entity/state/persistent-account-map';
import type { EntityReplica } from '$lib/types/ui';
import { unwrapLiveRuntimeEnv } from '$lib/utils/runtime/liveRuntimeEnv';
import { projectEntityWorkspaceContext } from '../../../../../packages/runtime-client/src/entity-workspace-context';

export function materializeReplicaView(candidate: EntityReplica | null | undefined): EntityReplica | null {
  if (!candidate) return null;
  const materialized: EntityReplica = { ...candidate };
  if (candidate.state) materialized.state = { ...candidate.state };
  if (candidate.position) materialized.position = { ...candidate.position };
  return materialized;
}

export function materializeAccountView(candidate: AccountReplica | null | undefined): AccountReplica | null {
  if (!candidate) return null;
  const materialized: AccountReplica = {
    ...candidate,
    state: { ...candidate.state },
  };
  if (candidate.state.settlementWorkspace) {
    materialized.state.settlementWorkspace = { ...candidate.state.settlementWorkspace };
  }
  if (candidate.activeDispute) materialized.activeDispute = { ...candidate.activeDispute };
  return materialized;
}

export function materializeReplicaMap(
  source: Map<string, EntityReplica> | null | undefined,
): Map<string, EntityReplica> | null {
  if (!(source instanceof Map)) return null;
  return new Map(source);
}

export function getEnvReplicaMap(
  sourceEnv: RuntimeReplica | EnvSnapshot | null | undefined,
  _revision = '',
): Map<string, EntityReplica> | null {
  if (!sourceEnv) return null;
  return materializeReplicaMap(sourceEnv.state.eReplicas as Map<string, EntityReplica>);
}

export function findReplicaForEntityTab(
  replicas: Map<string, EntityReplica> | null | undefined,
  entityId: string,
  signerId: string,
): EntityReplica | null {
  if (!replicas || !entityId) return null;
  const exactKey = signerId ? `${entityId}:${signerId}` : '';
  const exact = exactKey ? materializeReplicaView(replicas.get(exactKey) ?? null) : null;
  if (exact) return exact;
  const normalizedEntityId = String(entityId || '').trim().toLowerCase();
  for (const [replicaKey, candidate] of replicas.entries()) {
    const [replicaEntityId] = String(replicaKey).split(':');
    if (String(replicaEntityId || '').trim().toLowerCase() === normalizedEntityId) {
      return materializeReplicaView(candidate);
    }
  }
  return null;
}

export type EntityPanelJurisdictionView = {
  name?: string;
};

export type EntityPanelView = {
  runtimeId: string | null;
  height: number;
  timestamp: number;
  activeJurisdictionName: string | null;
  replicas: Map<string, EntityReplica> | null;
  replica: EntityReplica | null;
  profiles: GossipProfile[];
  profileByEntityId: Map<string, GossipProfile>;
  entityNames: Map<string, string>;
  jurisdictions: EntityPanelJurisdictionView[];
  isDevnet: boolean;
};

type RuntimeProjectionActiveEntity = NonNullable<RuntimeAdapterViewFrame['activeEntity']>;
type RuntimeProjectionAccountDoc = RuntimeProjectionActiveEntity['accounts']['items'][number];

function normalizeEntityId(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function summaryProfile(summary: RuntimeAdapterEntitySummary | null | undefined): GossipProfile {
  const entityId = normalizeEntityId(summary?.entityId);
  const chainId = Number(summary?.jurisdiction?.chainId);
  const jurisdiction = summary?.jurisdiction?.name
    ? {
        name: String(summary.jurisdiction.name),
        ...(Number.isFinite(chainId) ? { chainId } : {}),
        ...(summary.jurisdiction.entityProviderAddress ? { entityProviderAddress: summary.jurisdiction.entityProviderAddress } : {}),
        ...(summary.jurisdiction.depositoryAddress ? { depositoryAddress: summary.jurisdiction.depositoryAddress } : {}),
      }
    : undefined;
  return {
    entityId,
    entityEncryptionPublicKey: '',
    name: String(summary?.label || entityId).trim(),
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: Math.max(0, Math.floor(Number(summary?.height || 0))),
    runtimeId: '',
    runtimeEncPubKey: '',
    publicAccounts: [],
    wsUrl: null,
    relays: [],
    metadata: {
      isHub: summary?.isHub === true,
      routingFeePPM: 0,
      baseFee: 0n,
      ...(jurisdiction ? { jurisdiction } : {}),
    },
    accounts: [],
  } as GossipProfile;
}

function runtimeProjectionAccountKey(entityId: string, account: RuntimeProjectionAccountDoc): string {
  const owner = normalizeEntityId(entityId);
  const left = normalizeEntityId(account.state.leftEntity);
  const right = normalizeEntityId(account.state.rightEntity);
  if (owner && left === owner && right) return right;
  if (owner && right === owner && left) return left;
  return right || left;
}

const projectedAccountRootForbidden = (): never => {
  throw new Error('UI_PROJECTED_ACCOUNT_ROOT_FORBIDDEN');
};

const projectionAccount = (doc: RuntimeProjectionAccountDoc): AccountReplica => {
  const {
    deltas,
    locks,
    swapOffers,
    pulls,
    subcontracts,
    lendingIntents,
    requestedRebalance,
    requestedRebalanceFeeState,
    rebalanceFeePolicies,
    ...boundedState
  } = doc.state;
  return {
    ...doc,
    state: {
      ...boundedState,
      deltas: PersistentAccountStateMap.fromEntries('deltas', deltas),
      locks: PersistentAccountStateMap.fromEntries('locks', locks),
      swapOffers: PersistentAccountStateMap.fromEntries('swapOffers', swapOffers),
      ...(pulls
      ? { pulls: PersistentAccountStateMap.fromEntries('pulls', pulls) }
      : {}),
      ...(subcontracts
      ? { subcontracts: PersistentAccountStateMap.fromEntries('subcontracts', subcontracts) }
      : {}),
      ...(lendingIntents
      ? { lendingIntents: PersistentAccountStateMap.fromEntries('lendingIntents', lendingIntents) }
      : {}),
      requestedRebalance: PersistentAccountStateMap.fromEntries(
      'requestedRebalance',
        requestedRebalance,
      ),
      requestedRebalanceFeeState: PersistentAccountStateMap.fromEntries(
      'requestedRebalanceFeeState',
        requestedRebalanceFeeState,
      ),
      ...(rebalanceFeePolicies
      ? {
          rebalanceFeePolicies: PersistentAccountStateMap.fromEntries(
            'rebalanceFeePolicies',
            rebalanceFeePolicies,
          ),
        }
      : {}),
    },
    pendingWithdrawals: PersistentAccountStateMap.fromEntries(
    'pendingWithdrawals',
    doc.pendingWithdrawals,
    ),
    shadow: {
      ...doc.shadow,
      rebalance: {
        ...doc.shadow.rebalance,
        policy: PersistentAccountStateMap.fromEntries(
        'rebalanceShadowPolicy',
        doc.shadow.rebalance.policy,
        ),
        submittedAtByToken: PersistentAccountStateMap.fromEntries(
        'rebalanceShadowSubmitted',
        doc.shadow.rebalance.submittedAtByToken,
        ),
      },
    },
  };
};

function activeEntityProjectionReplica(activeEntity: RuntimeProjectionActiveEntity): EntityReplica {
  const entityId = normalizeEntityId(activeEntity.core.entityId || activeEntity.summary.entityId);
  // A compact adapter page is deliberately not a committed Entity Account
  // root. The ephemeral candidate supplies the exact read API while its empty
  // base hash callback makes any accidental consensus-root use fail loudly.
  const accounts = new EntityAccountCandidateMap(
    PersistentEntityAccountMap.empty(entityId, projectedAccountRootForbidden),
  );
  for (const item of activeEntity.accounts.items ?? []) {
    const key = runtimeProjectionAccountKey(entityId, item);
    if (!key) continue;
    accounts.set(key, projectionAccount(item));
  }
  const core = activeEntity.core;
  const state: EntityState = {
    entityId,
    height: Math.max(0, Math.floor(Number(core.height ?? activeEntity.summary.height ?? 0))),
    timestamp: core.timestamp,
    nonces: core.nonces,
    proposals: core.proposals,
    config: core.config,
    entityEncryptionPublicKey: core.entityEncryptionPublicKey,
    reserves: core.reserves,
    accounts,
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    profile: core.profile,
    htlcRoutes: core.htlcRoutes,
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: core.lockBook,
    ...(core.entityCommandNonces === undefined ? {} : { entityCommandNonces: core.entityCommandNonces }),
    ...(core.prevFrameHash === undefined ? {} : { prevFrameHash: core.prevFrameHash }),
    ...(core.externalWallet === undefined ? {} : { externalWallet: core.externalWallet }),
    ...(core.deferredAccountProposals === undefined
      ? {}
      : { deferredAccountProposals: core.deferredAccountProposals }),
    ...(core.jBatchState === undefined ? {} : { jBatchState: core.jBatchState }),
    ...(core.outDebtsByToken === undefined ? {} : { outDebtsByToken: core.outDebtsByToken }),
    ...(core.inDebtsByToken === undefined ? {} : { inDebtsByToken: core.inDebtsByToken }),
    ...(core.swapTradingPairs === undefined ? {} : { swapTradingPairs: core.swapTradingPairs }),
    ...(core.crossJurisdictionSwaps === undefined
      ? {}
      : { crossJurisdictionSwaps: core.crossJurisdictionSwaps }),
    ...(core.pendingCrossJurisdictionFillAcks === undefined
      ? {}
      : { pendingCrossJurisdictionFillAcks: core.pendingCrossJurisdictionFillAcks }),
    ...(core.crossJurisdictionBookAdmissions === undefined
      ? {}
      : { crossJurisdictionBookAdmissions: core.crossJurisdictionBookAdmissions }),
    ...(core.hubRebalanceConfig === undefined ? {} : { hubRebalanceConfig: core.hubRebalanceConfig }),
  };
  return {
    entityId,
    signerId: String(activeEntity.core.signerId || activeEntity.summary.signerId || ''),
    isProposer: activeEntity.core.isProposer === true,
    mempool: [],
    state,
    ...(core.htlcNotes === undefined ? {} : { htlcNotes: core.htlcNotes }),
  };
}

function collectRuntimeProjectionJurisdictions(
  frame: RuntimeAdapterViewFrame,
  activeReplica: EntityReplica | null,
): EntityPanelJurisdictionView[] {
  const seen = new Set<string>();
  const jurisdictions: EntityPanelJurisdictionView[] = [];
  const add = (candidate: EntityPanelJurisdictionView | null | undefined): void => {
    const key = jurisdictionKey(candidate);
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (!candidate) return;
    jurisdictions.push(candidate);
  };
  add(activeReplica?.state?.config?.jurisdiction);
  for (const summary of frame.entities ?? []) add(summary.jurisdiction);
  return jurisdictions;
}

function buildEntityPanelViewFromRuntimeProjection(
  frame: RuntimeAdapterViewFrame | null | undefined,
  entityId: string,
  signerId: string,
  sourceEnv: RuntimeReplica | EnvSnapshot | null | undefined,
): EntityPanelView | null {
  if (!frame?.activeEntity) return null;
  const context = projectEntityWorkspaceContext({ runtimeId: getRuntimeId(sourceEnv), frame });
  if (context.status !== 'selected') return null;
  const requestedEntityId = normalizeEntityId(entityId || frame.activeEntityId || frame.activeEntity.summary.entityId);
  const activeEntityId = context.entityId;
  if (requestedEntityId && activeEntityId && requestedEntityId !== activeEntityId) return null;

  const replicas = new Map<string, EntityReplica>();
  const activeReplica = activeEntityProjectionReplica(frame.activeEntity);
  const activeKey = `${activeReplica.entityId}:${normalizeEntityId(activeReplica.signerId || signerId)}`;
  replicas.set(activeKey, activeReplica);

  const profiles = (frame.entities ?? []).map(summaryProfile);
  const entityNames = new Map<string, string>();
  const profileByEntityId = new Map<string, GossipProfile>();
  for (const profile of profiles) {
    const id = normalizeEntityId(profile.entityId);
    if (!id) continue;
    profileByEntityId.set(id, profile);
    const name = String(profile.name || '').trim();
    if (name) entityNames.set(id, name);
  }
  const activeProfileName = String(activeReplica.state?.profile?.name || '').trim();
  if (activeReplica.entityId && activeProfileName) entityNames.set(activeReplica.entityId, activeProfileName);

  const jurisdictions = collectRuntimeProjectionJurisdictions(frame, activeReplica);
  return {
    runtimeId: context.runtimeId,
    height: context.height,
    timestamp: Math.max(0, Math.floor(Number(activeReplica.state?.timestamp ?? sourceEnv?.state.timestamp ?? 0))),
    activeJurisdictionName: context.jurisdictionName || getCurrentEntityJurisdictionName(sourceEnv, activeReplica),
    replicas,
    replica: findReplicaForEntityTab(replicas, activeReplica.entityId, activeReplica.signerId || signerId),
    profiles,
    profileByEntityId,
    entityNames,
    jurisdictions,
    isDevnet: jurisdictions.some((jurisdiction) => Number((jurisdiction as { chainId?: unknown })?.chainId ?? 0) === 31337),
  };
}

export function buildEntityPanelView(
  sourceEnv: RuntimeReplica | EnvSnapshot | null | undefined,
  entityId: string,
  signerId: string,
  revision = '',
  runtimeProjectionFrame?: RuntimeAdapterViewFrame | null,
): EntityPanelView {
  const projected = buildEntityPanelViewFromRuntimeProjection(runtimeProjectionFrame, entityId, signerId, sourceEnv);
  if (projected) return projected;

  const replicas = getEnvReplicaMap(sourceEnv, revision);
  const profiles = getGossipProfiles(sourceEnv);
  const entityNames = new Map<string, string>();
  const profileByEntityId = new Map<string, GossipProfile>();
  for (const profile of profiles) {
    const entityId = String(profile?.entityId || '').trim().toLowerCase();
    const name = String(profile?.name || '').trim();
    if (entityId && name) entityNames.set(entityId, name);
    if (entityId) profileByEntityId.set(entityId, profile);
  }
  for (const replica of replicas?.values?.() ?? []) {
    const replicaEntityId = String(replica?.entityId || replica?.state?.entityId || '').trim().toLowerCase();
    const profileName = String(replica?.state?.profile?.name || '').trim();
    if (replicaEntityId && profileName && !entityNames.has(replicaEntityId)) {
      entityNames.set(replicaEntityId, profileName);
    }
  }
  return {
    runtimeId: getRuntimeId(sourceEnv),
    height: Number(sourceEnv?.state.height ?? 0),
    timestamp: Math.max(0, Math.floor(Number(sourceEnv?.state.timestamp ?? 0))),
    activeJurisdictionName: getActiveJurisdictionName(sourceEnv),
    replicas,
    replica: findReplicaForEntityTab(replicas, entityId, signerId),
    profiles,
    profileByEntityId,
    entityNames,
    jurisdictions: sourceEnv?.state.jReplicas ? Array.from(sourceEnv.state.jReplicas.values()) as EntityPanelJurisdictionView[] : [],
    isDevnet: hasDevnetJurisdiction(sourceEnv),
  };
}

export function hasDevnetJurisdiction(sourceEnv: RuntimeReplica | EnvSnapshot | null | undefined): boolean {
  if (!sourceEnv?.state.jReplicas) return false;
  for (const [, replica] of sourceEnv.state.jReplicas.entries()) {
    if (Number(replica?.chainId ?? 0) === 31337) return true;
  }
  return false;
}

export function getRuntimeEnv(env: RuntimeReplica | EnvSnapshot | null | undefined): RuntimeReplica | null {
  return unwrapLiveRuntimeEnv(env);
}

export function requireRuntimeEnv(env: RuntimeReplica | EnvSnapshot | null | undefined, context: string): RuntimeReplica {
  const runtimeEnv = getRuntimeEnv(env);
  if (!runtimeEnv) throw new Error(`${context} requires live runtime environment`);
  return runtimeEnv;
}

export function getRuntimeId(env: RuntimeReplica | EnvSnapshot | null | undefined): string | null {
  const runtimeId = env?.runtimeId;
  return typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : null;
}

export function getActiveJurisdictionName(env: RuntimeReplica | EnvSnapshot | null | undefined): string | null {
  if (!env || !('activeJurisdiction' in env)) return null;
  return typeof env.activeJurisdiction === 'string' && env.activeJurisdiction.length > 0
    ? env.activeJurisdiction
    : null;
}

type JurisdictionLike = {
  name?: unknown;
  chainId?: unknown;
  depositoryAddress?: unknown;
};

export function jurisdictionKey(value: unknown): string {
  if (value && typeof value === 'object') {
    const jurisdiction = value as JurisdictionLike;
    const chainId = String(jurisdiction.chainId ?? '').trim();
    const depository = String(jurisdiction.depositoryAddress ?? '').trim().toLowerCase();
    if (chainId && depository) return `dep:${chainId}:${depository}`;
    if (chainId) return `chain:${chainId}`;
    return String(jurisdiction.name || '').trim().toLowerCase();
  }
  return String(value || '').trim().toLowerCase();
}

export function getCurrentEntityJurisdictionName(
  env: RuntimeReplica | EnvSnapshot | null | undefined,
  replica: EntityReplica | null | undefined,
): string | null {
  const configured = String(replica?.state?.config?.jurisdiction?.name || '').trim();
  return configured || getActiveJurisdictionName(env);
}

export function getCurrentEntityJurisdictionKey(
  env: RuntimeReplica | EnvSnapshot | null | undefined,
  replica: EntityReplica | null | undefined,
): string {
  return jurisdictionKey(replica?.state?.config?.jurisdiction)
    || jurisdictionKey(replica?.position?.jurisdiction)
    || jurisdictionKey(getActiveJurisdictionName(env));
}

export function getEntityJurisdictionKey(
  env: RuntimeReplica | EnvSnapshot | null | undefined,
  entityId: string,
): string {
  const normalized = String(entityId || '').trim().toLowerCase();
  if (!normalized) return '';

  const fromReplicas = getEntityJurisdictionKeyFromReplicas(
    env?.state.eReplicas as Map<string, EntityReplica> | null | undefined,
    normalized,
  );
  if (fromReplicas) return fromReplicas;

  const profile = getGossipProfiles(env).find((candidate) =>
    String(candidate?.entityId || '').trim().toLowerCase() === normalized
  );
  return jurisdictionKey(profile?.metadata?.jurisdiction);
}

export function getEntityJurisdictionKeyFromReplicas(
  replicas: Map<string, EntityReplica> | null | undefined,
  entityId: string,
): string {
  const normalized = String(entityId || '').trim().toLowerCase();
  if (!normalized || !(replicas instanceof Map)) return '';
  for (const [key, candidate] of replicas.entries()) {
    const [candidateEntityId] = String(key || '').split(':');
    const stateEntityId = String(candidate?.entityId || candidate?.state?.entityId || '').trim().toLowerCase();
    if (String(candidateEntityId || '').trim().toLowerCase() !== normalized && stateEntityId !== normalized) continue;
    return jurisdictionKey(candidate?.state?.config?.jurisdiction)
      || jurisdictionKey(candidate?.position?.jurisdiction);
  }
  return '';
}

export function isSameJurisdictionEntity(
  env: RuntimeReplica | EnvSnapshot | null | undefined,
  replica: EntityReplica | null | undefined,
  expectedEntityId: string,
  leftEntityId: string,
  rightEntityId: string,
): boolean {
  const currentEntityId = String(replica?.state?.entityId || expectedEntityId || '').trim().toLowerCase();
  const normalizedLeftEntityId = String(leftEntityId || '').trim().toLowerCase();
  const normalizedRightEntityId = String(rightEntityId || '').trim().toLowerCase();
  const leftJurisdiction = normalizedLeftEntityId === currentEntityId
    ? getCurrentEntityJurisdictionKey(env, replica)
    : getEntityJurisdictionKey(env, leftEntityId);
  const rightJurisdiction = normalizedRightEntityId === currentEntityId
    ? getCurrentEntityJurisdictionKey(env, replica)
    : getEntityJurisdictionKey(env, rightEntityId);
  if (!leftJurisdiction || !rightJurisdiction) return true;
  return leftJurisdiction === rightJurisdiction;
}

export function isSameJurisdictionEntityInReplicas(
  replicas: Map<string, EntityReplica> | null | undefined,
  replica: EntityReplica | null | undefined,
  expectedEntityId: string,
  leftEntityId: string,
  rightEntityId: string,
): boolean {
  const currentEntityId = String(replica?.state?.entityId || expectedEntityId || '').trim().toLowerCase();
  const normalizedLeftEntityId = String(leftEntityId || '').trim().toLowerCase();
  const normalizedRightEntityId = String(rightEntityId || '').trim().toLowerCase();
  const leftJurisdiction = normalizedLeftEntityId === currentEntityId
    ? getCurrentEntityJurisdictionKey(null, replica)
    : getEntityJurisdictionKeyFromReplicas(replicas, leftEntityId);
  const rightJurisdiction = normalizedRightEntityId === currentEntityId
    ? getCurrentEntityJurisdictionKey(null, replica)
    : getEntityJurisdictionKeyFromReplicas(replicas, rightEntityId);
  if (!leftJurisdiction || !rightJurisdiction) return true;
  return leftJurisdiction === rightJurisdiction;
}

export function getGossipProfiles(env: RuntimeReplica | EnvSnapshot | null | undefined): GossipProfile[] {
  if (!env?.gossip) return [];
  if ('getProfiles' in env.gossip && typeof env.gossip.getProfiles === 'function') {
    return env.gossip.getProfiles();
  }
  return Array.isArray(env.gossip.profiles) ? env.gossip.profiles : [];
}

export function isHubProfile(profile: GossipProfile | undefined): boolean {
  return profile ? profile.metadata.isHub === true : false;
}

export function resolveAccountCounterparty(entityId: string, account: AccountReplica): string {
  return account.state.leftEntity.toLowerCase() === entityId.toLowerCase()
    ? account.state.rightEntity
    : account.state.leftEntity;
}

export function findLocalAccountByCounterparty(
  entityId: string,
  accounts: ReadonlyMap<string, AccountReplica> | undefined,
  counterpartyId: string | undefined,
): AccountReplica | null {
  if (!counterpartyId || !accounts) return null;
  const needle = counterpartyId.toLowerCase();
  for (const [accountKey, account] of accounts.entries()) {
    if (accountKey.toLowerCase() === needle) return account;
    if (resolveAccountCounterparty(entityId, account).toLowerCase() === needle) return account;
  }
  return null;
}

export function isAccountLeftPerspective(entityId: string, account: AccountReplica): boolean {
  const owner = String(entityId || '').trim().toLowerCase();
  const left = String(account.state.leftEntity || '').trim().toLowerCase();
  const right = String(account.state.rightEntity || '').trim().toLowerCase();
  if (owner === left) return true;
  if (owner === right) return false;
  throw new Error(`Account perspective mismatch: owner=${entityId} left=${account.state.leftEntity} right=${account.state.rightEntity}`);
}
