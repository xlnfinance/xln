import type {
  AccountMachine,
  Env,
  EnvSnapshot,
  Profile as GossipProfile,
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
