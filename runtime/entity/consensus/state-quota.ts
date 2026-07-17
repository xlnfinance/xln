import type { EntityState } from '../../types';
import {
  getConsumptionTreeByteLength,
  type ConsumptionAccumulatorState,
} from '../consumption-accumulator';
import { encodeCanonicalEntityConsensusState } from './state-root';

export const DEFAULT_ENTITY_CONSENSUS_STATE_WARNING_BYTES = 1024 ** 3;
export const MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES = 10 * 1024 ** 4;

export type EntityConsensusStateQuotaConfig = Readonly<{
  warningBytes: number;
}>;

export type EntityConsensusStateConsumptionAdapter = Readonly<{
  getAccumulatorState: (
    state: EntityState,
  ) => Pick<ConsumptionAccumulatorState, 'count'> | undefined;
}>;

export type EntityConsensusStateByteMeasurement = Readonly<{
  canonicalBytes: bigint;
  consumptionTreeBytes: bigint;
  totalBytes: bigint;
}>;

export type EntityConsensusStateQuotaClassification =
  | 'within'
  | 'warning_growth'
  | 'warning_non_growth';

export type EntityConsensusStateQuotaAssessment = Readonly<{
  classification: EntityConsensusStateQuotaClassification;
  warningBytes: bigint;
  preStateBytes: bigint;
  postStateBytes: bigint;
  overageBytes: bigint;
}>;

const DEFAULT_CONFIG: EntityConsensusStateQuotaConfig = Object.freeze({
  warningBytes: DEFAULT_ENTITY_CONSENSUS_STATE_WARNING_BYTES,
});
const UTF8_ENCODER = new TextEncoder();

const strictConfigRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ENTITY_STATE_QUOTA_CONFIG_INVALID');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('ENTITY_STATE_QUOTA_CONFIG_INVALID');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'warningBytes') {
    throw new Error(`ENTITY_STATE_QUOTA_CONFIG_FIELDS_INVALID:${keys.map(String).join(',') || 'missing'}`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'warningBytes');
  if (!descriptor?.enumerable || !('value' in descriptor)) {
    throw new Error('ENTITY_STATE_QUOTA_CONFIG_DESCRIPTOR_INVALID');
  }
  return value as Record<string, unknown>;
};

export const validateEntityConsensusStateQuotaConfig = (
  value: unknown = DEFAULT_CONFIG,
): EntityConsensusStateQuotaConfig => {
  const warningBytes = strictConfigRecord(value)['warningBytes'];
  if (typeof warningBytes !== 'number' || !Number.isSafeInteger(warningBytes) || warningBytes <= 0) {
    throw new Error(`ENTITY_STATE_QUOTA_WARNING_BYTES_INVALID:${String(warningBytes)}`);
  }
  if (warningBytes > MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES) {
    throw new Error(
      `ENTITY_STATE_QUOTA_WARNING_BYTES_EXCEEDS_MAX:${warningBytes}:${MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES}`,
    );
  }
  return Object.freeze({ warningBytes });
};

export const measureEntityConsensusStateBytes = (
  state: EntityState,
  consumptionAdapter?: EntityConsensusStateConsumptionAdapter,
): EntityConsensusStateByteMeasurement => {
  const canonicalState = encodeCanonicalEntityConsensusState(state);
  const canonicalBytes = BigInt(UTF8_ENCODER.encode(canonicalState).byteLength);
  const accumulatorState = consumptionAdapter?.getAccumulatorState(state);
  const consumptionTreeBytes = accumulatorState === undefined
    ? 0n
    : getConsumptionTreeByteLength(accumulatorState.count);
  return Object.freeze({
    canonicalBytes,
    consumptionTreeBytes,
    totalBytes: canonicalBytes + consumptionTreeBytes,
  });
};

const validatedByteLength = (value: unknown, label: 'PRE' | 'POST'): bigint => {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new Error(`ENTITY_STATE_QUOTA_${label}_BYTES_INVALID:${String(value)}`);
  }
  return value;
};

export const classifyEntityConsensusStateQuotaTransition = (
  preStateBytesInput: bigint,
  postStateBytesInput: bigint,
  configInput?: unknown,
): EntityConsensusStateQuotaAssessment => {
  const preStateBytes = validatedByteLength(preStateBytesInput, 'PRE');
  const postStateBytes = validatedByteLength(postStateBytesInput, 'POST');
  const warningBytes = BigInt(validateEntityConsensusStateQuotaConfig(configInput).warningBytes);
  const classification: EntityConsensusStateQuotaClassification = postStateBytes <= warningBytes
    ? 'within'
    : postStateBytes > preStateBytes
      ? 'warning_growth'
      : 'warning_non_growth';
  return Object.freeze({
    classification,
    warningBytes,
    preStateBytes,
    postStateBytes,
    overageBytes: postStateBytes > warningBytes ? postStateBytes - warningBytes : 0n,
  });
};
