import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../../protocol/validation-primitives';
import type { EntityLeaderTimeoutVote, EntityFrame } from '../../types';
import { validateEntityTxs } from '../../tx-validation';
import { assertEntityFrameEventByteBudget } from './events';
import { validateJPrefixCertificate } from '../jurisdiction/prefix-validation';

const rejectUnexpectedKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new FinancialDataCorruptionError(
        `${context} has unexpected key "${key}"`,
      );
    }
  }
};

const validateLeaderVoteBody = (
  value: unknown,
  context: string,
): Record<string, unknown> => {
  const vote = validateObject(value, context);
  for (const field of [
    'entityId',
    'previousFrameHash',
    'previousLeaderId',
    'nextLeaderId',
  ] as const) {
    validateString(vote[field], `${context}.${field}`);
  }
  for (const field of ['targetHeight', 'fromView', 'toView'] as const) {
    const number = validateNumber(vote[field], `${context}.${field}`);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new FinancialDataCorruptionError(
        `${context}.${field} must be a non-negative safe integer`,
      );
    }
  }
  if (Number(vote['toView']) !== Number(vote['fromView']) + 1) {
    throw new FinancialDataCorruptionError(
      `${context}.toView must advance exactly one view`,
    );
  }
  return vote;
};

export const validateEntityLeaderVote = (
  value: unknown,
  context: string,
): void => {
  const vote = validateLeaderVoteBody(value, context);
  validateString(vote['voterId'], `${context}.voterId`);
  validateString(vote['signature'], `${context}.signature`);
  if (vote['preparedFrame'] !== undefined) {
    validateProposedEntityFrame(
      vote['preparedFrame'],
      `${context}.preparedFrame`,
    );
  }
};

