import type {
  CrossJurisdictionSwapRoute,
  RuntimeEntityInputsEnvelope,
} from '../types';
import { validateDeliverableEntityInput } from '../validation-utils';
import { normalizeRuntimeId } from './runtime-id';

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_ATOMIC_PAIR_INVALID');
  }
  const pair = value as Record<string, unknown>;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_CROSS_J_INTENT_INVALID');
  }
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('P2P_ENTITY_INPUTS_ENVELOPE_INVALID');
  }
  const envelope = value as Record<string, unknown>;
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
