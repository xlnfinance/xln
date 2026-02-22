import { getAddress } from 'ethers';

export const normalizeRuntimeId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return getAddress(trimmed).toLowerCase();
  } catch {
    return '';
  }
};

export const isRuntimeId = (value: unknown): value is string => normalizeRuntimeId(value).length > 0;
