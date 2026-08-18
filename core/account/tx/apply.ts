/**
 * Account Transaction Applicator
 * Routes AccountTx to the handler that mutates one bilateral account clone/state.
 */

import type { AccountReplica, AccountTx } from '../../types/account';
import type { AccountOutput } from '../../types/account';
import type { AccountConsensusContext } from '../consensus/context';
import type { AccountJClaimSession } from '../j-claims/j-claim-session';
import type { HtlcEnforcementClock } from '../htlc-deadline';
import type { AccountDraftReplica } from '../state/account-state-draft';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  createAccountTransitionKey,
  discardAccountTransition,
} from '../state/candidate-overlay';
import type { ApplyAccountTxResult } from './apply-types';
import { applyAccountTxMutation } from './mutation';
import { withAccountTxCandidateEffects } from './apply-result';

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
  const candidateEffects: AccountOutput[] = [];
  const result = await applyAccountTxMutation(
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
  const owner = beginAccountTransition(
    account,
    createAccountTransitionKey(account, { purpose: 'account-tx', type: accountTx.type }),
  );
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
    Object.assign(account, commitAccountTransition(owner).account);
    return result;
  } catch (error) {
    if (owner.lifecycle.status === 'active') discardAccountTransition(owner);
    throw error;
  }
}
