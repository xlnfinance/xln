import { describe, expect, test } from 'bun:test';

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
  test('retains the committed outbox without halting when lazy route bootstrap is not ready', async () => {
    const env = createEmptyEnv('committed-output-bootstrap-refused');
    const pending = output();
    env.pendingNetworkOutputs = [pending];
    let ready = false;
    let attempts = 0;
    env.infrastructure!.p2p = {
      bootstrapDirectEntityRoutes: async () => ready,
      enqueueEntityInputsDelivery: () => {
        attempts += 1;
        return ready ? deliveryAccepted() : deliveryDeferred({
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
      bootstrapDirectEntityRoutes: async () => {
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