export const validateEntityLeaderCertificate = (
  value: unknown,
  context: string,
): void => {
  const certificate = validateLeaderVoteBody(value, context);
  const votes = validateMapInstance(certificate['votes'], `${context}.votes`);
  if (votes.size === 0) {
    throw new FinancialDataCorruptionError(`${context}.votes cannot be empty`);
  }
  for (const [signerId, signature] of votes) {
    if (
      typeof signerId !== 'string' ||
      signerId.length === 0 ||
      typeof signature !== 'string' ||
      signature.length === 0
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.votes must map signer IDs to signatures`,
      );
    }
  }
  if (certificate['preparedVotes'] !== undefined) {
    const prepared = validateMapInstance(
      certificate['preparedVotes'],
      `${context}.preparedVotes`,
    );
    if (prepared.size !== votes.size) {
      throw new FinancialDataCorruptionError(
        `${context}.preparedVotes must cover every certificate vote`,
      );
    }
    for (const [signerId, value] of prepared) {
      if (typeof signerId !== 'string' || signerId.length === 0) {
        throw new FinancialDataCorruptionError(
          `${context}.preparedVotes signer ID must be non-empty`,
        );
      }
      validateEntityLeaderVote(value, `${context}.preparedVotes[${signerId}]`);
      const vote = value as EntityLeaderTimeoutVote;
      if (
        vote.voterId.toLowerCase() !== signerId.toLowerCase() ||
        vote.signature !== votes.get(signerId)
      ) {
        throw new FinancialDataCorruptionError(
          `${context}.preparedVotes must match votes signature and voterId`,
        );
      }
    }
  }
  if (certificate['preparedFrameHash'] !== undefined) {
    validateString(
      certificate['preparedFrameHash'],
      `${context}.preparedFrameHash`,
    );
  }
};

const validateFrameEvents = (
  value: unknown,
  context: string,
): EntityFrame['events'] => {
  const events = validateArray<Record<string, unknown>>(value, context);
  for (let index = 0; index < events.length; index += 1) {
    const item = `${context}[${index}]`;
    const event = validateObject(events[index], item);
    const type = validateString(event['type'], `${item}.type`);
    if (type === 'status') {
      rejectUnexpectedKeys(event, ['type', 'message'], item);
    } else if (type === 'text') {
      rejectUnexpectedKeys(event, ['type', 'validatorId', 'message'], item);
      const validatorId = validateString(
        event['validatorId'],
        `${item}.validatorId`,
      );
      if (!validatorId.trim() || validatorId !== validatorId.trim().toLowerCase()) {
        throw new FinancialDataCorruptionError(
          `${item}.validatorId must be a canonical lowercase validator id`,
        );
      }
    } else {
      throw new FinancialDataCorruptionError(`${item}.type is unsupported`);
    }
    validateString(event['message'], `${item}.message`);
  }
  const decoded = events as EntityFrame['events'];
  assertEntityFrameEventByteBudget(decoded);
  return decoded;
};

function assertProposedEntityFrame(
  frame: Record<string, unknown>,
  context: string,
): asserts frame is Record<string, unknown> & EntityFrame {
  rejectUnexpectedKeys(
    frame,
    [
      'height', 'parentFrameHash', 'stateRoot', 'authorityRoot', 'timestamp',
      'txs', 'events', 'hash', 'leader', 'jPrefixCertificate',
      'hashesToSign', 'collectedSigs', 'hankos',
    ],
    context,
  );
  validateNumber(frame['height'], `${context}.height`);
  validateString(frame['parentFrameHash'], `${context}.parentFrameHash`);
  for (const field of ['stateRoot', 'authorityRoot'] as const) {
    const root = validateString(frame[field], `${context}.${field}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(root)) {
      throw new FinancialDataCorruptionError(
        `${context}.${field} must be bytes32 hex`,
      );
    }
  }
  const timestamp = validateNumber(frame['timestamp'], `${context}.timestamp`);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new FinancialDataCorruptionError(
      `${context}.timestamp must be a non-negative safe integer`,
    );
  }
  validateEntityTxs(frame['txs'], `${context}.txs`);
  validateFrameEvents(frame['events'], `${context}.events`);
  validateString(frame['hash'], `${context}.hash`);
  const leader = validateObject(frame['leader'], `${context}.leader`);
  rejectUnexpectedKeys(
    leader,
    ['proposerSignerId', 'view', 'certificate', 'relayCertificate'],
    `${context}.leader`,
  );
  validateString(leader['proposerSignerId'], `${context}.leader.proposerSignerId`);
  const view = validateNumber(leader['view'], `${context}.leader.view`);
  if (!Number.isSafeInteger(view) || view < 0) {
    throw new FinancialDataCorruptionError(
      `${context}.leader.view must be a non-negative safe integer`,
    );
  }
  if (leader['certificate'] !== undefined) {
    validateEntityLeaderCertificate(
      leader['certificate'],
      `${context}.leader.certificate`,
    );
  }
  if (leader['relayCertificate'] !== undefined) {
    validateEntityLeaderCertificate(
      leader['relayCertificate'],
      `${context}.leader.relayCertificate`,
    );
  }
  if (frame['jPrefixCertificate'] !== undefined) {
    validateJPrefixCertificate(
      frame['jPrefixCertificate'],
      `${context}.jPrefixCertificate`,
    );
  }
  if ('newState' in frame || 'outputs' in frame || 'jOutputs' in frame) {
    throw new FinancialDataCorruptionError(
      `${context} cannot carry proposer-supplied execution state or outputs`,
    );
  }
  validateHashManifest(frame['hashesToSign'], context);
  if (frame['collectedSigs'] !== undefined) {
    const signatures = validateMapInstance(
      frame['collectedSigs'],
      `${context}.collectedSigs`,
    );
    for (const [signerId, values] of signatures) {
      if (typeof signerId !== 'string' || signerId.length === 0) {
        throw new FinancialDataCorruptionError(
          `${context}.collectedSigs signer must be string`,
        );
      }
      validateArray(values, `${context}.collectedSigs[${signerId}]`);
    }
  }
  if (frame['hankos'] !== undefined) {
    validateArray(frame['hankos'], `${context}.hankos`);
  }
}

const validateHashManifest = (value: unknown, context: string): void => {
  const hashes = validateArray<unknown>(value, `${context}.hashesToSign`);
  if (hashes.length === 0) {
    throw new FinancialDataCorruptionError(
      `${context}.hashesToSign cannot be empty`,
    );
  }
  hashes.forEach((rawEntry, index) => {
    const item = `${context}.hashesToSign[${index}]`;
    const entry = validateObject(rawEntry, item);
    validateString(entry['hash'], `${item}.hash`);
    validateString(entry['type'], `${item}.type`);
    validateString(entry['context'], `${item}.context`);
  });
};

export const validateProposedEntityFrame = (
  value: unknown,
  context: string,
): EntityFrame => {
  const frame = validateObject(value, context);
  assertProposedEntityFrame(frame, context);
  return frame;
};
