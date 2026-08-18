/**
 * Account-only collection boundary shared by snapshot and live validation.
 * Disk/network decoders produce Map; live committed state uses Patricia maps.
 * Human-audit importance: 95/100 — never weaken the global Map validator.
 */
import { TypeSafetyViolationError } from '../../protocol/boundary/validation-primitives';
import {
  isAccountStateCollection,
  type AccountStateCollection,
  type AccountStateMapKey,
} from '../state/persistent-state-map';

export const validateAccountStateCollection = (
  value: unknown,
  fieldName: string,
): AccountStateCollection<AccountStateMapKey, unknown> => {
  if (!isAccountStateCollection(value)) {
    throw new TypeSafetyViolationError(
      `${fieldName} must be a decoded Map or branded Account collection`,
      value,
    );
  }
  return value;
};
