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
import type { StateHash } from '../../../protocol/hashes';
import type { AccountJClaimSession } from '../../j-claims/j-claim-session';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
  publishAccountOverlay,
} from '../../state/candidate-overlay';
import { applyAccountTx } from '../../tx/apply';
import { noteAccountFrameForShadow } from '../../../rscore/shadow-hook';
import {
} from '../helpers';
import type { AccountConsensusContext } from '../context';
import type { HtlcEnforcementClock } from '../../htlc-deadline';
import { assertLiveCommitMatchesFrame } from '../incoming/commit-root';
import { timePerfPhase } from '../../../support/performance/profile';

export type CommittedAccountFrameTransition = Readonly<{
  accountStateRoot: StateHash;
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
  const owner = timePerfPhase(
    'account.commit.beginOverlay',
    () => beginAccountTransition(account),
  );
  const draft = accountTransitionView(owner);
  const candidateEffects: AccountOutput[] = [];
  const timedOutHashlocks: string[] = [];
  const jHeight = frame.jHeight ?? account.state.lastFinalizedJHeight ?? 0;

  try {
    await timePerfPhase('account.commit.applyTxs', async () => {
      for (const tx of frame.accountTxs) {
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
        candidateEffects.push(...(result.candidateEffects ?? []));
        if (result.outcome === 'htlc_error') timedOutHashlocks.push(result.hashlock);
      }
    });

    const committed = timePerfPhase(
      'account.commit.prepareOverlay',
      () => commitAccountTransition(owner, 'frameCommit'),
    );
    timePerfPhase('account.commit.publishOverlay', () => {
      publishAccountOverlay(account, committed.account);
      assertLiveCommitMatchesFrame(
        account,
        frame.accountStateRoot,
        options.role === 'proposer/commit' ? 'proposer' : 'receiver',
        frame.height,
        committed.account,
        committed.accountStateRoot,
      );
    });
    // Fire-and-forget: mirror this committed frame into the Rust account
    // engine when shadow mode is on (no-op otherwise, one env check).
    noteAccountFrameForShadow({
      ownerEntityId: account.proofHeader.fromEntity,
      counterpartyEntityId: account.proofHeader.toEntity,
      frameHeight: frame.height,
      byLeft: frame.byLeft,
      timestamp: frame.timestamp,
      jHeight,
      enforcementTimestamp: options.htlcEnforcementClock?.timestamp ?? frame.timestamp,
      enforcementJHeight: options.htlcEnforcementClock?.jHeight ?? jHeight,
      accountTxs: frame.accountTxs,
      committedStateRoot: committed.accountStateRoot,
      account,
    });
    return Object.freeze({
      accountStateRoot: committed.accountStateRoot,
      candidateEffects: Object.freeze(candidateEffects),
      timedOutHashlocks: Object.freeze(timedOutHashlocks),
    });
  } catch (error) {
    if (owner.lifecycle.status === 'active') discardAccountTransition(owner);
    throw error;
  }
};
