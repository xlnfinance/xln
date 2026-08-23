import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../../protocol/boundary/validation-primitives';
import type { EntityLeaderTimeoutVote, EntityFrame } from '../../types';
import { validateEntityTxs } from '../../tx-validation';
import { assertEntityFrameEventByteBudget } from './events';
import { validateJPrefixCertificate } from '../j-prefix/prefix-validation';
import {
  validateEntityInfraContext,
  type DecodedEntityInfraContext,
} from './infra-context-validation';
import { assertEntityFrameTotalByteBudget } from '../frame';
import { LIMITS } from '../../../config/constants';
import { packTransportValue } from '../../../protocol/serialization/binary-codec';
import { toFrameHash, toStateHash, type FrameHash, type StateHash } from '../../../protocol/hashes';
import { RecencySet } from '../../../support/collections/recency-memo';
import {
  toEntityHeight,
  toUnixMs,
  type EntityHeight,
  type UnixMs,
} from '../../../protocol/units';

export type DecodedEntityFrame = EntityFrame & Readonly<{
  height: EntityHeight;
  parentFrameHash: FrameHash | 'genesis';
  stateRoot: StateHash;
  authorityRoot: StateHash;
  timestamp: UnixMs;
  hash: FrameHash;
  entityContext: DecodedEntityInfraContext;
}>;

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

