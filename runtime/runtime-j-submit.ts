import type { EntityInput, Env, JInput, JTx, RuntimeTx } from './types';
import { getCachedSignerPrivateKey } from './account-crypto';
import { isBatchEmpty } from './j-batch';

export type RuntimeJOutboxQueue = (
  env: Env,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
) => void;

export type RuntimeJSubmitDeps = {
  enqueueRuntimeInputs: RuntimeJOutboxQueue;
};

const hasJEventTx = (input: EntityInput): boolean =>
  (input.entityTxs ?? []).some((tx) => tx?.type === 'j_event');

const captureQueuedEntityInputs = (env: Env): EntityInput[] => {
  const mempool = env.runtimeMempool ?? env.runtimeInput;
  return Array.isArray(mempool?.entityInputs) ? [...mempool.entityInputs] : [];
};

const prioritizeJEventsQueuedAfterSubmit = (env: Env, beforePoll: EntityInput[]): number => {
  const mempool = env.runtimeMempool ?? env.runtimeInput;
  if (!mempool || !Array.isArray(mempool.entityInputs)) return 0;
  const current = mempool.entityInputs;
  if (current.length <= beforePoll.length) return 0;

  const newlyQueued = current.slice(beforePoll.length);
  const newlyQueuedJEvents = newlyQueued.filter(hasJEventTx);
  if (newlyQueuedJEvents.length === 0) return 0;

  const newlyQueuedOtherInputs = newlyQueued.filter((input) => !hasJEventTx(input));
  // Chain receipts caused by the just-submitted J batch must be visible before
  // same-entity local follow-ups already queued for the next R-frame. Otherwise
  // a follow-up such as j_broadcast can observe a stale sentBatch latch and
  // fail even though the chain transaction has already finalized.
  mempool.entityInputs = [...newlyQueuedJEvents, ...beforePoll, ...newlyQueuedOtherInputs];
  env.runtimeMempool = mempool;
  env.runtimeInput = mempool;
  return newlyQueuedJEvents.length;
};

const pollSubmittedJEventsBeforeFollowups = async (env: Env, jAdapter: { pollNow?: () => Promise<void> }): Promise<void> => {
  if (typeof jAdapter.pollNow !== 'function') return;
  const beforePoll = captureQueuedEntityInputs(env);
  await jAdapter.pollNow();
  const prioritized = prioritizeJEventsQueuedAfterSubmit(env, beforePoll);
  if (prioritized > 0) {
    console.log(`✅ [J-SUBMIT] prioritized ${prioritized} watcher j_event input(s) before local follow-ups`);
  }
};

const validateSealedBatchJTx = (jTx: JTx): void => {
  if (jTx.type !== 'batch') return;
  if (isBatchEmpty(jTx.data.batch)) return;
  const missing: string[] = [];
  if (!jTx.data.encodedBatch) missing.push('encodedBatch');
  if (typeof jTx.data.entityNonce !== 'number') missing.push('entityNonce');
  if (!jTx.data.hankoSignature) missing.push('hankoSignature');
  if (missing.length === 0) return;
  throw new Error(
    `J_SUBMIT_FATAL: J_BATCH_CONSENSUS_HANKO_MISSING:${jTx.entityId}:missing=${missing.join(',')}`,
  );
};

/**
 * Submit post-commit J batches after the R-frame is durable.
 *
 * This is deliberately outside consensus. A failed chain submit is not a
 * market outcome; it means the runtime produced an invalid batch or the chain
 * transport is broken. Throw so the runtime loop halts with a debug payload
 * instead of manufacturing follow-up consensus state from a side-effect failure.
 */
export async function submitRuntimeJOutbox(
  env: Env,
  jOutbox: JInput[],
  _deps: RuntimeJSubmitDeps,
): Promise<void> {
  if (jOutbox.length === 0) return;

  const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
  console.log(`⚡ [SIDE-EFFECT] Submitting ${totalJTxs} J-txs via JAdapter (${jOutbox.length} JInputs)`);

  for (const jInput of jOutbox) {
    const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
    if (!jReplica) {
      throw new Error(`J_SUBMIT_FATAL: missing_jReplica:${jInput.jurisdictionName}`);
    }

    const jAdapter = jReplica.jadapter;
    if (!jAdapter) {
      throw new Error(`J_SUBMIT_FATAL: missing_jAdapter:${jInput.jurisdictionName}`);
    }

    for (const jTx of jInput.jTxs) {
      console.log(`📤 [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} → ${jInput.jurisdictionName}`);
      validateSealedBatchJTx(jTx);

      try {
        const submitData = jTx.data as { signerId?: unknown } | undefined;
        const submitSignerId = typeof submitData?.signerId === 'string' ? submitData.signerId : undefined;
        const submitSignerPrivateKey = submitSignerId ? getCachedSignerPrivateKey(submitSignerId) : null;
        const result = await jAdapter.submitTx(jTx, {
          env,
          ...(submitSignerId ? { signerId: submitSignerId } : {}),
          ...(submitSignerPrivateKey ? { signerPrivateKey: submitSignerPrivateKey } : {}),
          timestamp: jTx.timestamp ?? env.timestamp,
        });

        if (result.success) {
          console.log(
            `✅ [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)}: ok (events=${result.events?.length ?? 0}, txHash=${result.txHash ?? 'n/a'})`,
          );
          await pollSubmittedJEventsBeforeFollowups(env, jAdapter);
        } else {
          console.error(`❌ [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} FAILED: ${result.error}`);
          throw new Error(`J_SUBMIT_FATAL: ${result.error || 'unknown'}`);
        }
      } catch (error) {
        console.error(`❌ [J-SUBMIT] submitTx threw for ${jTx.entityId.slice(-4)}:`, error);
        throw error;
      }
    }

    // Submission does not own the watcher cursor.
    // The authoritative J-height path is watcher poll -> processEventBatch.
    jReplica.lastBlockTimestamp = env.timestamp;
  }
}
