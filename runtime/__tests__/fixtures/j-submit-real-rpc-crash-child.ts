import {
  closeInfraDb,
  closeRuntimeDb,
  loadEnvFromDB,
  process as processRuntime,
} from '../../runtime';
import { deriveSignerAddressSync } from '../../account/crypto';
import { getNextJSubmitRetryTimestamp } from '../../machine/j-submit-scheduler';
import { ENTITY_J_SUBMIT_FALLBACK_MS } from '../../entity/consensus/leader';
import { computeCanonicalEntityHash } from '../../storage/canonical-hash';
import {
  bootScenario,
  fundEntities,
  registerEntities,
} from '../../scenarios/boot';
import { formatRuntime } from '../../qa/runtime-ascii';
import { safeStringify } from '../../protocol/serialization';
import type { Env, JAdapter } from '../../types';

type Phase = 'crash' | 'recover';

type CrashProof = {
  runtimeId: string;
  jurisdictionName: string;
  senderId: string;
  receiverId: string;
  batchHash: string;
  entityNonce: number;
  attemptId: string;
  submitAttempts: number;
  lastSubmittedAt: number;
  runtimeTimestamp: number;
  txHash: string;
  blockNumber: number;
  chainNonce: string;
  senderReserve: string;
  receiverReserve: string;
  hankoBatchLogCount: number;
};

const [requestedPhase, seed, rpcUrl, proofPath, recoveryPath] = Bun.argv.slice(2);
if (!requestedPhase || !seed || !rpcUrl || !proofPath || !recoveryPath) {
  throw new Error('phase, seed, rpcUrl, proofPath and recoveryPath are required');
}
if (requestedPhase !== 'crash' && requestedPhase !== 'recover') {
  throw new Error(`J_SUBMIT_REAL_RPC_PHASE_INVALID:${requestedPhase}`);
}
const phase = requestedPhase as Phase;
const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();

const fail = (message: string): never => {
  throw new Error(`J_SUBMIT_REAL_RPC_FIXTURE:${message}`);
};

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) {
    fail(`${label}:expected=${String(expected)}:actual=${String(actual)}`);
  }
};

const crashNow = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not stop real RPC crash child');
};

const findReplica = (env: Env, entityId: string) => {
  const normalized = entityId.toLowerCase();
  const replica = Array.from(env.eReplicas.values()).find(
    (candidate) => candidate.entityId.toLowerCase() === normalized,
  );
  if (!replica) fail(`replica-missing:${entityId}`);
  return replica;
};

const driveUntil = async (
  env: Env,
  predicate: () => boolean,
  label: string,
  maxRounds = 30,
): Promise<void> => {
  for (let round = 0; round < maxRounds; round += 1) {
    if (predicate()) return;
    await processRuntime(env, []);
  }
  console.error(formatRuntime(env));
  console.error(safeStringify({
    label,
    runtimeMempool: env.runtimeMempool,
    pendingCommittedJOutbox: env.runtimeState?.pendingCommittedJOutbox,
    replicas: Array.from(env.eReplicas.values()).map((replica) => ({
      entityId: replica.entityId,
      signerId: replica.signerId,
      height: replica.state.height,
      jBatchState: replica.state.jBatchState,
      jSubmitState: replica.jSubmitState,
    })),
  }, 2));
  fail(`convergence-failed:${label}`);
};

const countExactHankoBatchLogs = async (
  adapter: JAdapter,
  entityId: string,
  batchHash: string,
): Promise<number> => {
  const event = adapter.depository.interface.getEvent('HankoBatchProcessed');
  if (!event) fail('HankoBatchProcessed-abi-missing');
  const logs = await adapter.provider.getLogs({
    address: adapter.addresses.depository,
    fromBlock: 0,
    toBlock: 'latest',
    topics: [event.topicHash, entityId, batchHash],
  });
  return logs.length;
};

const closeEnv = async (env: Env): Promise<void> => {
  const adapters = new Set<JAdapter>();
  for (const replica of env.jReplicas.values()) {
    if (replica.jadapter) adapters.add(replica.jadapter);
  }
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  for (const adapter of adapters) {
    await adapter.close();
    const provider = adapter.provider as typeof adapter.provider & { destroy?: () => void };
    if (typeof provider.destroy !== 'function') fail('rpc-provider-destroy-missing');
    provider.destroy();
  }
};

