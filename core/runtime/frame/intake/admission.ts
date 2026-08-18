import { createStructuredLogger, logError, shortId } from '../../../support/logger';
import { decodeRoutedEntityInput } from '../../delivery/topology/routing-validation';
import { validateJInputs } from '../../../storage/wal/runtime-machine-schema/j';
import type { RuntimeReplica, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../../types';
import type { JInput } from '../../../jurisdiction/machine/input';
import {
  validateExternalEntityInputTargets,
  RuntimeEntityInputApplyError,
} from '../../mempool/entity-inputs';
import { assertScheduledWakeTxAuthorized } from '../../mempool/scheduled-wake';
import { validateRuntimeInputShapeAndLimits } from '../../mempool/input-validation';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeInputAdmissionDeps = {
  normalizeEntityInput(
    env: RuntimeReplica,
    input: RoutedEntityInput,
    context: string,
  ): RoutedEntityInput;
};

export type PreparedRuntimeIngress = {
  runtimeTxs: RuntimeTx[];
  entityInputs: RoutedEntityInput[];
  jOutbox: JInput[];
};

const rejectRuntimeInput = (message: string): never => {
  runtimeLog.error('input.rejected', { message });
  throw new Error(message);
};

const collectJOutbox = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
): JInput[] => {
  if (!runtimeInput.jInputs?.length) return [];
  const inputs = validateJInputs(runtimeInput.jInputs, 'RUNTIME_INPUT_J');
  runtimeLog.debug('joutbox.incoming', { jInputs: inputs.length });
  for (const input of inputs) {
    if (!env.state.jReplicas.has(input.jurisdictionName)) {
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
  env: RuntimeReplica,
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
        decodeRoutedEntityInput(input),
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
      if (!isReplay && String(input?.from || '').trim()) {
        throw new RuntimeEntityInputApplyError(
          input,
          false,
          error,
          'malformed-ingress',
        );
      }
      throw error;
    }
  });

export const validateRuntimeInputIngress = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  isReplay: boolean,
  deps: RuntimeInputAdmissionDeps,
): PreparedRuntimeIngress => {
  validateRuntimeInputShapeAndLimits(env, runtimeInput, rejectRuntimeInput);
  const jOutbox = collectJOutbox(env, runtimeInput);
  const entityInputs = validateEntityInputs(env, runtimeInput, isReplay, deps);
  validateExternalEntityInputTargets(env, entityInputs, runtimeInput.runtimeTxs);
  return {
    runtimeTxs: [...runtimeInput.runtimeTxs],
    entityInputs,
    jOutbox,
  };
};
