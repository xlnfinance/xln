import { DEFAULT_PRIVATE_KEY } from '../../../jurisdiction/adapter/kernel/factory';
import { ethers } from 'ethers';
import { createJAdapter, createXlnJsonRpcProvider } from '../../../jurisdiction/adapter';
import {
  closeInfraDb,
  closeRuntimeDb,
  loadEnvFromDB,
  processRuntime,
  enqueueRuntimeInput,
  listPersistedCheckpointHeights,
  readPersistedStorageFrameRecord,
} from '../../../runtime';
import { deriveSignerAddressSync, getSignerPrivateKey } from '../../../account/crypto';
import { getNextJSubmitRetryTimestamp } from '../../../runtime/j-submit/j-submit-scheduler';
import { ENTITY_J_SUBMIT_RETRY_MS } from '../../../entity/consensus/leader';
import { computeCanonicalEntityHash } from '../../../storage/canonical-hash';
import { verifyPersistedFrameState } from '../../../storage/recovery/verify';
import { getJurisdictionIdentityRef } from '../../../jurisdiction/machine/jurisdiction-runtime';
import { ensureLiveJAdapterForReplica } from '../../../runtime/recovery/j-adapter-restore';
import {
  bootScenario,
  fundEntities,
  registerEntities,
  resolveScenarioBoardSigner,
} from '../../../scenarios/harness/boot';
import { processJEvents } from '../../../scenarios/harness/helpers';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import type { JurisdictionConfig } from '../../../entity/types';
import { formatRuntime } from '../../../qa/runtime-ascii';
import { readRuntimeMetadata } from '../../../runtime/loop/loop-environment';
import { safeStringify } from '../../../protocol/serialization';
import type { RuntimeReplica, JAdapter } from '../../../runtime/types';
import {
  getLiveJAdapter,
  getLiveJAdapterEntries,
  detachLiveJAdapter,
} from '../../../runtime/j-submit/live-jadapters';

type Phase = 'crash' | 'recover' | 'pending-crash' | 'pending-recover' | 'accepted-crash' | 'prepared-crash' | 'prepared-recover'
  | 'anchor-crash' | 'anchor-recover';
const PHASES: readonly Phase[] = ['crash', 'recover', 'pending-crash', 'pending-recover', 'accepted-crash', 'prepared-crash',
  'prepared-recover', 'anchor-crash', 'anchor-recover'];

type CrashProof = {
  runtimeId: string;
  jurisdictionName: string;
  jurisdictionRef: string;
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
  /** Runtime frames whose committed record carries a 'j_anchor' (anchored phases only). */
  anchorFrameHeights: number[];
  anchorFinalizedJHeights: Record<string, number>;
  receiverFunding: string;
};

