import { ethers } from 'ethers';

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
