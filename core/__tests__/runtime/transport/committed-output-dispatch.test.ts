import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime.ts';
import { createPreparedOutputGraph } from '../../../runtime/delivery/prepared-output';
import { dispatchCommittedEntityOutputs } from '../../../runtime/frame/dispatch';
import type { RoutedEntityInput } from '../../../runtime/types';

const targetRuntimeId = `0x${'22'.repeat(20)}`;
const targetEntityId = `0x${'33'.repeat(32)}`;

const output = (): RoutedEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: targetEntityId,
  signerId: `0x${'44'.repeat(20)}`,
  entityTxs: [],
  sourceRuntimeFrame: { height: 1, timestamp: 1 },
});

const planFor = (pending: RoutedEntityInput) => ({
  remoteOutputs: [{ output: pending, targetRuntimeId }],
  deferredOutputs: [],
  preparedOutputGraph: createPreparedOutputGraph(),
});

describe('committed Runtime output dispatch', () => {
  test('fails loud and retains the forensic outbox when lazy route bootstrap refuses', async () => {
    const env = createEmptyEnv('committed-output-bootstrap-refused');
    const pending = output();
    env.pendingNetworkOutputs = [pending];
    env.infrastructure!.p2p = {
      bootstrapDirectEntityRoutes: async () => false,
    } as never;

    await expect(dispatchCommittedEntityOutputs(
      env,
      new Set(),
      planFor(pending),
      {} as never,
    )).rejects.toThrow('DIRECT_OUTPUT_ROUTE_NOT_READY');
    expect(env.pendingNetworkOutputs).toEqual([pending]);
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
      {} as never,
    )).rejects.toThrow('TEST_ROUTE_BOOTSTRAP_FAILED');
    expect(env.pendingNetworkOutputs).toEqual([pending]);
  });
});
