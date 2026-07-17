import { ethers } from 'ethers';
import type { JReplica } from '../types';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const isUsableContractAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  ethers.isAddress(value) &&
  ethers.getAddress(value) !== ethers.getAddress(ZERO_ADDRESS);

export const requireUsableContractAddress = (label: string, value: unknown): string => {
  if (!isUsableContractAddress(value)) {
    throw new Error(`INVALID_${label.toUpperCase()}_ADDRESS`);
  }
  return value;
};

export const firstUsableContractAddress = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (isUsableContractAddress(value)) return value;
  }
  return null;
};

export type DurableJurisdictionStack = Readonly<{
  chainId: number;
  depository: string;
  entityProvider: string;
  account: string;
  deltaTransformer: string;
}>;

const requireDurableAddress = (name: string, value: unknown): string => {
  if (!isUsableContractAddress(value)) {
    throw new Error(`JURISDICTION_DURABLE_STACK_${name.toUpperCase()}_MISSING`);
  }
  return ethers.getAddress(value).toLowerCase();
};

/**
 * Decode the authoritative on-chain stack persisted with a JReplica.
 * Live adapters are I/O handles, never proof authority. Legacy aliases may be
 * present for UI compatibility, but must identify the exact same contracts.
 */
export const requireDurableJurisdictionStack = (replica: JReplica): DurableJurisdictionStack => {
  const chainId = Number(replica.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('JURISDICTION_DURABLE_STACK_CHAIN_ID_MISSING');
  }
  const depository = requireDurableAddress('depository', replica.contracts?.depository);
  const entityProvider = requireDurableAddress('entity_provider', replica.contracts?.entityProvider);
  const account = requireDurableAddress('account', replica.contracts?.account);
  const deltaTransformer = requireDurableAddress('delta_transformer', replica.contracts?.deltaTransformer);

  if (
    replica.depositoryAddress !== undefined
    && requireDurableAddress('depository_alias', replica.depositoryAddress) !== depository
  ) {
    throw new Error('JURISDICTION_DURABLE_STACK_DEPOSITORY_ALIAS_CONFLICT');
  }
  if (
    replica.entityProviderAddress !== undefined
    && requireDurableAddress('entity_provider_alias', replica.entityProviderAddress) !== entityProvider
  ) {
    throw new Error('JURISDICTION_DURABLE_STACK_ENTITY_PROVIDER_ALIAS_CONFLICT');
  }
  return { chainId, depository, entityProvider, account, deltaTransformer };
};
