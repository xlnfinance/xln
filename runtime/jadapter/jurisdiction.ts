import type { JurisdictionConfig } from '../entity/types';
import { requireJurisdictionChainId } from '../jurisdiction/jurisdiction-stack';
import { createJAdapter } from './factory';
import type { JAdapter, JAdapterConfig, JAdapterReplicaConnection } from './types';

const buildFromReplica = (jurisdiction: JurisdictionConfig): JAdapterReplicaConnection =>
  ({
    ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  });

export const isBrowserVMJurisdiction = (jurisdiction: JurisdictionConfig): boolean =>
  String(jurisdiction.address || '').startsWith('browservm://');

export const buildJAdapterConfigFromJurisdiction = (jurisdiction: JurisdictionConfig): JAdapterConfig => {
  const browserVM = isBrowserVMJurisdiction(jurisdiction);
  const config: JAdapterConfig = {
    mode: browserVM ? 'browservm' : 'rpc',
    chainId: requireJurisdictionChainId(
      jurisdiction.chainId,
      'J_ADAPTER_JURISDICTION_CHAIN_ID_INVALID',
    ),
    fromReplica: buildFromReplica(jurisdiction),
  };
  if (!browserVM) {
    config.rpcUrl = jurisdiction.address;
    config.watchOnly = true;
  }
  return config;
};

export const connectJurisdictionAdapter = async (jurisdiction: JurisdictionConfig): Promise<JAdapter> =>
  createJAdapter(buildJAdapterConfigFromJurisdiction(jurisdiction));

export const connectJurisdictionContracts = async (jurisdiction: JurisdictionConfig) => {
  const jadapter = await connectJurisdictionAdapter(jurisdiction);
  return {
    jadapter,
    provider: jadapter.provider,
    signer: jadapter.signer,
    entityProvider: jadapter.entityProvider,
    depository: jadapter.depository,
  };
};
