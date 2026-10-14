import type { EntityState } from '../types';
import { normalizeEntityRef } from '../../support/boundary-guards';

export { normalizeEntityRef };

export const findAccountKey = (state: EntityState, counterpartyId: string): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  return state.accounts.has(target) ? target : null;
};
