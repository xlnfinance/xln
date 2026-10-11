import type { EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { ensureLendingState } from '../../../../lendbook/state';
import { lendingFacilityKey, lendingTermsKey } from '../../../../lendbook/policy';
import { MalformedEntityFrameInputError } from '../../processing/invariant-errors';
import { addMessage } from '../../../frame-events';

/** Only the bank's authenticated Entity governance can configure these terms.
 * A saver/borrower Account frame cannot grant itself this authority. */
export const handleLendingPolicy = (
  state: EntityState,
  tx: Extract<EntityTx, { type: 'lendingSetTerms' | 'lendingApprove' }>,
  mutableFrameState = false,
) => {
  if (state.profile?.isHub !== true) throw new MalformedEntityFrameInputError(tx.type, 'LENDING_POLICY_BANK_REQUIRED');
  if (tx.type === 'lendingSetTerms') {
    const next = prepareEntityTxState(state, mutableFrameState);
    const lending = ensureLendingState(next);
    lending.terms ??= new Map();
    lending.terms.set(lendingTermsKey(tx.data), { ...tx.data });
    addMessage(next, `Bank terms set: token=${tx.data.tokenId} term=${tx.data.termId}`);
    return { newState: next, outputs: [] };
  }
  const account = state.accounts.get(tx.data.borrowerEntityId);
  if (!account || account.status !== 'active' || !account.state.deltas.has(tx.data.tokenId)) {
    throw new MalformedEntityFrameInputError(tx.type, 'LENDING_FACILITY_ACCOUNT_UNAVAILABLE');
  }
  const next = prepareEntityTxState(state, mutableFrameState);
  const lending = ensureLendingState(next);
  lending.facilities ??= new Map();
  lending.facilities.set(lendingFacilityKey(tx.data.borrowerEntityId, tx.data.tokenId, tx.data.termId), {
    ...tx.data, ...account.state.domain, jNonce: account.state.jNonce,
  });
  addMessage(next, `Bank facility set: borrower=${tx.data.borrowerEntityId} token=${tx.data.tokenId} term=${tx.data.termId} principal=${tx.data.maxPrincipal}`);
  return { newState: next, outputs: [] };
};
