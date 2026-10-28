import { handleJRebroadcast } from '../../../../entity/tx/handlers/j-batch/j-rebroadcast';
import { validateRuntimeAdapterWireMessage } from '../../../../api/runtime-adapter/wire-schema';
import { XLN_PROTOCOL_VERSION } from '../../../../protocol/version';
import { requestBatchSpeedUp } from '../../../../../ui/src/runtime/financial/batch-fees';
import type { JFeeQuote } from '../../../../runtime/j-submit/evm/evm-replacement';
import { EmbeddedRuntimeAdapter } from '../../../../api/runtime-adapter/embedded';
import { beginJPreparation } from '../../../../runtime/j-submit/preparation-driver';
import { encodeBuffer, decodeBuffer } from '../../../../storage/codec/codec';
import { buildStorageRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../../../../storage/wal/snapshot';
import { validateDurableRuntimeMachineSnapshot } from '../../../../storage/wal/runtime-machine-schema';
import { validateRuntimeTx } from '../../../../runtime/decode/runtime-tx';
import { authorizeEvmFeeLimits, authorizedEvmFeeLimits, initialEvmFeeLimits } from '../../../../runtime/j-submit/evm/evm-fee-authorization';
import { safeParse, safeStringify } from '../../../../protocol/serialization';
import { prepareEvmFeeReplacement } from '../../../../runtime/j-submit/evm/evm-replacement';
import { resolveRuntimeAdapterRead } from '../../../../api/runtime-adapter/resolve';
import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { encodeJBatch, computeBatchHankoHash } from '../../../../jurisdiction/machine/batch';
import { Depository__factory, EntityProvider__factory } from '../../../../../jurisdictions/typechain-types';
import { buildJSubmitAttemptId, registerPendingCommittedJOutbox, makeJSubmitResultRuntimeTx } from '../../../../runtime/j-submit/j-submit-state';
import { validateJInputs } from '../../../../storage/wal/runtime-machine-schema/j';
import { collectDueJSubmitRuntimeTxs } from '../../../../runtime/j-submit/j-submit-scheduler';

import { applyRuntimeTx } from '../../../../runtime/tx/tx-handlers';
import { submitRuntimeJOutbox } from '../../../../runtime/j-submit/j-submit';
import { ensureRuntimeInfrastructure } from '../../../../runtime/envelope/replica-envelope';
import type { RuntimeReplica, RuntimeTx } from '../../../../runtime/types';
import type { JAdapter } from '../../../../jurisdiction/adapter/types';
import {
  commitJSubmitAttempt,
  jurisdictionName,
} from '../../../fixtures/jurisdiction/j-submit-durability-fixture';

const payer = new ethers.Wallet(`0x${'21'.repeat(32)}`);

const signedWire = async (): Promise<{ raw: string; txHash: string }> => {
  const raw = await payer.signTransaction({
    type: 2,
    chainId: 31_337,
    nonce: 7,
    to: `0x${'22'.repeat(20)}`,
    data: '0x',
    value: 0n,
    gasLimit: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });
  return { raw, txHash: ethers.keccak256(raw) };
};

type PreparedProvider = Partial<Record<
  'getTransactionReceipt' | 'getTransaction' | 'waitForTransaction' | 'getBlock',
  (...args: unknown[]) => Promise<unknown>
>>;

const preparedAttempt = async (provider: PreparedProvider, adapterExtra: Record<string, unknown> = {}) => {
  const fixture = await commitJSubmitAttempt();
  const batch = fixture.jOutbox[0]?.jTxs[0];
  if (batch?.type !== 'batch' || !batch.data.runtimeSubmitAttempt) throw new Error('prepared fixture missing');
  const wire = await signedWire();
  batch.data.runtimeSubmitAttempt.rawTransaction = wire.raw;
  batch.data.runtimeSubmitAttempt.evmFeeLimits = initialEvmFeeLimits(wire.raw);
  installAdapter(fixture.env, {
    mode: 'rpc',
    pollNow: async () => {},
    signer: payer,
    depository: Depository__factory.connect(`0x${'22'.repeat(20)}`, payer),
    entityProvider: EntityProvider__factory.connect(`0x${'23'.repeat(20)}`, payer),
    provider: { getFeeData: async () => ({ maxFeePerGas: 4n, maxPriorityFeePerGas: 2n }), ...provider },
    broadcastPreparedTransaction: async () => wire.txHash,
    ...adapterExtra,
  } as unknown as JAdapter);
  return { ...fixture, ...wire };
};

const installAdapter = (env: RuntimeReplica, adapter: JAdapter): void => {
  env.state.jReplicas = new Map([[jurisdictionName, {
    name: jurisdictionName,
    chainId: 31337,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  }]]);
  ensureRuntimeInfrastructure(env).liveJAdapters = new Map([[jurisdictionName, adapter]]);
};

const submit = async (env: RuntimeReplica, jOutbox: Awaited<ReturnType<typeof commitJSubmitAttempt>>['jOutbox']) => {
  const queued: RuntimeTx[] = [];
  await submitRuntimeJOutbox(env, jOutbox, {
    enqueueRuntimeInputs: (_target, _inputs, runtimeTxs) => queued.push(...(runtimeTxs ?? [])),
  });
  return queued;
};

describe('prepared J batch wire reconciliation', () => {
  test('an unrecognised JSON-RPC read error is retried, never a terminal quarantine', async () => {
    // ethers maps a node's "header not found" to UNKNOWN_ERROR; the generic
    // classifier defaulted it to terminal and quarantined the signed batch.
    const coalesced = Object.assign(new Error('could not coalesce error'), {
      code: 'UNKNOWN_ERROR',
      info: { error: { code: -32_000, message: 'header not found' } },
    });
    const { env, replica, jOutbox, txHash } = await preparedAttempt({
      getTransactionReceipt: async () => { throw coalesced; },
    });

    const queued = await submit(env, jOutbox);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'recordJSubmitResult',
      data: {
        outcome: 'transientFailure',
        txHash,
        adapterFailure: { category: 'transient', code: 'J_PREPARED_CHAIN_READ_UNAVAILABLE' },
      },
    });
    await applyRuntimeTx(env, queued[0]!, { isReplay: true });
    expect(replica.jSubmitState?.terminalFailure).toBeUndefined();
    expect(env.infrastructure?.pendingCommittedJOutbox).toHaveLength(1);
  });

  test('a reverted receipt is terminal only once its block is behind the finality depth', async () => {
    // On EVM the adapter's safe head is the latest block, so `head >= receipt`
    // always held and an unfinalized revert quarantined a batch a reorg could include.
    const blockHash = `0x${'a7'.repeat(32)}`;
    const outcomeAtHead = async (head: number) => {
      const { env, jOutbox, txHash } = await preparedAttempt({
        getTransactionReceipt: async () => ({ hash: txHash, status: 0, blockNumber: 100, blockHash }),
        getBlock: async () => ({ hash: blockHash }),
      }, { getCurrentBlockNumber: async () => head, getFinalityDepth: () => 12 });
      const [result] = await submit(env, jOutbox);
      return result?.type === 'recordJSubmitResult' ? result.data : null;
    };

    expect(await outcomeAtHead(105)).toMatchObject({
      outcome: 'transientFailure',
      adapterFailure: { category: 'transient', code: 'J_PREPARED_RECEIPT_REVERTED_AWAITING_FINALITY' },
    });
    expect(await outcomeAtHead(112)).toMatchObject({
      outcome: 'terminalFailure',
      message: 'transaction reverted',
    });
  });

  test('a broadcast never waits for mining under the Runtime frame writer', async () => {
    // Waiting up to 10 s for one confirmation stalled every frame (payments,
    // ACKs) on a 12 s-block chain although the receipt only serves observers.
    const calls = { broadcast: 0, wait: 0 };
    const { env, replica, jOutbox, txHash } = await preparedAttempt({
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
      waitForTransaction: async () => {
        calls.wait += 1;
        return null;
      },
    }, {
      broadcastPreparedTransaction: async () => {
        calls.broadcast += 1;
        return txHash;
      },
    });

    const queued = await submit(env, jOutbox);

    expect(calls).toEqual({ broadcast: 1, wait: 0 });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'recordJSubmitResult',
      data: {
        outcome: 'transientFailure',
        txHash,
        adapterFailure: { category: 'transient', code: 'J_SUBMIT_TRANSACTION_NOT_MINED' },
      },
    });
    // Exactly one result owns the attempt and the signed wire stays the only
    // pending copy, so the next retry rebroadcasts these same bytes.
    await applyRuntimeTx(env, queued[0]!, { isReplay: true });
    expect(replica.jSubmitState?.txHash).toBe(txHash);
    expect(env.infrastructure?.pendingCommittedJOutbox).toHaveLength(1);
    expect(await submit(env, jOutbox)).toEqual([]);
  });
});

