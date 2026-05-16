import type { ConsensusConfig, Env, EntityReplica, JReplica, JurisdictionConfig } from './types';
import { firstUsableContractAddress } from './contract-address';
import { formatEntityId } from './utils';

type BrowserVmLike = {
  getDepositoryAddress?: () => string;
  getEntityProviderAddress?: () => string;
  getChainId?: () => bigint;
  browserVM?: BrowserVmLike;
};

const firstDefined = <T>(...values: Array<T | undefined>): T | undefined => {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
};

export const normalizeJurisdictionName = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

export const getJurisdictionConfigName = (jurisdiction?: Pick<JurisdictionConfig, 'name'> | null): string =>
  typeof jurisdiction?.name === 'string' ? jurisdiction.name.trim() : '';

export const getJReplicaByName = (env: Env, name?: string | null): JReplica | undefined => {
  const normalized = normalizeJurisdictionName(name);
  if (!normalized) return undefined;
  const exact = env.jReplicas?.get(name as string);
  if (exact) return exact;
  for (const replica of env.jReplicas?.values?.() || []) {
    if (normalizeJurisdictionName(replica?.name) === normalized) {
      return replica;
    }
  }
  return undefined;
};

const getCandidateReplica = (env: Env, current?: JurisdictionConfig): JReplica | undefined => {
  const named = getJReplicaByName(env, current?.name);
  if (named) return named;
  if (env.activeJurisdiction) {
    const active = env.jReplicas?.get(env.activeJurisdiction);
    if (active) return active;
  }
  for (const replica of env.jReplicas?.values?.() || []) {
    return replica;
  }
  return undefined;
};

export function resolveRuntimeJurisdictionConfig(
  env: Env,
  current?: JurisdictionConfig,
): JurisdictionConfig | undefined {
  const browserVmContainer = env.browserVM as BrowserVmLike | undefined;
  const browserVm = browserVmContainer?.browserVM ?? browserVmContainer;
  const replica = getCandidateReplica(env, current);

  const depositoryAddress = firstUsableContractAddress(
    replica?.jadapter?.addresses?.depository,
    replica?.depositoryAddress,
    replica?.contracts?.depository,
    current?.depositoryAddress,
    browserVm?.getDepositoryAddress?.(),
  );
  const entityProviderAddress = firstUsableContractAddress(
    replica?.jadapter?.addresses?.entityProvider,
    replica?.entityProviderAddress,
    replica?.contracts?.entityProvider,
    current?.entityProviderAddress,
    browserVm?.getEntityProviderAddress?.(),
  );
  const browserVmChainId = browserVm?.getChainId?.();
  const rawChainId = firstDefined<number | bigint>(
    replica?.jadapter?.chainId,
    replica?.chainId,
    current?.chainId,
    browserVmChainId,
  );
  const chainId =
    typeof rawChainId === 'bigint'
      ? Number(rawChainId)
      : (typeof rawChainId === 'number' && Number.isFinite(rawChainId) ? rawChainId : undefined);

  const currentName = current?.name?.trim() || undefined;
  const currentAddress = current?.address?.trim() || undefined;
  const replicaAddress = replica?.rpcs?.[0]?.trim() || undefined;
  const name = firstDefined(currentName, replica?.name, env.activeJurisdiction);
  const address = firstDefined(
    currentAddress,
    replicaAddress,
    browserVm ? 'browservm://' : undefined,
    name ? `jreplica://${name}` : undefined,
  );

  if (!name || !address || !depositoryAddress || !entityProviderAddress) {
    return current;
  }

  return {
    ...current,
    name,
    address,
    entityProviderAddress,
    depositoryAddress,
    ...(chainId !== undefined ? { chainId } : {}),
  };
}

