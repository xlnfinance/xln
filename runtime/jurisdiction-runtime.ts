import type { ConsensusConfig, Env, EntityReplica, JReplica, JurisdictionConfig } from './types';
import { firstUsableContractAddress } from './contract-address';

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

  const name = firstDefined(current?.name, replica?.name, env.activeJurisdiction);
  const address = firstDefined(
    current?.address,
    replica?.rpcs?.[0],
    browserVm ? 'browservm://' : undefined,
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
  if (!incomingName) return;
  for (const replica of env.eReplicas?.values?.() || []) {
    if (!sameEntity(replica, entityId)) continue;
    const existingName = getJurisdictionConfigName(replica.state?.config?.jurisdiction);
    if (!existingName) continue;
    if (normalizeJurisdictionName(existingName) !== normalizeJurisdictionName(incomingName)) {
      throw new Error(
        `ENTITY_JURISDICTION_CONFLICT: entity=${entityId} existing=${existingName} incoming=${incomingName}`,
      );
    }
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
