import type { JInput } from '../jurisdiction/machine/input';
import type { RoutedEntityInput, RuntimeReplica } from './types';
import {
  createRuntimeEntityInputBatchContext,
  entityInputLog,
  entityInputProfileEnabled,
  entityInputSlowMs,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
} from './entity-input/entity-input-contract.ts';
import {
  applyExternalEntityInput,
  discardMalformedRemoteEntityInput,
} from './entity-input/entity-input-staging.ts';
import {
  applyAtomicEntityInputPair,
  atomicPairInputsMatch,
} from './entity-input/entity-input-atomic.ts';
import { drainImmediateCrossJurisdictionOutputs } from './entity-input/entity-input-output.ts';
import { getPerfMs } from '../infra/time';

export {
  RuntimeEntityInputApplyError,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
} from './entity-input/entity-input-contract.ts';
export {
  collectAppliedAccountSenderHints,
  validateExternalEntityInputTargets,
} from './entity-input/entity-input-admission.ts';

/**
 * Runtime composition root for ordered Entity inputs.
 *
 * Each list item is admitted, applied, and drained before the next item.
 * A tagged Cross-J pair consumes two adjacent inputs and promotes both touched
 * candidates together; all other inputs consume one position.
 */
export const applyMergedEntityInputs = async (
  env: RuntimeReplica,
  inputs: RoutedEntityInput[],
  initialJOutbox: JInput[],
  options: RuntimeEntityInputApplyOptions,
): Promise<RuntimeEntityInputApplyResult> => {
  const context = createRuntimeEntityInputBatchContext(initialJOutbox);
  const startedAt = getPerfMs();
  for (let index = 0; index < inputs.length;) {
    const input = inputs[index]!;
    const next = inputs[index + 1];
    if (atomicPairInputsMatch(input, next)) {
      await applyAtomicEntityInputPair(
        env,
        [input, next],
        index,
        options,
        context,
      );
      index += 2;
    } else {
      try {
        await applyExternalEntityInput(env, input, index, options, context);
      } catch (error) {
        if (
          !discardMalformedRemoteEntityInput(
            env,
            error,
            index,
            context,
            options,
          )
        ) {
          throw error;
        }
      }
      index += 1;
    }
    await drainImmediateCrossJurisdictionOutputs(env, options, context);
  }

  const elapsedMs = Math.round(getPerfMs() - startedAt);
  if (entityInputProfileEnabled() || elapsedMs >= entityInputSlowMs()) {
    entityInputLog.info('inputs.profile', {
      height: env.state.height,
      elapsedMs,
      mergedInputs: inputs.length,
      appliedInputs: context.appliedEntityInputs.length,
      outputs: context.entityOutbox.length,
      jOutputs: context.jOutbox.length,
      phaseTotals: {
        externalApply: context.externalApplyMs,
        immediateCrossJApply: context.immediateCrossJApplyMs,
        remainder: Math.max(
          0,
          elapsedMs -
            context.externalApplyMs -
            context.immediateCrossJApplyMs,
        ),
      },
      slowInputs: context.profiledInputs
        .sort(
          (left, right) =>
            Number(right['elapsedMs'] || 0) -
            Number(left['elapsedMs'] || 0),
        )
        .slice(0, 16),
    });
  }
  return context;
};
