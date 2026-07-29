import type {
  DeliverableEntityInput,
  RoutedEntityInput,
} from '../types';
import {
  validateMapInstance,
  validateObject,
} from '../protocol/validation-primitives';
import {
  validateJPrefixAttestation,
} from '../entity/consensus/j-prefix-validation';
import { validateProposedEntityFrame } from '../entity/consensus/frame-validation';

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
}

export const decodeRoutedEntityInput = (value: unknown): RoutedEntityInput => {
  const input = validateObject(value, 'EntityInput');
  assertRoutedEntityInput(input);
  return input;
};

/**
 * Entity outputs and destination inputs share one canonical wire shape.
 * Direction is routing metadata, not a second schema.
 */
export const decodeRoutedEntityOutput = (
  output: unknown,
): RoutedEntityInput => {
  const value = validateObject(output, 'RoutedEntityOutput');
  if (typeof value['entityId'] !== 'string' || value['entityId'].length === 0) {
    throw new Error(
      'FINANCIAL-SAFETY: EntityOutput entityId is missing - routing corruption',
    );
  }
  if (
    typeof value['signerId'] !== 'string' ||
    value['signerId'].trim().length === 0
  ) {
    throw new Error(
      'FINANCIAL-SAFETY: EntityOutput signerId is missing - routed outputs must target an exact signer replica',
    );
  }
  return output as RoutedEntityInput;
};

/** Network delivery additionally requires an already resolved Runtime. */
export const validateDeliverableEntityInput = (
  output: unknown,
): DeliverableEntityInput => {
  const input = decodeRoutedEntityOutput(output);
  if (typeof input.runtimeId !== 'string' || input.runtimeId.trim().length === 0) {
    throw new Error(
      'FINANCIAL-SAFETY: Deliverable EntityOutput missing runtimeId',
    );
  }
  return input as DeliverableEntityInput;
};
