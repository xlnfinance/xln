import type { AccountState } from '../types';
import {
  FinancialDataCorruptionError,
  validateObject,
} from '../protocol/validation-primitives';
import { safeStringify } from '../protocol/serialization';
import { decodeAccountFrame } from './frame-validation';
import {
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from './state-root';

/**
 * A resend is a durable copy of one exact proposal, not a second proposal lane.
 * Keeping the signed frame and cached wire input coupled prevents recovery
 * from sending a different payload. Runtime resolves the current validator
 * route when it durably admits each output; transport metadata is not Account
 * state.
 */
export const validatePendingAccountResend = (
  account: Record<string, unknown>,
  context: string,
): void => {
  const pendingFrame = account['pendingFrame'];
  const pendingInput = account['pendingAccountInput'];
  const present = [pendingFrame, pendingInput].map(
    (value) => value !== undefined,
  );
  if (present.every((value) => !value)) return;
  if (!present.every(Boolean)) {
    throw new FinancialDataCorruptionError(
      `${context}.pendingFrame and pendingAccountInput must be present together`,
    );
  }

  const input = validateObject(pendingInput, `${context}.pendingAccountInput`);
  if (input['kind'] !== 'frame' && input['kind'] !== 'frame_ack') {
    throw new FinancialDataCorruptionError(
      `${context}.pendingAccountInput must carry a frame proposal`,
    );
  }
  const proposal = validateObject(
    input['proposal'],
    `${context}.pendingAccountInput.proposal`,
  );
  const storedFrame = decodeAccountFrame(
    pendingFrame,
    `${context}.pendingFrame`,
  );
  const proposedFrame = decodeAccountFrame(
    proposal['frame'],
    `${context}.pendingAccountInput.proposal.frame`,
  );
  if (safeStringify(proposedFrame) !== safeStringify(storedFrame)) {
    throw new FinancialDataCorruptionError(
      `${context}.pendingAccountInput proposal must exactly match pendingFrame`,
    );
  }

  const proofHeader = validateObject(
    account['proofHeader'],
    `${context}.proofHeader`,
  );
  if (
    input['fromEntityId'] !== proofHeader['fromEntity'] ||
    input['toEntityId'] !== proofHeader['toEntity']
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.pendingAccountInput endpoints must match proofHeader`,
    );
  }
  if (
    !sameAccountStateDomain(
      normalizeAccountStateDomain(account['domain'] as AccountState['domain']),
      normalizeAccountStateDomain(input['domain'] as AccountState['domain']),
    )
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.pendingAccountInput domain must match Account domain`,
    );
  }
};
