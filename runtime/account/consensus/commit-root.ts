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
  const incrementalRoot = computeAccountStateRoot(account);
  if (incrementalRoot === expectedRoot) return;
  const coldRoot = computeAccountStateRootCold(account);
  const details = {
    side,
    height,
    expectedRoot,
    incrementalRoot,
    coldRoot,
    incrementalSectionHashes: computeAccountStateSectionHashes(account),
    coldSectionHashes: computeAccountStateSectionHashesCold(account),
    incrementalCommitments: computeAccountCommitmentSectionDetail(account),
    coldCommitments: computeAccountCommitmentSectionDetailCold(account),
    pendingFrameTxTypes: account.pendingFrame?.accountTxs.map(tx => tx.type) ?? [],
    commitmentEntryCounts: {
      locks: account.locks.size,
      pulls: account.pulls?.size ?? 0,
      swapOffers: account.swapOffers.size,
      subcontracts: account.subcontracts?.size ?? 0,
      lendingIntents: account.lendingIntents?.size ?? 0,
    },
    liveFinancial: {
      deltas: Array.from(account.deltas.entries()),
      globalCreditLimits: account.globalCreditLimits,
      jNonce: account.jNonce,
      disputeConfig: account.disputeConfig,
    },
    ...(validatedMachine ? {
      validatedFinancial: {
        deltas: Array.from(validatedMachine.deltas.entries()),
        globalCreditLimits: validatedMachine.globalCreditLimits,
        jNonce: validatedMachine.jNonce,
        disputeConfig: validatedMachine.disputeConfig,
      },
    } : {}),
  };
  commitLog.error('frame.live_commit_root_mismatch', details);
  throw new Error(`ACCOUNT_LIVE_COMMIT_ROOT_MISMATCH:${safeStringify(details)}`);
};
