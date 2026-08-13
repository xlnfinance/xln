import type { RuntimeEntityInputsEnvelope } from '../../../runtime/types';
import {
  validateDeliverableEntityInput,
  type ValidatedDeliverableEntityInput,
} from '../../../runtime/routing/routing-validation';
import { decodeRuntimeId } from './runtime-id';
import type { RuntimeId } from '../../../protocol/identity';
import {
  toRuntimeHeight,
  toUnixMs,
  type RuntimeHeight,
  type UnixMs,
} from '../../../protocol/units';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';

export const MAX_P2P_ENTITY_INPUTS = 256;

export type DecodedRuntimeEntityInputsEnvelope = Omit<
  RuntimeEntityInputsEnvelope,
  'sourceRuntimeId' | 'sourceRuntimeHeight' | 'sourceRuntimeTimestamp' | 'entityInputs'
> & Readonly<{
  sourceRuntimeId: RuntimeId;
  sourceRuntimeHeight: RuntimeHeight;
  sourceRuntimeTimestamp: UnixMs;
  entityInputs: ValidatedDeliverableEntityInput[];
}>;

const requireFrameCoordinate = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`P2P_ENTITY_INPUTS_ENVELOPE_${field}_INVALID`);
  }
  return value;
};

const decodeAtomicPair = (
  value: unknown,
  inputCount: number,
): RuntimeEntityInputsEnvelope['atomicCrossJurisdictionPair'] => {
  if (value === undefined) return undefined;
  const pair = requireBoundaryRecord(
    value,
    'P2P_ENTITY_INPUTS_ENVELOPE_ATOMIC_PAIR_INVALID',
  );
  requireExactBoundaryKeys(
    pair,
    ['phase', 'pairKey'],
    [],
    'P2P_ENTITY_INPUTS_ENVELOPE_ATOMIC_PAIR_FIELDS_INVALID',
  );
  const phase = pair['phase'];
  const pairKey = pair['pairKey'];
  if (
    (phase !== 'proposal' && phase !== 'ack') ||
    typeof pairKey !== 'string' ||
    pairKey.length === 0 ||
    inputCount !== 2
  ) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_ATOMIC_PAIR_INVALID');
  }
  return { phase, pairKey };
};

/**
 * Decode authenticated plaintext before it crosses from transport into the
 * Runtime machine. Encryption proves confidentiality, not schema validity.
 */
export const decodeRuntimeEntityInputsEnvelope = (value: unknown): DecodedRuntimeEntityInputsEnvelope => {
  const envelope = requireBoundaryRecord(value, 'P2P_ENTITY_INPUTS_ENVELOPE_INVALID');
  requireExactBoundaryKeys(
    envelope,
    ['sourceRuntimeId', 'sourceRuntimeHeight', 'sourceRuntimeTimestamp', 'entityInputs', 'sourceSignature'],
    ['atomicCrossJurisdictionPair'],
    'P2P_ENTITY_INPUTS_ENVELOPE_FIELDS_INVALID',
  );
  let sourceRuntimeId: RuntimeId;
  try {
    sourceRuntimeId = decodeRuntimeId(envelope['sourceRuntimeId']);
  } catch {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_SOURCE_RUNTIME_INVALID');
  }
  const sourceSignature = envelope['sourceSignature'];
  if (typeof sourceSignature !== 'string' || !/^0x[0-9a-f]{130}$/.test(sourceSignature)) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_SOURCE_SIGNATURE_INVALID');
  }
  if (!Array.isArray(envelope['entityInputs'])) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_INPUTS_INVALID');
  }
  if (envelope['entityInputs'].length > MAX_P2P_ENTITY_INPUTS) {
    throw new Error(
      `P2P_ENTITY_INPUTS_ENVELOPE_INPUTS_TOO_MANY:${envelope['entityInputs'].length}:${MAX_P2P_ENTITY_INPUTS}`,
    );
  }
  if (envelope['entityInputs'].length === 0) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_EMPTY');
  }
  const atomicCrossJurisdictionPair = decodeAtomicPair(
    envelope['atomicCrossJurisdictionPair'],
    envelope['entityInputs'].length,
  );
  const entityInputs = envelope['entityInputs'].map(validateDeliverableEntityInput);
  return {
    sourceRuntimeId,
    sourceSignature,
    sourceRuntimeHeight: toRuntimeHeight(requireFrameCoordinate(envelope['sourceRuntimeHeight'], 'HEIGHT')),
    sourceRuntimeTimestamp: toUnixMs(requireFrameCoordinate(envelope['sourceRuntimeTimestamp'], 'TIMESTAMP')),
    entityInputs,
    ...(atomicCrossJurisdictionPair ? { atomicCrossJurisdictionPair } : {}),
  };
};
