import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import {
  advanceScenarioToNextNetworkRetry,
  converge,
  convergeWithOffline,
  processWithOffline,
} from '../../../scenarios/harness/helpers';
import { buildRouteOutputKey } from '../../../runtime/routing/output-routing';
import { registerReliableIngress } from '../../../runtime/reliable/reliable-delivery.ts';
import type { DeliverableEntityInput } from '../../../runtime/types';
import type { JPrefixAttestation } from '../../../types/jurisdiction-events';
import { htlcRouteConvergenceCycleBudget } from '../../../scenarios/payments/test-economy';

const entityId = `0x${'11'.repeat(32)}`;
const runtimeId = `0x${'22'.repeat(20)}`;

const envWithBacklog = (label: string) => {
  const env = createEmptyEnv(`scenario-convergence-timeout:${label}`);
  env.scenarioMode = true;
  env.runtimeMempool.entityInputs = [{
    entityId,
    signerId: '1',
  }];
  return env;
};

const networkOutput = (signerId: string): DeliverableEntityInput => ({
  entityId,
  signerId,
  runtimeId,
  sourceRuntimeFrame: { height: 1, timestamp: 100 },
});

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
    const rejection = convergeWithOffline(
      envWithBacklog('offline'),
      new Set(['4']),
      0,
      'validator-failover',
    ).catch((error: unknown) => error);
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

    await convergeWithOffline(env, new Set(['4']), 1, 'validator-offline');
    expect(env.pendingNetworkOutputs).toHaveLength(1);
  });

  test('online durable network backlog still fails simulated convergence', async () => {
    const env = createEmptyEnv('scenario-convergence-timeout:mixed-network');
    env.scenarioMode = true;
    env.pendingNetworkOutputs = [networkOutput('4'), networkOutput('3')];

    const rejection = convergeWithOffline(env, new Set(['4']), 1, 'mixed-network').catch((error: unknown) => error);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('convergeWithOffline:mixed-network: not converged after 1 cycles;');
    expect((error as Error).message).toContain('network=2');
    expect((error as Error).message).toContain(
      'networkLanes=[trigger@entity=0x1111111111111111111111111111111111111111111111111111111111111111,signer=3,runtime=0x2222222222222222222222222222222222222222,hasReplica=n;',
    );
    expect((error as Error).message).toContain(
      'trigger@entity=0x1111111111111111111111111111111111111111111111111111111111111111,signer=4,runtime=0x2222222222222222222222222222222222222222,hasReplica=n]',
    );
  });

  test('network diagnostics expose only bounded lane and target metadata', async () => {
    const env = createEmptyEnv('scenario-convergence-timeout:lane-metadata');
    env.scenarioMode = true;
    env.pendingNetworkOutputs = [{
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
    }];

    const rejection = converge(env, 0).catch((error: unknown) => error);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'networkLanes=[leader-timeout-vote@entity=0x1111111111111111111111111111111111111111111111111111111111111111,signer=3,runtime=0x2222222222222222222222222222222222222222,hasReplica=n]',
    );
    expect((error as Error).message).not.toContain('secret-signature-must-not-leak');
  });

  test('reconnect advances to the exact durable retry boundary without mutating the envelope', () => {
    const env = createEmptyEnv('scenario-network-reconnect:exact-retry');
    env.scenarioMode = true;
    env.state.timestamp = 1_999;
    const output = networkOutput('3');
    env.pendingNetworkOutputs = [output];
    env.infrastructure!.deferredNetworkMeta = new Map([
      [buildRouteOutputKey(output), { attempts: 1, nextRetryAt: 2_000 }],
    ]);

    expect(env.pendingNetworkOutputs).toEqual([output]);
    expect(advanceScenarioToNextNetworkRetry(env)).toBe(2_000);
    expect(env.state.timestamp).toBe(2_000);
    expect(env.pendingNetworkOutputs).toEqual([output]);
  });

  test('an offline local validator releases pre-apply reliable ingress for exact reconnect retry', async () => {
    const env = createEmptyEnv('scenario-network-reconnect:release-local-ingress');
    env.scenarioMode = true;
    env.state.timestamp = 1_000;
    const receiverRuntimeId = env.runtimeId!;
    const sourceValidatorId = `0x${'33'.repeat(20)}`;
    const attestation: JPrefixAttestation = {
      version: 1,
      entityId,
      targetEntityHeight: 1,
      parentFrameHash: 'genesis',
      validatorId: sourceValidatorId,
      jurisdictionRef: `stack:31337:0x${'44'.repeat(20)}`,
      baseHeight: 0,
      scannedThroughHeight: 1,
      tipBlockHash: `0x${'55'.repeat(32)}`,
      eventHistoryRoot: `0x${'66'.repeat(32)}`,
      rangeHash: `0x${'77'.repeat(32)}`,
      headers: [{ jHeight: 1, jBlockHash: `0x${'55'.repeat(32)}` }],
      blocks: [],
      signature: `0x${'88'.repeat(65)}`,
    };
    const output: DeliverableEntityInput = {
      runtimeId: receiverRuntimeId,
      entityId,
      signerId: '4',
      jPrefixAttestations: new Map([[sourceValidatorId, attestation]]),
    };

    expect(registerReliableIngress(env, receiverRuntimeId, output).kind).toBe('enqueue');
    expect(env.infrastructure?.pendingReliableIngress?.size).toBe(1);
    env.runtimeMempool.entityInputs = [output];

    await processWithOffline(env, undefined, new Set(['4']), 'validator-offline');

    expect(env.infrastructure?.pendingReliableIngress?.size).toBe(0);
    expect(env.runtimeMempool.entityInputs).toEqual([]);
    expect(registerReliableIngress(env, receiverRuntimeId, output).kind).toBe('enqueue');
  });
});
