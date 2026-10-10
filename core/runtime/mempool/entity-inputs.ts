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
  collectCommittedAccountFrames,
  registerCommittedAccountRoutes,
  rejectMalformedEntityInput,
  type StagedEntityInput,
} from '../admit/entity-input-staging.ts';
import { isProposalDeferrableEntityInput } from '../../entity/consensus/input/consensus';
import { RuntimeEntityInputApplyError } from '../admit/entity-input-contract.ts';
import { resolveEntityInputReplica } from '../admit/entity-input-admission.ts';
import { MalformedEntityFrameInputError } from '../../entity/tx/processing/invariant-errors';
import { AccountFrameRejectionError } from '../../entity/tx/handlers/account/input-phases';
import type { EntityTx } from '../../types/entity-tx';
import type { RejectedEntityIngressEvidence } from '../frame/intake/discard';
import {
  applyAtomicEntityInputPair,
  atomicPairInputsMatch,
} from '../admit/entity-input-atomic.ts';
import { drainImmediateCrossJurisdictionOutputs } from '../admit/entity-input-output.ts';
import {
  collectRuntimeEntityContext,
  describeEntityInputCommitShape,
} from '../admit/entity-context-collection.ts';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { getPerfMs } from '../../support/time';

export {
  RuntimeEntityInputApplyError,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
} from '../admit/entity-input-contract.ts';
export { validateExternalEntityInputTargets } from '../admit/entity-input-admission.ts';

type EntityInputBatchContext = ReturnType<typeof createRuntimeEntityInputBatchContext>;

/**
 * Per-replica proposal attempts one Runtime frame spends evicting rejected
 * transactions. Each attempt rebuilds the proposal from the live mempool, so a
 * queue of N rejected txs costs O(N) attempts of O(N) work; the bound keeps
 * one frame from stalling on a hostile queue. The remainder stays in the
 * replica mempool and is certified by the next wake, one tx at a time.
 */
const MAX_REPLICA_FLUSH_EVICTIONS = 8;

export type RuntimeEntityInputBatchResult = RuntimeEntityInputApplyResult & {
  /** Typed rejections decided inside this frame; the Runtime loop applies the policy once. */
  rejectedIngress: readonly RejectedEntityIngressEvidence[];
};

const rejectedInputEvidence = (
  error: RuntimeEntityInputApplyError,
): RejectedEntityIngressEvidence => ({
  origin: error.isRemoteIngress ? 'remote' : 'local',
  entityId: error.entityId,
  signerId: error.signerId,
  sourceRuntimeId: error.sourceRuntimeId,
  rejectionCode: error.rejectionCode,
});

/**
 * One rejected proposal attempt: evict the exact offending tx from the replica
 * mempool and decide whether another attempt is worth spending this frame.
 * Deterministic local cleanup, never a transport retry — no envelope is resent
 * and none is silently accepted.
 */
const evictRejectedProposalTx = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  error: unknown,
  eviction: number,
  flushIndex: number,
  rejectedIngress: RejectedEntityIngressEvidence[],
): { retry: boolean; evictedAttemptContext: EntityInfraContext | undefined } => {
  const { entityId, signerId } = input;
  const cause = error instanceof RuntimeEntityInputApplyError ? error.cause : undefined;
  const replica = resolveEntityInputReplica(env, input).replica;
  if (
    !(cause instanceof MalformedEntityFrameInputError) ||
    cause.frameTx === undefined ||
    !replica.mempool.includes(cause.frameTx as EntityTx)
  ) throw error;
  entityInputLog.warn('entity_input.batch_tx_evicted', {
    entity: entityId,
    signer: signerId,
    txType: cause.txType,
    rejection: cause.rejection,
  });
  replica.mempool = replica.mempool.filter(tx => tx !== cause.frameTx);
  if (cause instanceof AccountFrameRejectionError) {
    // A counterparty's Account frame is peer evidence even when it reached
    // this replica through a local continuation; the tx is gone and only the
    // Runtime loop decides halt-or-drop.
    entityInputLog.error('entity_input.discarded', {
      entityId,
      signerId,
      sourceRuntimeId: undefined,
      inputIndex: flushIndex,
      txType: cause.txType,
      rejectionCode: cause.rejection,
      cause: cause.message,
    });
    rejectedIngress.push({
      origin: 'peer-evidence',
      entityId,
      signerId,
      sourceRuntimeId: undefined,
      rejectionCode: cause.rejection,
      txType: cause.txType,
    });
  }
  const evictedAttemptContext = cause.attemptedEntityContext;
  if (eviction + 1 < MAX_REPLICA_FLUSH_EVICTIONS || replica.mempool.length === 0) {
    return { retry: true, evictedAttemptContext };
  }
  // Bounded work per frame: the rest of this replica's queue waits for the
  // next wake instead of costing another rebuild now. A typed rejection of the
  // attempt, never a Runtime halt.
  entityInputLog.error('entity_input.flush_dropped', {
    entityId,
    signerId,
    inputIndex: flushIndex,
    evictions: eviction + 1,
    remainingMempoolTxs: replica.mempool.length,
    rejectionCode: 'ENTITY_FLUSH_EVICTION_CAP',
  });
  rejectedIngress.push({
    // The eviction cap defers this replica's remaining queue to the next wake.
    // It is this Runtime's own bounded work, not a rejected sender, so the
    // reject policy must not surface it the way it surfaces a rejected tx.
    origin: 'deferral',
    entityId,
    signerId,
    sourceRuntimeId: undefined,
    rejectionCode: 'ENTITY_FLUSH_EVICTION_CAP',
  });
  return { retry: false, evictedAttemptContext };
};

