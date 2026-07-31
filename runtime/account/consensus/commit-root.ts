import type { AccountReplica } from '../../types/account';
import { createStructuredLogger } from '../../infra/logger';
import { safeStringify } from '../../protocol/serialization';
import {
  computeAccountCommitmentSectionDetail,
  computeAccountCommitmentSectionDetailCold,
  computeAccountStateRoot,
  computeAccountStateRootCold,
  computeAccountStateSectionHashes,
  computeAccountStateSectionHashesCold,
} from '../state-root';

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
): void => {
  const incrementalRoot = computeAccountStateRoot(account.state);
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
      globalCreditLimits: account.state.globalCreditLimits,
      jNonce: account.state.jNonce,
      disputeConfig: account.state.disputeConfig,
    },
    ...(validatedMachine ? {
      validatedFinancial: {
        deltas: Array.from(validatedMachine.state.deltas.entries()),
        globalCreditLimits: validatedMachine.state.globalCreditLimits,
        jNonce: validatedMachine.state.jNonce,
        disputeConfig: validatedMachine.state.disputeConfig,
      },
    } : {}),
  };
  commitLog.error('frame.live_commit_root_mismatch', details);
  throw new Error(`ACCOUNT_LIVE_COMMIT_ROOT_MISMATCH:${safeStringify(details)}`);
};
