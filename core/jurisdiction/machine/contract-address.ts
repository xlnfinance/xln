import { ethers } from 'ethers';
import { toLowerAddressOrNull } from '../../protocol/crypto/address-cache';
import { RecencyMemo } from '../../support/recency-memo';
import type { JReplica } from '../../types/jurisdiction-runtime';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const isUsableContractAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  toLowerAddressOrNull(value) !== null &&
  toLowerAddressOrNull(value) !== ZERO_ADDRESS;

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
 * `replica.contracts` is the only persisted source; live adapters are I/O
 * handles, never proof authority.
 */
// The stack is a pure function of the persisted `contracts` record; every
// Account proof body resolved it again with four checksum conversions.
const durableStacks = new RecencyMemo<object, DurableJurisdictionStack>(64);

export const requireDurableJurisdictionStack = (replica: JReplica): DurableJurisdictionStack => {
  const chainId = Number(replica.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('JURISDICTION_DURABLE_STACK_CHAIN_ID_MISSING');
  }
  const contracts = replica.contracts;
  const memoized = contracts ? durableStacks.get(contracts) : undefined;
  if (memoized && memoized.chainId === chainId) return memoized;
  const stack: DurableJurisdictionStack = {
    chainId,
    depository: requireDurableAddress('depository', contracts?.depository),
    entityProvider: requireDurableAddress('entity_provider', contracts?.entityProvider),
    account: requireDurableAddress('account', contracts?.account),
    deltaTransformer: requireDurableAddress('delta_transformer', contracts?.deltaTransformer),
  };
  if (contracts) durableStacks.set(contracts, stack);
  return stack;
};
