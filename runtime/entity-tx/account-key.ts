import type { EntityState } from '../types';

export const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const findAccountKey = (state: EntityState, counterpartyId: string): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  for (const key of state.accounts.keys()) {
    if (normalizeEntityRef(key) === target) return key;
  }
  return null;
};