/**
 * A proposal attempt that ended in eviction still consumed live infra context.
 * Replay looks that context up by replica and height before it can apply and
 * reject the same tx, so journal it when no certified frame recorded one at
 * the same key (set-if-absent keeps the committed context authoritative).
 */
const journalEvictedAttemptContext = (
  input: RoutedEntityInput,
  evictedAttemptContext: EntityInfraContext,
  context: EntityInputBatchContext,
): void => {
  const { entityId, signerId } = input;
  const replicaKey = `${entityId}:${signerId}`;
  const contextKey = `${replicaKey.toLowerCase()}:${evictedAttemptContext.height}`;
  if (context.entityContexts.has(contextKey)) return;
  collectRuntimeEntityContext(
    context.entityContexts,
    entityId,
    replicaKey,
    evictedAttemptContext,
    describeEntityInputCommitShape({ ...input, from: 'evicted-proposal-attempt' }),
    context.entityCommitInputShapes,
  );
};

const createDeferredProposalBatch = (
  env: RuntimeReplica,
  initialFlushIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: EntityInputBatchContext,
  rejectedIngress: RejectedEntityIngressEvidence[],
) => {
  const replicas = new Map<string, { entityId: string; signerId: string }>();
  const outcomeSlots = new Map<string, number[]>();
  const deferredInputs = new Map<string, RoutedEntityInput[]>();
  let flushIndex = initialFlushIndex;
  const noteStaged = (staged: StagedEntityInput, deferred: boolean): void => {
    if (staged.result.entityFrameCommitted) {
      replicas.delete(staged.replicaKey);
      for (const slot of outcomeSlots.get(staged.replicaKey) ?? []) {
        context.inputOutcomes[slot]!.entityFrameCommitted = true;
      }
      outcomeSlots.delete(staged.replicaKey);
      for (const input of deferredInputs.get(staged.replicaKey) ?? []) {
        const frames = collectCommittedAccountFrames(input, staged.result.nextReplica);
        registerCommittedAccountRoutes(env, input, frames, options);
      }
      deferredInputs.delete(staged.replicaKey);
    }
    if (!deferred || !isCommittedEntityInput(staged.result.outcome) || staged.result.entityFrameCommitted) return;
    replicas.set(staged.replicaKey, {
      entityId: staged.input.entityId,
      signerId: staged.signerId,
    });
    if (staged.input.from) {
      const inputs = deferredInputs.get(staged.replicaKey) ?? [];
      inputs.push(staged.input);
      deferredInputs.set(staged.replicaKey, inputs);
    }
    const slot = context.inputOutcomes.findLastIndex(entry => entry.inputIndex === staged.inputIndex);
    if (slot < 0) return;
    const slots = outcomeSlots.get(staged.replicaKey) ?? [];
    slots.push(slot);
    outcomeSlots.set(staged.replicaKey, slots);
  };
  const flushReplica = async (input: RoutedEntityInput): Promise<void> => {
    let evictedAttemptContext: EntityInfraContext | undefined;
    for (let eviction = 0; ; eviction += 1) {
      try {
        const staged = await applyExternalEntityInput(env, input, flushIndex, options, context, false);
        const appliedIndex = context.appliedEntityInputs.lastIndexOf(staged.result.appliedInput);
        if (appliedIndex >= 0) context.appliedEntityInputs.splice(appliedIndex, 1);
        noteStaged(staged, false);
        break;
      } catch (error) {
        const evicted = evictRejectedProposalTx(
          env,
          input,
          error,
          eviction,
          flushIndex,
          rejectedIngress,
        );
        evictedAttemptContext ??= evicted.evictedAttemptContext;
        if (evicted.retry) continue;
        break;
      }
    }
    if (evictedAttemptContext) journalEvictedAttemptContext(input, evictedAttemptContext, context);
    flushIndex += 1;
    await drainImmediateCrossJurisdictionOutputs(env, options, context);
  };
  const flush = async (): Promise<void> => {
    for (const { entityId, signerId } of [...replicas.values()]) {
      await flushReplica({ entityId, signerId, entityTxs: [] });
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
): Promise<RuntimeEntityInputBatchResult> => {
  const context = createRuntimeEntityInputBatchContext(initialJOutbox);
  const rejectedIngress: RejectedEntityIngressEvidence[] = [];
  const startedAt = getPerfMs();
  // R → E → A cascade: plain transaction inputs only fill their replica's
  // mempool; each touched replica then proposes once, so a Runtime frame with
  // hundreds of user inputs yields one Entity frame per Entity, not hundreds.
  const deferred = createDeferredProposalBatch(env, inputs.length, options, context, rejectedIngress);
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
          !(error instanceof RuntimeEntityInputApplyError) ||
          !rejectMalformedEntityInput(env, error, index, context, options)
        ) {
          throw error;
        }
        rejectedIngress.push(rejectedInputEvidence(error));
      }
      index += 1;
    }
    await drainImmediateCrossJurisdictionOutputs(env, options, context);
  }
  await deferred.flush();

  const elapsedMs = Math.round(getPerfMs() - startedAt);
  logEntityInputBatchProfile(env, inputs, context, elapsedMs);
  return { ...context, rejectedIngress };
};
