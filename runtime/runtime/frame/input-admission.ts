import { createStructuredLogger, logError, shortId } from '../../infra/logger';
import { normalizeRuntimeId } from '../../networking/runtime-id';
import { validateEntityInput } from '../../validation-utils';
import { validateJInputs } from '../../wal/runtime-machine-schema/j';
import type {
  RuntimeState,
  JInput,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeTx,
} from '../../types';
import {
  getInputReliableIdentity,
  registerReliableIngress,
} from '../reliable-delivery';
import { assertScheduledWakeTxAuthorized } from '../scheduled-wake';
import { validateRuntimeInputShapeAndLimits } from '../input-validation';
import { selectPotentialAtomicCrossJInputIndexes } from './cross-j-preflight';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeInputAdmissionDeps = {
  normalizeEntityInput(
    env: RuntimeState,
    input: RoutedEntityInput,
    context: string,
  ): RoutedEntityInput;
};

export type PreparedRuntimeIngress = {
  runtimeTxs: RuntimeTx[];
  entityInputs: RoutedEntityInput[];
  jOutbox: JInput[];
  immediateReliableReceipts: Array<{
    runtimeId: string;
    receipt: ReliableDeliveryReceipt;
  }>;
};

const rejectRuntimeInput = (message: string): never => {
  runtimeLog.error('input.rejected', { message });
  throw new Error(message);
};

const collectJOutbox = (
  env: RuntimeState,
  runtimeInput: RuntimeInput,
): JInput[] => {
  if (!runtimeInput.jInputs?.length) return [];
  const inputs = validateJInputs(runtimeInput.jInputs, 'RUNTIME_INPUT_J');
  runtimeLog.debug('joutbox.incoming', { jInputs: inputs.length });
  for (const input of inputs) {
    if (!env.jReplicas.has(input.jurisdictionName)) {
      rejectRuntimeInput(`Unknown J jurisdiction: ${input.jurisdictionName}`);
    }
    runtimeLog.debug('joutbox.collect', {
      jurisdictionName: input.jurisdictionName,
      jTxs: input.jTxs.length,
      types: input.jTxs.map(tx => tx.type),
    });
  }
  return inputs;
};

const validateEntityInputs = (
  env: RuntimeState,
  runtimeInput: RuntimeInput,
  isReplay: boolean,
  deps: RuntimeInputAdmissionDeps,
): RoutedEntityInput[] =>
  runtimeInput.entityInputs.map((input, index) => {
    try {
      for (const tx of input.entityTxs ?? []) {
        assertScheduledWakeTxAuthorized(tx, isReplay);
      }
      return deps.normalizeEntityInput(
        env,
        validateEntityInput(input),
        `runtimeInput[${index}]`,
      );
    } catch (error) {
      logError(
        'RUNTIME_TICK',
        `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityInput[${index}] before merge!`,
        {
          error: error instanceof Error ? error.message : String(error),
          entityId: shortId(input?.entityId, 12),
          signerId: shortId(input?.signerId, 12),
          sourceRuntimeId: shortId(input?.from, 12),
          sourceRuntimeHeight:
            (input as Partial<RoutedEntityInput>).sourceRuntimeFrame?.height ?? null,
          entityTxTypes: Array.isArray(input?.entityTxs)
            ? input.entityTxs.map(tx => tx?.type)
            : [],
        },
      );
      throw error;
    }
  });

const registerReliableEntityInputs = (
  env: RuntimeState,
  inputs: RoutedEntityInput[],
  isReplay: boolean,
): Pick<PreparedRuntimeIngress, 'entityInputs' | 'immediateReliableReceipts'> => {
  const atomicIndexes = selectPotentialAtomicCrossJInputIndexes(inputs);
  const entityInputs: RoutedEntityInput[] = [];
  const immediateReliableReceipts: PreparedRuntimeIngress['immediateReliableReceipts'] = [];

  for (const [inputIndex, input] of inputs.entries()) {
    const sourceRuntimeId = normalizeRuntimeId(input.from);
    if (!sourceRuntimeId || !getInputReliableIdentity(input)) {
      entityInputs.push(input);
      continue;
    }
    // Registration mutates only the isolated candidate. The live Runtime is
    // untouched until the frame's WAL commit succeeds.
    const registration = registerReliableIngress(env, sourceRuntimeId, input, {
      allowContiguousPendingAccountAck: atomicIndexes.has(inputIndex),
    });
    if (isReplay || registration.kind === 'ordinary' || registration.kind === 'enqueue') {
      entityInputs.push(input);
    } else if (registration.kind === 'receipt') {
      immediateReliableReceipts.push({
        runtimeId: sourceRuntimeId,
        receipt: registration.receipt,
      });
    }
  }
  return { entityInputs, immediateReliableReceipts };
};

export const prepareRuntimeInputIngress = (
  env: RuntimeState,
  runtimeInput: RuntimeInput,
  isReplay: boolean,
  deps: RuntimeInputAdmissionDeps,
): PreparedRuntimeIngress => {
  validateRuntimeInputShapeAndLimits(env, runtimeInput, rejectRuntimeInput);
  const jOutbox = collectJOutbox(env, runtimeInput);
  const validated = validateEntityInputs(env, runtimeInput, isReplay, deps);
  const reliable = registerReliableEntityInputs(env, validated, isReplay);
  return {
    runtimeTxs: [...runtimeInput.runtimeTxs],
    entityInputs: reliable.entityInputs,
    jOutbox,
    immediateReliableReceipts: reliable.immediateReliableReceipts,
  };
};
