import { describe, expect, test } from 'bun:test';
import retryVector from '../../fixtures/storage/cross-j-proposal-retry.json';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { validateDeliverableEntityInput } from '../../../runtime/delivery/topology/routing-validation';
import { dispatchEntityOutputs } from '../../../runtime/delivery/dispatch';
import { groupAtomicCrossJAdmissionOutputs } from '../../../runtime/delivery/pending';

import { createEmptyEnv } from '../../../runtime.ts';
import { createPreparedOutputGraph } from '../../../runtime/delivery/prepared-output';
import { dispatchCommittedEntityOutputs } from '../../../runtime/frame/dispatch';
import { notifyRuntimeStateChanged } from '../../../runtime/frame/notifications';
import { createRuntimeRoutingApi } from '../../../runtime/loop/loop-routing';
import { deliveryAccepted, deliveryDeferred } from '../../../protocol/payments/delivery-result';
import type { RoutedEntityInput } from '../../../runtime/types';

const targetRuntimeId = `0x${'22'.repeat(20)}`;
const targetEntityId = `0x${'33'.repeat(32)}`;
const routing = createRuntimeRoutingApi({ notifyEnvChange: notifyRuntimeStateChanged }).getRuntimeOutputRoutingDeps();

const output = (): RoutedEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: targetEntityId,
  signerId: `0x${'44'.repeat(20)}`,
  entityTxs: [],
  sourceRuntimeFrame: { height: 1, timestamp: 1 },
});

const planFor = (pending: RoutedEntityInput) => ({
  remoteOutputs: [{ output: pending, targetRuntimeId }],
  preparedOutputGraph: createPreparedOutputGraph(),
});

describe('committed Runtime output dispatch', () => {
  test('a wallet behind the j-catchup fence retains its outbox until P2P starts, without halting', async () => {
    const env = createEmptyEnv('committed-output-j-catchup');
    const pending = output();
    env.pendingNetworkOutputs = [pending];
    env.infrastructure!.entityInputsReady = false;
    const errors: string[] = [];
    env.error = ((_scope: string, code: string) => errors.push(code)) as never;
    await expect(dispatchCommittedEntityOutputs(env, new Set(), planFor(pending), routing)).resolves.toBeUndefined();
    expect(env.pendingNetworkOutputs).toEqual([pending]);
    expect(errors).toEqual([]);
    // The fence opened and P2P started: the same durable outbox is sent once.
    env.infrastructure!.entityInputsReady = true;
    let attempts = 0;
    env.infrastructure!.p2p = {
      bootstrapEntityRoutes: async () => true,
      enqueueEntityInputsDelivery: () => {
        attempts += 1;
        return deliveryAccepted();
      },
    } as never;
    await dispatchCommittedEntityOutputs(env, new Set(), planFor(pending), routing);
    expect(attempts).toBe(1);
    expect(env.pendingNetworkOutputs).toEqual([]);
  });

  test('retains the committed outbox without halting when lazy route bootstrap is not ready', async () => {
    const env = createEmptyEnv('committed-output-bootstrap-refused');
    const pending = output();
    env.pendingNetworkOutputs = [pending];
    let ready = false;
    let attempts = 0;
    env.infrastructure!.p2p = {
      bootstrapEntityRoutes: async () => ready,
      enqueueEntityInputsDelivery: () => {
        attempts += 1;
        return ready
          ? deliveryAccepted()
          : deliveryDeferred({
              outcome: 'deferred',
              code: 'P2P_DIRECT_RECIPIENT_NOT_READY',
            });
      },
    } as never;

    await expect(dispatchCommittedEntityOutputs(
      env,
      new Set(),
      planFor(pending),
      routing,
    )).resolves.toBeUndefined();
    expect(env.pendingNetworkOutputs).toEqual([pending]);
    expect(attempts).toBe(1);
    ready = true;
    await dispatchCommittedEntityOutputs(env, new Set(), planFor(pending), routing);
    expect(attempts).toBe(2);
    expect(env.pendingNetworkOutputs).toEqual([]);
  });

  test('propagates lazy route bootstrap errors and retains the forensic outbox', async () => {
    const env = createEmptyEnv('committed-output-bootstrap-error');
    const pending = output();
    env.pendingNetworkOutputs = [pending];
    env.infrastructure!.p2p = {
      bootstrapEntityRoutes: async () => {
        throw new Error('TEST_ROUTE_BOOTSTRAP_FAILED');
      },
    } as never;

    await expect(dispatchCommittedEntityOutputs(
      env,
      new Set(),
      planFor(pending),
      routing,
    )).rejects.toThrow('TEST_ROUTE_BOOTSTRAP_FAILED');
    expect(env.pendingNetworkOutputs).toEqual([pending]);
  });
});

test('a captured cross-J proposal retry retains its incomplete cohort without sending a leg or halting', () => {
  const [completeFrame, retryFrame] = retryVector.rows;
  if (!completeFrame || !retryFrame) throw new Error('CROSS_J_RETRY_VECTOR_MISSING');
  const complete = completeFrame.rowsBase64.map(row =>
    validateDeliverableEntityInput(decodeBuffer(Buffer.from(row, 'base64'))),
  );
  const retries = retryFrame.rowsBase64.map(row =>
    validateDeliverableEntityInput(decodeBuffer(Buffer.from(row, 'base64'))),
  );
  const retry = retries[0];
  if (!retry || retries.length !== 1) throw new Error('CROSS_J_RETRY_VECTOR_SHAPE');
  const original = complete.find(row => row.entityId === retry.entityId);
  const sibling = complete.find(row => row.entityId !== retry.entityId);
  if (!original || !sibling) throw new Error('CROSS_J_RETRY_ORIGINAL_PAIR_MISSING');
  const { sourceRuntimeFrame: _originalFrame, ...originalBytes } = original;
  const { sourceRuntimeFrame: _retryFrame, ...retryBytes } = retry;
  expect(encodeBuffer(retryBytes)).toEqual(encodeBuffer(originalBytes));
  expect(groupAtomicCrossJAdmissionOutputs(complete).map(unit => [unit.atomic, unit.complete])).toEqual([[true, true]]);
  expect(groupAtomicCrossJAdmissionOutputs(retries).map(unit => [unit.atomic, unit.complete])).toEqual([[true, false]]);

  const env = createEmptyEnv('captured-cross-j-pending-retry');
  env.runtimeId = retryVector.runtimeId;
  const later = { ...output(), runtimeId: retry.runtimeId, sourceRuntimeFrame: retry.sourceRuntimeFrame };
  const pending = [retry, later];
  // No transport exists: an incomplete financial cohort and later messages to
  // its destination must remain private, preserving their committed order.
  expect(() =>
    dispatchEntityOutputs(
      env,
      pending.map(row => ({ output: row, targetRuntimeId: retry.runtimeId })),
      routing,
    ),
  ).not.toThrow();
  expect(env.pendingNetworkOutputs).toEqual(pending);
  expect(encodeBuffer(retryBytes)).toEqual(encodeBuffer(originalBytes));
  const paired = groupAtomicCrossJAdmissionOutputs([retry, sibling]);
  expect(paired).toHaveLength(1);
  expect(paired[0]?.complete).toBe(true);
  expect(paired[0]?.outputs).toHaveLength(2);
});
