import type {
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from '../../../account/consensus/types';

export const illegalAccountInputSuccessWithError: HandleAccountInputResult = {
  ok: true,
  events: [],
  error: 'ACCOUNT_INPUT_VALIDATION',
};

export const illegalAccountInputRejectedWithResponse: HandleAccountInputResult = {
  ok: false,
  disposition: 'rejected',
  rejection: { kind: 'validation', message: 'ACCOUNT_INPUT_PARTY_MISMATCH' },
  events: [],
  response: { kind: 'ack', fromEntityId: '0x1', toEntityId: '0x2' },
};

export const illegalProposeIdleWithError: ProposeAccountFrameResult = {
  ok: true,
  outcome: 'idle',
  message: 'deferred',
  events: [],
  error: 'deferred',
};

export const illegalProposeRejectedWithAccountInput: ProposeAccountFrameResult = {
  ok: false,
  rejection: { message: 'No transactions to propose' },
  events: [],
  accountInput: { kind: 'ack', fromEntityId: '0x1', toEntityId: '0x2' },
};
