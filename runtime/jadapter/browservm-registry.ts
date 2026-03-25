import type { Env, JurisdictionConfig } from '../types';
import { requireUsableContractAddress } from '../contract-address';
import type { BrowserVMProvider } from './types';

let registeredBrowserVMJurisdiction: JurisdictionConfig | null = null;

type BrowserVMCarrier = BrowserVMProvider | { browserVM?: BrowserVMProvider | null } | null | undefined;

const unwrapBrowserVM = (value: BrowserVMCarrier): BrowserVMProvider | null => {
  if (!value || typeof value !== 'object') return null;
  if ('browserVM' in value) return value.browserVM ?? null;
  return value;
};

const buildBrowserVMJurisdiction = (
  depositoryAddress: string,
  entityProviderAddress: string,
): JurisdictionConfig => ({
  name: 'Simnet',
  chainId: 31337,
  address: 'browservm://',
  depositoryAddress,
  entityProviderAddress,
});

export const setBrowserVMJurisdiction = (
  env: Env | null,
  depositoryAddress: string,
  browserVMInstance?: BrowserVMCarrier,
): void => {
  const browserVM = unwrapBrowserVM(browserVMInstance);
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
  );
};

export const getBrowserVMInstance = (env?: Env | null): BrowserVMProvider | null =>
  (env?.browserVM as BrowserVMProvider | null | undefined) ?? null;

export const getRegisteredBrowserVMJurisdiction = (): JurisdictionConfig | null =>
  registeredBrowserVMJurisdiction;
