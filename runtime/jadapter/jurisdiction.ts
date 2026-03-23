import type { JReplica, JurisdictionConfig } from '../types';
import { getAvailableJurisdictions } from '../jurisdiction-config';
import { createJAdapter } from './index';
import type { JAdapter, JAdapterConfig } from './types';
import { getRegisteredBrowserVMJurisdiction } from './browservm-registry';

const buildFromReplica = (jurisdiction: JurisdictionConfig): JReplica =>
  ({
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  }) as JReplica;

export const isBrowserVMJurisdiction = (jurisdiction: JurisdictionConfig): boolean =>
  String(jurisdiction.address || '').startsWith('browservm://');

export const buildJAdapterConfigFromJurisdiction = (jurisdiction: JurisdictionConfig): JAdapterConfig => ({
  mode: isBrowserVMJurisdiction(jurisdiction) ? 'browservm' : 'rpc',
  chainId: jurisdiction.chainId ?? 31337,
  rpcUrl: isBrowserVMJurisdiction(jurisdiction) ? undefined : jurisdiction.address,
  fromReplica: buildFromReplica(jurisdiction),
});

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

export const getJurisdictionByAddress = async (
  address: string,
): Promise<JurisdictionConfig | undefined> => {
  const browserVMJurisdiction = getRegisteredBrowserVMJurisdiction();
  if (browserVMJurisdiction && browserVMJurisdiction.address === address) {
    return browserVMJurisdiction;
  }

  const jurisdictions = await getAvailableJurisdictions();
  return jurisdictions.find((jurisdiction) => jurisdiction.address === address);
};
