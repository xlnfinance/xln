import { createStructuredLogger } from '../../../support/logger';
import { createGossipLayer } from '../../../network/p2p/gossip';
import type { RuntimeReplica, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../../types';
import type { JInput } from '../../../jurisdiction/machine/input';

const runtimeLog = createStructuredLogger('runtime');

const countMeaningfulEntityInputs = (
  inputs: readonly RoutedEntityInput[],
): number =>
  inputs.reduce((count, input) => {
    const meaningful =
      (input.entityTxs?.length ?? 0) > 0 ||
      Boolean(input.proposedFrame) ||
      (input.hashPrecommits?.size ?? 0) > 0 ||
      (input.jPrefixAttestations?.size ?? 0) > 0 ||
      Boolean(input.leaderTimeoutVote);
    return count + Number(meaningful);
  }, 0);

const emitQueuedJBatches = (env: RuntimeReplica, jOutbox: readonly JInput[]): void => {
  for (const jInput of jOutbox) {
    for (const jTx of jInput.jTxs) {
      env.emit('JBatchQueued', {
        entityId: jTx.entityId,
        batchSize: (jTx.data as { batchSize?: number } | undefined)?.batchSize,
        jurisdictionName: jInput.jurisdictionName,
      });
    }
  }
};

export const advanceAppliedRuntimeFrame = (
  env: RuntimeReplica,
  runtimeTxs: readonly RuntimeTx[],
  appliedEntityInputs: readonly RoutedEntityInput[],
  entityFrameCommitted: boolean,
  entityOutbox: readonly RoutedEntityInput[],
  jOutbox: readonly JInput[],
): number => {
  emitQueuedJBatches(env, jOutbox);
  const meaningfulInputs = countMeaningfulEntityInputs(appliedEntityInputs);
  // An empty local trigger may still commit Entity/Account mempool work. The
  // actual Entity height transition is authoritative, not the trigger shape.
  const entityInputCount = entityFrameCommitted
    ? Math.max(meaningfulInputs, appliedEntityInputs.length)
    : meaningfulInputs;
  const advances =
    runtimeTxs.length > 0 ||
    entityInputCount > 0 ||
    entityOutbox.length > 0 ||
    jOutbox.length > 0;

  if (advances) {
    env.emit('RuntimeTick', {
      height: env.state.height + 1,
      runtimeTxs: runtimeTxs.length,
      entityInputs: entityInputCount,
      outputs: entityOutbox.length,
    });
    env.state.height++;
  } else {
    if (env.quietRuntimeLogs !== true) runtimeLog.debug('frame.skip_empty');
    env.extra = undefined;
  }
  if (!env.gossip) {
    runtimeLog.warn('gossip.missing_recreate', { height: env.state.height });
    env.gossip = createGossipLayer();
    runtimeLog.info('gossip.recreated', { height: env.state.height });
  }
  return entityInputCount;
};

export const buildAppliedRuntimeInput = (
  sourceInput: RuntimeInput,
  runtimeTxs: RuntimeTx[],
  appliedInputs: RoutedEntityInput[],
): RuntimeInput => ({
  runtimeTxs,
  entityInputs: appliedInputs,
  ...(sourceInput.jInputs?.length ? { jInputs: sourceInput.jInputs } : {}),
});
