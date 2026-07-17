import type { Env, JurisdictionConfig } from '../types';
import { requireUsableContractAddress } from '../jurisdiction/contract-address';
import type { BrowserVMProvider } from './types';

let registeredBrowserVMJurisdiction: JurisdictionConfig | null = null;

type BrowserVMCarrier = BrowserVMProvider | { browserVM?: BrowserVMProvider | null } | null | undefined;

const unwrapBrowserVM = (value: BrowserVMCarrier): BrowserVMProvider | null => {
  if (!value || typeof value !== 'object') return null;
  if ('browserVM' in value) return value.browserVM ?? null;
  return value as BrowserVMProvider;
};

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

export const setBrowserVMJurisdiction = (
  env: Env | null,
  depositoryAddress: string,
  chainId: number,
  browserVMInstance?: BrowserVMCarrier,
): void => {
  const browserVM = unwrapBrowserVM(browserVMInstance);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`BROWSERVM_JURISDICTION_CHAIN_ID_INVALID:${String(chainId)}`);
  }
  const providerChainId = browserVM?.getChainId?.();
  if (providerChainId !== undefined && BigInt(chainId) !== providerChainId) {
    throw new Error(
      `BROWSERVM_JURISDICTION_CHAIN_ID_MISMATCH:expected=${chainId}:actual=${providerChainId.toString()}`,
    );
  }
  if (browserVM && env) {
    (env as Env & { browserVM?: BrowserVMProvider | null }).browserVM = browserVM;
  }

  const entityProviderAddress = requireUsableContractAddress(
    'entity_provider',
    browserVM?.getEntityProviderAddress?.() || env?.browserVM?.getEntityProviderAddress?.(),
  );

  registeredBrowserVMJurisdiction = buildBrowserVMJurisdiction(
    requireUsableContractAddress('depository', depositoryAddress),
    entityProviderAddress,
    chainId,
  );
};

export const getBrowserVMInstance = (env?: Env | null): BrowserVMProvider | null =>
  (env?.browserVM as BrowserVMProvider | null | undefined) ?? null;

export const getRegisteredBrowserVMJurisdiction = (): JurisdictionConfig | null =>
  registeredBrowserVMJurisdiction;
