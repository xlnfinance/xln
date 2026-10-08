import { DEFAULT_PRIVATE_KEY } from '../../../jurisdiction/adapter/kernel/factory';
import { ethers } from 'ethers';
import { createJAdapter, createXlnJsonRpcProvider } from '../../../jurisdiction/adapter';
import {
  closeInfraDb,
  closeRuntimeDb,
  loadEnvFromDB,
  processRuntime,
  enqueueRuntimeInput,
} from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { getNextJSubmitRetryTimestamp } from '../../../runtime/j-submit/j-submit-scheduler';
import { ENTITY_J_SUBMIT_RETRY_MS } from '../../../entity/consensus/leader';
import { computeCanonicalEntityHash } from '../../../storage/canonical-hash';
import {
  bootScenario,
  fundEntities,
  registerEntities,
} from '../../../scenarios/harness/boot';
import { formatRuntime } from '../../../qa/runtime-ascii';
import { safeStringify } from '../../../protocol/serialization';
import type { RuntimeReplica, JAdapter } from '../../../runtime/types';
import {
  getLiveJAdapter,
  getLiveJAdapterEntries,
} from '../../../runtime/j-submit/live-jadapters';

type Phase = 'crash' | 'recover' | 'pending-crash' | 'pending-recover' | 'accepted-crash' | 'prepared-crash' | 'prepared-recover';

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
if (!['crash', 'recover', 'pending-crash', 'pending-recover', 'accepted-crash', 'prepared-crash', 'prepared-recover'].includes(requestedPhase)) {
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

const findReplica = (env: RuntimeReplica, entityId: string) => {
  const normalized = entityId.toLowerCase();
  const replica = Array.from(env.state.eReplicas.values()).find(
    (candidate) => candidate.entityId.toLowerCase() === normalized,
  );
  if (!replica) fail(`replica-missing:${entityId}`);
  return replica;
};

const driveUntil = async (
  env: RuntimeReplica,
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
    pendingCommittedJOutbox: env.infrastructure?.pendingCommittedJOutbox,
    replicas: Array.from(env.state.eReplicas.values()).map((replica) => ({
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

const closeEnv = async (env: RuntimeReplica): Promise<void> => {
  const adapters = new Set<JAdapter>(
    getLiveJAdapterEntries(env).map(({ adapter }) => adapter),
  );
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
  const jReplica = env.state.jReplicas.get(jurisdiction.name);
  if (!jReplica) fail(`jurisdiction-replica-missing:${jurisdiction.name}`);
  jReplica.rpcs = [rpcUrl];

  if (phase === 'prepared-crash') {
    // Separate public Anvil deployer avoids invalidating the first adapter's live NonceManager.
    const deployer = ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/1");
    const sibling = await createJAdapter({ mode: 'rpc', chainId: jadapter.chainId, rpcUrl, privateKey: deployer.privateKey });
    await sibling.deployStack();
    enqueueRuntimeInput(env, { runtimeTxs: [{ type: 'importJ', data: { name: 'Nonce sibling', chainId: sibling.chainId,
      ticker: 'ETH', rpcs: [rpcUrl], blockTimeMs: 1000, contracts: { ...sibling.addresses },
      entityProviderDeploymentBlock: sibling.entityProviderDeploymentBlock } }], entityInputs: [] });
    await driveUntil(env, () => Boolean(getLiveJAdapter(env, 'Nonce sibling')), 'same-chain-second-stack-import');
    await sibling.close();
  }

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

  const pendingCrash = phase === 'pending-crash' || phase === 'accepted-crash' || phase === 'prepared-crash';
  if (pendingCrash) await chainControl('evm_setAutomine', [false]);
  const broadcast = jadapter.broadcastPreparedTransaction.bind(jadapter);
  jadapter.broadcastPreparedTransaction = async raw => {
    const txHash = phase === 'prepared-crash' ? ethers.keccak256(raw) : await broadcast(raw);
    const receipt = await jadapter.provider.getTransactionReceipt(txHash);
    const result = { txHash, blockNumber: receipt?.blockNumber ?? 0 };
    if (!pendingCrash && (!receipt || receipt.status !== 1)) fail('rpc-submit-missing-receipt');
    const replica = findReplica(env, sender.id);
    const sentBatch = replica.state.jBatchState?.sentBatch;
    const local = replica.jSubmitState;
    const pending = env.infrastructure?.pendingCommittedJOutbox ?? [];
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
      runtimeTimestamp: env.state.timestamp,
      txHash: result.txHash,
      blockNumber: result.blockNumber ?? 0,
      chainNonce: (await jadapter.getEntityNonce(sender.id)).toString(),
      senderReserve: (await jadapter.getReserves(sender.id, 1)).toString(),
      receiverReserve: (await jadapter.getReserves(receiver.id, 1)).toString(),
      hankoBatchLogCount: await countExactHankoBatchLogs(jadapter, sender.id, sentBatch.batchHash),
    };
    await Bun.write(proofPath, JSON.stringify(proof));
    if (phase === 'accepted-crash' || phase === 'prepared-crash') crashNow();
    if (pendingCrash) return result.txHash;
    crashNow();
  };

  await driveUntil(
    env,
    () => Boolean(env.runtimeMempool?.runtimeTxs.some((tx) => tx.type === 'recordJSubmitResult')),
    'rpc-submit-result-queued',
  );
  if (pendingCrash) {
    await driveUntil(env, () => Boolean(findReplica(env, sender.id).jSubmitState?.txHash), 'pending-result-durable');
    crashNow();
  }
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
  const adapter = getLiveJAdapter(restored, proof.jurisdictionName);
  if (!adapter) fail(`restored-rpc-adapter-missing:${proof.jurisdictionName}`);
  assertEqual(adapter.mode, 'rpc', 'restored-adapter-mode');
  adapter.setQuietLogs?.(true);

  const pendingBefore = restored.infrastructure?.pendingCommittedJOutbox ?? [];
  assertEqual(pendingBefore.length, 1, 'pending-before-reconcile');
  assertEqual(replica.jSubmitState?.submitAttempts, 1, 'submit-attempts-before-reconcile');
  assertEqual(replica.jSubmitState?.lastResultAttemptId, undefined, 'result-before-reconcile');
  assertEqual(replica.state.jBatchState?.sentBatch?.batchHash, proof.batchHash, 'sent-batch-before-reconcile');
  assertEqual(await adapter.getEntityNonce(proof.senderId), 1n, 'chain-nonce-before-reconcile');
  const restoredTimestamp = restored.state.timestamp;
  const nextRetryTimestampBefore = getNextJSubmitRetryTimestamp(restored);
  assertEqual(nextRetryTimestampBefore, null, 'pending-attempt-must-not-schedule-second-attempt');

  await adapter.stopWatchingAndWait?.();
  adapter.startWatching(restored);
  await adapter.pollNow?.();
  await driveUntil(
    restored,
    () => (restored.infrastructure?.pendingCommittedJOutbox?.length ?? 0) === 0 &&
      findReplica(restored, proof.senderId).state.jBatchState?.sentBatch === undefined &&
      findReplica(restored, proof.senderId).state.jBatchState?.entityNonce === proof.entityNonce,
    'authenticated-j-event-applied',
  );
  const reconciledReplica = findReplica(restored, proof.senderId);
  const canonicalHash = computeCanonicalEntityHash(reconciledReplica).hash;
  const finalRuntimeHeight = restored.state.height;
  const finalEntityHeight = reconciledReplica.state.height;
  const finalTimestamp = restored.state.timestamp;
  const retryBackoffAt = proof.lastSubmittedAt + ENTITY_J_SUBMIT_RETRY_MS;
  const resultAttemptId = reconciledReplica.jSubmitState?.lastResultAttemptId;
  assertEqual(resultAttemptId, undefined, 'submit-result-must-not-replace-j-event-authority');
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
  const reopenedAdapter = getLiveJAdapter(reopened, proof.jurisdictionName);
  if (!reopenedAdapter) fail('second-reopen-adapter-missing');
  reopenedAdapter.setQuietLogs?.(true);
  assertEqual(reopened.state.height, finalRuntimeHeight, 'runtime-head-after-second-reopen');
  assertEqual(reopenedReplica.state.height, finalEntityHeight, 'entity-head-after-second-reopen');
  assertEqual(computeCanonicalEntityHash(reopenedReplica).hash, canonicalHash, 'canonical-hash-after-second-reopen');
  assertEqual(reopenedReplica.jSubmitState?.lastResultAttemptId, resultAttemptId, 'result-after-second-reopen');
  assertEqual(reopened.infrastructure?.pendingCommittedJOutbox?.length ?? 0, 0, 'pending-after-second-reopen');
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
    pendingAfter: reopened.infrastructure?.pendingCommittedJOutbox?.length ?? 0,
    submitAttempts: reopenedReplica.jSubmitState?.submitAttempts,
    resultOutcome: reopenedReplica.jSubmitState?.lastResultOutcome ?? null,
    resultAttemptId: reopenedReplica.jSubmitState?.lastResultAttemptId ?? null,
    entityNonce: reopenedReplica.state.jBatchState?.entityNonce,
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

const chainControl = async (method: string, params: unknown[]): Promise<void> => {
  const provider = createXlnJsonRpcProvider(rpcUrl);
  try { await provider.send(method, params); } finally { await provider.destroy(); }
};

const runPendingRecoverPhase = async (): Promise<void> => {
  const proof = JSON.parse(await Bun.file(proofPath).text()) as CrashProof;
  const env = await loadEnvFromDB(runtimeId, seed);
  if (!env) fail('pending-restore-null');
  env.scenarioMode = true;
  const adapter = getLiveJAdapter(env, proof.jurisdictionName);
  if (!adapter) fail('pending-adapter-missing');
  await adapter.stopWatchingAndWait?.();
  adapter.startWatching(env);
  const local = findReplica(env, proof.senderId).jSubmitState;
  const restoredBatch = (env.infrastructure?.pendingCommittedJOutbox ?? []).flatMap(input => input.jTxs)
    .find(tx => tx.type === 'batch' && tx.data.runtimeSubmitAttempt?.attemptId === proof.attemptId);
  const raw = restoredBatch?.type === 'batch' ? restoredBatch.data.runtimeSubmitAttempt?.rawTransaction : undefined;
  assertEqual(raw ? ethers.Transaction.from(raw).hash : local?.txHash, proof.txHash, 'restored-pending-hash');
  if (!local?.lastResultAttemptId) await driveUntil(env, () => Boolean(findReplica(env, proof.senderId).jSubmitState?.lastResultAttemptId), 'restored-accepted-result');
  assertEqual(await adapter.provider.getTransactionReceipt(proof.txHash), null, 'transaction-still-pending');
  if (raw) assertEqual(await adapter.broadcastPreparedTransaction(raw), proof.txHash, 'exact-duplicate-broadcast-hash');
  const priorNonce = await adapter.provider.getTransactionCount(await adapter.signer.getAddress(), 'pending');
  let submitCalls = 0;
  const submit = adapter.submitTx.bind(adapter);
  adapter.submitTx = async (...args) => { submitCalls += 1; return submit(...args); };
  const due = getNextJSubmitRetryTimestamp(env);
  if (due === null) fail('pending-retry-missing');
  env.state.timestamp = due;
  await driveUntil(env, () => (findReplica(env, proof.senderId).jSubmitState?.submitAttempts ?? 0) >= 2
    && findReplica(env, proof.senderId).jSubmitState?.lastResultAt === env.state.timestamp, 'pending-receipt-retry');
  assertEqual(submitCalls, 0, 'no-second-broadcast');
  assertEqual(findReplica(env, proof.senderId).jSubmitState?.txHash, proof.txHash, 'retry-preserves-hash');
  assertEqual(await adapter.provider.getTransactionCount(await adapter.signer.getAddress(), 'pending'), priorNonce, 'sender-nonce-unchanged');
  await chainControl('evm_mine', []);
  await adapter.pollNow?.();
  await driveUntil(env, () => findReplica(env, proof.senderId).state.jBatchState?.entityNonce === proof.entityNonce
    && findReplica(env, proof.senderId).state.jBatchState?.sentBatch === undefined, 'pending-mined-authenticated');
  const receipt = await adapter.provider.getTransactionReceipt(proof.txHash);
  assertEqual(receipt?.status, 1, 'original-receipt-success');
  assertEqual(await adapter.getReserves(proof.senderId, 1), 90n, 'pending-sender-reserve');
  assertEqual(await adapter.getReserves(proof.receiverId, 1), 10n, 'pending-receiver-reserve');
  const logs = await countExactHankoBatchLogs(adapter, proof.senderId, proof.batchHash);
  assertEqual(logs, 1, 'pending-one-economic-operation');
  const canonicalHash = computeCanonicalEntityHash(findReplica(env, proof.senderId)).hash;
  const height = env.state.height;
  await closeEnv(env);
  const reopened = await loadEnvFromDB(runtimeId, seed);
  if (!reopened) fail('pending-second-reopen-null');
  assertEqual(reopened.state.height, height, 'pending-second-reopen-height');
  assertEqual(computeCanonicalEntityHash(findReplica(reopened, proof.senderId)).hash, canonicalHash, 'pending-second-reopen-root');
  assertEqual(reopened.infrastructure?.pendingCommittedJOutbox?.length ?? 0, 0, 'pending-second-reopen-outbox');
  await closeEnv(reopened);
  const result = { txHash: proof.txHash, submitCalls, logs, priorNonce, status: receipt?.status, canonicalHash, height };
  await Bun.write(recoveryPath, safeStringify(result));
  console.info('J_SUBMIT_PENDING_RECOVERY_PROOF', safeStringify(result));
};

const runPreparedNonceRecovery = async (): Promise<void> => {
  const proof = JSON.parse(await Bun.file(proofPath).text()) as CrashProof;
  const env = await loadEnvFromDB(runtimeId, seed);
  if (!env) fail('nonce-restore-null');
  const adapter = getLiveJAdapter(env, proof.jurisdictionName);
  if (!adapter) fail('nonce-adapter-missing');
  const batch = env.infrastructure?.pendingCommittedJOutbox?.flatMap(input => input.jTxs)
    .find(tx => tx.type === 'batch' && tx.data.runtimeSubmitAttempt?.attemptId === proof.attemptId);
  const raw = batch?.type === 'batch' ? batch.data.runtimeSubmitAttempt?.rawTransaction : undefined;
  if (!raw) fail('nonce-prepared-wire-missing');
  const transaction = ethers.Transaction.from(raw);
  assertEqual(await adapter.provider.getTransaction(proof.txHash), null, 'original-not-broadcast');
  const sibling = getLiveJAdapter(env, 'Nonce sibling');
  if (!sibling || sibling.addresses.depository === adapter.addresses.depository) fail('distinct-imported-stack-required');
  assertEqual(sibling.chainId, adapter.chainId, 'same-chain-nonce-domain');
  const observed: number[] = [];
  for (let round = 0; round < 2; round += 1) {
    try {
      await sibling.prepareDurableTransaction(ethers.getBytes(DEFAULT_PRIVATE_KEY), {
        to: sibling.addresses.depository,
        data: sibling.depository.interface.encodeFunctionData('entityNonces', [proof.senderId]), value: 0n,
      }, async prepared => { observed.push(prepared.transactionNonce); return 'rejected'; });
      fail('nonce-rejection-did-not-reject');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('DURABLE_TRANSACTION_ACCEPTANCE_REJECTED')) throw error;
    }
    assertEqual(observed[round], transaction.nonce + 1, 'restored-nonce-reservation-survives-reset');
  }
  await Bun.write(recoveryPath, safeStringify({ reservedNonce: transaction.nonce, observed }));
  await closeEnv(env);
};

if (phase === 'prepared-recover') {
  await runPreparedNonceRecovery();
} else if (phase === 'pending-recover') {
  await runPendingRecoverPhase();
} else if (phase === 'crash' || phase === 'pending-crash' || phase === 'accepted-crash' || phase === 'prepared-crash') {
  await runCrashPhase();
} else {
  await runRecoverPhase();
}
