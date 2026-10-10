/**
 * Re-emit Account proposals that a peer never received.
 *
 * Frames are never dropped or rebuilt. When the counterparty runtime was
 * offline at dispatch time the Account still holds `pendingFrame` plus the
 * exact `pendingAccountInput` bytes that were signed for it, so recovery is a
 * pure read: hand those retained bytes back to the frame-local forced-response
 * channel and let the ordinary Account flush route them. This handler performs
 * no Account or Entity state mutation at all.
 */
import type { AccountInput } from '../../../../types/account';
import type { EntityState } from '../../../types';
import {
  assertProposeAccountsNowMatchesState,
  type ProposeAccountsNowTx,
} from '../../../consensus/account/propose-accounts-now-validation';
import { cloneIsolatedAccountInput } from '../../../../protocol/state/account-input-clone';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import type { EntityAccountInputWork } from '../../../consensus/account/canonical-worklist';

const proposeAccountsNowLog = createStructuredLogger('entity.tx.propose_accounts_now');

type ProposeAccountsNowResult = Readonly<{
  newState: EntityState;
  outputs: [];
  accountInputWorks: EntityAccountInputWork[];
}>;

export const handleProposeAccountsNowEntityTx = (
  state: EntityState,
  tx: ProposeAccountsNowTx,
): ProposeAccountsNowResult => {
  assertProposeAccountsNowMatchesState(state, tx);
  const accountInputWorks: EntityAccountInputWork[] = [];
  for (const counterparty of tx.data.counterparties) {
    const account = state.accounts.get(counterparty);
    const pending: AccountInput | undefined = account?.pendingAccountInput;
    if (!pending) {
      // A counterparty whose proposal already committed, or that never had one,
      // is ordinary progress. Nothing is owed, so nothing is emitted.
      proposeAccountsNowLog.debug('skip', {
        entity: shortId(state.entityId),
        account: shortId(counterparty),
        reason: account ? 'no_pending_proposal' : 'no_account',
      });
      continue;
    }
    accountInputWorks.push({
      accountId: counterparty,
      force: true,
      // Isolate the emitted bytes from the retained evidence: the flush pushes
      // this object into a Runtime output, and the Account must keep owning the
      // proposal it is still waiting on.
      response: cloneIsolatedAccountInput(pending),
    });
  }
  return { newState: state, outputs: [], accountInputWorks };
};
