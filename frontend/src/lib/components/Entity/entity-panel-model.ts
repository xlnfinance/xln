import type {
  AccountMachine,
  Env,
  EnvSnapshot,
  Profile as GossipProfile,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/xln-api';
import type { EntityReplica } from '$lib/types/ui';
import { unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';

export function materializeReplicaView(candidate: EntityReplica | null | undefined): EntityReplica | null {
  if (!candidate) return null;
  const materialized: EntityReplica = { ...candidate };
  if (candidate.state) materialized.state = { ...candidate.state };
  if (candidate.position) materialized.position = { ...candidate.position };
  return materialized;
}

export function materializeAccountView(candidate: AccountMachine | null | undefined): AccountMachine | null {
  if (!candidate) return null;
  const materialized: AccountMachine = {
    ...candidate,
    deltas: candidate.deltas instanceof Map ? new Map(candidate.deltas) : candidate.deltas,
  };
  if (candidate.settlementWorkspace) materialized.settlementWorkspace = { ...candidate.settlementWorkspace };
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
  sourceEnv: Env | EnvSnapshot | null | undefined,
  _revision = '',
): Map<string, EntityReplica> | null {
  if (!sourceEnv) return null;
  return materializeReplicaMap(sourceEnv.eReplicas as Map<string, EntityReplica>);
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
type RuntimeProjectionBookDoc = RuntimeProjectionActiveEntity['books']['items'][number];

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
      entityEncPubKey: '',
      isHub: summary?.isHub === true,
      routingFeePPM: 0,
      baseFee: 0n,
      board: { threshold: 0, validators: [] },
      ...(jurisdiction ? { jurisdiction } : {}),
    },
    accounts: [],
  } as GossipProfile;
}

function summaryReplica(summary: RuntimeAdapterEntitySummary): EntityReplica {
  const entityId = normalizeEntityId(summary.entityId);
  return {
    entityId,
    signerId: String(summary.signerId || ''),
    state: {
      entityId,
      height: Math.max(0, Math.floor(Number(summary.height || 0))),
      profile: {
        name: String(summary.label || entityId),
        ...(summary.isHub === true ? { isHub: true } : {}),
      },
      config: summary.jurisdiction ? { jurisdiction: summary.jurisdiction } : {},
      accounts: new Map(),
    },
  } as EntityReplica;
}

function runtimeProjectionAccountKey(entityId: string, account: RuntimeProjectionAccountDoc): string {
  const owner = normalizeEntityId(entityId);
  const left = normalizeEntityId((account as { leftEntity?: unknown }).leftEntity);
  const right = normalizeEntityId((account as { rightEntity?: unknown }).rightEntity);
  if (owner && left === owner && right) return right;
  if (owner && right === owner && left) return left;
  return right || left;
}

function runtimeProjectionBooksMap(items: RuntimeProjectionBookDoc[] | undefined): Map<string, unknown> {
  const books = new Map<string, unknown>();
  for (const item of items ?? []) {
    const record = item as { pairId?: unknown; book?: unknown };
    const pairId = String(record.pairId || '').trim();
    if (pairId) books.set(pairId, record.book ?? item);
  }
  return books;
}

function activeEntityProjectionReplica(activeEntity: RuntimeProjectionActiveEntity): EntityReplica {
  const entityId = normalizeEntityId(activeEntity.core.entityId || activeEntity.summary.entityId);
  const accounts = new Map<string, AccountMachine>();
  for (const item of activeEntity.accounts.items ?? []) {
    const key = runtimeProjectionAccountKey(entityId, item);
    if (!key) continue;
    const account = materializeAccountView(item as AccountMachine) ?? (item as AccountMachine);
    accounts.set(key, account);
  }
  const books = runtimeProjectionBooksMap(activeEntity.books.items);
  const state = {
    ...activeEntity.core,
    entityId,
    height: Math.max(0, Math.floor(Number(activeEntity.core.height ?? activeEntity.summary.height ?? 0))),
    profile: activeEntity.core.profile ?? {
      name: activeEntity.summary.label || entityId,
      ...(activeEntity.summary.isHub === true ? { isHub: true } : {}),
    },
    config: activeEntity.core.config ?? (
      activeEntity.summary.jurisdiction ? { jurisdiction: activeEntity.summary.jurisdiction } : {}
    ),
    accounts,
    ...(books.size > 0 || activeEntity.core.orderbookHubProfile ? {
      orderbookExt: {
        books,
        orderPairs: new Map(),
        referrals: activeEntity.core.orderbookReferrals ?? new Map(),
        ...(activeEntity.core.orderbookHubProfile ? { hubProfile: activeEntity.core.orderbookHubProfile } : {}),
      },
    } : {}),
  };
  return {
    entityId,
    signerId: String(activeEntity.core.signerId || activeEntity.summary.signerId || ''),
    isProposer: activeEntity.core.isProposer,
    state,
  } as EntityReplica;
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
  sourceEnv: Env | EnvSnapshot | null | undefined,
): EntityPanelView | null {
  if (!frame?.activeEntity) return null;
  const requestedEntityId = normalizeEntityId(entityId || frame.activeEntityId || frame.activeEntity.summary.entityId);
  const activeEntityId = normalizeEntityId(frame.activeEntity.summary.entityId || frame.activeEntity.core.entityId);
  if (requestedEntityId && activeEntityId && requestedEntityId !== activeEntityId) return null;

  const replicas = new Map<string, EntityReplica>();
  for (const summary of frame.entities ?? []) {
    const replica = summaryReplica(summary);
    const key = `${replica.entityId}:${normalizeEntityId(replica.signerId || '')}`;
    replicas.set(key, replica);
  }
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
    runtimeId: getRuntimeId(sourceEnv),
    height: Math.max(0, Math.floor(Number(frame.height || 0))),
    timestamp: Math.max(0, Math.floor(Number(activeReplica.state?.timestamp ?? sourceEnv?.timestamp ?? 0))),
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
  sourceEnv: Env | EnvSnapshot | null | undefined,
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
    height: Number(sourceEnv?.height ?? 0),
    timestamp: Math.max(0, Math.floor(Number(sourceEnv?.timestamp ?? 0))),
    activeJurisdictionName: getActiveJurisdictionName(sourceEnv),
    replicas,
    replica: findReplicaForEntityTab(replicas, entityId, signerId),
    profiles,
    profileByEntityId,
    entityNames,
    jurisdictions: sourceEnv?.jReplicas ? Array.from(sourceEnv.jReplicas.values()) as EntityPanelJurisdictionView[] : [],
    isDevnet: hasDevnetJurisdiction(sourceEnv),
  };
}