export function requireRuntimeJurisdictionConfigByName(
  env: Env,
  name: string | undefined | null,
  current?: JurisdictionConfig,
): JurisdictionConfig {
  const configuredName = String(name || current?.name || '').trim();
  if (!configuredName) {
    throw new Error('ENTITY_JURISDICTION_MISSING');
  }

  const replica = getJReplicaByName(env, configuredName);
  if (!replica) {
    throw new Error(`ENTITY_JURISDICTION_UNAVAILABLE: ${configuredName}`);
  }

  const candidate: JurisdictionConfig = {
    name: replica.name || configuredName,
    address: current?.address || replica.rpcs?.[0] || (replica.jadapter?.mode === 'browservm' ? 'browservm://' : ''),
    entityProviderAddress:
      current?.entityProviderAddress ||
      replica.jadapter?.addresses?.entityProvider ||
      replica.entityProviderAddress ||
      replica.contracts?.entityProvider ||
      '',
    depositoryAddress:
      current?.depositoryAddress ||
      replica.jadapter?.addresses?.depository ||
      replica.depositoryAddress ||
      replica.contracts?.depository ||
      '',
    ...(
      current?.chainId !== undefined
        ? { chainId: current.chainId }
        : replica.chainId !== undefined
          ? { chainId: replica.chainId }
          : replica.jadapter?.chainId !== undefined
            ? { chainId: replica.jadapter.chainId }
            : {}
    ),
    ...(current?.rebalancePolicyUsd ? { rebalancePolicyUsd: current.rebalancePolicyUsd } : {}),
  };

  const resolved = resolveRuntimeJurisdictionConfig(env, {
    ...candidate,
    name: replica.name || configuredName,
  });
  const resolvedName = getJurisdictionConfigName(resolved);
  if (!resolved || normalizeJurisdictionName(resolvedName) !== normalizeJurisdictionName(configuredName)) {
    throw new Error(`ENTITY_JURISDICTION_RESOLVE_FAILED: ${configuredName}`);
  }
  if (!resolved.depositoryAddress || !resolved.entityProviderAddress || !resolved.chainId) {
    throw new Error(`ENTITY_JURISDICTION_INCOMPLETE: ${configuredName}`);
  }
  return resolved;
}

const sameEntity = (replica: EntityReplica, entityId: string): boolean =>
  String(replica?.entityId || '').toLowerCase() === String(entityId || '').toLowerCase();

const sameSigner = (replica: EntityReplica, signerId?: string | null): boolean => {
  if (!signerId) return false;
  return String(replica?.signerId || '').toLowerCase() === String(signerId).toLowerCase();
};

export function assertEntityJurisdictionBinding(
  env: Env,
  entityId: string,
  incomingJurisdiction?: JurisdictionConfig | null,
): void {
  const incomingName = getJurisdictionConfigName(incomingJurisdiction);
  if (!incomingName) {
    throw new Error(`ENTITY_JURISDICTION_MISSING: entity=${entityId}`);
  }
  for (const replica of env.eReplicas?.values?.() || []) {
    if (!sameEntity(replica, entityId)) continue;
    const existingName = getJurisdictionConfigName(replica.state?.config?.jurisdiction);
    if (!existingName) continue;
    if (!sameAccountJurisdiction(replica.state?.config?.jurisdiction, incomingJurisdiction)) {
      throw new Error(
        `ENTITY_JURISDICTION_CONFLICT: entity=${entityId} existing=${existingName} incoming=${incomingName}`,
      );
    }
  }
}

export function requireBoundEntityConfig(
  env: Env,
  entityId: string,
  config: ConsensusConfig,
): ConsensusConfig {
  const resolved = mergeRuntimeJurisdictionConfig(config, env);
  const jurisdictionName = getJurisdictionConfigName(resolved.jurisdiction);
  if (!jurisdictionName) {
    throw new Error(`ENTITY_JURISDICTION_MISSING: entity=${entityId}`);
  }
  const jurisdiction = requireRuntimeJurisdictionConfigByName(env, jurisdictionName, resolved.jurisdiction);
  assertEntityJurisdictionBinding(env, entityId, jurisdiction);
  return {
    ...resolved,
    jurisdiction,
  };
}

export function backfillEntityJurisdictionBinding(
  env: Env,
  entityId: string,
  jurisdiction: JurisdictionConfig,
): void {
  const jurisdictionName = getJurisdictionConfigName(jurisdiction);
  if (!jurisdictionName) return;
  for (const replica of env.eReplicas?.values?.() || []) {
    if (!sameEntity(replica, entityId)) continue;
    const existingName = getJurisdictionConfigName(replica.state?.config?.jurisdiction);
    if (existingName) continue;
    replica.state.config = {
      ...replica.state.config,
      jurisdiction,
    };
  }
}

const normalizeEntityRef = (value: unknown): string => String(value || '').toLowerCase();

const normalizeJurisdictionChainId = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

const readJurisdictionName = (jurisdiction: unknown): string => {
  if (!jurisdiction || typeof jurisdiction !== 'object') return '';
  return normalizeJurisdictionName((jurisdiction as { name?: unknown }).name);
};

const readJurisdictionChainId = (jurisdiction: unknown): number | null => {
  if (!jurisdiction || typeof jurisdiction !== 'object') return null;
  return normalizeJurisdictionChainId((jurisdiction as { chainId?: unknown }).chainId);
};

const readJurisdictionDepository = (jurisdiction: unknown): string => {
  if (!jurisdiction || typeof jurisdiction !== 'object') return '';
  return String((jurisdiction as { depositoryAddress?: unknown }).depositoryAddress || '').trim().toLowerCase();
};

