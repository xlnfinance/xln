import type { AccountReplica } from '../../../types/account';
import { createStructuredLogger } from '../../../support/logger';
import { safeStringify } from '../../../protocol/serialization';
import {
  computeAccountCommitmentSectionDetail,
  computeAccountCommitmentSectionDetailCold,
  computeAccountStateRoot,
  computeAccountStateRootCold,
  computeAccountStateSectionHashes,
  computeAccountStateSectionHashesCold,
} from '../../commitment/state-root';

const commitLog = createStructuredLogger('account.commit');

/**
 * The signed Account root is the bilateral commit criterion.
 *
 * Incremental map commitments are compile-time exhaustively invalidated by
 * AccountTx handlers, so the hot path must not rebuild every map. On mismatch
 * the independent cold oracle runs once and reports whether the cache or the
 * actual financial state diverged.
 */
export const assertLiveCommitMatchesFrame = (
  account: AccountReplica,
  expectedRoot: string,
  side: 'proposer' | 'receiver',
  height: number,
  validatedMachine?: AccountReplica,
  preparedRoot?: string,
): void => {
  // A committed overlay already computed this exact root before its financial
  // state object was folded into `account`. Reuse it on the success path. A
  // second Patricia walk here proved only the assignment operation and doubled
  // Account consensus hashing; the independent hot+cold walks remain on every
  // mismatch and retain the complete fail-fast dump.
  const incrementalRoot = preparedRoot ?? computeAccountStateRoot(account.state, undefined, 'commitAssertion');
  if (incrementalRoot === expectedRoot) return;
  const coldRoot = computeAccountStateRootCold(account.state);
  const details = {
    side,
    height,
    expectedRoot,
    incrementalRoot,
    coldRoot,
    incrementalSectionHashes: computeAccountStateSectionHashes(account.state),
    coldSectionHashes: computeAccountStateSectionHashesCold(account.state),
    incrementalCommitments: computeAccountCommitmentSectionDetail(account.state),
    coldCommitments: computeAccountCommitmentSectionDetailCold(account.state),
    pendingFrameTxTypes: account.pendingFrame?.accountTxs.map(tx => tx.type) ?? [],
    commitmentEntryCounts: {
      locks: account.state.locks.size,
      pulls: account.state.pulls?.size ?? 0,
      swapOffers: account.state.swapOffers.size,
      subcontracts: account.state.subcontracts?.size ?? 0,
      lendingIntents: account.state.lendingIntents?.size ?? 0,
    },
    liveFinancial: {
      deltas: Array.from(account.state.deltas.entries()),
      jNonce: account.state.jNonce,
      disputeConfig: account.state.disputeConfig,
    },
    ...(validatedMachine ? {
      validatedFinancial: {
        deltas: Array.from(validatedMachine.state.deltas.entries()),
        jNonce: validatedMachine.state.jNonce,
        disputeConfig: validatedMachine.state.disputeConfig,
      },
    } : {}),
  };
  commitLog.error('frame.live_commit_root_mismatch', details);
  throw new Error(`ACCOUNT_LIVE_COMMIT_ROOT_MISMATCH:${safeStringify(details)}`);
};