test('review 5: an aged pending EVM wire receives a durable fee replacement', async () => {
  const { env, jOutbox } = await preparedAttempt({
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: null, nonce: 7, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
  });
  env.state.timestamp += 3_600_000;
  const queued = await submit(env, jOutbox);
  expect(queued.some(tx => tx.type === 'replaceJPreparedTransaction')).toBe(true);
});

const canonicalAttempt = async () => {
  const fixture = await preparedAttempt({ getTransactionReceipt: async () => null, getTransaction: async () => null });
  const batch = fixture.jOutbox[0]!.jTxs[0]!;
  if (batch.type !== 'batch' || !batch.data.runtimeSubmitAttempt) throw new Error('batch missing');
  const address = `0x${'22'.repeat(20)}`;
  fixture.env.state.jReplicas.get(jurisdictionName)!.contracts = { depository: address } as never;
  batch.data.encodedBatch = encodeJBatch(batch.data.batch);
  batch.data.batchHash = computeBatchHankoHash(31337, address, batch.data.encodedBatch, BigInt(batch.data.entityNonce!));
  batch.data.hankoSignature = payer.signingKey.sign(batch.data.batchHash).serialized;
  const attempt = batch.data.runtimeSubmitAttempt;
  attempt.attemptId = buildJSubmitAttemptId({ jurisdictionName, entityId: batch.entityId, signerId: batch.data.signerId!,
    entityNonce: batch.data.entityNonce!, batchGeneration: batch.data.batchGeneration!, batchHash: batch.data.batchHash,
    attemptNumber: attempt.attemptNumber });
  fixture.replica.jSubmitState!.batchHash = batch.data.batchHash;
  Object.assign(fixture.replica.state.jBatchState!.sentBatch!, { batchHash: batch.data.batchHash, encodedBatch: batch.data.encodedBatch });
  fixture.replica.hankoWitness!.set(batch.data.batchHash, { hanko: batch.data.hankoSignature, type: 'jBatch', entityHeight: 1, createdAt: 1000 });
  const data = Depository__factory.createInterface().encodeFunctionData('processBatch', [batch.data.encodedBatch, batch.data.hankoSignature, batch.data.entityNonce]);
  const raw = await payer.signTransaction({ type: 2, chainId: 31337, nonce: 7, to: address, data, gasLimit: 500000n,
    maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  attempt.rawTransaction = raw;
  return { ...fixture, batch, attempt, raw };
};

test('replacement fsync boundary retains every signed sibling through replay and retry', async () => {
  const { env, replica, jOutbox, batch, attempt, raw } = await canonicalAttempt();
  env.state.timestamp += 180000;
  const [tx] = await submit(env, jOutbox);
  if (tx?.type !== 'replaceJPreparedTransaction') throw new Error('replacement missing');
  // Crash before the queued Runtime input commits leaves only the old wire.
  expect(attempt.rawTransaction).toBe(raw);
  const recoveredInputs = structuredClone(env.infrastructure!.pendingCommittedJOutbox);
  const emitted = await applyRuntimeTx(env, tx, { isReplay: true });
  expect(attempt.competingTransactions).toEqual([raw]);
  expect(attempt.rawTransaction).toBe(tx.data.rawTransaction);
  expect(emitted).toHaveLength(1);
  expect(await applyRuntimeTx(env, tx, { isReplay: true })).toEqual([]);
  // Crash after WAL but before broadcast reconstructs the same wire set.
  const committed = structuredClone(env.infrastructure!.pendingCommittedJOutbox);
  expect(() => validateJInputs(committed, 'RECOVERY')).not.toThrow();
  env.infrastructure!.pendingCommittedJOutbox = recoveredInputs;
  await applyRuntimeTx(env, tx, { isReplay: true });
  expect(env.infrastructure!.pendingCommittedJOutbox).toEqual(committed);
  const recovered = env.infrastructure!.pendingCommittedJOutbox![0]!.jTxs[0]!;
  if (recovered.type !== 'batch') throw new Error('recovered batch missing');
  await applyRuntimeTx(env, makeJSubmitResultRuntimeTx(recovered, jurisdictionName, 'transientFailure', { message: 'pending' }), { isReplay: true });
  env.state.timestamp += 60000;
  const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
  if (!retry) throw new Error('retry missing');
  const next = await applyRuntimeTx(env, retry, { isReplay: true });
  registerPendingCommittedJOutbox(env, next);
  const successor = next[0]!.jTxs[0]!;
  expect(successor.type === 'batch' && successor.data.runtimeSubmitAttempt).toMatchObject({
    rawTransaction: tx.data.rawTransaction, competingTransactions: [raw] });
  expect(replica.jSubmitState!.submitAttempts).toBe(2);
  expect(batch.data.entityNonce).toBe(1);
});

test('a response approaching its on-chain response deadline bumps before the age threshold', async () => {
  const { env, replica, jOutbox, batch } = await canonicalAttempt();
  const account = [...replica.state.accounts.values()][0];
  // Build only the current account envelope read by deadline selection.
  const counterentity = `0x${'77'.repeat(32)}`;
  replica.state.accounts.set(counterentity, { ...account, state: { ...account?.state,
    leftEntity: replica.entityId, disputeConfig: { leftResponseSeconds: 90, rightResponseSeconds: 3600 } },
    activeDispute: { observedOnChain: true, disputeStartTimestamp: 0, disputeTimeout: 90 } } as never);
  batch.data.batch.counterDisputes.push({ counterentity } as never);
  env.state.timestamp += 31000;
  const queued = await submit(env, jOutbox);
  expect(queued.some(tx => tx.type === 'replaceJPreparedTransaction')).toBe(true);
});

for (const winner of ['original', 'replacement']) test(`receipt from ${winner} wins after recovery, without rebroadcasting siblings`, async () => {
  let broadcasts = 0;
  const original = await signedWire();
  const next = ethers.Transaction.from(original.raw);
  next.signature = null; next.maxFeePerGas = 4n; next.maxPriorityFeePerGas = 2n;
  const replacement = await payer.signTransaction(next);
  const hash = winner === 'original' ? original.txHash : ethers.keccak256(replacement);
  const { env, jOutbox } = await preparedAttempt({
    getTransactionReceipt: async requested => requested === hash ? { hash, status: 1, blockNumber: 100, blockHash: `0x${'ab'.repeat(32)}`, index: 0, logs: [] } : null,
  }, { broadcastPreparedTransaction: async () => { broadcasts++; return hash; } });
  const batch = jOutbox[0]!.jTxs[0]!;
  if (batch.type !== 'batch' || !batch.data.runtimeSubmitAttempt) throw new Error('batch missing');
  batch.data.runtimeSubmitAttempt.rawTransaction = replacement;
  batch.data.runtimeSubmitAttempt.competingTransactions = [original.raw];
  const queued = await submit(env, jOutbox);
  expect(queued[0]).toMatchObject({ type: 'recordJSubmitResult', data: { outcome: 'submitted', txHash: hash } });
  expect(broadcasts).toBe(0);
});

test('one-click rebroadcast keeps the original payer nonce across the Entity generation change', async () => {
  const { env, replica, batch, raw } = await canonicalAttempt();
  await applyRuntimeTx(env, makeJSubmitResultRuntimeTx(batch, jurisdictionName, 'transientFailure', { message: 'pending' }), { isReplay: true });
  replica.state.jBatchState!.broadcastCount += 1;
  replica.state.jBatchState!.sentBatch!.feeOverrides = { gasBumpBps: 1000 };
  // The rebroadcast frame registers its outbox before the Runtime retry frame.
  registerPendingCommittedJOutbox(env, []);
  expect(env.infrastructure!.pendingCommittedJOutbox).toHaveLength(1);
  env.state.timestamp += 60000;
  const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
  if (!retry) throw new Error('manual retry missing');
  const next = await applyRuntimeTx(env, retry, { isReplay: true });
  registerPendingCommittedJOutbox(env, next);
  const [replacement] = await submit(env, next);
  expect(replacement).toMatchObject({ type: 'replaceJPreparedTransaction' });
  if (replacement?.type !== 'replaceJPreparedTransaction') throw new Error('manual replacement missing');
  expect(ethers.Transaction.from(replacement.data.rawTransaction).nonce).toBe(ethers.Transaction.from(raw).nonce);
  expect(ethers.Transaction.from(replacement.data.rawTransaction).data).toBe(ethers.Transaction.from(raw).data);
});

test('fee RPC failure is retryable and never quarantines the signed wire', async () => {
  const { env, jOutbox } = await preparedAttempt({ getTransactionReceipt: async () => null }, {
    provider: { getTransactionReceipt: async () => null, getFeeData: async () => { throw new Error('execution reverted while reading fee data'); } },
  });
  env.state.timestamp += 180000;
  const [result] = await submit(env, jOutbox);
  expect(result).toMatchObject({ type: 'recordJSubmitResult', data: { outcome: 'transientFailure' } });
});

test('market age alone does not replace a sufficiently priced transaction', async () => {
  const { env, jOutbox } = await preparedAttempt({ getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: null }) }, {
    provider: { getTransactionReceipt: async () => null, getTransaction: async () => ({ blockNumber: null }),
      getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }) },
  });
  env.state.timestamp += 3600000;
  const queued = await submit(env, jOutbox);
  expect(queued.some(tx => tx.type === 'replaceJPreparedTransaction')).toBe(false);
  expect(queued[0]).toMatchObject({ type: 'recordJSubmitResult', data: { outcome: 'transientFailure' } });
});

