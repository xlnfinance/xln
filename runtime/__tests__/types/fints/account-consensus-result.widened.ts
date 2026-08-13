import type {
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from '../../../account/consensus/types';

type IllegalAccountInputSuccessWithError = {
  ok: true;
  events: string[];
  error: string;
};

type IllegalProposeRejectedWithAccountInput = {
  ok: false;
  rejection: { message: string };
  events: string[];
  accountInput: { kind: 'ack' };
};

type WidenedInput = HandleAccountInputResult | IllegalAccountInputSuccessWithError;
type WidenedPropose = ProposeAccountFrameResult | IllegalProposeRejectedWithAccountInput;

export const illegalAccountInputSuccessWithError: WidenedInput = {
  ok: true,
  events: [],
  error: 'ACCOUNT_INPUT_VALIDATION',
};

export const illegalProposeRejectedWithAccountInput: WidenedPropose = {
  ok: false,
  rejection: { message: 'No transactions to propose' },
  events: [],
  accountInput: { kind: 'ack' },
};
