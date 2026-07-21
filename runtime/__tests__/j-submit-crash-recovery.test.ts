import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  loadEnvFromDB,
  process as processRuntime,
  registerRecoveryBackupBarrier,
} from '../runtime';
import { deriveSignerAddressSync } from '../account/crypto';
import { getNextJSubmitRetryTimestamp } from '../machine/j-submit-scheduler';
import { dbRootPath } from '../machine/platform';
import { computeCanonicalEntityHash } from '../storage/canonical-hash';
import { bootScenario, fundEntities, registerEntities } from '../scenarios/boot';
import {
  cleanupRuntimeStorage,
  crashBoundaryFixture,
  driveRuntimeUntil,
  findJSubmitCrashReplica,
  processUntilJSubmitCrash,
} from './fixtures/j-submit-crash-helpers';

type RealCrashBoundary =
  | 'before-intent'
  | 'after-durable-intent'
  | 'after-rpc-submit-before-result'
  | 'after-durable-result';

const findReplica = findJSubmitCrashReplica;
const processUntilFailure = processUntilJSubmitCrash;

describe('J submit crash recovery', () => {
  let cleanupRuntimeId = '';
  afterEach(() => {
    if (cleanupRuntimeId) cleanupRuntimeStorage(cleanupRuntimeId);
    cleanupRuntimeId = '';
  });

  test('reconciles an exact BrowserVM batch receipt after the submit result is lost', async () => {
    mkdirSync(dbRootPath, { recursive: true });
    const seed = `J submit real crash ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    cleanupRuntimeId = runtimeId;
    cleanupRuntimeStorage(runtimeId);
    const { env, jadapter, jurisdiction } = await bootScenario({
      name: 'j-submit-real-terminal-rejection',
      seed,
      signerIds: ['1', '2'],
      storageEnabled: true,
      mode: 'browservm',
    });
    env.quietRuntimeLogs = true;
    expect(jadapter.mode).toBe('browservm');
    jadapter.startWatching(env);
    const senderSigner = deriveSignerAddressSync(seed, '1').toLowerCase();
    const receiverSigner = deriveSignerAddressSync(seed, '2').toLowerCase();
    const [sender, receiver] = await registerEntities(env, jadapter, [
      { name: 'Sender', signer: senderSigner, position: { x: -10, y: 0, z: 0 } },
      { name: 'Receiver', signer: receiverSigner, position: { x: 10, y: 0, z: 0 } },
    ], jurisdiction);
    if (!sender || !receiver) throw new Error('real terminal rejection entities missing');
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
      () => (findReplica(env, sender.id).state.jBatchState?.batch.reserveToReserve.length ?? 0) === 1,
      'real r2r committed before terminal broadcast',
    );

    const removeIntentBarrier = registerRecoveryBackupBarrier(env, async () => {
      throw new Error('CRASH_AFTER_INTENT_COMMIT');
    });
    await processUntilFailure(env, [{
      entityId: sender.id,
      signerId: sender.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }], 'CRASH_AFTER_INTENT_COMMIT');
    removeIntentBarrier();
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const afterIntent = await loadEnvFromDB(runtimeId, seed);
    if (!afterIntent) throw new Error('failed to restore committed J intent');
    afterIntent.scenarioMode = true;
    afterIntent.quietRuntimeLogs = true;
    afterIntent.jReplicas.get(jurisdiction.name)!.jadapter = jadapter;
    const intentReplica = findReplica(afterIntent, sender.id);
    expect(intentReplica.state.jBatchState?.status).toBe('sent');
    expect(intentReplica.jSubmitState).toBeUndefined();
    expect(afterIntent.runtimeMempool?.runtimeTxs).toHaveLength(1);
    expect(afterIntent.runtimeMempool?.runtimeTxs[0]?.type).toBe('retryJSubmit');
    registerRecoveryBackupBarrier(afterIntent, async () => {
      throw new Error('CRASH_AFTER_ATTEMPT_COMMIT');
    });
    await processUntilFailure(afterIntent, [], 'CRASH_AFTER_ATTEMPT_COMMIT');
    await closeRuntimeDb(afterIntent);
    await closeInfraDb(afterIntent);

    const afterAttempt = await loadEnvFromDB(runtimeId, seed);
    if (!afterAttempt) throw new Error('failed to restore durable J attempt');
    afterAttempt.scenarioMode = true;
    afterAttempt.quietRuntimeLogs = true;
    afterAttempt.jReplicas.get(jurisdiction.name)!.jadapter = jadapter;
    expect(findReplica(afterAttempt, sender.id).jSubmitState).toMatchObject({
      submitAttempts: 1,
      entityNonce: 1,
    });
    expect(afterAttempt.runtimeState?.pendingCommittedJOutbox).toHaveLength(1);
    const sealedAttempt = afterAttempt.runtimeState?.pendingCommittedJOutbox?.[0]?.jTxs[0];
    if (sealedAttempt?.type !== 'batch') {
      throw new Error('real terminal rejection sealed batch attempt missing');
    }
    await jadapter.processBatch(
      sealedAttempt.data.encodedBatch,
      sealedAttempt.data.hankoSignature,
      BigInt(sealedAttempt.data.entityNonce),
    );

    // Let any independently due Entity scheduler work commit behind the same
    // pre-I/O recovery fence. The state captured after reopen is therefore the
    // exact baseline for the validator-local submit result transition.
    registerRecoveryBackupBarrier(afterAttempt, async () => {
      throw new Error('PAUSE_AFTER_SCHEDULER_COMMIT');
    });
    await processUntilFailure(afterAttempt, [], 'PAUSE_AFTER_SCHEDULER_COMMIT');
    await closeRuntimeDb(afterAttempt);
    await closeInfraDb(afterAttempt);

    const beforeIo = await loadEnvFromDB(runtimeId, seed);
    if (!beforeIo) throw new Error('failed to restore before real BrowserVM rejection');
    beforeIo.scenarioMode = true;
    beforeIo.quietRuntimeLogs = true;
    beforeIo.jReplicas.get(jurisdiction.name)!.jadapter = jadapter;
    const consensusStateBeforeResult = structuredClone(findReplica(beforeIo, sender.id).state);
    const consensusHashBeforeResult = computeCanonicalEntityHash(findReplica(beforeIo, sender.id)).hash;
    expect(beforeIo.runtimeState?.pendingCommittedJOutbox).toHaveLength(1);

    await processRuntime(beforeIo, []);
    const queuedResult = beforeIo.runtimeMempool?.runtimeTxs[0];
    expect(queuedResult?.type).toBe('recordJSubmitResult');
    if (queuedResult?.type !== 'recordJSubmitResult') throw new Error('exact receipt result was not queued');
    expect(queuedResult.data.outcome).toBe('reconciled');
    expect(queuedResult.data.message).toBeUndefined();
    expect(findReplica(beforeIo, sender.id).jSubmitState?.terminalFailure).toBeUndefined();
    expect(findReplica(beforeIo, sender.id).state).toEqual(consensusStateBeforeResult);
    expect(computeCanonicalEntityHash(findReplica(beforeIo, sender.id)).hash).toBe(consensusHashBeforeResult);
    await closeRuntimeDb(beforeIo);
    await closeInfraDb(beforeIo);

    const afterIo = await loadEnvFromDB(runtimeId, seed);
    if (!afterIo) throw new Error('failed to restore after uncommitted J result');
    afterIo.scenarioMode = true;
    afterIo.quietRuntimeLogs = true;
    expect(afterIo.runtimeState?.pendingCommittedJOutbox).toHaveLength(1);
    expect(findReplica(afterIo, sender.id).jSubmitState?.terminalFailure).toBeUndefined();
    afterIo.jReplicas.get(jurisdiction.name)!.jadapter = jadapter;
    await processRuntime(afterIo, []);
    const replayedResult = afterIo.runtimeMempool?.runtimeTxs[0];
    expect(replayedResult?.type).toBe('recordJSubmitResult');
    if (replayedResult?.type !== 'recordJSubmitResult') throw new Error('replayed exact receipt result missing');
    expect(replayedResult.data.outcome).toBe('reconciled');
    expect(replayedResult.data.message).toBeUndefined();
    await processRuntime(afterIo, []);
    expect(findReplica(afterIo, sender.id).state.jBatchState?.sentBatch).toBeUndefined();
    const consensusHashAfterReconcile = computeCanonicalEntityHash(findReplica(afterIo, sender.id)).hash;
    expect(consensusHashAfterReconcile).not.toBe(consensusHashBeforeResult);
    await closeRuntimeDb(afterIo);
    await closeInfraDb(afterIo);

    const afterResult = await loadEnvFromDB(runtimeId, seed);
    if (!afterResult) throw new Error('failed to restore durable J result');
    try {
      const finalReplica = findReplica(afterResult, sender.id);
      expect(finalReplica.jSubmitState?.submitAttempts).toBe(1);
      expect(finalReplica.jSubmitState?.lastResultOutcome).toBe('reconciled');
      expect(finalReplica.jSubmitState?.terminalFailure).toBeUndefined();
      expect(finalReplica.state.jBatchState?.sentBatch).toBeUndefined();
      expect(afterResult.runtimeState?.pendingCommittedJOutbox ?? []).toEqual([]);
      expect(computeCanonicalEntityHash(finalReplica).hash).toBe(consensusHashAfterReconcile);
    } finally {
      await closeRuntimeDb(afterResult);
      await closeInfraDb(afterResult);
    }
  }, 30_000);

  for (const boundary of [
    'before-intent',
    'after-durable-intent',
    'after-rpc-submit-before-result',
    'after-durable-result',
  ] satisfies RealCrashBoundary[]) {
    test(`reopens exact J-submit state after real SIGKILL ${boundary}`, async () => {
      mkdirSync(dbRootPath, { recursive: true });
      const seed = `J submit real crash ${process.pid} deterministic seed`;
      const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
      cleanupRuntimeId = runtimeId;
      cleanupRuntimeStorage(runtimeId);

      const child = Bun.spawn({
        cmd: [process.execPath, crashBoundaryFixture, seed, boundary],
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, XLN_DB_PATH: dbRootPath },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(137);
      expect(child.signalCode, `${stdout}\n${stderr}`).toBe('SIGKILL');

      const restored = await loadEnvFromDB(runtimeId, seed);
      if (!restored) throw new Error(`failed to restore J-submit crash boundary ${boundary}`);
      try {
        const replica = Array.from(restored.eReplicas.values()).find((candidate) => (
          candidate.jSubmitState !== undefined ||
          candidate.state.jBatchState?.sentBatch !== undefined ||
          (candidate.state.jBatchState?.batch.reserveToReserve.length ?? 0) > 0
        ));
        if (!replica) throw new Error(`restored J-submit sender missing at ${boundary}`);
        const pending = restored.runtimeState?.pendingCommittedJOutbox ?? [];
        if (boundary === 'before-intent') {
          expect(replica.state.jBatchState?.status).toBe('accumulating');
          expect(replica.state.jBatchState?.sentBatch).toBeUndefined();
          expect(replica.jSubmitState).toBeUndefined();
          expect(pending).toEqual([]);
        } else if (boundary === 'after-durable-intent') {
          expect(replica.state.jBatchState?.status).toBe('sent');
          expect(replica.state.jBatchState?.sentBatch?.entityNonce).toBe(1);
          expect(replica.jSubmitState).toBeUndefined();
          expect(pending).toEqual([]);
          expect(restored.runtimeMempool?.runtimeTxs.some((tx) => tx.type === 'retryJSubmit')).toBe(true);
          expect(getNextJSubmitRetryTimestamp(restored)).toBe(0);
        } else if (boundary === 'after-rpc-submit-before-result') {
          expect(replica.jSubmitState).toMatchObject({
            submitAttempts: 1,
            entityNonce: 1,
          });
          expect(replica.jSubmitState?.lastResultAttemptId).toBeUndefined();
          expect(pending).toHaveLength(1);
        } else {
          expect(replica.jSubmitState).toMatchObject({
            submitAttempts: 1,
            lastResultOutcome: 'submitted',
          });
          expect(replica.jSubmitState?.lastResultFingerprint).toBeString();
          expect(pending).toEqual([]);
        }
      } finally {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      }
    }, 60_000);
  }
});
