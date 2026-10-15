import { toLowerAddressOrNull } from '../crypto/address-cache';
import {
  isValidRuntimeId,
  toRuntimeId,
  type RuntimeId,
} from './index';

export const normalizeRuntimeId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lower = toLowerAddressOrNull(trimmed);
  if (lower === null) return '';
  try {
    return toRuntimeId(lower);
  } catch {
    return '';
  }
};

export const decodeRuntimeId = (value: unknown): RuntimeId => {
  const normalized = normalizeRuntimeId(value);
  if (!normalized) throw new Error(`RUNTIME_ID_INVALID:${String(value)}`);
  return toRuntimeId(normalized);
};

export const isRuntimeId = isValidRuntimeId;
