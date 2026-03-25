import type { ConsensusConfig, Env, JReplica, JurisdictionConfig } from './types';
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

const getCandidateReplica = (env: Env, current?: JurisdictionConfig): JReplica | undefined => {
  const named = current?.name ? env.jReplicas?.get(current.name) : undefined;
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
  const rawChainId = firstDefined(
    replica?.jadapter?.chainId,
    replica?.chainId,
    current?.chainId,
    browserVm?.getChainId?.(),
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
