import type { JInput } from '../../jurisdiction/machine/input';
import type { RoutedEntityInput, RuntimeReplica } from '../types';
import {
  createRuntimeEntityInputBatchContext,
  entityInputLog,
  entityInputProfileEnabled,
  entityInputSlowMs,
  isCommittedEntityInput,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
} from '../admit/entity-input-contract.ts';
import {
  applyExternalEntityInput,
  rejectMalformedEntityInput,
  type StagedEntityInput,
} from '../admit/entity-input-staging.ts';
import { isProposalDeferrableEntityInput } from '../../entity/consensus/input/consensus';
import { RuntimeEntityInputApplyError } from '../admit/entity-input-contract.ts';
import { resolveEntityInputReplica } from '../admit/entity-input-admission.ts';
import { MalformedEntityFrameInputError } from '../../entity/tx/processing/invariant-errors';
import type { EntityTx } from '../../types/entity-tx';
import {
  applyAtomicEntityInputPair,
  atomicPairInputsMatch,
} from '../admit/entity-input-atomic.ts';
import { drainImmediateCrossJurisdictionOutputs } from '../admit/entity-input-output.ts';
import { getPerfMs } from '../../support/time';

export {
  RuntimeEntityInputApplyError,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
} from '../admit/entity-input-contract.ts';
export {
  collectAppliedAccountSenderHints,
  validateExternalEntityInputTargets,
} from '../admit/entity-input-admission.ts';

type EntityInputBatchContext = ReturnType<typeof createRuntimeEntityInputBatchContext>;

const createDeferredProposalBatch = (
  env: RuntimeReplica,
  initialFlushIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: EntityInputBatchContext,
) => {
  const replicas = new Map<string, { entityId: string; signerId: string }>();
  const outcomeSlots = new Map<string, number[]>();
  let flushIndex = initialFlushIndex;
  const noteStaged = (staged: StagedEntityInput, deferred: boolean): void => {
    if (staged.result.entityFrameCommitted) {
      replicas.delete(staged.replicaKey);
      for (const slot of outcomeSlots.get(staged.replicaKey) ?? []) {
        context.inputOutcomes[slot]!.entityFrameCommitted = true;
      }
      outcomeSlots.delete(staged.replicaKey);
    }
    if (!deferred || !isCommittedEntityInput(staged.result.outcome) || staged.result.entityFrameCommitted) return;
    replicas.set(staged.replicaKey, {
      entityId: staged.input.entityId,
      signerId: staged.signerId,
    });
    const slot = context.inputOutcomes.findLastIndex(entry => entry.inputIndex === staged.inputIndex);
    if (slot < 0) return;
    const slots = outcomeSlots.get(staged.replicaKey) ?? [];
    slots.push(slot);
    outcomeSlots.set(staged.replicaKey, slots);
  };
  const flush = async (): Promise<void> => {
    for (const { entityId, signerId } of [...replicas.values()]) {
      const input: RoutedEntityInput = { entityId, signerId, entityTxs: [] };
      for (let eviction = 0; ; eviction += 1) {
        try {
          const staged = await applyExternalEntityInput(env, input, flushIndex, options, context, false);
          const appliedIndex = context.appliedEntityInputs.lastIndexOf(staged.result.appliedInput);
          if (appliedIndex >= 0) context.appliedEntityInputs.splice(appliedIndex, 1);
          noteStaged(staged, false);
          break;
        } catch (error) {
          // This is deterministic local mempool cleanup, not transport retry:
          // the exact rejected tx is removed once and the remaining admitted
          // batch is evaluated. No envelope is resent or silently accepted.
          const cause = error instanceof RuntimeEntityInputApplyError ? error.cause : undefined;
          const replica = resolveEntityInputReplica(env, input).replica;
          if (
            !(cause instanceof MalformedEntityFrameInputError) ||
            cause.frameTx === undefined ||
            !replica.mempool.includes(cause.frameTx as EntityTx) ||
            eviction >= 8
          ) throw error;
          entityInputLog.warn('entity_input.batch_tx_evicted', {
            entity: entityId,
            signer: signerId,
            txType: cause.txType,
            rejection: cause.rejection,
          });
          replica.mempool = replica.mempool.filter(tx => tx !== cause.frameTx);
        }
      }
      flushIndex += 1;
      await drainImmediateCrossJurisdictionOutputs(env, options, context);
    }
    replicas.clear();
  };
  return { noteStaged, flush };
};

const logEntityInputBatchProfile = (
  env: RuntimeReplica,
  inputs: readonly RoutedEntityInput[],
  context: EntityInputBatchContext,
  elapsedMs: number,
): void => {
  if (!entityInputProfileEnabled() && elapsedMs < entityInputSlowMs()) return;
  // warn when explicitly requested: hub children default to warn level,
  // so info here would silently discard the operator's profile run.
  const emit = entityInputProfileEnabled() ? entityInputLog.warn : entityInputLog.info;
  emit('inputs.profile', {
    height: env.state.height,
    elapsedMs,
    mergedInputs: inputs.length,
    appliedInputs: context.appliedEntityInputs.length,
    outputs: context.entityOutbox.length,
    jOutputs: context.jOutbox.length,
    phaseTotals: {
      externalApply: context.externalApplyMs,
      immediateCrossJApply: context.immediateCrossJApplyMs,
      remainder: Math.max(0, elapsedMs - context.externalApplyMs - context.immediateCrossJApplyMs),
    },
    slowInputs: context.profiledInputs
      .sort((left, right) => Number(right['elapsedMs'] || 0) - Number(left['elapsedMs'] || 0))
      .slice(0, 16),
  });
};

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
  // R → E → A cascade: plain transaction inputs only fill their replica's
  // mempool; each touched replica then proposes once, so a Runtime frame with
  // hundreds of user inputs yields one Entity frame per Entity, not hundreds.
  const deferred = createDeferredProposalBatch(env, inputs.length, options, context);
  for (let index = 0; index < inputs.length;) {
    const input = inputs[index]!;
    const next = inputs[index + 1];
    if (atomicPairInputsMatch(input, next)) {
      // A tagged pair must see every earlier admission already framed, exactly
      // as when each input framed on its own.
      await deferred.flush();
      await applyAtomicEntityInputPair(
        env,
        [input, next],
        index,
        options,
        context,
      );
      index += 2;
    } else {
      const deferProposal = isProposalDeferrableEntityInput(input);
      try {
        deferred.noteStaged(
          await applyExternalEntityInput(env, input, index, options, context, deferProposal),
          deferProposal,
        );
      } catch (error) {
        if (
          !rejectMalformedEntityInput(
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
  await deferred.flush();

  const elapsedMs = Math.round(getPerfMs() - startedAt);
  logEntityInputBatchProfile(env, inputs, context, elapsedMs);
  return context;
};
