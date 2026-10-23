import type { EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { ensureLendingState } from '../../../../lendbook/state';
import { decodeLendingFacility, lendingFacilityKey, lendingTermsKey } from '../../../../lendbook/policy';
import { MalformedEntityFrameInputError } from '../../processing/invariant-errors';
import { addMessage } from '../../../frame-events';
import { validateEntityTx } from '../../../tx-validation';

/** Only input decoding is a sender rejection. State preparation and commitment
 * stay outside this boundary so an invariant/storage failure remains fail-stop. */
const decodePolicyInput = <T>(txType: string, decode: () => T): T => {
  try {
    return decode();
  } catch (error) {
    throw new MalformedEntityFrameInputError(txType, error instanceof Error ? error.message : String(error));
  }
};

/** Only the bank's authenticated Entity governance can configure these terms.
 * A saver/borrower Account frame cannot grant itself this authority. */
export const handleLendingPolicy = (
  state: EntityState,
  tx: Extract<EntityTx, { type: 'lendingSetTerms' | 'lendingApprove' }>,
  mutableFrameState = false,
) => {
  if (state.profile?.isHub !== true) throw new MalformedEntityFrameInputError(tx.type, 'LENDING_POLICY_BANK_REQUIRED');
  // Validate the exact raw command before binding derived Account authority.
  // Otherwise injected domain/nonce fields can be silently overwritten here
  // while the signed command itself becomes unreplayable in the WAL decoder.
  decodePolicyInput(tx.type, () => validateEntityTx(tx, 'LENDING_POLICY_INPUT'));
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
  // Bank governance is the authority; the borrower cannot grant itself a
  // facility. Bind this approval to the existing Account domain and J epoch.
  // Accepting a demand-loan/negative facility here used to commit data that
  // the same canonical decoder rejected during WAL recovery.
  const facility = decodePolicyInput(tx.type, () =>
    decodeLendingFacility({
      ...tx.data,
      ...account.state.domain,
      jNonce: account.state.jNonce,
    }),
  );
  const next = prepareEntityTxState(state, mutableFrameState);
  const lending = ensureLendingState(next);
  lending.facilities ??= new Map();
  lending.facilities.set(lendingFacilityKey(facility.borrowerEntityId, facility.tokenId, facility.termId), facility);
  addMessage(
    next,
    `Bank facility set: borrower=${tx.data.borrowerEntityId} token=${tx.data.tokenId} term=${tx.data.termId} principal=${tx.data.maxPrincipal}`,
  );
  return { newState: next, outputs: [] };
};
