import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'fs';

import {
  closeInfraDb,
  closeRuntimeDb,
  loadEnvFromDB,
  process as processRuntime,
  registerRecoveryBackupBarrier,
} from '../runtime';
import { deriveSignerAddressSync } from '../account/crypto';
import { dbRootPath } from '../machine/platform';
import { bootScenario, fundEntities, registerEntities } from '../scenarios/boot';
import {
  cleanupRuntimeStorage,
  driveRuntimeUntil,
  findJSubmitCrashReplica,
  processUntilJSubmitCrash,
} from './fixtures/j-submit-crash-helpers';

describe('J-submit abort with durable pending attempt', () => {
  let cleanupRuntimeId = '';
  afterEach(() => {
    if (cleanupRuntimeId) cleanupRuntimeStorage(cleanupRuntimeId);
    cleanupRuntimeId = '';
  });

  test('durable Entity abort prevents the committed pending attempt from reaching BrowserVM', async () => {
    mkdirSync(dbRootPath, { recursive: true });
    const seed = `J submit real crash ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    cleanupRuntimeId = runtimeId;
    cleanupRuntimeStorage(runtimeId);
    const { env, jadapter, jurisdiction } = await bootScenario({
      name: 'j-submit-abort-pending',
      seed,
      signerIds: ['1', '2'],
      storageEnabled: true,
      mode: 'browservm',
    });
    env.quietRuntimeLogs = true;
    const senderSigner = deriveSignerAddressSync(seed, '1').toLowerCase();
    const receiverSigner = deriveSignerAddressSync(seed, '2').toLowerCase();
    const [sender, receiver] = await registerEntities(env, jadapter, [
      { name: 'Sender', signer: senderSigner, position: { x: -10, y: 0, z: 0 } },
      { name: 'Receiver', signer: receiverSigner, position: { x: 10, y: 0, z: 0 } },
    ], jurisdiction);
    if (!sender || !receiver) throw new Error('abort-pending entities missing');
    await fundEntities(env, jadapter, [{ id: sender.id, tokenId: 1, amount: 100n }]);
    await processRuntime(env, [{
      entityId: sender.id,
      signerId: sender.signer,
      entityTxs: [{
        type: 'r2r',
        data: { toEntityId: receiver.id, tokenId: 1, amount: 10n },
      }],
    }]);
    await driveRuntimeUntil(
      env,
      () => (findJSubmitCrashReplica(env, sender.id).state.jBatchState?.batch.reserveToReserve.length ?? 0) === 1,
      'abort-pending r2r commit',
    );

    const removeIntentBarrier = registerRecoveryBackupBarrier(env, async () => {
      throw new Error('PAUSE_AFTER_ABORT_TEST_INTENT');
    });
    await processUntilJSubmitCrash(env, [{
      entityId: sender.id,
      signerId: sender.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }], 'PAUSE_AFTER_ABORT_TEST_INTENT');
    removeIntentBarrier();

    const removeAttemptBarrier = registerRecoveryBackupBarrier(env, async () => {
      throw new Error('PAUSE_AFTER_ABORT_TEST_ATTEMPT');
    });
    await processUntilJSubmitCrash(env, [], 'PAUSE_AFTER_ABORT_TEST_ATTEMPT');
    removeAttemptBarrier();
    expect(env.runtimeState?.pendingCommittedJOutbox).toHaveLength(1);

    const removeAbortBarrier = registerRecoveryBackupBarrier(env, async () => {
      throw new Error('PAUSE_AFTER_DURABLE_ABORT');
    });
    await processUntilJSubmitCrash(env, [{
      entityId: sender.id,
      signerId: sender.signer,
      entityTxs: [{
        type: 'j_abort_sent_batch',
        data: { reason: 'operator-abort-before-io', requeueToCurrent: true },
      }],
    }], 'PAUSE_AFTER_DURABLE_ABORT');
    removeAbortBarrier();
    expect(findJSubmitCrashReplica(env, sender.id).state.jBatchState?.sentBatch).toBeUndefined();
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('failed to restore durable abort with pending attempt');
    restored.scenarioMode = true;
    restored.quietRuntimeLogs = true;
    restored.jReplicas.get(jurisdiction.name)!.jadapter = jadapter;
    const browserVM = jadapter.getBrowserVM();
    if (!browserVM) throw new Error('abort-pending BrowserVM missing');
    const blockBefore = browserVM.getBlockNumber();
    const nonceBefore = await jadapter.getEntityNonce(sender.id);
    const staleBatchTx = restored.runtimeState?.pendingCommittedJOutbox?.[0]?.jTxs[0];
    if (!staleBatchTx || staleBatchTx.type !== 'batch' || !staleBatchTx.data.runtimeSubmitAttempt) {
      throw new Error('restored stale batch attempt missing');
    }

    // Rebuild the exact same batch in the same restored tick. Hash and nonce
    // repeat, so only the deterministic broadcast generation can prove that
    // the old pre-abort attempt is tombstoned.
    await processRuntime(restored, [{
      entityId: sender.id,
      signerId: sender.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }]);
    expect(browserVM.getBlockNumber()).toBe(blockBefore);
    expect(await jadapter.getEntityNonce(sender.id)).toBe(nonceBefore);
    const rebuilt = findJSubmitCrashReplica(restored, sender.id).state.jBatchState?.sentBatch;
    expect(rebuilt?.batchHash).toBe(staleBatchTx.data.batchHash);
    expect(rebuilt?.entityNonce).toBe(staleBatchTx.data.entityNonce);
    expect(findJSubmitCrashReplica(restored, sender.id).state.jBatchState?.broadcastCount)
      .toBeGreaterThan(staleBatchTx.data.runtimeSubmitAttempt.batchGeneration);
    const cancellationResult = restored.runtimeMempool?.runtimeTxs.find(
      (runtimeTx) => runtimeTx.type === 'recordJSubmitResult',
    );
    expect(cancellationResult?.type).toBe('recordJSubmitResult');
    if (cancellationResult?.type !== 'recordJSubmitResult') {
      throw new Error('durable abort cancellation result missing');
    }
    expect(cancellationResult.data.outcome).toBe('reconciled');
    await processRuntime(restored, []);
    const staleAttemptId = staleBatchTx.data.runtimeSubmitAttempt.attemptId;
    const livePendingIds = (restored.runtimeState?.pendingCommittedJOutbox ?? []).flatMap(
      (input) => input.jTxs.flatMap((jTx) => (
        jTx.type === 'batch' && jTx.data.runtimeSubmitAttempt
          ? [jTx.data.runtimeSubmitAttempt.attemptId]
          : []
      )),
    );
    expect(livePendingIds).not.toContain(staleAttemptId);
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);

    const final = await loadEnvFromDB(runtimeId, seed);
    if (!final) throw new Error('failed to reopen durable J-submit abort result');
    try {
      const restoredPendingIds = (final.runtimeState?.pendingCommittedJOutbox ?? []).flatMap(
        (input) => input.jTxs.flatMap((jTx) => (
          jTx.type === 'batch' && jTx.data.runtimeSubmitAttempt
            ? [jTx.data.runtimeSubmitAttempt.attemptId]
            : []
        )),
      );
      expect(restoredPendingIds).not.toContain(staleAttemptId);
      expect(findJSubmitCrashReplica(final, sender.id).state.jBatchState?.sentBatch?.batchHash)
        .toBe(staleBatchTx.data.batchHash);
    } finally {
      await closeRuntimeDb(final);
      await closeInfraDb(final);
    }
  }, 30_000);
});
