import type { JurisdictionConfig } from '../../entity/types';
import { requireUsableContractAddress } from '../machine/contract-address';
import type { BrowserVMProvider } from './types';

export const buildBrowserVMJurisdiction = (
  depositoryAddress: string,
  entityProviderAddress: string,
  chainId: number,
): JurisdictionConfig => ({
  name: 'Simnet',
  chainId,
  address: 'browservm://',
  depositoryAddress,
  entityProviderAddress,
});

export const assertBrowserVMJurisdiction = (
  depositoryAddress: string,
  chainId: number,
  browserVM: BrowserVMProvider,
): void => {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`BROWSERVM_JURISDICTION_CHAIN_ID_INVALID:${String(chainId)}`);
  }
  const providerChainId = browserVM.getChainId?.();
  if (providerChainId !== undefined && BigInt(chainId) !== providerChainId) {
    throw new Error(
      `BROWSERVM_JURISDICTION_CHAIN_ID_MISMATCH:expected=${chainId}:actual=${providerChainId.toString()}`,
    );
  }
  requireUsableContractAddress(
    'entity_provider',
    browserVM.getEntityProviderAddress?.(),
  );
  requireUsableContractAddress('depository', depositoryAddress);
};
