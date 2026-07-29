import type { RuntimeInput, RuntimeState } from '../types';
import { requireRuntimeMempool } from '../input-queue';
import { ensureRuntimeState } from '../runtime-state';
import { rebuildScheduledWakeIndex } from '../scheduled-wake';

export { cloneRuntimeFrameMempool } from './clone';

/**
 * One Runtime frame owns the input detached from the live ingress queue.
 *
 * Runtime has exactly one writer, so its deterministic State is mutated
 * directly. New transport input continues to append to the fresh live
 * mempool while the detached input is immutable frame material. There is no
 * second speculative Runtime State and therefore no O(total state) clone.
 */
export type RuntimeFrameTransaction = {
  liveEnv: RuntimeState;
  frameMempool: RuntimeInput;
  liveFrameLogBaseLength: number;
  published: boolean;
};

export const createRuntimeFrameTransaction = (
  liveEnv: RuntimeState,
): RuntimeFrameTransaction => {
  const frameMempool = requireRuntimeMempool(liveEnv);
  const activeMempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
  ensureRuntimeState(liveEnv).inFlightEntityInputs = frameMempool.entityInputs.length;
  liveEnv.runtimeMempool = activeMempool;
  return {
    liveEnv,
    frameMempool,
    liveFrameLogBaseLength: liveEnv.frameLogs.length,
    published: false,
  };
};

export const runtimeInputHasQueuedWork = (input: RuntimeInput): boolean =>
  input.runtimeTxs.length > 0 ||
  input.entityInputs.length > 0 ||
  (input.jInputs?.length ?? 0) > 0 ||
  (input.reliableReceipts?.length ?? 0) > 0;

/** Restore older detached input before work that arrived during execution. */
export const prependOlderRuntimeInput = (
  older: RuntimeInput,
  newer: RuntimeInput,
): RuntimeInput => {
  const merged: RuntimeInput = {
    runtimeTxs: [...older.runtimeTxs, ...newer.runtimeTxs],
    entityInputs: [...older.entityInputs, ...newer.entityInputs],
    ...((older.jInputs?.length ?? 0) + (newer.jInputs?.length ?? 0) > 0
      ? { jInputs: [...(older.jInputs ?? []), ...(newer.jInputs ?? [])] }
      : {}),
    ...((older.reliableReceipts?.length ?? 0) + (newer.reliableReceipts?.length ?? 0) > 0
      ? {
          reliableReceipts: [
            ...(older.reliableReceipts ?? []),
            ...(newer.reliableReceipts ?? []),
          ],
        }
      : {}),
  };
  const queuedAt = [older.queuedAt, newer.queuedAt]
    .filter((value): value is number => Number.isFinite(value))
    .reduce<number | undefined>(
      (latest, value) => latest === undefined ? value : Math.max(latest, value),
      undefined,
    );
  if (runtimeInputHasQueuedWork(merged) && queuedAt !== undefined) {
    merged.queuedAt = queuedAt;
  }
  return merged;
};

/**
 * Build the exact queue that publication will expose without publishing it.
 *
 * WAL must persist both work deferred from the current frame and arrivals
 * accepted while that frame was executing. Persisting only the live queue
 * loses deferred work on crash; publishing before WAL would expose an
 * uncommitted frame.
 */
export const previewPublishedRuntimeInput = (
  transaction: RuntimeFrameTransaction,
): RuntimeInput =>
  prependOlderRuntimeInput(
    transaction.frameMempool,
    requireRuntimeMempool(transaction.liveEnv),
  );

/**
 * Finish the frame by retaining deferred input before arrivals for the next
 * frame. Consensus State is already installed in-place; publish never copies
 * Runtime, Entity, or Jurisdiction maps.
 */
export const publishRuntimeFrameTransaction = (
  transaction: RuntimeFrameTransaction,
): RuntimeState => {
  if (transaction.published) return transaction.liveEnv;
  const { liveEnv, frameMempool } = transaction;
  const activeMempool = requireRuntimeMempool(liveEnv);
  const mergedMempool = prependOlderRuntimeInput(frameMempool, activeMempool);
  liveEnv.runtimeMempool = mergedMempool;
  liveEnv.history = [];
  liveEnv.frameLogs = liveEnv.frameLogs.slice(transaction.liveFrameLogBaseLength);

  const state = ensureRuntimeState(liveEnv);
  state.stateMutationInFlight = false;
  state.wakeRequested =
    state.wakeRequested === true ||
    runtimeInputHasQueuedWork(mergedMempool) ||
    (state.pendingProfileCertificationEntityIds?.size ?? 0) > 0;
  rebuildScheduledWakeIndex(liveEnv);
  for (const replica of liveEnv.jReplicas.values()) {
    replica.jadapter?.setBlockTimestamp(liveEnv.timestamp);
  }
  transaction.published = true;
  return liveEnv;
};
