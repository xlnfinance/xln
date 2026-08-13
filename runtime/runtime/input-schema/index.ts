import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type { RuntimeInput } from '../types';
import {
  toEntityId,
  toRuntimeId,
  toSignerId,
  type EntityId,
  type RuntimeId,
  type SignerId,
} from '../../protocol/identity';
import { toUnixMs, type UnixMs } from '../../protocol/units';
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
export type DecodedRuntimeInput = Omit<RuntimeInput, 'timestamp' | 'queuedAt'> & Readonly<{
  timestamp?: UnixMs;
  queuedAt?: UnixMs;
  entityInputs: DecodedRuntimeEntityInput[];
}>;

type DecodedRuntimeEntityInput = RuntimeInput['entityInputs'][number] & {
  entityId: EntityId;
  signerId: SignerId;
  runtimeId?: RuntimeId;
  from?: RuntimeId;
};

function assertRuntimeEntityInputIdentity(
  entityInput: Record<string, unknown>,
  code: string,
  index: number,
): asserts entityInput is Record<string, unknown> & DecodedRuntimeEntityInput {
  const rawEntityId = entityInput['entityId'];
  if (typeof rawEntityId !== 'string') {
    throw new Error(`${code}_ENTITY_INPUT_INVALID:index=${index}`);
  }
  toEntityId(rawEntityId);
  const rawSignerId = entityInput['signerId'];
  if (typeof rawSignerId !== 'string') {
    throw new Error(`${code}_ENTITY_INPUT_INVALID:index=${index}`);
  }
  toSignerId(rawSignerId);
  for (const field of ['runtimeId', 'from'] as const) {
    const runtimeId = entityInput[field];
    if (runtimeId !== undefined) {
      if (typeof runtimeId !== 'string') {
        throw new Error(`${code}_ENTITY_INPUT_INVALID:index=${index}`);
      }
      toRuntimeId(runtimeId);
    }
  }
}

const decodeRuntimeEntityInput = (
  entry: unknown,
  code: string,
  index: number,
): DecodedRuntimeEntityInput => {
  const entityInput = requireBoundaryRecord(
    entry,
    `${code}_ENTITY_INPUT_INVALID:index=${index}`,
  );
  assertRuntimeEntityInputIdentity(entityInput, code, index);
  // The child Entity-input decoder owns the remaining fields. This Runtime
  // boundary proves only the routing identity it consumes before delegation.
  return entityInput;
};

export const decodeRuntimeInput = (
  value: unknown,
  code: string,
): DecodedRuntimeInput => {
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
  const reliableReceipts = input['reliableReceipts'] === undefined
    ? undefined
    : requireInputArray(input, 'reliableReceipts', code);
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
