import { LIMITS } from '../../config/constants';
import { safeStringify } from '../../protocol/serialization';
import { MAX_ENTITY_FRAME_J_RANGE_BYTES } from '../../jurisdiction/machine/range-budget';
import type { EntityTx } from '../../types/entity-tx';
import type { RuntimeReplica, RuntimeInput, RoutedEntityInput } from '../types';

export const MAX_RUNTIME_J_INPUTS = 256;
export const MAX_RUNTIME_J_TXS = 1_024;
export const MAX_RUNTIME_J_TXS_PER_JURISDICTION = 512;
// Runtime must be able to ingest any one atomic Entity J-range. ProofBody
// calldata enrichment can legitimately make a single EVM block several MiB;
// a smaller independent cap would wedge that canonical height forever. The
// extra MiB bounds the Runtime/JInput envelope for the existing count limits.
export const MAX_RUNTIME_J_INPUT_BYTES = MAX_ENTITY_FRAME_J_RANGE_BYTES + 1024 * 1024;

type RejectRuntimeInput = (message: string) => never;

const validateRuntimeJIngressLimits = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  reject: RejectRuntimeInput,
): void => {
  if (runtimeInput.jInputs === undefined) return;
  if (!Array.isArray(runtimeInput.jInputs)) {
    reject(`Invalid jInputs: expected array, got ${typeof runtimeInput.jInputs}`);
  }
  if (runtimeInput.jInputs.length > MAX_RUNTIME_J_INPUTS) {
    reject(`Too many J inputs: ${runtimeInput.jInputs.length} > ${MAX_RUNTIME_J_INPUTS}`);
  }

  let totalTxs = 0;
  let totalBytes = 0;
  const txsByJurisdiction = new Map<string, number>();
  for (const [index, input] of runtimeInput.jInputs.entries()) {
    if (!input || !Array.isArray(input.jTxs)) reject(`Invalid J input at index ${index}`);
    const jurisdictionName = String(input.jurisdictionName || '');
    if (!env.state.jReplicas.has(jurisdictionName)) {
      reject(`Unknown J jurisdiction: ${jurisdictionName}`);
    }
    totalTxs += input.jTxs.length;
    if (totalTxs > MAX_RUNTIME_J_TXS) {
      reject(`Too many J transactions: ${totalTxs} > ${MAX_RUNTIME_J_TXS}`);
    }
    const jurisdictionTxs = (txsByJurisdiction.get(jurisdictionName) ?? 0) + input.jTxs.length;
    if (jurisdictionTxs > MAX_RUNTIME_J_TXS_PER_JURISDICTION) {
      reject(
        `Too many J transactions for ${jurisdictionName}: ` +
        `${jurisdictionTxs} > ${MAX_RUNTIME_J_TXS_PER_JURISDICTION}`,
      );
    }
    txsByJurisdiction.set(jurisdictionName, jurisdictionTxs);
    totalBytes += new TextEncoder().encode(safeStringify(input)).byteLength;
    if (totalBytes > MAX_RUNTIME_J_INPUT_BYTES) {
      reject(`J payload too large: ${totalBytes} > ${MAX_RUNTIME_J_INPUT_BYTES}`);
    }
  }
};

/**
 * One shape/resource boundary shared by public admission and isolated apply.
 * Callers own the error prefix because admission and replay intentionally
 * expose different failure taxonomies while enforcing identical limits.
 */
export const validateRuntimeInputShapeAndLimits = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  reject: RejectRuntimeInput,
): void => {
  if (!runtimeInput) reject('Null runtime input provided');
  if (!Array.isArray(runtimeInput.runtimeTxs)) {
    reject(`Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`);
  }
  if (!Array.isArray(runtimeInput.entityInputs)) {
    reject(`Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`);
  }
  validateRuntimeJIngressLimits(env, runtimeInput, reject);
  if (runtimeInput.runtimeTxs.length > LIMITS.MAX_RUNTIME_INPUT_RUNTIME_TXS) {
    reject(
      `Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > ` +
      `${LIMITS.MAX_RUNTIME_INPUT_RUNTIME_TXS}`,
    );
  }
  if (runtimeInput.entityInputs.length > LIMITS.MAX_RUNTIME_INPUT_ENTITY_INPUTS) {
    reject(
      `Too many entity inputs: ${runtimeInput.entityInputs.length} > ` +
      `${LIMITS.MAX_RUNTIME_INPUT_ENTITY_INPUTS}`,
    );
  }
};

const OUTBOX_BACKPRESSURE_EXEMPT_TXS = new Set<EntityTx['type']>([
  'scheduledWake',
  'accountInput',
  'j_event',
  'processHtlcTimeouts',
  'prepareDispute',
  'disputeStart',
  'disputeFinalize',
  'j_broadcast',
  'j_rebroadcast',
  'j_abort_sent_batch',
  'j_clear_batch',
]);

export const runtimeInputRequiresOutboxCapacity = (
  entityInputs: readonly RoutedEntityInput[],
): boolean => entityInputs.some(input =>
  !input.from &&
  (input.entityTxs ?? []).some(tx => !OUTBOX_BACKPRESSURE_EXEMPT_TXS.has(tx.type)));