const runCrashPhase = async (): Promise<never> => {
  process.env['ANVIL_RPC'] = rpcUrl;
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'j-submit-real-rpc-crash',
    seed,
    signerIds: ['1', '2'],
    storageEnabled: true,
    mode: 'rpc',
    rpcUrl,
  });
  env.quietRuntimeLogs = true;
  jadapter.setQuietLogs?.(true);
  assertEqual(jadapter.mode, 'rpc', 'adapter-mode');
  const jReplica = env.jReplicas.get(jurisdiction.name);
  if (!jReplica) fail(`jurisdiction-replica-missing:${jurisdiction.name}`);
  jReplica.rpcs = [rpcUrl];

  const senderSigner = deriveSignerAddressSync(seed, '1').toLowerCase();
  const receiverSigner = deriveSignerAddressSync(seed, '2').toLowerCase();
  const [sender, receiver] = await registerEntities(env, jadapter, [
    { name: 'Sender', signer: senderSigner, position: { x: -10, y: 0, z: 0 } },
    { name: 'Receiver', signer: receiverSigner, position: { x: 10, y: 0, z: 0 } },
  ], jurisdiction);
  if (!sender || !receiver) fail('entities-not-registered');

  await fundEntities(env, jadapter, [{ id: sender.id, tokenId: 1, amount: 100n }]);
  await processRuntime(env, [{
    entityId: sender.id,
    signerId: sender.signer,
    entityTxs: [{
      type: 'r2r',
      data: { toEntityId: receiver.id, tokenId: 1, amount: 10n },
    }],
  }]);
  await driveUntil(
    env,
    () => (findReplica(env, sender.id).state.jBatchState?.batch.reserveToReserve.length ?? 0) === 1,
    'r2r-committed',
  );

  await processRuntime(env, [{
    entityId: sender.id,
    signerId: sender.signer,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);
  await driveUntil(
    env,
    () => findReplica(env, sender.id).state.jBatchState?.sentBatch !== undefined &&
      Boolean(env.runtimeMempool?.runtimeTxs.some((tx) => tx.type === 'retryJSubmit')),
    'durable-submit-intent',
  );

  const originalSubmitTx = jadapter.submitTx.bind(jadapter);
  jadapter.submitTx = async (...args) => {
    const result = await originalSubmitTx(...args);
    if (!result.success || !result.txHash || !Number.isSafeInteger(result.blockNumber)) {
      fail(`rpc-submit-failed:${result.error ?? 'missing receipt identity'}`);
    }
    const replica = findReplica(env, sender.id);
    const sentBatch = replica.state.jBatchState?.sentBatch;
    const local = replica.jSubmitState;
    const pending = env.runtimeState?.pendingCommittedJOutbox ?? [];
    const pendingBatch = pending.flatMap((input) => input.jTxs).find(
      (jTx) => jTx.type === 'batch' && jTx.entityId.toLowerCase() === sender.id.toLowerCase(),
    );
    if (!sentBatch || !local || !pendingBatch || pendingBatch.type !== 'batch') {
      fail('durable-attempt-not-present-after-rpc-submit');
    }
    if (local.lastResultAttemptId !== undefined) {
      fail(`result-became-durable-before-crash:${local.lastResultAttemptId}`);
    }
    const attemptId = pendingBatch.data.runtimeSubmitAttempt?.attemptId;
    if (!attemptId) fail('pending-attempt-id-missing');
    const proof: CrashProof = {
      runtimeId,
      jurisdictionName: jurisdiction.name,
      senderId: sender.id,
      receiverId: receiver.id,
      batchHash: sentBatch.batchHash,
      entityNonce: sentBatch.entityNonce,
      attemptId,
      submitAttempts: local.submitAttempts,
      lastSubmittedAt: local.lastSubmittedAt,
      runtimeTimestamp: env.timestamp,
      txHash: result.txHash,
      blockNumber: result.blockNumber!,
      chainNonce: (await jadapter.getEntityNonce(sender.id)).toString(),
      senderReserve: (await jadapter.getReserves(sender.id, 1)).toString(),
      receiverReserve: (await jadapter.getReserves(receiver.id, 1)).toString(),
      hankoBatchLogCount: await countExactHankoBatchLogs(jadapter, sender.id, sentBatch.batchHash),
    };
    await Bun.write(proofPath, JSON.stringify(proof));
    crashNow();
  };

  await driveUntil(
    env,
    () => Boolean(env.runtimeMempool?.runtimeTxs.some((tx) => tx.type === 'recordJSubmitResult')),
    'rpc-submit-result-queued',
  );
  return fail('crash-boundary-not-reached');
};

const runRecoverPhase = async (): Promise<void> => {
  const proof = JSON.parse(await Bun.file(proofPath).text()) as CrashProof;
  assertEqual(proof.runtimeId, runtimeId, 'proof-runtime-id');
  const restored = await loadEnvFromDB(runtimeId, seed);
  if (!restored) fail('restore-returned-null');
  restored.scenarioMode = true;
  restored.quietRuntimeLogs = true;
  const replica = findReplica(restored, proof.senderId);
  const jReplica = restored.jReplicas.get(proof.jurisdictionName);
  const adapter = jReplica?.jadapter;
  if (!adapter) fail(`restored-rpc-adapter-missing:${proof.jurisdictionName}`);
  assertEqual(adapter.mode, 'rpc', 'restored-adapter-mode');
  adapter.setQuietLogs?.(true);

  const pendingBefore = restored.runtimeState?.pendingCommittedJOutbox ?? [];
  assertEqual(pendingBefore.length, 1, 'pending-before-reconcile');
  assertEqual(replica.jSubmitState?.submitAttempts, 1, 'submit-attempts-before-reconcile');
  assertEqual(replica.jSubmitState?.lastResultAttemptId, undefined, 'result-before-reconcile');
  assertEqual(replica.state.jBatchState?.sentBatch?.batchHash, proof.batchHash, 'sent-batch-before-reconcile');
  assertEqual(await adapter.getEntityNonce(proof.senderId), 1n, 'chain-nonce-before-reconcile');
  const restoredTimestamp = restored.timestamp;
  const nextRetryTimestampBefore = getNextJSubmitRetryTimestamp(restored);
  assertEqual(nextRetryTimestampBefore, null, 'pending-attempt-must-not-schedule-second-attempt');

  await driveUntil(
    restored,
    () => (restored.runtimeState?.pendingCommittedJOutbox?.length ?? 0) === 0 &&
      findReplica(restored, proof.senderId).state.jBatchState?.sentBatch === undefined &&
      findReplica(restored, proof.senderId).jSubmitState?.lastResultOutcome === 'reconciled',
    'chain-consumed-attempt-reconciled',
  );
  const reconciledReplica = findReplica(restored, proof.senderId);
  const canonicalHash = computeCanonicalEntityHash(reconciledReplica).hash;
  const finalRuntimeHeight = restored.height;
  const finalEntityHeight = reconciledReplica.state.height;
  const finalTimestamp = restored.timestamp;
  const retryBackoffAt = proof.lastSubmittedAt + ENTITY_J_SUBMIT_FALLBACK_MS;
  const resultAttemptId = reconciledReplica.jSubmitState?.lastResultAttemptId;
  assertEqual(resultAttemptId, proof.attemptId, 'reconciled-attempt-id');
  assertEqual(reconciledReplica.jSubmitState?.submitAttempts, 1, 'no-second-submit-attempt');
  if (finalTimestamp >= retryBackoffAt) {
    fail(`reconcile-waited-for-backoff:backoffAt=${retryBackoffAt}:actual=${finalTimestamp}`);
  }
  assertEqual(await adapter.getEntityNonce(proof.senderId), 1n, 'chain-nonce-after-reconcile');
  assertEqual(await adapter.getReserves(proof.senderId, 1), 90n, 'sender-reserve-after-reconcile');
  assertEqual(await adapter.getReserves(proof.receiverId, 1), 10n, 'receiver-reserve-after-reconcile');
  assertEqual(
    await countExactHankoBatchLogs(adapter, proof.senderId, proof.batchHash),
    1,
    'hanko-log-count-after-reconcile',
  );
  await closeEnv(restored);

  const reopened = await loadEnvFromDB(runtimeId, seed);
  if (!reopened) fail('second-reopen-returned-null');
  reopened.scenarioMode = true;
  reopened.quietRuntimeLogs = true;
  const reopenedReplica = findReplica(reopened, proof.senderId);
  const reopenedAdapter = reopened.jReplicas.get(proof.jurisdictionName)?.jadapter;
  if (!reopenedAdapter) fail('second-reopen-adapter-missing');
  reopenedAdapter.setQuietLogs?.(true);
  assertEqual(reopened.height, finalRuntimeHeight, 'runtime-head-after-second-reopen');
  assertEqual(reopenedReplica.state.height, finalEntityHeight, 'entity-head-after-second-reopen');
  assertEqual(computeCanonicalEntityHash(reopenedReplica).hash, canonicalHash, 'canonical-hash-after-second-reopen');
  assertEqual(reopenedReplica.jSubmitState?.lastResultAttemptId, resultAttemptId, 'result-after-second-reopen');
  assertEqual(reopened.runtimeState?.pendingCommittedJOutbox?.length ?? 0, 0, 'pending-after-second-reopen');
  assertEqual(await reopenedAdapter.getEntityNonce(proof.senderId), 1n, 'chain-nonce-after-second-reopen');
  const finalHankoBatchLogCount = await countExactHankoBatchLogs(
    reopenedAdapter,
    proof.senderId,
    proof.batchHash,
  );
  assertEqual(finalHankoBatchLogCount, 1, 'hanko-log-count-after-second-reopen');

  await Bun.write(recoveryPath, JSON.stringify({
    runtimeId,
    pendingBefore: pendingBefore.length,
    pendingAfter: reopened.runtimeState?.pendingCommittedJOutbox?.length ?? 0,
    submitAttempts: reopenedReplica.jSubmitState?.submitAttempts,
    resultOutcome: reopenedReplica.jSubmitState?.lastResultOutcome,
    resultAttemptId: reopenedReplica.jSubmitState?.lastResultAttemptId,
    nextRetryTimestampBefore,
    restoredTimestamp,
    finalTimestamp,
    retryBackoffAt,
    finalRuntimeHeight,
    finalEntityHeight,
    canonicalHash,
    chainNonce: (await reopenedAdapter.getEntityNonce(proof.senderId)).toString(),
    senderReserve: (await reopenedAdapter.getReserves(proof.senderId, 1)).toString(),
    receiverReserve: (await reopenedAdapter.getReserves(proof.receiverId, 1)).toString(),
    hankoBatchLogCount: finalHankoBatchLogCount,
  }));
  await closeEnv(reopened);
};

if (phase === 'crash') {
  await runCrashPhase();
} else {
  await runRecoverPhase();
}
