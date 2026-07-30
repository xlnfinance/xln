import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type { RuntimeInput } from '../types';
import { validateRuntimeTx } from './runtime-tx';

const requireInputArray = (
  input: Record<string, unknown>,
  field: 'runtimeTxs' | 'entityInputs' | 'jInputs' | 'reliableReceipts',
  code: string,
): unknown[] => {
  const entries = input[field];
  if (!Array.isArray(entries)) {
    throw new Error(`${code}_${field.toUpperCase()}_INVALID`);
  }
  return entries;
};

/**
 * Decode the Runtime-owned part of an ingress batch before it reaches the
 * mempool. Child-machine inputs have their own owner decoders during Runtime
 * admission; Runtime transactions are fully decoded here and in WAL replay.
 */
export const decodeRuntimeInput = (
  value: unknown,
  code: string,
): RuntimeInput => {
  const input = requireBoundaryRecord(value, `${code}_INVALID`);
  requireExactBoundaryKeys(
    input,
    ['runtimeTxs', 'entityInputs'],
    ['jInputs', 'reliableReceipts', 'timestamp', 'queuedAt'],
    `${code}_FIELDS_INVALID`,
  );
  const runtimeTxs = requireInputArray(input, 'runtimeTxs', code);
  const entityInputs = requireInputArray(input, 'entityInputs', code);
  runtimeTxs.forEach((tx, index) =>
    validateRuntimeTx(tx, `${code}_RUNTIME_TX_${index}`));
  entityInputs.forEach((entry, index) => {
    const entityInput = requireBoundaryRecord(
      entry,
      `${code}_ENTITY_INPUT_INVALID:index=${index}`,
    );
    if (
      typeof entityInput['entityId'] !== 'string'
      || entityInput['entityId'].trim().length === 0
    ) {
      throw new Error(`${code}_ENTITY_INPUT_INVALID:index=${index}`);
    }
  });
  const jInputs = input['jInputs'] === undefined
    ? undefined
    : requireInputArray(input, 'jInputs', code);
  jInputs?.forEach((entry, index) => {
    const jInput = requireBoundaryRecord(
      entry,
      `${code}_J_INPUT_INVALID:index=${index}`,
    );
    requireExactBoundaryKeys(
      jInput,
      ['jurisdictionName', 'jTxs'],
      [],
      `${code}_J_INPUT_FIELDS_INVALID:index=${index}`,
    );
    if (
      typeof jInput['jurisdictionName'] !== 'string'
      || !Array.isArray(jInput['jTxs'])
    ) {
      throw new Error(`${code}_J_INPUT_INVALID:index=${index}`);
    }
  });
  const reliableReceipts = input['reliableReceipts'] === undefined
    ? undefined
    : requireInputArray(input, 'reliableReceipts', code);
  const timestamp = input['timestamp'] === undefined
    ? undefined
    : requireBoundaryInteger(input['timestamp'], `${code}_TIMESTAMP_INVALID`);
  const queuedAt = input['queuedAt'] === undefined
    ? undefined
    : requireBoundaryInteger(input['queuedAt'], `${code}_QUEUED_AT_INVALID`);
  return {
    runtimeTxs: runtimeTxs as RuntimeInput['runtimeTxs'],
    entityInputs: entityInputs as RuntimeInput['entityInputs'],
    ...(jInputs === undefined
      ? {}
      : { jInputs: jInputs as NonNullable<RuntimeInput['jInputs']> }),
    ...(reliableReceipts === undefined
      ? {}
      : {
          reliableReceipts:
            reliableReceipts as NonNullable<RuntimeInput['reliableReceipts']>,
        }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(queuedAt === undefined ? {} : { queuedAt }),
  };
};
