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
  const deferredReplicas = new Map<string, { entityId: string; signerId: string }>();
  // Outcome slots of admissions still waiting for their replica's frame; the
  // frame that later proposes the mempool commits them, and their outcome
  // reports `entityFrameCommitted` exactly as an immediate proposal would have.
  const deferredOutcomeSlots = new Map<string, number[]>();
  const noteStaged = (staged: StagedEntityInput, deferred: boolean): void => {
    // Any later frame proposes from the replica mempool, so it carries every
    // admission deferred before it; only unframed admissions still need a flush.
    if (staged.result.entityFrameCommitted) {
      deferredReplicas.delete(staged.replicaKey);
      for (const slot of deferredOutcomeSlots.get(staged.replicaKey) ?? []) {
        context.inputOutcomes[slot]!.entityFrameCommitted = true;
      }
      deferredOutcomeSlots.delete(staged.replicaKey);
    }
    if (deferred && isCommittedEntityInput(staged.result.outcome) && !staged.result.entityFrameCommitted) {
      deferredReplicas.set(staged.replicaKey, { entityId: staged.input.entityId, signerId: staged.signerId });
      const slot = context.inputOutcomes.findLastIndex(entry => entry.inputIndex === staged.inputIndex);
      if (slot >= 0) {
        const slots = deferredOutcomeSlots.get(staged.replicaKey) ?? [];
        slots.push(slot);
        deferredOutcomeSlots.set(staged.replicaKey, slots);
      }
    }
  };
  let flushIndex = inputs.length;
  const flushDeferredReplicas = async (): Promise<void> => {
    for (const { entityId, signerId } of [...deferredReplicas.values()]) {
      // Deferred admissions are durable in the replica mempool; a malformed or
      // stale later input for the same replica cannot leave them unproposed.
      const flush: RoutedEntityInput = { entityId, signerId, entityTxs: [] };
      for (let attempt = 0; ; attempt += 1) {
        try {
          const staged = await applyExternalEntityInput(env, flush, flushIndex, options, context, false);
          // The flush is Runtime-derived: replay re-derives it from the
          // recorded external inputs, so it is not part of the applied input.
          const appliedIndex = context.appliedEntityInputs.lastIndexOf(staged.result.appliedInput);
          if (appliedIndex >= 0) context.appliedEntityInputs.splice(appliedIndex, 1);
          noteStaged(staged, false);
          break;
        } catch (error) {
          // The proposer evicts a rejected mempool tx while others remain; the
          // last remaining rejected tx surfaces here. Drop it the way a lone
          // malformed remote input was dropped before batching, then re-flush.
          const cause = error instanceof RuntimeEntityInputApplyError ? error.cause : undefined;
          const replica = resolveEntityInputReplica(env, flush).replica;
          if (
            !(cause instanceof MalformedEntityFrameInputError) ||
            cause.frameTx === undefined ||
            !replica.mempool.includes(cause.frameTx as EntityTx) ||
            attempt >= 8
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
    deferredReplicas.clear();
  };
  for (let index = 0; index < inputs.length;) {
    const input = inputs[index]!;
    const next = inputs[index + 1];
    if (atomicPairInputsMatch(input, next)) {
      // A tagged pair must see every earlier admission already framed, exactly
      // as when each input framed on its own.
      await flushDeferredReplicas();
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
        noteStaged(await applyExternalEntityInput(env, input, index, options, context, deferProposal), deferProposal);
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
  await flushDeferredReplicas();

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