test('successive fee bumps retain original and intermediate hashes in the current WAL schema', async () => {
  const { env, jOutbox, attempt, raw } = await canonicalAttempt();
  env.state.timestamp += 180000;
  const [first] = await submit(env, jOutbox);
  if (first?.type !== 'replaceJPreparedTransaction') throw new Error('first bump missing');
  await applyRuntimeTx(env, first, { isReplay: true });
  // A second explicit owner action can replace an already replaced wire.
  const batch = jOutbox[0]!.jTxs[0]!;
  if (batch.type !== 'batch') throw new Error('batch missing');
  batch.data.feeOverrides = { gasBumpBps: 2000 };
  const [second] = await submit(env, jOutbox);
  if (second?.type !== 'replaceJPreparedTransaction') throw new Error('second bump missing');
  await applyRuntimeTx(env, second, { isReplay: true });
  expect(attempt.competingTransactions).toEqual([raw, first.data.rawTransaction]);
  expect(attempt.rawTransaction).toBe(second.data.rawTransaction);
  expect(() => validateJInputs(env.infrastructure!.pendingCommittedJOutbox, 'MULTI_REPLACEMENT')).not.toThrow();
});


test('both wallets read the same committed fee quote and reject historical substitution', async () => {
  const { env, batch } = await canonicalAttempt();
  const quote = await resolveRuntimeAdapterRead({ env }, 'j-fee', { entityId: batch.entityId });
  expect(quote).toMatchObject({ currentMaxFeeWei: '2', currentPriorityFeeWei: '1', suggestedMaxFeeWei: '4',
    suggestedPriorityFeeWei: '2', deadline: null });
  await expect(resolveRuntimeAdapterRead({ env }, 'j-fee', { entityId: batch.entityId, atHeight: 1 })).rejects.toThrow('current committed wire');
});