function sameAccountJurisdiction(sourceJurisdiction: unknown, targetJurisdiction: unknown): boolean {
  const sourceChainId = readJurisdictionChainId(sourceJurisdiction);
  const targetChainId = readJurisdictionChainId(targetJurisdiction);
  const sourceDepository = readJurisdictionDepository(sourceJurisdiction);
  const targetDepository = readJurisdictionDepository(targetJurisdiction);

  if (sourceChainId !== null || targetChainId !== null) {
    return (
      sourceChainId !== null &&
      targetChainId !== null &&
      sourceChainId === targetChainId &&
      Boolean(sourceDepository && targetDepository) &&
      sourceDepository === targetDepository
    );
  }

  if (sourceDepository || targetDepository) {
    return Boolean(sourceDepository && targetDepository && sourceDepository === targetDepository);
  }

  const sourceName = readJurisdictionName(sourceJurisdiction);
  const targetName = readJurisdictionName(targetJurisdiction);
  return Boolean(sourceName && targetName && sourceName === targetName);
}

const findLocalEntityJurisdiction = (env: Env, entityId: string): unknown | null => {
  const target = normalizeEntityRef(entityId);
  for (const [replicaKey, replica] of env.eReplicas?.entries?.() || []) {
    const replicaEntityId = normalizeEntityRef(replica?.state?.entityId || replica?.entityId || replicaKey);
    if (replicaEntityId === target) {
      return replica?.state?.config?.jurisdiction ?? null;
    }
  }
  return null;
};

const findProfileJurisdiction = (env: Env, entityId: string): unknown | null => {
  const target = normalizeEntityRef(entityId);
  const profile = env.gossip?.getProfiles?.().find((candidate) =>
    normalizeEntityRef(candidate?.entityId || '') === target,
  );
  return profile?.metadata?.jurisdiction ?? null;
};

export function assertSameJurisdictionAccount(
  env: Env,
  sourceEntityId: string,
  sourceJurisdiction: JurisdictionConfig | unknown | null | undefined,
  counterpartyEntityId: string,
): void {
  if (!sourceJurisdiction) {
    throw new Error(
      `ACCOUNT_SOURCE_JURISDICTION_UNKNOWN: entity=${formatEntityId(sourceEntityId)} ` +
      `counterparty=${formatEntityId(counterpartyEntityId)}`,
    );
  }

  const targetJurisdiction =
    findLocalEntityJurisdiction(env, counterpartyEntityId) ??
    findProfileJurisdiction(env, counterpartyEntityId);

  if (!targetJurisdiction) {
    throw new Error(
      `ACCOUNT_JURISDICTION_UNKNOWN: entity=${formatEntityId(sourceEntityId)} ` +
      `counterparty=${formatEntityId(counterpartyEntityId)}`,
    );
  }

  if (!sameAccountJurisdiction(sourceJurisdiction, targetJurisdiction)) {
    throw new Error(
      `ACCOUNT_CROSS_JURISDICTION_FORBIDDEN: entity=${formatEntityId(sourceEntityId)} ` +
      `counterparty=${formatEntityId(counterpartyEntityId)}`,
    );
  }
}

export function requireEntityRuntimeJurisdictionConfig(
  env: Env,
  entityId: string,
  signerId?: string | null,
): JurisdictionConfig {
  let exactSignerName = '';
  let foundName = '';
  for (const replica of env.eReplicas?.values?.() || []) {
    if (!sameEntity(replica, entityId)) continue;
    const name = getJurisdictionConfigName(replica.state?.config?.jurisdiction);
    if (!name) continue;
    if (sameSigner(replica, signerId)) {
      exactSignerName = name;
      break;
    }
    if (!foundName) {
      foundName = name;
      continue;
    }
    if (normalizeJurisdictionName(foundName) !== normalizeJurisdictionName(name)) {
      throw new Error(`ENTITY_JURISDICTION_CONFLICT: entity=${entityId} existing=${foundName} incoming=${name}`);
    }
  }

  const name = exactSignerName || foundName;
  if (!name) {
    throw new Error(`ENTITY_JURISDICTION_MISSING: entity=${entityId}`);
  }

  return requireRuntimeJurisdictionConfigByName(env, name);
}

export function mergeRuntimeJurisdictionConfig(
  config: ConsensusConfig,
  env: Env,
): ConsensusConfig {
  const jurisdiction = resolveRuntimeJurisdictionConfig(env, config.jurisdiction);
  if (!jurisdiction) return config;
  return {
    ...config,
    jurisdiction,
  };
}