const validateFrameIdentityAndContext = (
  frame: Record<string, unknown>,
  context: string,
): ReturnType<typeof validateEntityInfraContext> => {
  rejectUnexpectedKeys(
    frame,
    [
      'height', 'parentFrameHash', 'stateRoot', 'authorityRoot', 'timestamp',
      'entityContext', 'txs', 'events', 'hash', 'leader', 'jPrefixCertificate',
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
  let entityContext;
  try {
    entityContext = validateEntityInfraContext(frame['entityContext']);
  } catch (error) {
    throw new FinancialDataCorruptionError(
      `${context}.entityContext invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    entityContext.height !== Number(frame['height']) ||
    entityContext.parentFrameHash !== String(frame['parentFrameHash'])
  ) {
    throw new FinancialDataCorruptionError(`${context}.entityContext binding mismatch`);
  }
  return entityContext;
};

const validateFrameLeader = (
  value: unknown,
  entityContext: ReturnType<typeof validateEntityInfraContext>,
  context: string,
): void => {
  const leader = validateObject(value, `${context}.leader`);
  rejectUnexpectedKeys(
    leader,
    ['proposerSignerId', 'view', 'certificate', 'relayCertificate'],
    `${context}.leader`,
  );
  validateString(leader['proposerSignerId'], `${context}.leader.proposerSignerId`);
  if (
    entityContext.proposerSignerId !== String(leader['proposerSignerId'])
  ) {
    throw new FinancialDataCorruptionError(`${context}.entityContext proposer mismatch`);
  }
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
};

const validateFrameOptionalEvidence = (
  frame: Record<string, unknown>,
  context: string,
): void => {
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
    const hankos = validateArray(frame['hankos'], `${context}.hankos`);
    if (hankos.length !== 1) {
      throw new FinancialDataCorruptionError(`${context}.hankos must contain exactly the EntityFrame Hanko`);
    }
    validateString(hankos[0], `${context}.hankos[0]`);
  }
};

function assertProposedEntityFrame(
  frame: Record<string, unknown>,
  context: string,
): asserts frame is Record<string, unknown> & DecodedEntityFrame {
  const entityContext = validateFrameIdentityAndContext(frame, context);
  validateEntityTxs(frame['txs'], `${context}.txs`);
  validateFrameEvents(frame['events'], `${context}.events`);
  const hash = validateString(frame['hash'], `${context}.hash`);
  toEntityHeight(Number(frame['height']));
  toUnixMs(Number(frame['timestamp']));
  toStateHash(String(frame['stateRoot']));
  toStateHash(String(frame['authorityRoot']));
  const parentFrameHash = String(frame['parentFrameHash']);
  if (parentFrameHash !== 'genesis') toFrameHash(parentFrameHash);
  toFrameHash(hash);
  validateFrameLeader(frame['leader'], entityContext, context);
  validateFrameOptionalEvidence(frame, context);
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

const PLACEHOLDER_ECDSA_SIG = `0x${'11'.repeat(65)}`;
// A certified EntityFrame retains only its own Hanko. Secondary Hankos are
// attached to their exact Account/dispute/output payloads before commit.
const PLACEHOLDER_HANKO = `0x${'22'.repeat(2_200)}`;

/**
 * Wire bytes of the unsigned frame plus the signature/Hanko fields a certified
 * frame gains, measured on the MessagePack transport encoding the frame
 * actually travels in. Placeholders stand in for bytes not yet known.
 */
const estimateCertifiedEntityFrameWireBytes = (
  frame: Record<string, unknown>,
  signerId: string,
  hashCount: number,
  includeHankos: boolean,
): number => {
  if (Object.hasOwn(frame, 'collectedSigs') || Object.hasOwn(frame, 'hankos')) {
    throw new FinancialDataCorruptionError('ENTITY_FRAME_WIRE_ESTIMATE_REQUIRES_UNSIGNED_FRAME');
  }
  const certified = {
    ...frame,
    collectedSigs: new Map([[signerId.toLowerCase(), Array.from({ length: hashCount }, () => PLACEHOLDER_ECDSA_SIG)]]),
    ...(includeHankos ? { hankos: [PLACEHOLDER_HANKO] } : {}),
  };
  return packTransportValue(certified).byteLength;
};

const assertEntityFrameCertifiedWireBudget = (
  frame: Record<string, unknown>,
  context: string,
): number => {
  const wireBytes = packTransportValue(frame).byteLength;
  if (wireBytes <= LIMITS.MAX_FRAME_SIZE_BYTES) return wireBytes;
  const part = (value: unknown): number => {
    try { return packTransportValue(value).byteLength; } catch { return -1; }
  };
  throw new FinancialDataCorruptionError(
    `${context} wire byte limit exceeded: ${wireBytes}:${LIMITS.MAX_FRAME_SIZE_BYTES}` +
    `:txs=${part(frame['txs'])}:events=${part(frame['events'])}:context=${part(frame['entityContext'])}` +
    `:hankos=${part(frame['hankos'])}:collectedSigs=${part(frame['collectedSigs'])}`,
  );
};

/** Certified bytes include hashesToSign + sigs + the EntityFrame Hanko. Fit measured empty events;
 *  throw here after apply, before sign, so eviction does not pay for a doomed certification. */
export const assertEstimatedCertifiedEntityFrameWire = (
  frame: Record<string, unknown>,
  signerId: string,
  includeHankos: boolean,
  context: string,
): number => {
  const hashes = frame['hashesToSign'];
  if (!Array.isArray(hashes) || hashes.length === 0) {
    throw new FinancialDataCorruptionError(`${context}.hashesToSign cannot be empty`);
  }
  const estimatedBytes = estimateCertifiedEntityFrameWireBytes(
    frame,
    signerId,
    hashes.length,
    includeHankos,
  );
  if (estimatedBytes <= LIMITS.MAX_FRAME_SIZE_BYTES) return estimatedBytes;
  // Failure path retains the exact historical diagnostics. The hot path uses
  // byte arithmetic and never builds or encodes thousands of placeholder
  // Hanko strings merely to prove the same conservative bound.
  return assertEntityFrameCertifiedWireBudget({
    ...frame,
    collectedSigs: new Map([[signerId.toLowerCase(), hashes.map(() => PLACEHOLDER_ECDSA_SIG)]]),
    ...(includeHankos ? { hankos: [PLACEHOLDER_HANKO] } : {}),
  }, context);
};

/**
 * Frames this process certified itself (commitment, hash, signatures and wire
 * budget all verified by the transition that produced them). Storage re-ran
 * the full structural + byte-budget validator on every one of them before put;
 * data read back from disk or received from peers never enters this set.
 */
const locallyCertifiedFrames = new RecencySet<object>(256);
export const trustLocallyCertifiedEntityFrame = (frame: EntityFrame): void => {
  locallyCertifiedFrames.add(frame);
};

export const validateProposedEntityFrame = (
  value: unknown,
  context: string,
): DecodedEntityFrame => {
  if (value !== null && typeof value === 'object' && locallyCertifiedFrames.has(value)) {
    return value as DecodedEntityFrame;
  }
  const frame = validateObject(value, context);
  assertProposedEntityFrame(frame, context);
  try {
    assertEntityFrameTotalByteBudget({
      prevFrameHash: frame.parentFrameHash,
      height: frame.height,
      timestamp: frame.timestamp,
      txs: frame.txs,
      events: frame.events,
      entityId: frame.entityContext.entityId,
      stateRoot: frame.stateRoot,
      authorityRoot: frame.authorityRoot,
      entityContext: frame.entityContext,
      ...(frame.jPrefixCertificate ? { jPrefixCertificate: frame.jPrefixCertificate } : {}),
    });
  } catch (error) {
    throw new FinancialDataCorruptionError(
      `${context} total byte limit invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertEntityFrameCertifiedWireBudget(frame, context);
  return frame;
};
