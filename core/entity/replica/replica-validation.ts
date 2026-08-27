import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import type { EntityReplica } from '../types';
import { validateHtlcNotes } from '../htlc/note-validation';
import {
  validateEntityLeaderCertificate,
  validateEntityLeaderVote,
  validateProposedEntityFrame,
} from '../consensus/frame/validation';
import {
  validateJPrefixAttestation,
  validateJPrefixCertificate,
} from '../consensus/j-prefix/prefix-validation';
import {
  validateEntityProviderActionSubmitState,
  validateJSubmitState,
} from './replica-submit-validation';
import {
  validateReplicaJHistory,
  validateReplicaLineageAndWitnesses,
} from './replica-evidence-validation';
import { validateEntityState } from '../state/state-validation';

const assertExactFields = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void => {
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new FinancialDataCorruptionError(
      `${context} contains unexpected fields: ${unexpected.sort().join(',')}`,
    );
  }
};

const validateEntityCandidate = (
  value: unknown,
  entityId: string,
  context: string,
): void => {
  if (value === undefined) return;
  const candidate = validateObject(value, `${context}.candidate`);
  validateString(candidate['frameHash'], `${context}.candidate.frameHash`);
  const height = validateNumber(
    candidate['height'],
    `${context}.candidate.height`,
  );
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new FinancialDataCorruptionError(
      `${context}.candidate.height must be a positive safe integer`,
    );
  }
  const state = validateEntityState(
    candidate['state'],
    `${context}.candidate.state`,
  );
  if (state.entityId !== entityId || state.height !== height) {
    throw new FinancialDataCorruptionError(
      `${context}.candidate state identity or height mismatch`,
    );
  }
  for (const field of ['outputs', 'jOutputs', 'hashesToSign'] as const) {
    validateArray(candidate[field], `${context}.candidate.${field}`);
  }
  const changes = validateArray<unknown>(
    candidate['storageChanges'],
    `${context}.candidate.storageChanges`,
  );
  changes.forEach((value, index) => {
    const item = `${context}.candidate.storageChanges[${index}]`;
    const change = validateObject(value, item);
    const family = validateString(change['family'], `${item}.family`);
    validateString(change['entityId'], `${item}.entityId`);
    if (family === 'account') {
      assertExactFields(
        change,
        new Set(['family', 'entityId', 'counterpartyId']),
        item,
      );
      validateString(change['counterpartyId'], `${item}.counterpartyId`);
    } else if (family === 'book') {
      assertExactFields(
        change,
        new Set(['family', 'entityId', 'pairId', 'deleted']),
        item,
      );
      validateString(change['pairId'], `${item}.pairId`);
      if (change['deleted'] !== undefined && typeof change['deleted'] !== 'boolean') {
        throw new FinancialDataCorruptionError(`${item}.deleted must be boolean`);
      }
    } else if (family === 'entity') {
      assertExactFields(change, new Set(['family', 'entityId']), item);
    } else {
      throw new FinancialDataCorruptionError(`${item}.family is invalid`);
    }
  });
  if (candidate['proposableAccounts'] !== undefined) {
    const proposable = validateArray<unknown>(
      candidate['proposableAccounts'],
      `${context}.candidate.proposableAccounts`,
    );
    proposable.forEach((value, index) => {
      validateString(value, `${context}.candidate.proposableAccounts[${index}]`);
    });
  }
  for (const field of [
    'accountJClaimNodeChanges',
  ] as const) {
    if (candidate[field] === undefined) continue;
    const nodeChanges = validateObject(
      candidate[field],
      `${context}.candidate.${field}`,
    );
    validateArray(
      nodeChanges['newNodes'],
      `${context}.candidate.${field}.newNodes`,
    );
    validateArray(
      nodeChanges['replacedNodeHashes'],
      `${context}.candidate.${field}.replacedNodeHashes`,
    );
  }
};

const validatePosition = (value: unknown, context: string): void => {
  if (value === undefined) return;
  const position = validateObject(value, `${context}.position`);
  for (const axis of ['x', 'y', 'z'] as const) {
    validateNumber(position[axis], `${context}.position.${axis}`);
  }
};

const validateLeaderConsensus = (
  replica: Record<string, unknown>,
  context: string,
): void => {
  if (replica['leaderVotes'] !== undefined) {
    const votes = validateMapInstance(
      replica['leaderVotes'],
      `${context}.leaderVotes`,
    );
    for (const [signerId, vote] of votes) {
      if (typeof signerId !== 'string' || signerId.length === 0) {
        throw new FinancialDataCorruptionError(
          `${context}.leaderVotes signer must be non-empty string`,
        );
      }
      validateEntityLeaderVote(vote, `${context}.leaderVotes[${signerId}]`);
    }
  }
  if (replica['pendingLeaderCertificate'] !== undefined) {
    validateEntityLeaderCertificate(
      replica['pendingLeaderCertificate'],
      `${context}.pendingLeaderCertificate`,
    );
  }
  if (replica['lastConsensusProgressAt'] === undefined) return;
  const progressAt = validateNumber(
    replica['lastConsensusProgressAt'],
    `${context}.lastConsensusProgressAt`,
  );
  if (!Number.isSafeInteger(progressAt) || progressAt < 0) {
    throw new FinancialDataCorruptionError(
      `${context}.lastConsensusProgressAt must be non-negative`,
    );
  }
};

