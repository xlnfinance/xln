import type { EntityTx } from '../../../../types/entity-tx';
import type { EntityState } from '../../../types';
import { validateCustomContractTransition } from '../../../../account/tx-validation/custom-contract';

/** Local financial admission only; never inject a fabricated peer AccountInput. */
export const handleCustomContractEntityTx = (
  state: EntityState, tx: Extract<EntityTx, { type: 'customContract' }>,
) => {
  validateCustomContractTransition(tx.data.transition);
  const accountId = tx.data.counterpartyEntityId;
  if (!state.accounts.has(accountId)) throw new Error(`CUSTOM_CONTRACT_ACCOUNT_MISSING:${accountId}`);
  return { newState: state, outputs: [], accountTxs: [{ accountId,
    tx: { type: 'subcontract_transition' as const, data: tx.data.transition } }] };
};
