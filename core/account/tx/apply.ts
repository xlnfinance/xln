/**
 * Account Transaction Applicator
 * Routes AccountTx to the handler that mutates one bilateral account overlay.
 */

import type { AccountOutput, AccountReplica, AccountTx } from '../../types/account';
import type { AccountConsensusContext } from '../consensus/context';
import type { AccountJClaimSession } from '../j-claims/j-claim-session';
import type { HtlcEnforcementClock } from '../htlc-deadline';
import type { AccountDraftReplica } from '../state/account-state-draft';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
  publishAccountTransition,
} from '../state/candidate-overlay';
import type { ApplyAccountTxResult } from './apply-types';
import { applyAccountTxMutation } from './mutation';
import { accountTxRejected, accountTxValidationRejected, senderDeltaRejection, withAccountTxCandidateEffects } from './apply-result';
import { accountDisputeGasCharge, disputeGasAdmissionError } from '../validation/dispute-gas-budget';
import { collectSameJurisdictionSwapOutputs } from './same-j-swap-output';

export async function applyAccountTx(
  account: AccountDraftReplica,
  accountTx: AccountTx,
  byLeft: boolean,
  currentTimestamp: number = 0,
  currentJHeight: number = 0,
  isValidation: boolean = false,
  consensusContext?: AccountConsensusContext,
  jClaimSession?: AccountJClaimSession,
  counterpartyCertifiedBoardHash?: string,
  htlcEnforcementClock?: HtlcEnforcementClock,
): Promise<ApplyAccountTxResult> {
  const previousDisputeGas = accountDisputeGasCharge(account.state);
  const candidateEffects: AccountOutput[] = [];
  let result: ApplyAccountTxResult;
  try {
    result = await applyAccountTxMutation(
      account,
      accountTx,
      byLeft,
      currentTimestamp,
      currentJHeight,
      isValidation,
      consensusContext,
      jClaimSession,
      counterpartyCertifiedBoardHash,
      candidateEffects,
      htlcEnforcementClock,
    );
  } catch (error) {
    // Every handler drafts token rows through createDeltaDraft. Converting its
    // sender-caused failures here covers payments, HTLC locks, swaps and
    // settlement alike; before, only add_delta/set_credit_limit caught them
    // and a peer payment on a 129th token row halted the Runtime. The caller
    // discards this tx's transition, so a partial draft never commits.
    const rejection = senderDeltaRejection(error);
    if (!rejection) throw error;
    return accountTxRejected(rejection, [rejection.message]);
  }
  if (result.ok) {
    const budgetError = disputeGasAdmissionError(previousDisputeGas, accountDisputeGasCharge(account.state), accountTx);
    if (budgetError) return accountTxValidationRejected(budgetError, [budgetError]);
    candidateEffects.push(...collectSameJurisdictionSwapOutputs(account, accountTx));
  }
  return withAccountTxCandidateEffects(result, candidateEffects);
}

/**
 * Account-machine boundary for caller-owned mutable Entity candidates. Financial
 * handlers still receive only the explicit draft; this wrapper owns its full
 * lifecycle and publishes the resulting bounded shell into the caller-owned
 * candidate object after a successful transition.
 */
export async function applyAccountTxToMutableReplica(
  account: AccountReplica,
  accountTx: AccountTx,
  byLeft: boolean,
  currentTimestamp: number = 0,
  currentJHeight: number = 0,
  isValidation: boolean = false,
  consensusContext?: AccountConsensusContext,
  jClaimSession?: AccountJClaimSession,
  counterpartyCertifiedBoardHash?: string,
  htlcEnforcementClock?: HtlcEnforcementClock,
): Promise<ApplyAccountTxResult> {
  const owner = beginAccountTransition(account);
  try {
    const result = await applyAccountTx(
      accountTransitionView(owner),
      accountTx,
      byLeft,
      currentTimestamp,
      currentJHeight,
      isValidation,
      consensusContext,
      jClaimSession,
      counterpartyCertifiedBoardHash,
      htlcEnforcementClock,
    );
    if (!result.ok) {
      discardAccountTransition(owner);
      return result;
    }
    publishAccountTransition(account, owner, 'mutableTx');
    return result;
  } catch (error) {
    if (owner.lifecycle.status === 'active') discardAccountTransition(owner);
    throw error;
  }
}
