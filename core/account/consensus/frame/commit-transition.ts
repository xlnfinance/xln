/**
 * Commit one already-authenticated Account frame through one Account overlay.
 * FIFO transaction order is preserved, while all touched Patricia paths are
 * prepared once at the frame boundary instead of once per transaction.
 * Human-audit importance: 100/100 — this is the bilateral money commit path.
 */
import type {
  AccountFrame,
  AccountOutput,
  AccountReplica,
} from '../../../types/account';
import type { AccountJClaimSession } from '../../j-claims/j-claim-session';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  createAccountTransitionKey,
  discardAccountTransition,
  publishAccountOverlay,
} from '../../state/candidate-overlay';
import { applyAccountTx } from '../../tx/apply';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
} from '../helpers';
import type { AccountConsensusContext } from '../context';
import type { HtlcEnforcementClock } from '../../htlc-deadline';

export type CommittedAccountFrameTransition = Readonly<{
  candidateEffects: readonly AccountOutput[];
  timedOutHashlocks: readonly string[];
}>;

type CommitAccountFrameTransitionOptions = Readonly<{
  context: AccountConsensusContext;
  account: AccountReplica;
  frame: AccountFrame;
  jClaimSession: AccountJClaimSession;
  role: 'proposer/commit' | 'receiver/collision-commit';
  counterpartyCertifiedBoardHash?: string;
  htlcEnforcementClock?: HtlcEnforcementClock;
}>;

/**
 * Apply ordered frame transactions to one draft, then atomically publish the
 * prepared replica shell. A failure discards every touched branch; callers
 * never observe a prefix of the frame.
 */
export const commitAccountFrameTransition = async (
  options: CommitAccountFrameTransitionOptions,
): Promise<CommittedAccountFrameTransition> => {
  const { account, frame } = options;
  const owner = beginAccountTransition(
    account,
    createAccountTransitionKey(account, {
      purpose: 'committed-account-frame',
      role: options.role,
      stateHash: frame.stateHash,
    }),
  );
  const draft = accountTransitionView(owner);
  const candidateEffects: AccountOutput[] = [];
  const timedOutHashlocks: string[] = [];
  const jHeight = frame.jHeight ?? account.state.lastFinalizedJHeight ?? 0;

  try {
    for (const tx of frame.accountTxs) {
      const beforeSettlement = captureSettlementVector(draft);
      const result = await applyAccountTx(
        draft,
        tx,
        frame.byLeft,
        frame.timestamp,
        jHeight,
        false,
        options.context,
        options.jClaimSession,
        options.counterpartyCertifiedBoardHash,
        options.htlcEnforcementClock,
      );
      if (!result.ok) {
        throw new Error(
          `Frame ${frame.height} commit failed: ${tx.type} - ${result.rejection.message}`,
        );
      }
      assertNoUnilateralSettlementMutation(draft, beforeSettlement, tx, options.role);
      candidateEffects.push(...(result.candidateEffects ?? []));
      if (result.outcome === 'htlc_error') timedOutHashlocks.push(result.hashlock);
    }

    publishAccountOverlay(account, commitAccountTransition(owner).account);
    return Object.freeze({
      candidateEffects: Object.freeze(candidateEffects),
      timedOutHashlocks: Object.freeze(timedOutHashlocks),
    });
  } catch (error) {
    if (owner.lifecycle.status === 'active') discardAccountTransition(owner);
    throw error;
  }
};
