import { MAX_SUBMIT_FAILURE_MESSAGE_CHARS } from '../runtime/submit-identity';
import { describe, expect, test } from 'bun:test';

import { applyRuntimeTx } from '../runtime/tx-handlers';
import {
  makeJSubmitResultRuntimeTx,
  registerPendingCommittedJOutbox,
} from '../runtime/j-submit-state';
import { J_SUBMIT_RESULT_FINGERPRINT_LIMIT } from '../runtime/j-submit-result';
import { collectDueJSubmitRuntimeTxs } from '../runtime/j-submit-scheduler';
import { submitRuntimeJOutbox } from '../runtime/j-submit';
import { ENTITY_J_SUBMIT_FALLBACK_MS } from '../entity/consensus/leader';
import { createEmptyBatch } from '../jurisdiction/machine/batch';
import { computeCanonicalEntityHash } from '../storage/canonical-hash';
import { buildCanonicalEntityReplicaSnapshot } from '../storage/wal/snapshot';
import {
  batchHash,
  commitJSubmitAttempt,
  entityId,
  jurisdictionName,
  makeJSubmitDurabilityFixture,
  signerId,
} from './fixtures/j-submit-durability-fixture';
import { attachLiveJAdapter } from '../runtime/live-jadapters';
import type { RuntimeReplica } from '../runtime/types';
import type { JAdapter } from '../jurisdiction/adapter/types';

const makeFixture = makeJSubmitDurabilityFixture;
const commitAttempt = commitJSubmitAttempt;

const installSubmitAdapter = (env: RuntimeReplica, adapter: JAdapter): void => {
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
  attachLiveJAdapter(env, jurisdictionName, adapter);
};