const validateJPrefixRound = (value: unknown, context: string): void => {
  if (value === undefined) return;
  const round = validateObject(value, `${context}.jPrefixRound`);
  assertExactFields(
    round,
    new Set([
      'targetEntityHeight',
      'parentFrameHash',
      'jurisdictionRef',
      'baseHeight',
      'attestations',
      'certificate',
    ]),
    `${context}.jPrefixRound`,
  );
  validateNumber(
    round['targetEntityHeight'],
    `${context}.jPrefixRound.targetEntityHeight`,
  );
  validateString(
    round['parentFrameHash'],
    `${context}.jPrefixRound.parentFrameHash`,
  );
  validateString(
    round['jurisdictionRef'],
    `${context}.jPrefixRound.jurisdictionRef`,
  );
  validateNumber(round['baseHeight'], `${context}.jPrefixRound.baseHeight`);
  const attestations = validateMapInstance(
    round['attestations'],
    `${context}.jPrefixRound.attestations`,
  );
  for (const [signerId, attestation] of attestations) {
    validateString(signerId, `${context}.jPrefixRound.attestations.signerId`);
    validateJPrefixAttestation(
      attestation,
      `${context}.jPrefixRound.attestations[${String(signerId)}]`,
    );
  }
  if (round['certificate'] !== undefined) {
    validateJPrefixCertificate(
      round['certificate'],
      `${context}.jPrefixRound.certificate`,
    );
  }
};

type EntityReplicaMetadata = EntityReplica;

function assertEntityReplicaMetadata(
  replica: Record<string, unknown>,
  context: string,
): asserts replica is Record<string, unknown> & EntityReplicaMetadata {
  const entityId = validateString(replica['entityId'], `${context}.entityId`);
  validateString(replica['signerId'], `${context}.signerId`);
  const state = validateEntityState(replica['state'], `${context}.state`);
  if (state.entityId !== entityId) {
    throw new FinancialDataCorruptionError(
      `${context}.state.entityId must match replica.entityId`,
      { entityId, stateEntityId: state.entityId },
    );
  }
  validateArray(replica['mempool'], `${context}.mempool`);
  if (typeof replica['isProposer'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context}.isProposer must be boolean`);
  }
  if (replica['proposal'] !== undefined) {
    validateProposedEntityFrame(replica['proposal'], `${context}.proposal`);
  }
  if (replica['lockedFrame'] !== undefined) {
    validateProposedEntityFrame(replica['lockedFrame'], `${context}.lockedFrame`);
  }
  validateEntityCandidate(replica['candidate'], entityId, context);
  validateReplicaLineageAndWitnesses(replica, context);
  validatePosition(replica['position'], context);
  validateLeaderConsensus(replica, context);
  validateHtlcNotes(replica['htlcNotes'], context);
  validateReplicaJHistory(replica['jHistory'], context);
  validateJPrefixRound(replica['jPrefixRound'], context);
  if (replica['jSubmitState'] !== undefined) {
    validateJSubmitState(replica['jSubmitState'], `${context}.jSubmitState`);
  }
  if (replica['entityProviderActionSubmitState'] !== undefined) {
    validateEntityProviderActionSubmitState(
      replica['entityProviderActionSubmitState'],
      `${context}.entityProviderActionSubmitState`,
    );
  }
}

function assertEntityReplica(
  replica: Record<string, unknown>,
  context: string,
): asserts replica is Record<string, unknown> & EntityReplica {
  assertEntityReplicaMetadata(replica, context);
}

export const validateEntityReplica = (
  value: unknown,
  context = 'EntityReplica',
): EntityReplica => {
  const replica = validateObject(value, context);
  assertEntityReplica(replica, context);
  return replica;
};

/**
 * Decode durable replica coordination metadata without accepting secrets.
 *
 * Runtime signer material rederives the private encryption key after storage
 * verification. Persisting it here would turn every WAL/checkpoint copy into
 * a plaintext key backup and would make remote history export unsafe.
 */
export const validateEntityReplicaMetadata = (
  value: unknown,
  context = 'EntityReplicaMetadata',
): EntityReplicaMetadata => {
  const replica = validateObject(value, context);
  if (Object.hasOwn(replica, 'entityEncPrivKey')) {
    throw new FinancialDataCorruptionError(
      `${context}.entityEncPrivKey must not be persisted`,
    );
  }
  assertEntityReplicaMetadata(replica, context);
  return replica;
};
