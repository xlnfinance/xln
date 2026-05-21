import type { Env, JInput, RoutedEntityInput, RuntimeTx } from './types';
import { getCachedSignerPrivateKey } from './account-crypto';

export type RuntimeJOutboxQueue = (
  env: Env,
  inputs?: RoutedEntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
) => void;

export type RuntimeJSubmitDeps = {
  enqueueRuntimeInputs: RuntimeJOutboxQueue;
};

const buildAbortSentBatchInput = (
  entityId: string,
  reason: string,
  signerId?: string,
): RoutedEntityInput => ({
  entityId,
  ...(signerId ? { signerId } : {}),
  entityTxs: [
    {
      type: 'j_abort_sent_batch',
      data: {
        requeueToCurrent: true,
        reason: `submit_failed:${String(reason || 'unknown').slice(0, 240)}`,
      },
    },
  ],
});

/**
 * Submit post-commit J batches after the R-frame is durable.
 *
 * This is deliberately outside consensus: a failed chain submit queues an
 * explicit j_abort_sent_batch for a later frame instead of mutating the just
 * committed state. Keeping it in one module makes the tick engine read as:
 * apply -> persist -> dispatch side effects.
 */
export async function submitRuntimeJOutbox(
  env: Env,
  jOutbox: JInput[],
  deps: RuntimeJSubmitDeps,
): Promise<void> {
  if (jOutbox.length === 0) return;

  const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
  console.log(`⚡ [SIDE-EFFECT] Submitting ${totalJTxs} J-txs via JAdapter (${jOutbox.length} JInputs)`);

  for (const jInput of jOutbox) {
    const queueMissingInfraAbort = (reason: string) => {
      for (const jTx of jInput.jTxs) {
        if (jTx.type !== 'batch') continue;
        const signerId = typeof jTx.data?.signerId === 'string' ? jTx.data.signerId : undefined;
        deps.enqueueRuntimeInputs(
          env,
          [buildAbortSentBatchInput(jTx.entityId, reason, signerId)],
          undefined,
          undefined,
          env.timestamp,
        );
      }
    };

    const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
    if (!jReplica) {
      console.error(`❌ [J-SUBMIT] Jurisdiction "${jInput.jurisdictionName}" not found — skipping`);
      queueMissingInfraAbort(`missing_jReplica:${jInput.jurisdictionName}`);
      continue;
    }

    const jAdapter = jReplica.jadapter;
    if (!jAdapter) {
      console.error(`❌ [J-SUBMIT] No JAdapter for jurisdiction "${jInput.jurisdictionName}" — skipping`);
      queueMissingInfraAbort(`missing_jAdapter:${jInput.jurisdictionName}`);
      continue;
    }

    for (const jTx of jInput.jTxs) {
      console.log(`📤 [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} → ${jInput.jurisdictionName}`);
      const queueAbortSentBatch = (reason: string) => {
        if (jTx.type !== 'batch') return;
        const signerId = typeof jTx.data?.signerId === 'string' ? jTx.data.signerId : undefined;
        deps.enqueueRuntimeInputs(
          env,
          [buildAbortSentBatchInput(jTx.entityId, reason, signerId)],
          undefined,
          undefined,
          env.timestamp,
        );
        console.warn(
          `⚠️ [J-SUBMIT] queued j_abort_sent_batch for ${jTx.entityId.slice(-4)} after failed batch submission`,
        );
      };

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
        } else {
          console.error(`❌ [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} FAILED: ${result.error}`);
          if (!env.scenarioMode) {
            queueAbortSentBatch(result.error || 'unknown');
          }
          if (env.scenarioMode) {
            throw new Error(`J-SUBMIT FAILED: ${result.error || 'unknown'}`);
          }
        }
      } catch (error) {
        console.error(`❌ [J-SUBMIT] submitTx threw for ${jTx.entityId.slice(-4)}:`, error);
        if (!env.scenarioMode) {
          const msg = error instanceof Error ? error.message : String(error);
          queueAbortSentBatch(msg);
        }
        if (env.scenarioMode) throw error;
      }
    }

    // Submission does not own the watcher cursor.
    // The authoritative J-height path is watcher poll -> processEventBatch.
    jReplica.lastBlockTimestamp = env.timestamp;
  }
}
