import {
  FinancialDataCorruptionError,
  validateObject,
} from '../../protocol/boundary/validation-primitives';
import { safeStringify } from '../../protocol/serialization';
import { decodeAccountFrame } from './frame-validation';
import {
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../commitment/state-root';

/**
 * The pending signed proposal is exact evidence for the in-flight Account
 * frame. It is retained for ACK validation and recovery, never as an automatic
 * transport retry queue.
 */
export const validatePendingAccountProposal = (
  account: Record<string, unknown>,
  context: string,
): void => {
  const state = validateObject(account['state'], `${context}.state`);
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
      normalizeAccountStateDomain(state['domain']),
      normalizeAccountStateDomain(input['domain']),
    )
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.pendingAccountInput domain must match Account domain`,
    );
  }
};
