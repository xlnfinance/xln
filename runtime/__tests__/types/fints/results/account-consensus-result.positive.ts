import type {
  HandleAccountInputApplied,
  HandleAccountInputDispute,
  HandleAccountInputRejected,
  HandleAccountInputResult,
  ProposeAccountFrameIdle,
  ProposeAccountFrameProposed,
  ProposeAccountFrameRejected,
  ProposeAccountFrameResult,
} from '../../../../account/consensus/types';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type AppliedHasNoRejection = Expect<Equal<keyof HandleAccountInputApplied & 'rejection', never>>;
type AppliedHasNoSuccessAlias = Expect<Equal<keyof HandleAccountInputApplied & 'success', never>>;
type RejectedHasNoResponse = Expect<Equal<keyof HandleAccountInputRejected & 'response', never>>;
type RejectedHasNoCommitted = Expect<Equal<keyof HandleAccountInputRejected & 'committedFrames', never>>;
type DisputeHasNoRejection = Expect<Equal<keyof HandleAccountInputDispute & 'rejection', never>>;
type ProposedHasNoError = Expect<Equal<keyof ProposeAccountFrameProposed & 'error', never>>;
type IdleHasNoAccountInput = Expect<Equal<keyof ProposeAccountFrameIdle & 'accountInput', never>>;
type ProposeRejectedHasNoAccountInput = Expect<Equal<keyof ProposeAccountFrameRejected & 'accountInput', never>>;
type InputResultHasNoError = Expect<Equal<keyof HandleAccountInputResult & 'error', never>>;
type ProposeResultHasNoSuccess = Expect<Equal<keyof ProposeAccountFrameResult & 'success', never>>;

const applied: HandleAccountInputResult = { ok: true, events: ['applied'] };
const rejected: HandleAccountInputResult = {
  ok: false,
  disposition: 'rejected',
  rejection: { kind: 'validation', message: 'ACCOUNT_INPUT_PARTY_MISMATCH' },
  events: [],
};
const dispute: HandleAccountInputResult = {
  ok: false,
  disposition: 'dispute',
  disputeRequired: { reason: 'Credit limit cannot be negative', evidenceSecrets: [] },
  events: [],
};
const idle: ProposeAccountFrameResult = {
  ok: true,
  outcome: 'idle',
  message: 'Transactions deferred until signed settlement finalizes: 1',
  events: [],
};
const proposeRejected: ProposeAccountFrameResult = {
  ok: false,
  rejection: { message: 'ACCOUNT_PROPOSAL_STATUS_FROZEN:dispute_preparing' },
  events: [],
};

export const fintsPositiveAccountConsensusResult = (): {
  applied: HandleAccountInputApplied;
  rejected: HandleAccountInputRejected;
  dispute: HandleAccountInputDispute;
  idle: ProposeAccountFrameIdle;
  proposeRejected: ProposeAccountFrameRejected;
  covered: [
    AppliedHasNoRejection,
    AppliedHasNoSuccessAlias,
    RejectedHasNoResponse,
    RejectedHasNoCommitted,
    DisputeHasNoRejection,
    ProposedHasNoError,
    IdleHasNoAccountInput,
    ProposeRejectedHasNoAccountInput,
    InputResultHasNoError,
    ProposeResultHasNoSuccess,
  ];
} => {
  if (!applied.ok) throw new Error('FINTS_POSITIVE_ACCOUNT_INPUT_APPLIED');
  if (rejected.ok || rejected.disposition !== 'rejected') throw new Error('FINTS_POSITIVE_ACCOUNT_INPUT_REJECTED');
  if (dispute.ok || dispute.disposition !== 'dispute') throw new Error('FINTS_POSITIVE_ACCOUNT_INPUT_DISPUTE');
  if (!idle.ok || idle.outcome !== 'idle') throw new Error('FINTS_POSITIVE_PROPOSE_IDLE');
  if (proposeRejected.ok) throw new Error('FINTS_POSITIVE_PROPOSE_REJECTED');
  return {
    applied,
    rejected,
    dispute,
    idle,
    proposeRejected,
    covered: [true, true, true, true, true, true, true, true, true, true],
  };
};
