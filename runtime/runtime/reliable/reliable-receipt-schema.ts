import {
  requireArray,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../protocol/boundary/boundary-primitives.ts';
import type {
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
} from '../types.ts';
import { getReliableIdentityValidationError } from './reliable-frontier.ts';

const decodeReliableIdentity = (
  value: unknown,
  code: string,
): ReliableDeliveryIdentity => {
  const identity = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(identity, [
    'kind', 'entityId', 'signerId', 'laneKey', 'height', 'frameHash', 'logicalKey',
    'evidenceVersion', 'evidenceKind', 'evidenceDigest',
  ], ['logIndex', 'bodyDigest', 'evidenceBindings'], `${code}_FIELDS`);
  if (identity['evidenceBindings'] !== undefined) {
    for (const [index, raw] of requireArray(identity['evidenceBindings'], `${code}_BINDINGS`).entries()) {
      const binding = requireBoundaryRecord(raw, `${code}_BINDING_${index}`);
      requireExactBoundaryKeys(binding, ['subject', 'digest'], [], `${code}_BINDING_${index}_FIELDS`);
    }
  }
  const error = getReliableIdentityValidationError(identity);
  if (error) throw new Error(`${code}:${error}`);
  return identity as ReliableDeliveryIdentity;
};

/** Exact boundary decoder shared by network/control ingress and durable WAL. */
export const decodeReliableDeliveryReceipt = (
  value: unknown,
  code: string,
): ReliableDeliveryReceipt => {
  const receipt = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(receipt, ['body', 'signature'], [], `${code}_FIELDS`);
  const body = requireBoundaryRecord(receipt['body'], `${code}_BODY`);
  requireExactBoundaryKeys(
    body,
    ['version', 'coverage', 'receiverRuntimeId', 'identity', 'appliedRuntimeHeight'],
    [],
    `${code}_BODY_FIELDS`,
  );
  if (body['version'] !== 1) throw new Error(`${code}_BODY_VERSION`);
  if (body['coverage'] !== 'exact' && body['coverage'] !== 'terminal') {
    throw new Error(`${code}_BODY_COVERAGE`);
  }
  requireString(body['receiverRuntimeId'], `${code}_BODY_RECEIVER`);
  decodeReliableIdentity(body['identity'], `${code}_BODY_IDENTITY`);
  requireBoundaryInteger(body['appliedRuntimeHeight'], `${code}_BODY_HEIGHT`);
  requireString(receipt['signature'], `${code}_SIGNATURE`);
  return receipt as ReliableDeliveryReceipt;
};

export const validateReliableDeliveryIdentity = (
  value: unknown,
  code: string,
): void => {
  decodeReliableIdentity(value, code);
};