const [requestedPhase, seed, rpcUrl, proofPath, recoveryPath] = Bun.argv.slice(2);
if (!requestedPhase || !seed || !rpcUrl || !proofPath || !recoveryPath) {
  throw new Error('phase, seed, rpcUrl, proofPath and recoveryPath are required');
}
if (!PHASES.some(candidate => candidate === requestedPhase)) {
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

// A fresh lazy Entity starts from the authenticated storage anchor the watcher
// proposes right after import, not from a registration-history scan.
const importLazyEntity = async (
  env: RuntimeReplica,
  jadapter: JAdapter,
  jurisdiction: JurisdictionConfig,
  signerIndex: string,
): Promise<{ id: string; signer: string }> => {
  const signer = resolveScenarioBoardSigner(env, signerIndex);
  const id = generateLazyEntityId([signer], 1n, env).toLowerCase();
  jadapter.registerEntityWallet?.(id, ethers.hexlify(getSignerPrivateKey(env, signer)));
  enqueueRuntimeInput(env, {
    runtimeTxs: [createTestEntityImportRuntimeTx(env, {
      entityId: id,
      signerId: signer,
      data: {
        isProposer: true,
        config: { mode: 'proposer-based', threshold: 1n, validators: [signer], shares: { [signer]: 1n }, jurisdiction },
      },
    })],
    entityInputs: [],
  });
  await processRuntime(env);
  return { id, signer };
};

const readAnchorFrameHeights = async (env: RuntimeReplica): Promise<number[]> => {
  const heights: number[] = [];
  for (let height = 1; height <= env.state.height; height += 1) {
    const frame = await readPersistedStorageFrameRecord(env, height);
    if (frame && safeStringify(frame.runtimeInput).includes('"j_anchor"')) heights.push(height);
  }
  return heights;
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

  const anchored = phase === 'anchor-crash';
  const [sender, receiver] = anchored
    ? [
      await importLazyEntity(env, jadapter, jurisdiction, '1'),
      await importLazyEntity(env, jadapter, jurisdiction, '2'),
    ]
    : await registerEntities(env, jadapter, [
      { name: 'Sender', signer: deriveSignerAddressSync(seed, '1').toLowerCase(), position: { x: -10, y: 0, z: 0 } },
      { name: 'Receiver', signer: deriveSignerAddressSync(seed, '2').toLowerCase(), position: { x: 10, y: 0, z: 0 } },
    ], jurisdiction);
  if (!sender || !receiver) fail('entities-not-registered');
  const anchorFinalizedJHeights: Record<string, number> = {};
  if (anchored) {
    await processJEvents(env);
    await driveUntil(
      env,
      () => [sender, receiver].every(entity => findReplica(env, entity.id).state.jHistoryFinality !== undefined),
      'lazy-entities-anchored',
    );
    for (const entity of [sender, receiver]) {
      anchorFinalizedJHeights[entity.id] = Number(findReplica(env, entity.id).state.lastFinalizedJHeight);
    }
  }
  const anchorFrameHeights = anchored ? await readAnchorFrameHeights(env) : [];
  if (anchored && anchorFrameHeights.length === 0) fail('j-anchor-frame-not-persisted');

  // Anchored receivers hold their own reserve so restore can prove new J-authority work.
  const receiverFunding = anchored ? 50n : 0n;
  await fundEntities(env, jadapter, [
    { id: sender.id, tokenId: 1, amount: 100n },
    ...(anchored ? [{ id: receiver.id, tokenId: 1, amount: receiverFunding }] : []),
  ]);
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
      jurisdictionRef: getJurisdictionIdentityRef(jReplica),
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
      anchorFrameHeights,
      anchorFinalizedJHeights,
      receiverFunding: receiverFunding.toString(),
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

const verifyCommittedRuntimeRoot = async (env: RuntimeReplica): Promise<string> => {
  const frame = await readPersistedStorageFrameRecord(env, env.state.height);
  if (!frame) fail('runtime-frame-missing');
  const verification = verifyPersistedFrameState(env, frame);
  assertEqual(verification.actualStateHash, verification.expectedStateHash, 'runtime-post-state-root');
  assertEqual(verification.actualCanonicalStateHash, verification.expectedCanonicalStateHash, 'runtime-canonical-root');
  return verification.actualStateHash;
};

const runRecoverPhase = async (): Promise<void> => {
  const proof = JSON.parse(await Bun.file(proofPath).text()) as CrashProof;
  assertEqual(proof.runtimeId, runtimeId, 'proof-runtime-id');
  const alternateRpc = new URL(rpcUrl);
  alternateRpc.hostname = 'localhost';
  alternateRpc.search = '?trusted-restore=1';
  const trustedRpcUrl = alternateRpc.toString();
  const restoreOptions = {
    trustedJurisdictionRpcBindings: [{ jurisdictionRef: proof.jurisdictionRef, rpcUrl: trustedRpcUrl }],
  };
  const restored = await loadEnvFromDB(runtimeId, seed, restoreOptions);
  if (!restored) fail('restore-returned-null');
  const checkpointHeightsAtRestore = await listPersistedCheckpointHeights(restored);
  // Recovery's own selection record: the checkpoint it actually restored and the WAL frames it replayed.
  const replayMeta = readRuntimeMetadata(restored, '__replayMeta') as { checkpointHeight: number; replayedFrameCount: number } | undefined;
  if (!replayMeta) fail('replay-meta-missing');
  await verifyCommittedRuntimeRoot(restored);
  assertEqual(restored.state.jReplicas.get(proof.jurisdictionName)?.rpcs?.join(','), rpcUrl, 'first-restore-preserves-rpcs');
  restored.scenarioMode = true;
  restored.quietRuntimeLogs = true;
  const replica = findReplica(restored, proof.senderId);
  const adapter = getLiveJAdapter(restored, proof.jurisdictionName);
  if (!adapter) fail(`restored-rpc-adapter-missing:${proof.jurisdictionName}`);
  assertEqual(adapter.mode, 'rpc', 'restored-adapter-mode');
  assertEqual((adapter.provider as ethers.JsonRpcProvider)._getConnection().url, trustedRpcUrl, 'first-restore-live-rpc');
  adapter.setQuietLogs?.(true);
  // Committed anchor finality is durable state: restore must not fall back to a scan.
  const restoredJHistoryScannedThrough: Record<string, number | null> = {};
  for (const [entityId, height] of Object.entries(proof.anchorFinalizedJHeights)) {
    const anchoredReplica = findReplica(restored, entityId);
    if (anchoredReplica.state.jHistoryFinality === undefined) fail(`restored-anchor-finality-missing:${entityId}`);
    assertEqual(Number(anchoredReplica.state.lastFinalizedJHeight) >= height, true, `restored-anchor-height:${entityId}`);
    restoredJHistoryScannedThrough[entityId] = anchoredReplica.jHistory?.scannedThroughHeight ?? null;
  }

  const pendingBefore = restored.infrastructure?.pendingCommittedJOutbox ?? [];
  assertEqual(pendingBefore.length, 1, 'pending-before-reconcile');
  assertEqual(replica.jSubmitState?.submitAttempts, 1, 'submit-attempts-before-reconcile');
  assertEqual(replica.jSubmitState?.lastResultAttemptId, undefined, 'result-before-reconcile');
  assertEqual(replica.state.jBatchState?.sentBatch?.batchHash, proof.batchHash, 'sent-batch-before-reconcile');
  assertEqual(await adapter.getEntityNonce(proof.senderId), 1n, 'chain-nonce-before-reconcile');
  const restoredTimestamp = restored.state.timestamp;
  const nextRetryTimestampBefore = getNextJSubmitRetryTimestamp(restored);
  assertEqual(nextRetryTimestampBefore, null, 'pending-attempt-must-not-schedule-second-attempt');

  // J authority restored from committed anchor state admits new reserve work
  // before any watcher scan applies the mined batch: the sender still holds it.
  let receiverAdmissionFrames: number | null = null;
  if (Object.keys(proof.anchorFinalizedJHeights).length > 0) {
    const committedJState = () => {
      const senderState = findReplica(restored, proof.senderId).state;
      const receiverState = findReplica(restored, proof.receiverId).state;
      return {
        senderEntityNonce: senderState.jBatchState?.entityNonce,
        senderReserve: senderState.reserves.get(1),
        receiverReserve: receiverState.reserves.get(1),
      };
    };
    const before = committedJState();
    // initJBatch leaves entityNonce absent until the first J event; j_broadcast reads it as `?? 0`.
    assertEqual(before.senderEntityNonce ?? 0, proof.entityNonce - 1, 'restored-sender-committed-entity-nonce');
    assertEqual(before.senderReserve, 100n, 'restored-sender-committed-reserve');
    assertEqual(before.receiverReserve, BigInt(proof.receiverFunding), 'restored-receiver-committed-reserve');
    const receiverReplica = findReplica(restored, proof.receiverId);
    const heightBefore = receiverReplica.state.height;
    await processRuntime(restored, [{
      entityId: proof.receiverId,
      signerId: receiverReplica.signerId,
      entityTxs: [{ type: 'r2r', data: { toEntityId: proof.senderId, tokenId: 1, amount: 5n } }],
    }]);
    await driveUntil(
      restored,
      () => (findReplica(restored, proof.receiverId).state.jBatchState?.batch.reserveToReserve.length ?? 0) === 1,
      'restored-anchor-r2r-admitted',
    );
    const admitted = findReplica(restored, proof.receiverId).state.jBatchState?.batch.reserveToReserve[0];
    assertEqual(admitted?.receivingEntity.toLowerCase(), proof.senderId.toLowerCase(), 'restored-r2r-receiving-entity');
    assertEqual(admitted?.tokenId, 1, 'restored-r2r-token');
    assertEqual(admitted?.amount, 5n, 'restored-r2r-amount');
    // Queuing moves no money and no nonce: only the authenticated J event may.
    const after = committedJState();
    assertEqual(after.senderEntityNonce, before.senderEntityNonce, 'r2r-admission-sender-entity-nonce-unchanged');
    assertEqual(after.senderReserve, before.senderReserve, 'r2r-admission-sender-reserve-unchanged');
    assertEqual(after.receiverReserve, before.receiverReserve, 'r2r-admission-receiver-reserve-unchanged');
    assertEqual(findReplica(restored, proof.senderId).state.jBatchState?.sentBatch?.batchHash, proof.batchHash,
      'r2r-admitted-before-j-event');
    assertEqual(restored.infrastructure?.pendingCommittedJOutbox?.length ?? 0, 1, 'r2r-admitted-before-reconcile');
    receiverAdmissionFrames = findReplica(restored, proof.receiverId).state.height - heightBefore;
  }

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
  const runtimeHash = await verifyCommittedRuntimeRoot(restored);
  const finalRuntimeHeight = restored.state.height;
  const finalEntityHeight = reconciledReplica.state.height;
  const finalTimestamp = restored.state.timestamp;
  const retryBackoffAt = proof.lastSubmittedAt + ENTITY_J_SUBMIT_RETRY_MS;
  const resultAttemptId = reconciledReplica.jSubmitState?.lastResultAttemptId;
  if (receiverAdmissionFrames === null) {
    assertEqual(resultAttemptId, undefined, 'submit-result-must-not-replace-j-event-authority');
  } else {
    // The pre-poll admission frame re-read the exact mined wire: an observer-only
    // 'submitted' result. sentBatch/entityNonce still advanced only via the J event.
    assertEqual(resultAttemptId, proof.attemptId, 'pre-poll-result-exact-attempt');
    assertEqual(reconciledReplica.jSubmitState?.lastResultOutcome, 'submitted', 'submit-result-must-not-replace-j-event-authority');
    assertEqual(reconciledReplica.jSubmitState?.txHash, proof.txHash, 'pre-poll-result-exact-wire');
  }
  assertEqual(reconciledReplica.jSubmitState?.submitAttempts, 1, 'no-second-submit-attempt');
  if (finalTimestamp >= retryBackoffAt) {
    fail(`reconcile-waited-for-backoff:backoffAt=${retryBackoffAt}:actual=${finalTimestamp}`);
  }
  assertEqual(await adapter.getEntityNonce(proof.senderId), 1n, 'chain-nonce-after-reconcile');
  assertEqual(await adapter.getReserves(proof.senderId, 1), 90n, 'sender-reserve-after-reconcile');
  const receiverReserve = 10n + BigInt(proof.receiverFunding);
  assertEqual(await adapter.getReserves(proof.receiverId, 1), receiverReserve, 'receiver-reserve-after-reconcile');
  assertEqual(
    await countExactHankoBatchLogs(adapter, proof.senderId, proof.batchHash),
    1,
    'hanko-log-count-after-reconcile',
  );
  await closeEnv(restored);

  const reopened = await loadEnvFromDB(runtimeId, seed, restoreOptions);
  if (!reopened) fail('second-reopen-returned-null');
  assertEqual(await verifyCommittedRuntimeRoot(reopened), runtimeHash, 'runtime-root-after-second-reopen');
  assertEqual(reopened.state.jReplicas.get(proof.jurisdictionName)?.rpcs?.join(','), rpcUrl, 'second-restore-preserves-rpcs');
  reopened.scenarioMode = true;
  reopened.quietRuntimeLogs = true;
  const reopenedReplica = findReplica(reopened, proof.senderId);
  const initialAdapter = getLiveJAdapter(reopened, proof.jurisdictionName);
  if (!initialAdapter) fail('second-reopen-adapter-missing');
  await initialAdapter.close();
  (initialAdapter.provider as ethers.JsonRpcProvider).destroy();
  detachLiveJAdapter(reopened, proof.jurisdictionName, initialAdapter);
  const reopenedAdapter = await ensureLiveJAdapterForReplica(reopened, proof.jurisdictionName);
  if (!reopenedAdapter) fail('second-reopen-adapter-missing');
  assertEqual((reopenedAdapter.provider as ethers.JsonRpcProvider)._getConnection().url, trustedRpcUrl, 'recreated-live-rpc');
  assertEqual(await verifyCommittedRuntimeRoot(reopened), runtimeHash, 'recreated-adapter-preserves-runtime-root');
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
    runtimeHash,
    trustedRpcUrl,
    committedRpcUrl: reopened.state.jReplicas.get(proof.jurisdictionName)?.rpcs?.[0],
    chainNonce: (await reopenedAdapter.getEntityNonce(proof.senderId)).toString(),
    senderReserve: (await reopenedAdapter.getReserves(proof.senderId, 1)).toString(),
    receiverReserve: (await reopenedAdapter.getReserves(proof.receiverId, 1)).toString(),
    hankoBatchLogCount: finalHankoBatchLogCount,
    anchorFrameHeights: proof.anchorFrameHeights,
    checkpointHeightsAtRestore,
    selectedCheckpointHeight: replayMeta.checkpointHeight,
    replayedFrameCount: replayMeta.replayedFrameCount,
    restoredJHistoryScannedThrough,
    receiverAdmissionFrames,
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
} else if (phase === 'crash' || phase === 'pending-crash' || phase === 'accepted-crash' || phase === 'prepared-crash'
  || phase === 'anchor-crash') {
  await runCrashPhase();
} else {
  await runRecoverPhase();
}
