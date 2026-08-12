import type { ApplyAccountTxResult } from '../../../account/tx/apply-types';
import { toHashlock, type LockId } from '../../../account/tx/units';

type IllegalSuccessWithError = {
  ok: true;
  outcome: 'applied';
  events: string[];
  error: string;
};

type WidenedResult = ApplyAccountTxResult | IllegalSuccessWithError;
type WidenedLockId = LockId | ReturnType<typeof toHashlock>;

export const illegalSuccessWithError: WidenedResult = {
  ok: true,
  outcome: 'applied',
  events: [],
  error: 'ACCOUNT_TX_VALIDATION',
};

export const illegalHashlockAsLockId: WidenedLockId = toHashlock(`0x${'11'.repeat(32)}`);
