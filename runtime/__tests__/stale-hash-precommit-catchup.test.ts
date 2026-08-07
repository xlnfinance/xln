import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { applyEntityInput } from '../entity/consensus';
import { createEmptyEnv } from '../runtime';
import {
  applyReliableDeliveryReceipts,
  commitReliableIngress,
  registerReliableIngress,
  releaseUncommittedReliableIngress,
} from '../runtime/reliable-delivery';
import type { DeliverableEntityInput, RuntimeReplica } from '../runtime/types';
import type { EntityReplica } from '../entity/types';

const runtime = (seed: string): RuntimeReplica => {
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, '1'));
  env.runtimeId = runtimeId;
  env.runtimeSeed = seed;
  env.infrastructure ??= {};
  return env;
};

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;

describe('stale hash-precommit catch-up', () => {
  test('past Entity height commits as no-op and terminalizes retained loopback outbox', async () => {
    const env = runtime('stale-precommit-catchup');
    const output: DeliverableEntityInput = {
      runtimeId: env.runtimeId!,
      from: env.runtimeId!,
      entityId: entityId('b1'),
      signerId: signerId('b2'),
      hashPrecommitFrame: { height: 10, frameHash: `0x${'ab'.repeat(32)}` },
      hashPrecommits: new Map([[signerId('a1'), [`0x${'11'.repeat(65)}`]]]),
    } as never;

    const replica = {
      entityId: output.entityId,
      signerId: output.signerId,
      entityEncPubKey: '',
      isProposer: false,
      mempool: [],
      state: {
        entityId: output.entityId,
        height: 13,
        prevFrameHash: `0x${'cd'.repeat(32)}`,
        lastFinalizedJHeight: 0,
        jBlockChain: [],
        accounts: new Map(),
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [output.signerId],
          shares: { [output.signerId]: 1n },
        },
      },
    } as unknown as EntityReplica;
    env.state.eReplicas.set(`${output.entityId}:${output.signerId}`, replica);
    env.pendingNetworkOutputs = [structuredClone(output)];

    expect(registerReliableIngress(env, env.runtimeId!, output).kind).toBe('enqueue');
    const result = await applyEntityInput(env, replica, output);
    expect(result.outcome).toEqual({ kind: 'committed' });

    const commits = commitReliableIngress(env, [output]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.receipt?.body.coverage).toBe('terminal');
    expect(commits[0]?.receipt?.body.identity.height).toBe(10);
    releaseUncommittedReliableIngress(env, [output], [output]);

    const removed = applyReliableDeliveryReceipts(env, [commits[0]!.receipt!]);
    expect(removed.removed).toBe(1);
    expect(env.pendingNetworkOutputs ?? []).toEqual([]);
  });
});
