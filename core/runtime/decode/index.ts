import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type { RuntimeInput } from '../types';
import { toUnixMs, type UnixMs } from '../../protocol/units';
import {
  decodeRoutedEntityInput,
  type ValidatedRoutedEntityInput,
} from '../delivery/topology/routing-validation';
import { validateRuntimeTx } from './runtime-tx';
import { validateEntityTx } from '../../entity/tx-validation';
import { validateJInputs } from '../../storage/wal/runtime-machine-schema/j';

const requireInputArray = (
  input: Record<string, unknown>,
  field: 'runtimeTxs' | 'entityInputs' | 'jInputs',
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
export type DecodedRuntimeInput = Omit<RuntimeInput, 'timestamp' | 'queuedAt'> & Readonly<{
  timestamp?: UnixMs;
  queuedAt?: UnixMs;
  entityInputs: DecodedRuntimeEntityInput[];
}>;

type DecodedRuntimeEntityInput = ValidatedRoutedEntityInput;

const decodeRuntimeEntityInput = (
  entry: unknown,
  code: string,
  index: number,
): DecodedRuntimeEntityInput => decodeRoutedEntityInput(requireBoundaryRecord(
  entry,
  `${code}_ENTITY_INPUT_INVALID:index=${index}`,
));

export const decodeRuntimeInput = (
  value: unknown,
  code: string,
): DecodedRuntimeInput => {
  const input = requireBoundaryRecord(value, `${code}_INVALID`);
  requireExactBoundaryKeys(
    input,
    ['runtimeTxs', 'entityInputs'],
    ['jInputs', 'timestamp', 'queuedAt'],
    `${code}_FIELDS_INVALID`,
  );
  const runtimeTxs = requireInputArray(input, 'runtimeTxs', code);
  const entityInputs = requireInputArray(input, 'entityInputs', code);
  runtimeTxs.forEach((tx, index) =>
    validateRuntimeTx(tx, `${code}_RUNTIME_TX_${index}`));
  const decodedEntityInputs = entityInputs.map((entry, index) =>
    decodeRuntimeEntityInput(entry, code, index));
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
  const timestamp = input['timestamp'] === undefined
    ? undefined
    : toUnixMs(requireBoundaryInteger(input['timestamp'], `${code}_TIMESTAMP_INVALID`));
  const queuedAt = input['queuedAt'] === undefined
    ? undefined
    : toUnixMs(requireBoundaryInteger(input['queuedAt'], `${code}_QUEUED_AT_INVALID`));
  return {
    runtimeTxs: runtimeTxs as RuntimeInput['runtimeTxs'],
    entityInputs: decodedEntityInputs,
    ...(jInputs === undefined
      ? {}
      : { jInputs: jInputs as NonNullable<RuntimeInput['jInputs']> }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(queuedAt === undefined ? {} : { queuedAt }),
  };
};

/**
 * Local API ingress (RAdapter send, control runtime-input) runs the exact
 * EntityTx and JInput decoders, as P2P transport does: a malformed body is
 * refused at the wire instead of halting the Runtime inside a transition.
 * The WAL schema keeps the shallow decode above so committed frames replay.
 */
export const decodeLocalRuntimeInput = (
  value: unknown,
  code: string,
): DecodedRuntimeInput => {
  const input = decodeRuntimeInput(value, code);
  input.entityInputs.forEach((entityInput, index) => {
    entityInput.entityTxs?.forEach((tx, txIndex) => {
      validateEntityTx(tx, `${code}_ENTITY_INPUT_${index}_TX_${txIndex}`);
    });
  });
  if (input.jInputs) validateJInputs(input.jInputs, `${code}_J_INPUTS`);
  return input;
};
