import type { RoutedEntityInput } from '../../types';
import type { EntityOutput } from '../../../entity/types';
import {
  toEntityId,
  toRuntimeId,
  toSignerId,
  type EntityId,
  type RuntimeId,
  type SignerId,
} from '../../../protocol/identity';
import {
  validateMapInstance,
  validateObject,
} from '../../../protocol/boundary/validation-primitives';
import {
  validateJPrefixAttestation,
} from '../../../entity/consensus/j-prefix/prefix-validation';
import { validateProposedEntityFrame } from '../../../entity/consensus/frame/validation';
import { requireKnownEntityTxType } from '../../../entity/tx/processing/catalog';
import { getEntityInputPhaseCombinationError } from '../../../entity/consensus/input/phase-views';
import {
  requireBoundaryInteger,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';
import { toFrameHash, type FrameHash } from '../../../protocol/hashes';
import {
  toEntityHeight,
  toRuntimeHeight,
  toUnixMs,
  type EntityHeight,
  type RuntimeHeight,
  type UnixMs,
} from '../../../protocol/units';

const assertEntityMessagePayload: (
  input: Record<string, unknown>,
) => asserts input is Record<string, unknown> & EntityOutput = input => {
  if (
    input['entityTxs'] === undefined &&
    input['proposedFrame'] === undefined &&
    input['hashPrecommits'] === undefined &&
    input['jPrefixAttestations'] === undefined &&
    input['leaderTimeoutVote'] === undefined
  ) {
    throw new Error(
      'FINANCIAL-SAFETY: entityTxs, proposedFrame, hashPrecommits, jPrefixAttestations, or leaderTimeoutVote required',
    );
  }
  if (input['entityTxs'] !== undefined && !Array.isArray(input['entityTxs'])) {
    throw new Error('FINANCIAL-SAFETY: entityTxs must be array');
  }
  if (input['entityTxs'] !== undefined) {
    input['entityTxs'].forEach((tx, index) => {
      requireKnownEntityTxType(tx, `EntityInput.entityTxs_${index}`);
    });
  }
  if (input['proposedFrame'] !== undefined) {
    validateProposedEntityFrame(
      input['proposedFrame'],
      'EntityInput.proposedFrame',
    );
  }
  if (input['hashPrecommitFrame'] !== undefined) {
    const reference = validateObject(
      input['hashPrecommitFrame'],
      'EntityInput.hashPrecommitFrame',
    );
    requireExactBoundaryKeys(
      reference,
      ['height', 'frameHash'],
      [],
      'ENTITY_INPUT_HASH_PRECOMMIT_FRAME_FIELDS_INVALID',
    );
    if (typeof reference['frameHash'] !== 'string') {
      throw new Error(
        'FINANCIAL-SAFETY: hashPrecommits require exact hashPrecommitFrame',
      );
    }
    toEntityHeight(requireBoundaryInteger(
      reference['height'],
      'ENTITY_INPUT_HASH_PRECOMMIT_HEIGHT_INVALID',
    ));
    toFrameHash(reference['frameHash']);
  }
  if (input['hashPrecommits'] !== undefined && input['hashPrecommitFrame'] === undefined) {
    throw new Error(
      'FINANCIAL-SAFETY: hashPrecommits require exact hashPrecommitFrame',
    );
  }
  if (input['jPrefixAttestations'] !== undefined) {
    const attestations = validateMapInstance(
      input['jPrefixAttestations'],
      'EntityInput.jPrefixAttestations',
    );
    if (attestations.size === 0) {
      throw new Error(
        'FINANCIAL-SAFETY: jPrefixAttestations cannot be empty',
      );
    }
    for (const [signerId, attestation] of attestations) {
      if (typeof signerId !== 'string' || signerId.trim().length === 0) {
        throw new Error(
          'FINANCIAL-SAFETY: jPrefixAttestations signer must be non-empty string',
        );
      }
      validateJPrefixAttestation(
        attestation,
        `EntityInput.jPrefixAttestations[${signerId}]`,
      );
    }
  }
};

export type ValidatedRoutedEntityInput = RoutedEntityInput & Readonly<{
  entityId: EntityId;
  signerId: SignerId;
  runtimeId?: RuntimeId;
  from?: RuntimeId;
  sourceRuntimeFrame?: Readonly<{
    height: RuntimeHeight;
    timestamp: UnixMs;
  }>;
  hashPrecommitFrame?: Readonly<{
    height: EntityHeight;
    frameHash: FrameHash;
  }>;
}>;

export type ValidatedDeliverableEntityInput = ValidatedRoutedEntityInput & Readonly<{
  runtimeId: RuntimeId;
}>;

function assertRoutedEntityInput(
  input: Record<string, unknown>,
): asserts input is Record<string, unknown> & ValidatedRoutedEntityInput {
  if (typeof input['entityId'] !== 'string' || input['entityId'].length === 0) {
    throw new Error(
      'FINANCIAL-SAFETY: entityId is missing or invalid - financial routing corruption detected',
    );
  }
  if (
    typeof input['signerId'] !== 'string' ||
    input['signerId'].trim().length === 0
  ) {
    throw new Error(
      'FINANCIAL-SAFETY: signerId is missing - entity input must target an exact signer replica',
    );
  }
  toEntityId(input['entityId']);
  toSignerId(input['signerId']);
  for (const field of ['runtimeId', 'from'] as const) {
    const runtimeId = input[field];
    if (runtimeId !== undefined) {
      if (typeof runtimeId !== 'string') {
        throw new Error(`FINANCIAL-SAFETY: ${field} must be a RuntimeId`);
      }
      toRuntimeId(runtimeId);
    }
  }
  if (input['sourceRuntimeFrame'] !== undefined) {
    const sourceFrame = validateObject(
      input['sourceRuntimeFrame'],
      'EntityInput.sourceRuntimeFrame',
    );
    requireExactBoundaryKeys(
      sourceFrame,
      ['height', 'timestamp'],
      [],
      'ENTITY_INPUT_SOURCE_RUNTIME_FRAME_FIELDS_INVALID',
    );
    toRuntimeHeight(requireBoundaryInteger(
      sourceFrame['height'],
      'ENTITY_INPUT_SOURCE_RUNTIME_HEIGHT_INVALID',
    ));
    toUnixMs(requireBoundaryInteger(
      sourceFrame['timestamp'],
      'ENTITY_INPUT_SOURCE_RUNTIME_TIMESTAMP_INVALID',
    ));
  }
  assertEntityMessagePayload(input);
}

export const decodeRoutedEntityInput = (value: unknown): ValidatedRoutedEntityInput => {
  const input = validateObject(value, 'EntityInput');
  assertRoutedEntityInput(input);
  const phaseError = getEntityInputPhaseCombinationError(input);
  if (phaseError) throw new Error(`FINANCIAL-SAFETY:${phaseError}`);
  return input;
};

/** Decode a committed Entity output before Runtime adds transport routing. */
export const decodeEntityOutput = (
  output: unknown,
): EntityOutput => {
  const value = validateObject(output, 'RoutedEntityOutput');
  if (typeof value['entityId'] !== 'string' || value['entityId'].length === 0) {
    throw new Error(
      'FINANCIAL-SAFETY: EntityOutput entityId is missing - routing corruption',
    );
  }
  if (value['runtimeId'] !== undefined || value['from'] !== undefined) {
    throw new Error(
      'FINANCIAL-SAFETY: EntityOutput cannot contain Runtime transport routing',
    );
  }
  if (value['signerId'] !== undefined) {
    assertRoutedEntityInput(value);
    return value;
  }
  assertEntityMessagePayload(value);
  return value;
};

/** Network delivery additionally requires an already resolved Runtime. */
function assertDeliverableRuntime(
  input: Record<string, unknown> & ValidatedRoutedEntityInput,
): asserts input is Record<string, unknown> & ValidatedDeliverableEntityInput {
  if (input.runtimeId === undefined) {
    throw new Error(
      'FINANCIAL-SAFETY: Deliverable EntityOutput missing runtimeId',
    );
  }
}

export const validateDeliverableEntityInput = (
  output: unknown,
): ValidatedDeliverableEntityInput => {
  const value = validateObject(output, 'DeliverableEntityInput');
  assertRoutedEntityInput(value);
  assertDeliverableRuntime(value);
  return value;
};