export function hasDevnetJurisdiction(sourceEnv: Env | EnvSnapshot | null | undefined): boolean {
  if (!sourceEnv?.jReplicas) return false;
  for (const [, replica] of sourceEnv.jReplicas.entries()) {
    if (Number(replica?.chainId ?? 0) === 31337) return true;
  }
  return false;
}

export function getRuntimeEnv(env: Env | EnvSnapshot | null | undefined): Env | null {
  return unwrapLiveRuntimeEnv(env);
}

export function requireRuntimeEnv(env: Env | EnvSnapshot | null | undefined, context: string): Env {
  const runtimeEnv = getRuntimeEnv(env);
  if (!runtimeEnv) throw new Error(`${context} requires live runtime environment`);
  return runtimeEnv;
}

export function getRuntimeId(env: Env | EnvSnapshot | null | undefined): string | null {
  const runtimeId = env?.runtimeId;
  return typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : null;
}

export function getActiveJurisdictionName(env: Env | EnvSnapshot | null | undefined): string | null {
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
  env: Env | EnvSnapshot | null | undefined,
  replica: EntityReplica | null | undefined,
): string | null {
  const configured = String(replica?.state?.config?.jurisdiction?.name || '').trim();
  return configured || getActiveJurisdictionName(env);
}

export function getCurrentEntityJurisdictionKey(
  env: Env | EnvSnapshot | null | undefined,
  replica: EntityReplica | null | undefined,
): string {
  return jurisdictionKey(replica?.state?.config?.jurisdiction)
    || jurisdictionKey(replica?.position?.jurisdiction)
    || jurisdictionKey(getActiveJurisdictionName(env));
}

export function getEntityJurisdictionKey(
  env: Env | EnvSnapshot | null | undefined,
  entityId: string,
): string {
  const normalized = String(entityId || '').trim().toLowerCase();
  if (!normalized) return '';

  const fromReplicas = getEntityJurisdictionKeyFromReplicas(
    env?.eReplicas as Map<string, EntityReplica> | null | undefined,
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
  env: Env | EnvSnapshot | null | undefined,
  replica: EntityReplica | null | undefined,
  fallbackEntityId: string,
  leftEntityId: string,
  rightEntityId: string,
): boolean {
  const currentEntityId = String(replica?.state?.entityId || fallbackEntityId || '').trim().toLowerCase();
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
  fallbackEntityId: string,
  leftEntityId: string,
  rightEntityId: string,
): boolean {
  const currentEntityId = String(replica?.state?.entityId || fallbackEntityId || '').trim().toLowerCase();
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

export function getGossipProfiles(env: Env | EnvSnapshot | null | undefined): GossipProfile[] {
  if (!env?.gossip) return [];
  if ('getProfiles' in env.gossip && typeof env.gossip.getProfiles === 'function') {
    return env.gossip.getProfiles();
  }
  return Array.isArray(env.gossip.profiles) ? env.gossip.profiles : [];
}

export function isHubProfile(profile: GossipProfile | undefined): boolean {
  return profile ? profile.metadata.isHub === true : false;
}

export function resolveAccountCounterparty(entityId: string, account: AccountMachine): string {
  return account.leftEntity.toLowerCase() === entityId.toLowerCase()
    ? account.rightEntity
    : account.leftEntity;
}

export function findLocalAccountByCounterparty(
  entityId: string,
  accounts: Map<string, AccountMachine> | undefined,
  counterpartyId: string | undefined,
): AccountMachine | null {
  if (!counterpartyId || !accounts) return null;
  const needle = counterpartyId.toLowerCase();
  for (const [accountKey, account] of accounts.entries()) {
    if (accountKey.toLowerCase() === needle) return account;
    if (resolveAccountCounterparty(entityId, account).toLowerCase() === needle) return account;
  }
  return null;
}

export function isAccountLeftPerspective(entityId: string, account: AccountMachine): boolean {
  const owner = String(entityId || '').trim().toLowerCase();
  const left = String(account.leftEntity || '').trim().toLowerCase();
  const right = String(account.rightEntity || '').trim().toLowerCase();
  if (owner === left) return true;
  if (owner === right) return false;
  throw new Error(`Account perspective mismatch: owner=${entityId} left=${account.leftEntity} right=${account.rightEntity}`);
}
