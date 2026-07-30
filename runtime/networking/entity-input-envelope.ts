import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { RuntimeEntityInputsEnvelope } from '../runtime/types';
import { validateDeliverableEntityInput } from '../runtime/routing-validation';
import { normalizeRuntimeId } from './runtime-id';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';

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

const decodeCrossJurisdictionIntent = (value: unknown): CrossJurisdictionSwapRoute | undefined => {
  if (value === undefined) return undefined;
  requireBoundaryRecord(value, 'P2P_ENTITY_INPUTS_ENVELOPE_CROSS_J_INTENT_INVALID');
  // The transport only establishes the envelope shape. Runtime admission
  // canonicalizes and validates every financial field against local state;
  // duplicating that protocol validator here would create two authorities.
  return value as CrossJurisdictionSwapRoute;
};

/**
 * Decode authenticated plaintext before it crosses from transport into the
 * Runtime machine. Encryption proves confidentiality, not schema validity.
 */
export const decodeRuntimeEntityInputsEnvelope = (value: unknown): RuntimeEntityInputsEnvelope => {
  const envelope = requireBoundaryRecord(value, 'P2P_ENTITY_INPUTS_ENVELOPE_INVALID');
  requireExactBoundaryKeys(
    envelope,
    ['sourceRuntimeId', 'sourceRuntimeHeight', 'sourceRuntimeTimestamp', 'entityInputs'],
    ['atomicCrossJurisdictionPair', 'crossJurisdictionIntent'],
    'P2P_ENTITY_INPUTS_ENVELOPE_FIELDS_INVALID',
  );
  const sourceRuntimeId = normalizeRuntimeId(envelope['sourceRuntimeId']);
  if (!sourceRuntimeId) throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_SOURCE_RUNTIME_INVALID');
  if (!Array.isArray(envelope['entityInputs'])) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_INPUTS_INVALID');
  }
  const entityInputs = envelope['entityInputs'].map(validateDeliverableEntityInput);
  const crossJurisdictionIntent = decodeCrossJurisdictionIntent(envelope['crossJurisdictionIntent']);
  if (crossJurisdictionIntent && entityInputs.length > 0) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_MIXED_CONTENT');
  }
  if (!crossJurisdictionIntent && entityInputs.length === 0) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_EMPTY');
  }
  const atomicCrossJurisdictionPair = decodeAtomicPair(
    envelope['atomicCrossJurisdictionPair'],
    entityInputs.length,
  );
  return {
    sourceRuntimeId,
    sourceRuntimeHeight: requireFrameCoordinate(envelope['sourceRuntimeHeight'], 'HEIGHT'),
    sourceRuntimeTimestamp: requireFrameCoordinate(envelope['sourceRuntimeTimestamp'], 'TIMESTAMP'),
    entityInputs,
    ...(atomicCrossJurisdictionPair ? { atomicCrossJurisdictionPair } : {}),
    ...(crossJurisdictionIntent ? { crossJurisdictionIntent } : {}),
  };
};
