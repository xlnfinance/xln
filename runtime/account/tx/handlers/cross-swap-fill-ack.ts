import type { AccountState } from '../../../types';
import {
  prepareCrossSwapFillAck,
} from './cross-swap-fill-ack-admission';
import {
  applyUnfilledCrossSwapCancellation,
  validateCrossSwapFillProgress,
} from './cross-swap-fill-ack-commit';
import { commitCrossSwapFillProgress } from './cross-swap-fill-ack-projection';
import type {
  CrossSwapFillAckResult,
  CrossSwapFillAckTx,
} from './cross-swap-fill-ack-types';

/**
 * Commits a book-owner fill acknowledgement into bilateral Account state.
 * Admission and exact amount proofs run before any route or history mutation.
 */
export async function handleCrossSwapFillAck(
  account: AccountState,
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
