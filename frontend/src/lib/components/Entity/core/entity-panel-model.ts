import type {
  RuntimeReplica,
  EnvSnapshot,
  Profile as GossipProfile,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
  EntityReplica,
} from '@xln/core/api/public/runtime-module';
import type { AccountReadView, EntityReadState, EntityReadView } from './entity-panel-types';
import { unwrapLiveRuntimeEnv } from '#lib/utils/runtime/liveRuntimeEnv.ts';

export function materializeReplicaView<T extends EntityReadView>(candidate: T | null | undefined): T | null {
  if (!candidate) return null;
  const materialized = { ...candidate };
  if (candidate.state) materialized.state = { ...candidate.state };
  if (candidate.position) materialized.position = { ...candidate.position };
  return materialized;
}

export function materializeAccountView(candidate: AccountReadView | null | undefined): AccountReadView | null {
  if (!candidate) return null;
  const materialized: AccountReadView = {
    ...candidate,
    state: { ...candidate.state },
  };
  if (candidate.state.settlementWorkspace) {
    materialized.state.settlementWorkspace = { ...candidate.state.settlementWorkspace };
  }
  if (candidate.activeDispute) materialized.activeDispute = { ...candidate.activeDispute };
  return materialized;
}

export function materializeReplicaMap<T extends EntityReadView>(
  source: Map<string, T> | null | undefined,
): Map<string, T> | null {
  if (!(source instanceof Map)) return null;
  return new Map(source);
}

export function getEnvReplicaMap(
  sourceEnv: RuntimeReplica | EnvSnapshot | null | undefined,
  _revision = '',
): Map<string, EntityReplica> | null {
  if (!sourceEnv) return null;
  return materializeReplicaMap(sourceEnv.state.eReplicas);
}

export function findReplicaForEntityTab<T extends EntityReadView>(
  replicas: Map<string, T> | null | undefined,
  entityId: string,
  signerId: string,
): T | null {
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
  replicas: Map<string, EntityReadView> | null;
  replica: EntityReadView | null;
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

function activeEntityProjectionReplica(activeEntity: RuntimeProjectionActiveEntity): EntityReadView {
  const entityId = normalizeEntityId(activeEntity.core.entityId || activeEntity.summary.entityId);
  // The page remains a read view: no Patricia reconstruction or consensus-root API.
  const accounts = new Map<string, AccountReadView>();
  for (const item of activeEntity.accounts.items ?? []) {
    const key = runtimeProjectionAccountKey(entityId, item);
    if (!key) continue;
    accounts.set(key, item);
  }
  const core = activeEntity.core;
  const state: EntityReadState = {
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
    paybook: core.paybook,
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
    ...(core.crossJurisdictionBookAdmissions === undefined
      ? {}
      : { crossJurisdictionBookAdmissions: core.crossJurisdictionBookAdmissions }),
    ...(core.hubRebalanceConfig === undefined ? {} : { hubRebalanceConfig: core.hubRebalanceConfig }),
  };
  return {
    entityId,
    signerId: String(activeEntity.core.signerId || activeEntity.summary.signerId || ''),
    isProposer: activeEntity.core.isProposer === true,
    state,
  };
}

function collectRuntimeProjectionJurisdictions(
  frame: RuntimeAdapterViewFrame,
  activeReplica: EntityReadView | null,
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
  const requestedEntityId = normalizeEntityId(entityId || frame.activeEntityId || frame.activeEntity.summary.entityId);
  const activeEntityId = normalizeEntityId(frame.activeEntity.summary.entityId || frame.activeEntity.core.entityId);
  if (requestedEntityId && activeEntityId && requestedEntityId !== activeEntityId) return null;

  const replicas = new Map<string, EntityReadView>();
  const activeReplica = activeEntityProjectionReplica(frame.activeEntity);
  const activeKey = `${activeReplica.entityId}:${normalizeEntityId(activeReplica.signerId || signerId)}`;
  replicas.set(activeKey, activeReplica);

  const transportProfiles = new Map(getGossipProfiles(sourceEnv).map(profile => [normalizeEntityId(profile.entityId), profile]));
  const profiles = (frame.entities ?? []).map(summary => ({
    ...summaryProfile(summary),
    // Transport identity belongs to Gossip; a financial summary does not contain it.
    runtimeId: transportProfiles.get(normalizeEntityId(summary.entityId))?.runtimeId ?? '',
  }));
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
    runtimeId: getRuntimeId(sourceEnv),
    height: Math.max(0, Math.floor(Number(frame.height || 0))),
    timestamp: Math.max(0, Math.floor(Number(activeReplica.state?.timestamp ?? sourceEnv?.state.timestamp ?? 0))),
    activeJurisdictionName: getCurrentEntityJurisdictionName(sourceEnv, activeReplica),
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
  replica: EntityReadView | null | undefined,
): string | null {
  const configured = String(replica?.state?.config?.jurisdiction?.name || '').trim();
  return configured || getActiveJurisdictionName(env);
}

export function getCurrentEntityJurisdictionKey(
  env: RuntimeReplica | EnvSnapshot | null | undefined,
  replica: EntityReadView | null | undefined,
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
    env?.state.eReplicas as Map<string, EntityReadView> | null | undefined,
    normalized,
  );
  if (fromReplicas) return fromReplicas;

  const profile = getGossipProfiles(env).find((candidate) =>
    String(candidate?.entityId || '').trim().toLowerCase() === normalized
  );
  return jurisdictionKey(profile?.metadata?.jurisdiction);
}

export function getEntityJurisdictionKeyFromReplicas(
  replicas: Map<string, EntityReadView> | null | undefined,
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
  replica: EntityReadView | null | undefined,
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
  replicas: Map<string, EntityReadView> | null | undefined,
  replica: EntityReadView | null | undefined,
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

export function resolveAccountCounterparty(entityId: string, account: AccountReadView): string {
  return account.state.leftEntity.toLowerCase() === entityId.toLowerCase()
    ? account.state.rightEntity
    : account.state.leftEntity;
}

export function findLocalAccountByCounterparty(
  entityId: string,
  accounts: ReadonlyMap<string, AccountReadView> | undefined,
  counterpartyId: string | undefined,
): AccountReadView | null {
  if (!counterpartyId || !accounts) return null;
  const needle = counterpartyId.toLowerCase();
  for (const [accountKey, account] of accounts.entries()) {
    if (accountKey.toLowerCase() === needle) return account;
    if (resolveAccountCounterparty(entityId, account).toLowerCase() === needle) return account;
  }
  return null;
}

export function isAccountLeftPerspective(entityId: string, account: AccountReadView): boolean {
  const owner = String(entityId || '').trim().toLowerCase();
  const left = String(account.state.leftEntity || '').trim().toLowerCase();
  const right = String(account.state.rightEntity || '').trim().toLowerCase();
  if (owner === left) return true;
  if (owner === right) return false;
  throw new Error(`Account perspective mismatch: owner=${entityId} left=${account.state.leftEntity} right=${account.state.rightEntity}`);
}
