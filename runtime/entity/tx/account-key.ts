import type { EntityState } from '../types';

export const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const findAccountKey = (state: EntityState, counterpartyId: string): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  return state.accounts.has(target) ? target : null;
};
