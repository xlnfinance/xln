import type { ApplyAccountTxResult } from '../../../../account/tx/apply-types';

type IllegalSuccessWithError = {
  ok: true;
  outcome: 'applied';
  events: string[];
  error: string;
};

type WidenedResult = ApplyAccountTxResult | IllegalSuccessWithError;

export const illegalSuccessWithError: WidenedResult = {
  ok: true,
  outcome: 'applied',
  events: [],
  error: 'ACCOUNT_TX_VALIDATION',
};
