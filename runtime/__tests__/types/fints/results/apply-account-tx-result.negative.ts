import type { ApplyAccountTxResult } from '../../../../account/tx/apply-types';

export const illegalSuccessWithError: ApplyAccountTxResult = {
  ok: true,
  outcome: 'applied',
  events: [],
  error: 'ACCOUNT_TX_VALIDATION',
};
