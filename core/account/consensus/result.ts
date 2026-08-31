import type { AccountInputRejectionCode } from '../input/input-rejection';
import { AccountInputEvidenceError } from '../input/input-rejection';
import type { AccountTxRejection } from '../tx/apply-types';
import type {
  HandleAccountInputApplied,
  HandleAccountInputDispute,
  HandleAccountInputRejected,
  HandleAccountInputRejection,
  HandleAccountInputResult,
  AccountInputDisputeRequired,
  ProposeAccountFrameIdle,
  ProposeAccountFrameProposed,
  ProposeAccountFrameRejected,
  ProposeAccountFrameResult,
} from './types';

export const accountInputApplied = (
  payload: Omit<HandleAccountInputApplied, 'ok'>,
): HandleAccountInputApplied => ({ ok: true, ...payload });

const accountInputRejected = (
  rejection: HandleAccountInputRejection,
  events: string[],
): HandleAccountInputRejected => ({
  ok: false,
  disposition: 'rejected',
  rejection,
  events,
});

export const rejectAccountInput = (
  code: AccountInputRejectionCode,
  reason: string,
  events: string[],
): HandleAccountInputRejected =>
  accountInputRejected({ kind: 'input', code, message: reason }, events);

export const rejectAccountInputEvidenceError = (
  error: unknown,
  events: string[],
): HandleAccountInputRejected => {
  if (!(error instanceof AccountInputEvidenceError)) throw error;
  return rejectAccountInput(error.code, error.message, events);
};

export const accountInputTxRejected = (
  tx: AccountTxRejection,
  events: string[],
  message = tx.message,
): HandleAccountInputRejected =>
  accountInputRejected({ kind: 'tx', tx, message }, events);

export const accountInputValidationRejected = (
  message: string,
  events: string[],
): HandleAccountInputRejected =>
  accountInputRejected({ kind: 'validation', message }, events);

export const accountInputDisputeRequired = (
  disputeRequired: AccountInputDisputeRequired,
  events: string[],
): HandleAccountInputDispute => ({
  ok: false,
  disposition: 'dispute',
  disputeRequired,
  events,
});

export const proposeAccountFrameProposed = (
  payload: Omit<ProposeAccountFrameProposed, 'ok' | 'outcome'>,
): ProposeAccountFrameProposed => ({ ok: true, outcome: 'proposed', ...payload });

export const proposeAccountFrameIdle = (
  payload: Omit<ProposeAccountFrameIdle, 'ok' | 'outcome'>,
): ProposeAccountFrameIdle => ({ ok: true, outcome: 'idle', ...payload });

export const proposeAccountFrameRejected = (
  message: string,
  events: string[],
): ProposeAccountFrameRejected => ({
  ok: false,
  rejection: { message },
  events,
  proposalDroppedTransactions: [],
});

export const isProposedAccountFrame = (
  result: ProposeAccountFrameResult,
): result is ProposeAccountFrameProposed => result.ok && result.outcome === 'proposed';

export const isAccountInputDispute = (
  result: HandleAccountInputResult,
): result is HandleAccountInputDispute => !result.ok && result.disposition === 'dispute';

export const assertNeverAccountResult = (value: never): never => {
  throw new Error(`ACCOUNT_CONSENSUS_OUTCOME_UNHANDLED:${String(value)}`);
};

export const accountInputFailureMessage = (result: HandleAccountInputResult): string => {
  if (result.ok) return 'ACCOUNT_INPUT_UNEXPECTED_OK';
  if (result.disposition === 'dispute') return result.disputeRequired.reason;
  if (result.disposition === 'rejected') return result.rejection.message;
  return assertNeverAccountResult(result);
};

export const proposeAccountFrameMessage = (result: ProposeAccountFrameResult): string => {
  if (!result.ok) return result.rejection.message;
  if (result.outcome === 'idle') return result.message;
  if (result.outcome === 'proposed') return 'PROPOSE_ACCOUNT_FRAME_PROPOSED';
  return assertNeverAccountResult(result);
};

export const accountInputPeerRejectionCode = (
  result: HandleAccountInputResult,
): AccountInputRejectionCode | undefined => {
  if (result.ok || result.disposition !== 'rejected' || result.rejection.kind !== 'input') {
    return undefined;
  }
  return result.rejection.code;
};