test('node underpriced feedback bumps again without treating an unaccepted sibling as the node minimum', async () => {
  const { env, replica, batch, attempt, jOutbox } = await canonicalAttempt();
  const transaction = ethers.Transaction.from(attempt.rawTransaction!);
  transaction.signature = null; transaction.maxFeePerGas = 100n; transaction.maxPriorityFeePerGas = 10n;
  attempt.rawTransaction = await payer.signTransaction(transaction);
  attempt.evmFeeLimits = initialEvmFeeLimits(attempt.rawTransaction);
  const adapter = env.infrastructure!.liveJAdapters!.get(jurisdictionName)!;
  Object.assign(adapter, { broadcastPreparedTransaction: async (raw: string) => ethers.keccak256(raw) });
  Object.assign(adapter.provider, { getFeeData: async () => ({ maxFeePerGas: 105n, maxPriorityFeePerGas: 11n }) });
  env.state.timestamp += 180000;
  const [first] = await submit(env, jOutbox);
  if (first?.type !== 'replaceJPreparedTransaction') throw new Error('first bump missing');
  await applyRuntimeTx(env, first, { isReplay: true });
  const hash = ethers.keccak256(first.data.rawTransaction);
  const message = 'replacement transaction underpriced';
  await applyRuntimeTx(env, makeJSubmitResultRuntimeTx(batch, jurisdictionName, 'transientFailure', {
    txHash: hash, message, adapterFailure: { category: 'transient', code: 'REPLACEMENT_UNDERPRICED', message },
  }), { isReplay: true });
  env.state.timestamp += 60000;
  const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
  if (!retry) throw new Error('retry missing');
  const next = await applyRuntimeTx(env, retry, { isReplay: true });
  registerPendingCommittedJOutbox(env, next);
  const [second] = await submit(env, next);
  if (second?.type !== 'replaceJPreparedTransaction') throw new Error('node-required bump missing');
  const bumped = ethers.Transaction.from(second.data.rawTransaction);
  expect(bumped.maxFeePerGas).toBeGreaterThanOrEqual(125n);
  expect(bumped.maxPriorityFeePerGas).toBeGreaterThanOrEqual(13n);
  const emitted = await applyRuntimeTx(env, second, { isReplay: true });
  const broadcast = await submit(env, emitted);
  // The failure named the previous hash: it cannot force an endless bump loop.
  expect(broadcast[0]).toMatchObject({ type: 'recordJSubmitResult', data: { outcome: 'transientFailure' } });
  expect(replica.jSubmitState!.txHash).toBe(hash);
});