describe('durable validator-local J submit state', () => {
  test('committed batch without an attempt is due immediately', () => {
    const { env } = makeFixture();
    const retries = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      type: 'retryJSubmit',
      data: { entityId, signerId, batchHash, entityNonce: 1 },
    });
  });

  test('queued retry becomes a no-op after authenticated finality retires its sealed batch', async () => {
    const { env, replica } = makeFixture();
    const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!retry) throw new Error('retry fixture missing');
    delete replica.state.jBatchState?.sentBatch;

    expect(await applyRuntimeTx(env, retry, { isReplay: true })).toEqual([]);
    expect(replica.jSubmitState).toBeUndefined();
  });

  test('finalized nonce-collision quarantine suppresses retries and reconciles a durable outbox before I/O', async () => {
    const { env, replica, retry, jOutbox } = await commitAttempt();
    const sent = replica.state.jBatchState?.sentBatch;
    if (!sent) throw new Error('quarantine fixture sent batch missing');
    sent.terminalFailure = {
      message: 'J_BATCH_NONCE_CONSUMED_BY_DIFFERENT_HASH:0xdead',
      failedAt: env.state.timestamp,
    };

    expect(collectDueJSubmitRuntimeTxs(env, env.state.timestamp + ENTITY_J_SUBMIT_FALLBACK_MS)).toEqual([]);
    expect(await applyRuntimeTx(env, retry, { isReplay: true })).toEqual([]);

    const queued: Parameters<typeof applyRuntimeTx>[1][] = [];
    await submitRuntimeJOutbox(env, jOutbox, {
      enqueueRuntimeInputs: (_target, _inputs, runtimeTxs) => {
        queued.push(...(runtimeTxs ?? []));
      },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'recordJSubmitResult',
      data: { outcome: 'reconciled', message: 'committed-batch-cancelled-before-submit' },
    });
  });

  test('attempt RuntimeTx records local attempt before exposing external outbox', async () => {
    const { replica, jOutbox } = await commitAttempt();
    const attempt = jOutbox[0]?.jTxs[0]?.type === 'batch'
      ? jOutbox[0].jTxs[0].data.runtimeSubmitAttempt
      : undefined;
    expect(attempt).toMatchObject({ attemptNumber: 1, attemptedAt: 2_000 });
    expect(replica.jSubmitState).toMatchObject({
      batchHash,
      entityNonce: 1,
      submitAttempts: 1,
      lastSubmittedAt: 2_000,
    });
  });

  test('terminal result is local, replayable, and cannot change Entity consensus hash', async () => {
    const { env, replica, jOutbox } = await commitAttempt();
    const batchTx = jOutbox[0]?.jTxs[0];
    if (!batchTx || batchTx.type !== 'batch') throw new Error('batch attempt fixture missing');
    const beforeHash = computeCanonicalEntityHash(replica).hash;
    const resultTx = makeJSubmitResultRuntimeTx(
      batchTx,
      jurisdictionName,
      'terminalFailure',
      { message: 'staticCall revert: E3()' },
    );
    await applyRuntimeTx(env, resultTx, { isReplay: true });

    expect(replica.jSubmitState?.terminalFailure).toMatchObject({ message: 'staticCall revert: E3()' });
    expect(replica.state.jBatchState?.sentBatch?.terminalFailure).toBeUndefined();
    expect(computeCanonicalEntityHash(replica).hash).toBe(beforeHash);
    expect(env.infrastructure?.pendingCommittedJOutbox).toEqual([]);
    expect(collectDueJSubmitRuntimeTxs(env, env.state.timestamp + ENTITY_J_SUBMIT_FALLBACK_MS * 2)).toEqual([]);
  });

  test('transient result starts backoff from the persisted attempt timestamp', async () => {
    const { env, jOutbox } = await commitAttempt();
    const batchTx = jOutbox[0]?.jTxs[0];
    if (!batchTx || batchTx.type !== 'batch') throw new Error('batch attempt fixture missing');
    await applyRuntimeTx(env, makeJSubmitResultRuntimeTx(
      batchTx,
      jurisdictionName,
      'transientFailure',
      { message: 'ECONNRESET' },
    ), { isReplay: true });

    expect(collectDueJSubmitRuntimeTxs(env, 2_000 + ENTITY_J_SUBMIT_FALLBACK_MS - 1)).toEqual([]);
    expect(collectDueJSubmitRuntimeTxs(env, 2_000 + ENTITY_J_SUBMIT_FALLBACK_MS)).toHaveLength(1);
  });

  test('authenticated J input defers external I/O and makes the batch immediately retryable', async () => {
    const { env, replica, jOutbox } = await commitAttempt();
    let submitCalls = 0;
    env.runtimeMempool!.entityInputs.push({
      entityId,
      signerId,
      entityTxs: [{ type: 'j_event', data: {} as never }],
    });
    installSubmitAdapter(env, {
        pollNow: async () => {},
        submitTx: async () => {
          submitCalls += 1;
          return { success: true, events: [] };
        },
      } as JAdapter);
    const queued: Parameters<typeof applyRuntimeTx>[1][] = [];

    await submitRuntimeJOutbox(env, jOutbox, {
      enqueueRuntimeInputs: (_target, _inputs, runtimeTxs) => queued.push(...(runtimeTxs ?? [])),
    });

    expect(submitCalls).toBe(0);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'recordJSubmitResult',
      data: { outcome: 'eventBarrier', message: 'authenticated-j-events-before-submit' },
    });
    await applyRuntimeTx(env, queued[0]!, { isReplay: true });
    expect(replica.jSubmitState?.lastResultOutcome).toBe('eventBarrier');
    expect(collectDueJSubmitRuntimeTxs(env, env.state.timestamp)).toHaveLength(1);
  });

  test('empty J-prefix liveness does not starve an otherwise valid submit', async () => {
    const { env, jOutbox } = await commitAttempt();
    let submitCalls = 0;
    installSubmitAdapter(env, {
        pollNow: async () => {
          env.runtimeMempool!.entityInputs.push({
            entityId,
            signerId,
            jPrefixAttestations: new Map([[signerId, { blocks: [] } as never]]),
          });
        },
        submitTx: async () => {
          submitCalls += 1;
          return { success: true, events: [] };
        },
      } as JAdapter);
    const queued: Parameters<typeof applyRuntimeTx>[1][] = [];

    await submitRuntimeJOutbox(env, jOutbox, {
      enqueueRuntimeInputs: (_target, _inputs, runtimeTxs) => queued.push(...(runtimeTxs ?? [])),
    });

    expect(submitCalls).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'recordJSubmitResult',
      data: { outcome: 'submitted' },
    });
  });

  test('structured adapter failure and bounded message survive the durable replica snapshot', async () => {
    const { env, replica, jOutbox } = await commitAttempt();
    const batchTx = jOutbox[0]?.jTxs[0];
    if (!batchTx || batchTx.type !== 'batch') throw new Error('batch attempt fixture missing');
    const oversizedMessage = `NETWORK_ERROR:${'x'.repeat(MAX_SUBMIT_FAILURE_MESSAGE_CHARS * 2)}`;
    const resultTx = makeJSubmitResultRuntimeTx(batchTx, jurisdictionName, 'transientFailure', {
      message: oversizedMessage,
      adapterFailure: {
        category: 'transient',
        code: 'NETWORK_ERROR',
        message: oversizedMessage,
      },
    });
    await applyRuntimeTx(env, resultTx, { isReplay: true });

    const restored = buildCanonicalEntityReplicaSnapshot(replica);
    expect(resultTx.data.message?.length).toBeLessThanOrEqual(MAX_SUBMIT_FAILURE_MESSAGE_CHARS);
    expect(restored.jSubmitState?.lastFailure?.adapterFailure).toMatchObject({
      category: 'transient',
      code: 'NETWORK_ERROR',
    });
    expect(restored.jSubmitState?.lastFailure?.adapterFailure?.message.length)
      .toBeLessThanOrEqual(MAX_SUBMIT_FAILURE_MESSAGE_CHARS);
  });

  test('forged J-submit RuntimeTx is rejected outside replay', async () => {
    const { env } = makeFixture();
    const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!retry) throw new Error('retry fixture missing');
    const forged = structuredClone(retry);
    await expect(applyRuntimeTx(env, forged)).rejects.toThrow('J_SUBMIT_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED');
  });

  test('queued retry cannot overlap a durable pending attempt', async () => {
    const { env, replica, retry } = await commitAttempt();
    env.state.timestamp += ENTITY_J_SUBMIT_FALLBACK_MS;

    expect(await applyRuntimeTx(env, retry, { isReplay: true })).toEqual([]);
    expect(replica.jSubmitState?.submitAttempts).toBe(1);
    expect(env.infrastructure?.pendingCommittedJOutbox).toHaveLength(1);
  });

  test('late result retires only its old pending attempt and cannot corrupt a newer attempt', async () => {
    const { env, replica, jOutbox: firstOutbox } = await commitAttempt();
    const firstBatchTx = firstOutbox[0]?.jTxs[0];
    if (!firstBatchTx || firstBatchTx.type !== 'batch') throw new Error('first attempt fixture missing');

    env.infrastructure!.pendingCommittedJOutbox = [];
    env.state.timestamp += ENTITY_J_SUBMIT_FALLBACK_MS;
    const [secondRetry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!secondRetry) throw new Error('second retry fixture missing');
    const secondOutbox = await applyRuntimeTx(env, secondRetry, { isReplay: true });
    registerPendingCommittedJOutbox(env, secondOutbox);
    registerPendingCommittedJOutbox(env, firstOutbox);
    const before = structuredClone(replica.jSubmitState);

    await applyRuntimeTx(env, makeJSubmitResultRuntimeTx(
      firstBatchTx,
      jurisdictionName,
      'reconciled',
    ), { isReplay: true });

    expect(replica.jSubmitState).toEqual(before);
    const pending = env.infrastructure?.pendingCommittedJOutbox ?? [];
    expect(pending).toHaveLength(1);
    const remaining = pending[0]?.jTxs[0];
    expect(remaining?.type === 'batch' ? remaining.data.runtimeSubmitAttempt?.attemptNumber : null).toBe(2);
  });

  test('exact duplicate result is idempotent but a conflicting payload for the same attempt fails closed', async () => {
    const { env, replica, jOutbox } = await commitAttempt();
    const batchTx = jOutbox[0]?.jTxs[0];
    if (!batchTx || batchTx.type !== 'batch') throw new Error('batch attempt fixture missing');
    const resultTx = makeJSubmitResultRuntimeTx(
      batchTx,
      jurisdictionName,
      'terminalFailure',
      { message: 'staticCall revert: E3()' },
    );
    await applyRuntimeTx(env, resultTx, { isReplay: true });
    const afterFirstResult = {
      local: structuredClone(replica.jSubmitState),
      pending: structuredClone(env.infrastructure?.pendingCommittedJOutbox),
    };

    await applyRuntimeTx(env, structuredClone(resultTx), { isReplay: true });
    expect(replica.jSubmitState).toEqual(afterFirstResult.local);
    expect(env.infrastructure?.pendingCommittedJOutbox).toEqual(afterFirstResult.pending);

    const conflicting = structuredClone(resultTx);
    conflicting.data.message = 'staticCall revert: E5()';
    await expect(applyRuntimeTx(env, conflicting, { isReplay: true }))
      .rejects.toThrow('J_SUBMIT_RESULT_DUPLICATE_CONFLICT');
    expect(replica.jSubmitState).toEqual(afterFirstResult.local);
    expect(env.infrastructure?.pendingCommittedJOutbox).toEqual(afterFirstResult.pending);
  });

  test('conflicting duplicate of an older recorded attempt still fails after a newer result', async () => {
    const { env, replica, jOutbox: firstOutbox } = await commitAttempt();
    const firstBatchTx = firstOutbox[0]?.jTxs[0];
    if (!firstBatchTx || firstBatchTx.type !== 'batch') throw new Error('first attempt fixture missing');
    const firstResult = makeJSubmitResultRuntimeTx(
      firstBatchTx,
      jurisdictionName,
      'transientFailure',
      { message: 'ECONNRESET' },
    );
    await applyRuntimeTx(env, firstResult, { isReplay: true });

    env.state.timestamp += ENTITY_J_SUBMIT_FALLBACK_MS;
    const [secondRetry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!secondRetry) throw new Error('second retry fixture missing');
    const secondOutbox = await applyRuntimeTx(env, secondRetry, { isReplay: true });
    registerPendingCommittedJOutbox(env, secondOutbox);
    const secondBatchTx = secondOutbox[0]?.jTxs[0];
    if (!secondBatchTx || secondBatchTx.type !== 'batch') throw new Error('second attempt fixture missing');
    await applyRuntimeTx(env, makeJSubmitResultRuntimeTx(
      secondBatchTx,
      jurisdictionName,
      'submitted',
      { txHash: `0x${'b1'.repeat(32)}` },
    ), { isReplay: true });
    const afterSecondResult = structuredClone(replica.jSubmitState);

    await applyRuntimeTx(env, structuredClone(firstResult), { isReplay: true });
    expect(replica.jSubmitState).toEqual(afterSecondResult);

    const conflicting = structuredClone(firstResult);
    conflicting.data.message = 'ETIMEDOUT';
    await expect(applyRuntimeTx(env, conflicting, { isReplay: true }))
      .rejects.toThrow('J_SUBMIT_RESULT_DUPLICATE_CONFLICT');
    expect(replica.jSubmitState).toEqual(afterSecondResult);
  });

  test('dedupe journal is deterministically bounded and retained across replica restore', async () => {
    const { env, replica } = makeFixture();
    const results: Extract<Parameters<typeof applyRuntimeTx>[1], { type: 'recordJSubmitResult' }>[] = [];
    for (let index = 0; index < J_SUBMIT_RESULT_FINGERPRINT_LIMIT + 8; index += 1) {
      const [retry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
      if (!retry) throw new Error(`retry ${index + 1} missing`);
      const outbox = await applyRuntimeTx(env, retry, { isReplay: true });
      registerPendingCommittedJOutbox(env, outbox);
      const batchTx = outbox[0]?.jTxs[0];
      if (!batchTx || batchTx.type !== 'batch') throw new Error(`attempt ${index + 1} missing`);
      const result = makeJSubmitResultRuntimeTx(
        batchTx,
        jurisdictionName,
        'transientFailure',
        { message: `NETWORK_ERROR:${index + 1}` },
      );
      results.push(result);
      await applyRuntimeTx(env, result, { isReplay: true });
      env.state.timestamp += ENTITY_J_SUBMIT_FALLBACK_MS;
    }

    const firstAttemptId = results[0]!.data.attemptId;
    const lastAttemptId = results.at(-1)!.data.attemptId;
    expect(replica.jSubmitState?.resultFingerprintOrder).toHaveLength(J_SUBMIT_RESULT_FINGERPRINT_LIMIT);
    expect(Object.keys(replica.jSubmitState?.resultFingerprints ?? {}))
      .toHaveLength(J_SUBMIT_RESULT_FINGERPRINT_LIMIT);
    expect(replica.jSubmitState?.resultFingerprints?.[firstAttemptId]).toBeUndefined();
    expect(replica.jSubmitState?.resultFingerprintOrder?.at(-1)).toBe(lastAttemptId);

    const restored = buildCanonicalEntityReplicaSnapshot(replica);
    expect(restored.jSubmitState?.resultFingerprintOrder).toEqual(replica.jSubmitState?.resultFingerprintOrder);
    const beforeOldReplay = structuredClone(restored.jSubmitState);
    const restoredFixture = makeFixture();
    restoredFixture.env.state.eReplicas.set(`${entityId}:${signerId}`, restored);
    restoredFixture.env.infrastructure = structuredClone(env.infrastructure);
    await applyRuntimeTx(restoredFixture.env, structuredClone(results[0]!), { isReplay: true });
    expect(restored.jSubmitState).toEqual(beforeOldReplay);

    const conflictingRecent = structuredClone(results.at(-1)!);
    conflictingRecent.data.message = 'different recent result';
    await expect(applyRuntimeTx(restoredFixture.env, conflictingRecent, { isReplay: true }))
      .rejects.toThrow('J_SUBMIT_RESULT_DUPLICATE_CONFLICT');
  });

  test('old RPC result retires only its exact old attempt and is idempotent beside a new pending batch', async () => {
    const { env, replica, jOutbox: firstOutbox } = await commitAttempt();
    const firstBatchTx = firstOutbox[0]?.jTxs[0];
    const firstSent = replica.state.jBatchState?.sentBatch;
    if (!firstBatchTx || firstBatchTx.type !== 'batch' || !firstSent) {
      throw new Error('first attempt fixture missing');
    }

    const nextBatch = createEmptyBatch();
    nextBatch.reserveToReserve.push({
      receivingEntity: `0x${'71'.repeat(32)}`,
      tokenId: 2,
      amount: 20n,
    });
    const nextBatchHash = `0x${'81'.repeat(32)}`;
    replica.state.jBatchState!.sentBatch = {
      ...firstSent,
      batch: nextBatch,
      batchHash: nextBatchHash,
      encodedBatch: '0x5678',
      entityNonce: 2,
    };
    replica.hankoWitness!.set(nextBatchHash, {
      hanko: '0x5678',
      type: 'jBatch',
      entityHeight: 2,
      createdAt: env.state.timestamp,
    });
    const [nextRetry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!nextRetry) throw new Error('next batch retry fixture missing');
    const nextOutbox = await applyRuntimeTx(env, nextRetry, { isReplay: true });
    registerPendingCommittedJOutbox(env, nextOutbox);
    const oldResult = makeJSubmitResultRuntimeTx(firstBatchTx, jurisdictionName, 'submitted', {
      txHash: `0x${'91'.repeat(32)}`,
    });

    await applyRuntimeTx(env, oldResult, { isReplay: true });
    const pendingAfterOldResult = structuredClone(env.infrastructure?.pendingCommittedJOutbox);
    expect(pendingAfterOldResult).toHaveLength(1);
    const remaining = pendingAfterOldResult?.[0]?.jTxs[0];
    expect(remaining?.type === 'batch' ? remaining.data.batchHash : null).toBe(nextBatchHash);
    const localAfterOldResult = structuredClone(replica.jSubmitState);

    await applyRuntimeTx(env, structuredClone(oldResult), { isReplay: true });
    expect(replica.jSubmitState).toEqual(localAfterOldResult);
    expect(env.infrastructure?.pendingCommittedJOutbox).toEqual(pendingAfterOldResult);
  });

  test('pending outbox rejects a conflicting payload that reuses an attempt id', async () => {
    const { env, jOutbox } = await commitAttempt();
    const before = structuredClone(env.infrastructure?.pendingCommittedJOutbox);
    const conflicting = structuredClone(jOutbox);
    const conflictingBatch = conflicting[0]?.jTxs[0];
    if (!conflictingBatch || conflictingBatch.type !== 'batch') {
      throw new Error('conflicting pending fixture missing');
    }
    conflictingBatch.data.batchHash = `0x${'a1'.repeat(32)}`;

    expect(() => registerPendingCommittedJOutbox(env, conflicting))
      .toThrow('J_SUBMIT_PENDING_ATTEMPT_ID_MISMATCH');
    expect(env.infrastructure?.pendingCommittedJOutbox).toEqual(before);
  });
});
