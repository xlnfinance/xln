import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { converge, convergeWithOffline, processWithOffline } from '../../../scenarios/harness/helpers';
import { deliveryDeferred } from '../../../protocol/payments/delivery-result';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import type { DeliverableEntityInput, RuntimeReplica } from '../../../runtime/types';
import type { JPrefixAttestation } from '../../../types/jurisdiction-events';
import { htlcRouteConvergenceCycleBudget } from '../../../scenarios/payments/test-economy';

const entityId = `0x${'11'.repeat(32)}`;
const runtimeId = `0x${'22'.repeat(20)}`;

const envWithBacklog = (label: string) => {
  const env = createEmptyEnv(`scenario-convergence-timeout:${label}`);
  env.scenarioMode = true;
  env.runtimeMempool.entityInputs = [
    {
      entityId,
      signerId: '1',
    },
  ];
  return env;
};

const networkOutput = (signerId: string): DeliverableEntityInput => ({
  entityId,
  signerId,
  entityTxs: [],
  runtimeId,
  sourceRuntimeFrame: { height: 1, timestamp: 100 },
});

/**
 * `env.pendingNetworkOutputs` is the committed Runtime outbox: every frame
 * retries it (runtime/frame/process.ts -> flushCommittedNetworkOutputs). A
 * Runtime holding remote outputs with no transport at all is a wiring fault and
 * fail-stops with ROUTE_P2P_UNAVAILABLE (runtime/delivery/dispatch.ts:350,
 * characterized by storage-frame-journal-retention.test.ts). An unreachable
 * peer is the other case: an authenticated route whose recipient is not ready
 * defers, so the unit stays in the outbox instead of being retired
 * (dispatch.ts dispatchDirectOutputEnvelope -> isDeliveryRecipientNotReady).
 * These diagnostics tests need that second case, so they attach the readiness
 * result the real direct route returns for a peer that is not ready.
 */
const attachUnreachablePeerRoute = (env: RuntimeReplica): void => {
  ensureRuntimeInfrastructure(env).directEntityInputsDispatch = () =>
    deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_SESSION_NOT_READY' });
};

describe('scenario convergence timeout diagnostics', () => {
  test('budgets every durable stage of a four-hop HTLC without weakening exhaustion checks', () => {
    expect(htlcRouteConvergenceCycleBudget(2)).toBe(16);
    expect(htlcRouteConvergenceCycleBudget(3)).toBe(21);
    expect(() => htlcRouteConvergenceCycleBudget(-1)).toThrow('HTLC_ROUTE_INTERMEDIARY_COUNT_INVALID');
  });

  test('regular convergence never silently returns with queued work', async () => {
    const rejection = converge(envWithBacklog('regular'), 0).catch((error: unknown) => error);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('converge: not converged after 0 cycles;');
    expect((error as Error).message).toContain('outputs=0,network=0,inbox=0,inputs=1');
    expect((error as Error).message).toContain('networkLanes=[]');
    expect((error as Error).message).toContain('self=0x');
  });

  test('offline convergence reports its reason and exact queued work', async () => {
    const rejection = convergeWithOffline(envWithBacklog('offline'), new Set(['4']), 0, 'validator-failover').catch(
      (error: unknown) => error,
    );
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('convergeWithOffline:validator-failover: not converged after 0 cycles;');
    expect((error as Error).message).toContain('outputs=0,network=0,inbox=0,inputs=1');
    expect((error as Error).message).toContain('networkLanes=[]');
    expect((error as Error).message).toContain('self=0x');
  });

  test('offline-only durable network backlog does not block simulated convergence', async () => {
    const env = createEmptyEnv('scenario-convergence-timeout:offline-network');
    env.scenarioMode = true;
    env.pendingNetworkOutputs = [networkOutput('4')];
    attachUnreachablePeerRoute(env);

    await convergeWithOffline(env, new Set(['4']), 1, 'validator-offline');
    expect(env.pendingNetworkOutputs).toHaveLength(1);
  });

  test('offline local delivery is retained in FIFO backlog until reconnect', async () => {
    const env = createEmptyEnv('scenario-convergence-timeout:offline-local');
    env.scenarioMode = true;
    const first = { entityId, signerId: '4' };
    const second = { entityId, signerId: '4', entityTxs: [] };
    env.pendingOutputs = [first, second];

    await processWithOffline(env, undefined, new Set(['4']), 'validator-offline');

    expect(env.pendingOutputs).toEqual([first, second]);
    await convergeWithOffline(env, new Set(['4']), 1, 'validator-offline');
    expect(env.pendingOutputs).toEqual([first, second]);
  });

  test('online durable network backlog still fails simulated convergence', async () => {
    const env = createEmptyEnv('scenario-convergence-timeout:mixed-network');
    env.scenarioMode = true;
    env.pendingNetworkOutputs = [networkOutput('4'), networkOutput('3')];
    attachUnreachablePeerRoute(env);

    const rejection = convergeWithOffline(env, new Set(['4']), 1, 'mixed-network').catch((error: unknown) => error);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('convergeWithOffline:mixed-network: not converged after 1 cycles;');
    expect((error as Error).message).toContain('network=2');
    expect((error as Error).message).toContain(
      'trigger@entity=0x1111111111111111111111111111111111111111111111111111111111111111,signer=3,runtime=0x2222222222222222222222222222222222222222,hasReplica=n',
    );
    expect((error as Error).message).toContain(
      'trigger@entity=0x1111111111111111111111111111111111111111111111111111111111111111,signer=4,runtime=0x2222222222222222222222222222222222222222,hasReplica=n',
    );
  });

  test('network diagnostics expose only bounded lane and target metadata', async () => {
    const env = createEmptyEnv('scenario-convergence-timeout:lane-metadata');
    env.scenarioMode = true;
    env.pendingNetworkOutputs = [
      {
        ...networkOutput('3'),
        leaderTimeoutVote: {
          entityId,
          targetHeight: 9,
          previousFrameHash: 'genesis',
          fromView: 0,
          toView: 1,
          previousLeaderId: '1',
          nextLeaderId: '2',
          voterId: '3',
          signature: 'secret-signature-must-not-leak',
        },
      },
    ];

    const rejection = converge(env, 0).catch((error: unknown) => error);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'networkLanes=[leader-timeout-vote@entity=0x1111111111111111111111111111111111111111111111111111111111111111,signer=3,runtime=0x2222222222222222222222222222222222222222,hasReplica=n]',
    );
    expect((error as Error).message).not.toContain('secret-signature-must-not-leak');
  });
});
