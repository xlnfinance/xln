import type { DeliverableEntityInput, RoutedEntityInput } from './types';
import type { EntityOutput } from '../entity/types';
import {
  validateMapInstance,
  validateObject,
} from '../protocol/validation-primitives';
import {
  validateJPrefixAttestation,
} from '../entity/consensus/j-prefix-validation';
import { validateProposedEntityFrame } from '../entity/consensus/frame-validation';
import { requireKnownEntityTxType } from '../entity/tx/catalog';

const assertEntityMessagePayload = (
  input: Record<string, unknown>,
): void => {
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
  if (
    input['leaderTimeoutVote'] !== undefined &&
    (
      input['entityTxs'] !== undefined ||
      input['proposedFrame'] !== undefined ||
      input['hashPrecommitFrame'] !== undefined ||
      input['hashPrecommits'] !== undefined ||
      input['jPrefixAttestations'] !== undefined
    )
  ) {
    throw new Error(
      'FINANCIAL-SAFETY: leaderTimeoutVote must use a dedicated consensus lane',
    );
  }
  if (input['proposedFrame'] !== undefined) {
    validateProposedEntityFrame(
      input['proposedFrame'],
      'EntityInput.proposedFrame',
    );
  }
  if (input['hashPrecommits'] !== undefined) {
    const reference = validateObject(
      input['hashPrecommitFrame'],
      'EntityInput.hashPrecommitFrame',
    );
    if (
      !Number.isSafeInteger(reference['height']) ||
      typeof reference['frameHash'] !== 'string' ||
      reference['frameHash'].trim().length === 0
    ) {
      throw new Error(
        'FINANCIAL-SAFETY: hashPrecommits require exact hashPrecommitFrame',
      );
    }
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

function assertRoutedEntityInput(
  input: Record<string, unknown>,
): asserts input is Record<string, unknown> & RoutedEntityInput {
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
  assertEntityMessagePayload(input);
}

export const decodeRoutedEntityInput = (value: unknown): RoutedEntityInput => {
  const input = validateObject(value, 'EntityInput');
  assertRoutedEntityInput(input);
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
    return output as RoutedEntityInput;
  }
  assertEntityMessagePayload(value);
  return output as EntityOutput;
};

/** Network delivery additionally requires an already resolved Runtime. */
export const validateDeliverableEntityInput = (
  output: unknown,
): DeliverableEntityInput => {
  const value = validateObject(output, 'DeliverableEntityInput');
  assertRoutedEntityInput(value);
  const input = output as RoutedEntityInput;
  if (typeof input.runtimeId !== 'string' || input.runtimeId.trim().length === 0) {
    throw new Error(
      'FINANCIAL-SAFETY: Deliverable EntityOutput missing runtimeId',
    );
  }
  return input as DeliverableEntityInput;
};