for (const restart of [false, true]) test(`q57: repeated fresh underpriced feedback stops at payer caps (restart=${restart})`, async () => {
  const { env, replica, batch, attempt } = await canonicalAttempt();
  const limits = { maxFeePerGasWei: '4', maxPriorityFeePerGasWei: '3' };
  Object.assign(attempt, { evmFeeLimits: limits });
  const adapter = env.infrastructure!.liveJAdapters!.get(jurisdictionName)!;
  Object.assign(adapter.provider, { getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }) });
  let current = batch;
  for (let index = 0; index < 5; index++) {
    const pending = current.data.runtimeSubmitAttempt!;
    Object.assign(replica.jSubmitState!, { txHash: ethers.keccak256(pending.rawTransaction!),
      lastFailure: { message: 'replacement transaction underpriced' } });
    const tx = await prepareEvmFeeReplacement(env, adapter, jurisdictionName, current);
    if (index >= 2) {
      expect(tx).toBeNull();
      continue;
    }
    if (tx?.type !== 'replaceJPreparedTransaction') throw new Error('authorized replacement missing');
    await applyRuntimeTx(env, tx, { isReplay: true });
    if (restart) {
      restoreFeeAttempt(env);
      const restored = env.infrastructure!.pendingCommittedJOutbox!;
      const recovered = restored[0]!.jTxs[0]!;
      if (recovered.type !== 'batch') throw new Error('recovered batch missing');
      current = recovered;
      expect(current.data.runtimeSubmitAttempt).toMatchObject({ evmFeeLimits: limits });
    }
  }
  expect(ethers.Transaction.from(current.data.runtimeSubmitAttempt!.rawTransaction!).maxFeePerGas).toBe(4n);
  expect(ethers.Transaction.from(current.data.runtimeSubmitAttempt!.rawTransaction!).maxPriorityFeePerGas).toBe(3n);
});


for (const limits of [
  { maxFeePerGasWei: '3', maxPriorityFeePerGasWei: '3' },
  { maxFeePerGasWei: '100', maxPriorityFeePerGasWei: '2' },
]) test(`q57: each absolute ceiling stops signing independently: ${safeStringify(limits)}`, async () => {
  const { env, replica, batch, attempt } = await canonicalAttempt();
  attempt.evmFeeLimits = limits;
  const adapter = env.infrastructure!.liveJAdapters!.get(jurisdictionName)!;
  Object.assign(adapter.provider, { getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }) });
  Object.assign(replica.jSubmitState!, { txHash: ethers.keccak256(attempt.rawTransaction!), lastFailure: { message: 'replacement transaction underpriced' } });
  const first = await prepareEvmFeeReplacement(env, adapter, jurisdictionName, batch);
  if (first?.type !== 'replaceJPreparedTransaction') throw new Error('first bump missing');
  await applyRuntimeTx(env, first, { isReplay: true });
  Object.assign(replica.jSubmitState!, { txHash: ethers.keccak256(attempt.rawTransaction!) });
  batch.data.feeOverrides = { gasBumpBps: 2000 };
  let signatures = 0;
  Object.assign(adapter, { signer: { getAddress: () => payer.getAddress(), signTransaction: async () => { signatures++; throw new Error('over-cap signing'); } } });
  expect(await prepareEvmFeeReplacement(env, adapter, jurisdictionName, batch)).toBeNull();
  expect(signatures).toBe(0);
});

test('unsigned fee requests cannot raise wire ceilings; only the exact payer authorization can', async () => {
  const { env, batch, attempt, raw } = await canonicalAttempt();
  delete attempt.rawTransaction; delete attempt.evmFeeLimits;
  const record: RuntimeTx = { type: 'recordJPreparedTransaction', data: { jurisdictionName, attemptId: attempt.attemptId, rawTransaction: raw } };
  await applyRuntimeTx(env, record, { isReplay: true });
  expect(attempt.evmFeeLimits).toEqual({ maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '1' });
  const limits = { maxFeePerGasWei: '4', maxPriorityFeePerGasWei: '3' };
  const auth = await authorizeEvmFeeLimits(payer, jurisdictionName, attempt.attemptId, raw, limits);
  if (auth.type !== 'recordJPreparedTransaction' || !auth.data.feeAuthorization) throw new Error('authorization missing');
  for (const changed of [
    { ...auth.data.feeAuthorization, maxFeePerGasWei: '5' },
    { ...auth.data.feeAuthorization, signature: (await new ethers.Wallet(`0x${'23'.repeat(32)}`).signMessage('wrong payer')).toLowerCase() },
  ]) {
    await expect(applyRuntimeTx(env, { ...auth, data: { ...auth.data, feeAuthorization: changed } }, { isReplay: true })).rejects.toThrow('EVM_FEE_AUTHORIZATION_PAYER');
    expect(attempt.evmFeeLimits).toEqual({ maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '1' });
  }
  const decoded = validateRuntimeTx(safeParse(safeStringify(auth)), 'Q57_AUTHORIZATION_WAL');
  await applyRuntimeTx(env, decoded, { isReplay: true });
  expect(attempt.evmFeeLimits).toEqual(limits);
  await applyRuntimeTx(env, record, { isReplay: true });
  expect(attempt.evmFeeLimits).toEqual(limits);
  expect(batch.data.runtimeSubmitAttempt!.competingTransactions).toBeUndefined();
});

for (const restart of [false, true]) test(`q57: RPC rejects every new hash; sibling inclusion survives exhausted caps (restart=${restart})`, async () => {
  const { env, jOutbox, batch, attempt, raw } = await canonicalAttempt();
  const limits = { maxFeePerGasWei: '4', maxPriorityFeePerGasWei: '3' };
  await applyRuntimeTx(env, await authorizeEvmFeeLimits(payer, jurisdictionName, attempt.attemptId, raw, limits), { isReplay: true });
  const adapter = env.infrastructure!.liveJAdapters!.get(jurisdictionName)!;
  const rejected = new Set<string>();
  const checked = new Set<string>();
  let included = false;
  Object.assign(adapter.provider, {
    getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getTransactionReceipt: async (hash: string) => {
      checked.add(hash);
      return included && hash === ethers.keccak256(raw) ? { hash, status: 1, blockNumber: 100, blockHash: `0x${'ab'.repeat(32)}`, index: 0, logs: [] } : null;
    },
  });
  Object.assign(adapter, { broadcastPreparedTransaction: async (wire: string) => {
    rejected.add(ethers.keccak256(wire));
    throw Object.assign(new Error('replacement transaction underpriced'), { code: 'REPLACEMENT_UNDERPRICED' });
  } });
  let current = jOutbox;
  for (let index = 0; index < 5; index++) {
    let [tx] = await submit(env, current);
    if (tx?.type === 'replaceJPreparedTransaction') {
      expect(index).toBeLessThan(3);
      current = await applyRuntimeTx(env, tx, { isReplay: true });
      [tx] = await submit(env, current);
    }
    expect(tx).toMatchObject({ type: 'recordJSubmitResult', data: { outcome: 'transientFailure', adapterFailure: { code: 'REPLACEMENT_UNDERPRICED' } } });
    if (!tx) throw new Error('rejection missing');
    await applyRuntimeTx(env, tx, { isReplay: true });
    if (restart) restoreFeeAttempt(env);
    env.state.timestamp += 60000;
    const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!retry) throw new Error('retry missing');
    current = await applyRuntimeTx(env, retry, { isReplay: true });
    registerPendingCommittedJOutbox(env, current);
    expect(current[0]!.jTxs[0]!).toMatchObject({ data: { runtimeSubmitAttempt: { evmFeeLimits: limits } } });
  }
  expect(rejected.size).toBe(3);
  expect(checked).toEqual(rejected);
  included = true;
  const [result] = await submit(env, current);
  expect(result).toMatchObject({ type: 'recordJSubmitResult', data: { outcome: 'submitted', txHash: ethers.keccak256(raw) } });
  expect(batch.data.entityNonce).toBe(1);
});


