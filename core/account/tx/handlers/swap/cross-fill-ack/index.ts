import type { AccountDraftReplica } from '../../../../state/account-state-draft';
import {
  prepareCrossSwapFillAck,
} from './admission';
import {
  applyUnfilledCrossSwapCancellation,
  validateCrossSwapFillProgress,
} from './commit';
import { commitCrossSwapFillProgress } from './projection';
import type {
  CrossSwapFillAckResult,
  CrossSwapFillAckTx,
} from './types';

/**
 * Commits a book-owner fill acknowledgement into bilateral Account state.
 * Admission and exact amount proofs run before any route or financial-state mutation.
 */
export async function handleCrossSwapFillAck(
  account: AccountDraftReplica,
  tx: CrossSwapFillAckTx,
  byLeft: boolean,
  timestamp: number,
  height: number,
): Promise<CrossSwapFillAckResult> {
  const admission = prepareCrossSwapFillAck(account, tx, byLeft);
  if (!admission.ok) return admission.result;
  const cancelled = applyUnfilledCrossSwapCancellation(
    admission.prepared,
    timestamp,
    height,
  );
  if (cancelled) return cancelled;
  const validated = validateCrossSwapFillProgress(admission.prepared);
  if (!validated.ok) return validated.result;
  return commitCrossSwapFillProgress(
    admission.prepared,
    validated.fill,
    timestamp,
    height,
  );
}
