import { toLowerAddressOrNull } from '../../../protocol/crypto/address-cache';
import {
  isValidRuntimeId,
  toRuntimeId,
  type RuntimeId,
} from '../../../protocol/identity';

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

// The identity module owns the RuntimeId predicate/brand. Re-exporting the
// canonical predicate keeps P2P callers on that single minting boundary.
export const isRuntimeId = isValidRuntimeId;