test('q57: recovery rejects an obsolete EVM wire without durable payer ceilings', async () => {
  const { env, attempt } = await canonicalAttempt();
  delete attempt.evmFeeLimits;
  expect(() => validateJInputs(env.infrastructure!.pendingCommittedJOutbox, 'Q57_OLD')).toThrow('EVM_FEE_LIMITS_MISSING');
});


const restoreFeeAttempt = (env: RuntimeReplica): void => {
  const bytes = encodeBuffer(buildStorageRuntimeMachineSnapshot(env));
  const recovered = validateDurableRuntimeMachineSnapshot(decodeBuffer(bytes), 'Q57_STORAGE_RESTART');
  restoreDurableRuntimeSnapshot(env, recovered);
};

const prepareThroughDriver = async (ceilingWei?: string) => {
  const fixture = await canonicalAttempt();
  const { env, batch, attempt, raw } = fixture;
  delete attempt.rawTransaction;
  delete attempt.evmFeeLimits;
  const adapter = env.infrastructure!.liveJAdapters!.get(jurisdictionName)!;
  if (ceilingWei !== undefined) Object.assign(adapter, { evmFeeCeilingWei: ceilingWei });
  Object.assign(adapter, { submitTx: async (_batch: unknown, options: Parameters<JAdapter['submitTx']>[1]) => {
    await options.prepareOnly!({ rawTransaction: raw, transactionHash: ethers.keccak256(raw), transactionNonce: 7 });
    return { success: true };
  } });
  const queued: RuntimeTx[] = [];
  await beginJPreparation(env, adapter, jurisdictionName, batch, {}, tx => queued.push(tx), async () => {});
  const record = queued[0]!;
  await applyRuntimeTx(env, record, { isReplay: true });
  for (const callback of env.infrastructure!.runtimeFrameCommitCallbacks!)
    callback({ height: 1, runtimeInput: { runtimeTxs: [record], entityInputs: [] } });
  await Promise.all(env.infrastructure!.jPreparationTasks!.values());
  return { ...fixture, adapter, record };
};

test('q61: production preparation authorizes default ceilings; underpriced bumps stop at them', async () => {
  const { env, replica, batch, attempt, adapter, record } = await prepareThroughDriver();
  expect(record).toMatchObject({ type: 'recordJPreparedTransaction', data: { feeAuthorization: {
    maxFeePerGasWei: '8', maxPriorityFeePerGasWei: '8',
  } } });
  const signed: string[] = [];
  const signTransaction = payer.signTransaction.bind(payer);
  Object.assign(adapter, { signer: { getAddress: () => payer.getAddress(),
    signTransaction: async (tx: ethers.TransactionRequest) => { const raw = await signTransaction(tx); signed.push(raw); return raw; } } });
  for (let index = 0; index < 10; index++) {
    Object.assign(replica.jSubmitState!, { txHash: ethers.keccak256(attempt.rawTransaction!),
      lastFailure: { message: 'replacement transaction underpriced' } });
    const next = await prepareEvmFeeReplacement(env, adapter, jurisdictionName, batch);
    if (!next) break;
    await applyRuntimeTx(env, next, { isReplay: true });
  }
  expect(signed.length).toBeGreaterThan(0);
  expect(ethers.Transaction.from(attempt.rawTransaction!).maxFeePerGas).toBe(8n);
  expect(signed.every(raw => ethers.Transaction.from(raw).maxFeePerGas! <= 8n)).toBe(true);
  expect(await prepareEvmFeeReplacement(env, adapter, jurisdictionName, batch)).toBeNull();
});

test('q61: wallet Speed up commits payer authorization before rebroadcast; stale/rejected actions sign no replacement', async () => {
  const { env, replica, batch, attempt, adapter } = await prepareThroughDriver();
  for (let index = 0; index < 10; index++) {
    Object.assign(replica.jSubmitState!, { txHash: ethers.keccak256(attempt.rawTransaction!), lastFailure: { message: 'replacement transaction underpriced' } });
    const next = await prepareEvmFeeReplacement(env, adapter, jurisdictionName, batch);
    if (!next) break;
    await applyRuntimeTx(env, next, { isReplay: true });
  }
  expect(ethers.Transaction.from(attempt.rawTransaction!).maxFeePerGas).toBe(8n);
  expect(await prepareEvmFeeReplacement(env, adapter, jurisdictionName, batch)).toBeNull();
  const quote = await resolveRuntimeAdapterRead<JFeeQuote>({ env }, 'j-fee', { entityId: batch.entityId });
  env.infrastructure!.lifecyclePhase = 'running';
  const inputs: import('../../../../runtime/types').RuntimeInput[] = [];
  const wallet = new EmbeddedRuntimeAdapter({ getEnv: () => env,
    enqueueRuntimeInput: (_env, input) => { inputs.push(input); }, validateRuntimeInputAdmission: () => {},
    submitCrossJurisdictionIntent: async () => ({ delivered: true }), registerRuntimePublishedCallback: () => () => {},
  });
  let replacements = 0;
  const sign = payer.signTransaction.bind(payer);
  Object.assign(adapter, { signer: { getAddress: () => payer.getAddress(), signMessage: payer.signMessage.bind(payer),
    signTransaction: async (tx: ethers.TransactionRequest) => { replacements++; return sign(tx); } } });
  const action = { type: 'authorize-evm-fees' as const, entityId: batch.entityId, signerId: batch.data.signerId!,
    attemptId: quote.attemptId, transactionHash: quote.transactionHash, ceilingWei: quote.ceilingWei };
  await expect(wallet.control({ ...action, transactionHash: ethers.ZeroHash })).rejects.toThrow('EVM_FEE_QUOTE_STALE');
  expect(inputs).toHaveLength(0);
  expect(replacements).toBe(0);
  let rebroadcasts = 0;
  let rebroadcastBatch: typeof batch | undefined;
  const pending = requestBatchSpeedUp({ adapter: wallet, entityId: batch.entityId, signerId: batch.data.signerId!, quote,
    confirm: message => { expect(message).toContain('16 wei/gas'); return true; },
    rebroadcast: async gasBumpBps => {
      rebroadcasts++;
      replica.state.config.jurisdiction!.depositoryAddress = `0x${'22'.repeat(20)}`;
      replica.state.config.jurisdiction!.entityProviderAddress = `0x${'23'.repeat(20)}`;
      env.state.jReplicas.get(jurisdictionName)!.contracts!.entityProvider = `0x${'23'.repeat(20)}`;
      const result = await handleJRebroadcast(replica.state, { type: 'j_rebroadcast', data: { gasBumpBps } }, env);
      replica.state = result.newState;
      expect(result.jOutputs).toHaveLength(1);
      env.state.timestamp += 60000;
      const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
      if (!retry) throw new Error('wallet rebroadcast retry missing');
      const outbox = await applyRuntimeTx(env, retry, { isReplay: true });
      registerPendingCommittedJOutbox(env, outbox);
      const next = outbox[0]!.jTxs[0]!;
      if (next.type !== 'batch') throw new Error('wallet rebroadcast batch missing');
      expect(next.data.runtimeSubmitAttempt!.evmFeeLimits).toEqual({ maxFeePerGasWei: '16', maxPriorityFeePerGasWei: '16' });
      rebroadcastBatch = next;
    } });
  for (let index = 0; index < 20 && !inputs.length; index++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(inputs).toHaveLength(1);
  expect(attempt.evmFeeLimits!.maxFeePerGasWei).toBe('8');
  const record = inputs[0]!.runtimeTxs[0]!;
  await applyRuntimeTx(env, record, { isReplay: true });
  for (const callback of env.infrastructure!.runtimeFrameCommitCallbacks!) callback({ height: 2, runtimeInput: inputs[0]! });
  expect(await pending).toBe(true);
  expect(attempt.evmFeeLimits!.maxFeePerGasWei).toBe('16');
  expect(inputs).toHaveLength(1); // UI requests replacement only after authorization commit returns.
  expect(rebroadcasts).toBe(1);
  if (!rebroadcastBatch) throw new Error('committed wallet rebroadcast missing');
  const next = await prepareEvmFeeReplacement(env, adapter, jurisdictionName, rebroadcastBatch);
  expect(next?.type).toBe('replaceJPreparedTransaction');
  if (next?.type !== 'replaceJPreparedTransaction') throw new Error('speed-up replacement missing');
  expect(ethers.Transaction.from(next.data.rawTransaction).maxFeePerGas).toBeGreaterThan(8n);
  expect(replacements).toBe(1);
  await applyRuntimeTx(env, next!, { isReplay: true });
  expect(await prepareEvmFeeReplacement(env, adapter, jurisdictionName, rebroadcastBatch)).toBeNull();
  expect(replacements).toBe(1);
});

test('q61: operator config signs one absolute ceiling with the actual wire payer', async () => {
  const { attempt, record } = await prepareThroughDriver('12');
  if (record.type !== 'recordJPreparedTransaction') throw new Error('record missing');
  expect(authorizedEvmFeeLimits(jurisdictionName, attempt.attemptId, attempt.rawTransaction!, record.data.feeAuthorization))
    .toEqual({ maxFeePerGasWei: '12', maxPriorityFeePerGasWei: '12' });
});

test('q64: preparation raises a configured ceiling below the signed wire', async () => {
  const { env, attempt, record } = await prepareThroughDriver('1');
  if (record.type !== 'recordJPreparedTransaction') throw new Error('record missing');
  expect(authorizedEvmFeeLimits(jurisdictionName, attempt.attemptId, attempt.rawTransaction!, record.data.feeAuthorization))
    .toEqual({ maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '2' });
  expect(env.infrastructure!.halted).not.toBe(true);
});

test('q64: a queued automatic replacement makes wallet authorization stale without halting or rebroadcasting', async () => {
  const { env, replica, batch, attempt, adapter } = await prepareThroughDriver();
  const old = attempt.rawTransaction!;
  const limits = structuredClone(attempt.evmFeeLimits);
  Object.assign(replica.jSubmitState!, { txHash: ethers.keccak256(old), lastFailure: { message: 'replacement transaction underpriced' } });
  const replacement = await prepareEvmFeeReplacement(env, adapter, jurisdictionName, batch);
  if (replacement?.type !== 'replaceJPreparedTransaction') throw new Error('automatic replacement missing');
  const quote = await resolveRuntimeAdapterRead<JFeeQuote>({ env }, 'j-fee', { entityId: batch.entityId });
  env.infrastructure!.lifecyclePhase = 'running';
  const inputs: import('../../../../runtime/types').RuntimeInput[] = [{ runtimeTxs: [replacement], entityInputs: [] }];
  const wallet = new EmbeddedRuntimeAdapter({ getEnv: () => env,
    enqueueRuntimeInput: (_env, input) => { inputs.push(input); }, validateRuntimeInputAdmission: () => {},
    submitCrossJurisdictionIntent: async () => ({ delivered: true }), registerRuntimePublishedCallback: () => () => {},
  });
  let signatures = 0;
  let rebroadcasts = 0;
  Object.assign(adapter, { signer: { getAddress: () => payer.getAddress(), signMessage: payer.signMessage.bind(payer),
    signTransaction: async () => { signatures++; throw new Error('unexpected wallet replacement'); } } });
  const pending = requestBatchSpeedUp({ adapter: wallet, entityId: batch.entityId, signerId: batch.data.signerId!, quote,
    confirm: () => true, rebroadcast: async () => { rebroadcasts++; } });
  const outcome = pending.then(() => null, (error: unknown) => error);
  for (let index = 0; index < 20 && inputs.length < 2; index++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(inputs).toHaveLength(2);
  const runtimeInput = { runtimeTxs: inputs.flatMap(input => input.runtimeTxs), entityInputs: [] };
  await applyRuntimeTx(env, runtimeInput.runtimeTxs[0]!, { isReplay: true });
  try {
    expect(await applyRuntimeTx(env, runtimeInput.runtimeTxs[1]!, { isReplay: true })).toEqual([]);
  } finally {
    for (const callback of env.infrastructure!.runtimeFrameCommitCallbacks!) callback({ height: 2, runtimeInput });
    expect(await outcome).toMatchObject({ message: 'EVM_FEE_QUOTE_STALE' });
  }
  expect(env.infrastructure!.halted).not.toBe(true);
  expect(attempt.rawTransaction).toBe(replacement.data.rawTransaction);
  expect(attempt.competingTransactions).toEqual([old]);
  expect(attempt.evmFeeLimits).toEqual(limits);
  expect(rebroadcasts).toBe(0);
  expect(signatures).toBe(0);
  const authorization = runtimeInput.runtimeTxs[1]!;
  if (authorization.type !== 'recordJPreparedTransaction' || !authorization.data.feeAuthorization) throw new Error('authorization missing');
  const forged = { ...authorization, data: { ...authorization.data,
    feeAuthorization: { ...authorization.data.feeAuthorization, maxFeePerGasWei: '17' } } };
  await expect(applyRuntimeTx(env, forged, { isReplay: true })).rejects.toThrow('EVM_FEE_AUTHORIZATION_PAYER');
  const unknown = ethers.Transaction.from(old);
  unknown.signature = null;
  unknown.nonce++;
  const conflict = await authorizeEvmFeeLimits(payer, jurisdictionName, attempt.attemptId, await payer.signTransaction(unknown),
    { maxFeePerGasWei: '16', maxPriorityFeePerGasWei: '16' });
  await expect(applyRuntimeTx(env, conflict, { isReplay: true })).rejects.toThrow('J_PREPARED_TRANSACTION_CONFLICT');
  expect(attempt.evmFeeLimits).toEqual(limits);
});

for (const refusal of ['cancel', 'signer-rejected', 'wrong-payer']) test(`q61: ${refusal} signs no replacement or authorization record`, async () => {
  const { env, batch, adapter } = await prepareThroughDriver();
  env.infrastructure!.lifecyclePhase = 'running';
  const quote = await resolveRuntimeAdapterRead<JFeeQuote>({ env }, 'j-fee', { entityId: batch.entityId });
  const inputs: import('../../../../runtime/types').RuntimeInput[] = [];
  const wallet = new EmbeddedRuntimeAdapter({ getEnv: () => env,
    enqueueRuntimeInput: (_env, input) => { inputs.push(input); }, validateRuntimeInputAdmission: () => {},
    submitCrossJurisdictionIntent: async () => ({ delivered: true }), registerRuntimePublishedCallback: () => () => {},
  });
  let signatures = 0;
  Object.assign(adapter, { signer: {
    getAddress: async () => refusal === 'wrong-payer' ? ethers.ZeroAddress : payer.address,
    signMessage: async () => { signatures++; throw new Error('PAYER_REJECTED'); },
    signTransaction: async () => { signatures++; throw new Error('unexpected replacement'); },
  } });
  let rebroadcasts = 0;
  const action = requestBatchSpeedUp({ adapter: wallet, entityId: batch.entityId, signerId: batch.data.signerId!, quote,
    confirm: () => refusal !== 'cancel', rebroadcast: async () => { rebroadcasts++; } });
  if (refusal === 'cancel') expect(await action).toBe(false);
  else await expect(action).rejects.toThrow(refusal === 'wrong-payer' ? 'EVM_REPLACEMENT_PAYER_UNAVAILABLE' : 'PAYER_REJECTED');
  expect(rebroadcasts).toBe(0);
  expect(signatures).toBe(refusal === 'signer-rejected' ? 1 : 0);
  expect(inputs).toHaveLength(0);
});

test('q61: remote authorization control validates exact current-attempt request fields', () => {
  const action = { type: 'authorize-evm-fees', entityId: `0x${'31'.repeat(32)}`, signerId: payer.address.toLowerCase(),
    attemptId: `0x${'22'.repeat(32)}`, transactionHash: `0x${'33'.repeat(32)}`, ceilingWei: '16' };
  const request = (value: unknown) => validateRuntimeAdapterWireMessage({ v: XLN_PROTOCOL_VERSION, id: 'fee-auth', op: 'control', action: value });
  expect(request(action)).toMatchObject({ op: 'control', action });
  for (const changed of [{ ...action, ceilingWei: '01' }, { ...action, entityId: payer.address },
    { ...action, signature: '0x' }, { ...action, transactionHash: '' }]) expect(() => request(changed)).toThrow();
});
