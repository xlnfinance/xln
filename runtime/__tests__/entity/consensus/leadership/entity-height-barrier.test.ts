import { describe, expect, test } from 'bun:test';

import { applyEntityHeightDurabilityBarrier } from '../../../../runtime/input-pipeline/entity-height-barrier';
import { mergeEntityInputs } from '../../../../entity/consensus/input/merge';
import { createEmptyEnv } from '../../../../runtime';
import type { EntityReplica, EntityFrame } from '../../../../entity/types';
import type { RoutedEntityInput, RuntimeInput, RuntimeTx } from '../../../../runtime/types';

const signer = (byte: string): string => `0x${byte.repeat(20)}`;
const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const runtimeId = `0x${'cc'.repeat(20)}`;

const certifiedFrame = (height: number, byte: string): EntityFrame => ({
  height,
  parentFrameHash: height === 1 ? 'genesis' : `0x${'10'.repeat(32)}`,
  stateRoot: `0x${'20'.repeat(32)}`,
  authorityRoot: `0x${'30'.repeat(32)}`,
  timestamp: height,
  txs: [],
  events: [],
  hash: `0x${byte.repeat(32)}`,
  leader: { proposerSignerId: signer('11'), view: 0 },
  hashesToSign: [],
  collectedSigs: new Map(),
  hankos: ['0x01'],
});

const installLane = (env: ReturnType<typeof createEmptyEnv>, entityId: string, signerId: string, height: number): void => {
  env.state.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    entityEncPubKey: '',
    state: { entityId, height },
  } as unknown as EntityReplica);
};

const input = (entityId: string, signerId: string, height: number, byte: string): RoutedEntityInput => ({
  entityId,
  signerId,
  proposedFrame: certifiedFrame(height, byte),
});

const localCommand = (
  entityId: string,
  signerId: string,
  name: string,
  from?: string,
): RoutedEntityInput => ({
  entityId,
  signerId,
  ...(from ? { from } : {}),
  entityTxs: [{
    type: 'setHubConfig',
    data: { hubName: name, matchingStrategy: 'amount', routingFeePPM: 1, baseFee: 0n, swapTakerFeeBps: 1 },
  } as never],
});

const laneHeights = (inputs: RoutedEntityInput[]): string[] => inputs
  .map(entry => `${entry.entityId}:${entry.proposedFrame!.height}`)
  .sort();

describe('Entity durable-height barrier', () => {
  test('keeps one next certified height per lane without global HOL blocking', () => {
    const env = createEmptyEnv('entity-height-barrier');
    const entityA = entity('aa');
    const entityB = entity('bb');
    const signerA = signer('a1');
    const signerB = signer('b1');
    installLane(env, entityA, signerA, 0);
    installLane(env, entityB, signerB, 7);

    const a1 = input(entityA, signerA, 1, 'a1');
    const a2 = input(entityA, signerA, 2, 'a2');
    const b8 = input(entityB, signerB, 8, 'b8');
    const b9 = input(entityB, signerB, 9, 'b9');
    const runtimeInput: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [a2, b9, a1, b8],
    };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };

    expect(applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, 77)).toBe(2);
    expect(laneHeights(runtimeInput.entityInputs)).toEqual(laneHeights([a1, b8]));
    expect(laneHeights(mempool.entityInputs)).toEqual(laneHeights([a2, b9]));
    expect(mempool.queuedAt).toBe(77);
  });

  test('defers both atomic siblings when either lane is height-blocked', () => {
    const env = createEmptyEnv('entity-height-atomic-barrier');
    const entityA = entity('aa');
    const entityB = entity('bb');
    const signerA = signer('a1');
    const signerB = signer('b1');
    installLane(env, entityA, signerA, 0);
    installLane(env, entityB, signerB, 0);

    const a1 = input(entityA, signerA, 1, 'a1');
    const a2 = input(entityA, signerA, 2, 'a2');
    const b1 = input(entityB, signerB, 1, 'b1');
    const marker = { phase: 'proposal' as const, pairKey: 'height-pair' };
    const sourceRuntimeFrame = { height: 12, timestamp: 77 };
    Object.assign(a2, { from: signer('cc'), sourceRuntimeFrame, atomicCrossJurisdictionPair: marker });
    Object.assign(b1, { from: signer('cc'), sourceRuntimeFrame, atomicCrossJurisdictionPair: marker });
    const runtimeInput: RuntimeInput = { runtimeTxs: [], entityInputs: [a1, a2, b1] };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };

    expect(applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, 77)).toBe(2);
    expect(runtimeInput.entityInputs).toEqual([a1]);
    expect(mempool.entityInputs).toEqual([a2, b1]);
  });

  test('startup batch: unmerged local command + loopback stay ordered and lose no work', () => {
    const env = createEmptyEnv('entity-height-startup-batch');
    env.runtimeId = runtimeId;
    const entityId = entity('bf');
    const signerId = signer('a3');
    installLane(env, entityId, signerId, 0);

    const hubConfig = localCommand(entityId, signerId, 'H1');
    const loopback = localCommand(entityId, signerId, 'loopback-profile', runtimeId);
    const followUp = localCommand(entityId, signerId, 'H1-follow');
    const emptyWake: RoutedEntityInput = { entityId, signerId, entityTxs: [] };

    expect(mergeEntityInputs([hubConfig, loopback, followUp, emptyWake])).toHaveLength(3);

    const runtimeInput: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [hubConfig, loopback, followUp, emptyWake],
    };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };

    expect(applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, 11)).toBe(3);
    expect(runtimeInput.entityInputs).toEqual([hubConfig]);
    expect(mempool.entityInputs).toEqual([loopback, followUp, emptyWake]);
    expect(mempool.entityInputs.map(entry => entry.entityTxs?.[0] && 'data' in entry.entityTxs[0]
      ? (entry.entityTxs[0].data as { hubName?: string }).hubName
      : 'wake')).toEqual(['loopback-profile', 'H1-follow', 'wake']);
  });

  test('defers an empty consensus wake that would commit beside a local command', () => {
    const env = createEmptyEnv('entity-height-empty-wake');
    const entityId = entity('bf');
    const signerId = signer('a3');
    installLane(env, entityId, signerId, 1);
    const hubConfig = localCommand(entityId, signerId, 'H1');
    const emptyWake: RoutedEntityInput = { entityId, signerId, entityTxs: [] };
    expect(mergeEntityInputs([hubConfig, emptyWake])).toHaveLength(2);

    const forward: RuntimeInput = { runtimeTxs: [], entityInputs: [hubConfig, emptyWake] };
    const forwardMempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityHeightDurabilityBarrier(env, forward, forwardMempool, 11)).toBe(1);
    expect(forward.entityInputs).toEqual([hubConfig]);
    expect(forwardMempool.entityInputs).toEqual([emptyWake]);

    const reverse: RuntimeInput = { runtimeTxs: [], entityInputs: [emptyWake, hubConfig] };
    const reverseMempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityHeightDurabilityBarrier(env, reverse, reverseMempool, 11)).toBe(1);
    expect(reverse.entityInputs).toEqual([emptyWake]);
    expect(reverseMempool.entityInputs).toEqual([hubConfig]);
  });

  test('conservatively isolates J-prefix and leader inputs from a second commit', () => {
    const env = createEmptyEnv('entity-height-consensus-continuation');
    const entityId = entity('bd');
    const signerId = signer('a4');
    installLane(env, entityId, signerId, 2);
    const command = localCommand(entityId, signerId, 'next');
    const continuations: RoutedEntityInput[] = [
      {
        entityId,
        signerId,
        jPrefixAttestations: new Map([[signerId, {
          version: 1,
          entityId,
          targetEntityHeight: 3,
          parentFrameHash: `0x${'10'.repeat(32)}`,
          validatorId: signerId,
          jurisdictionRef: 'stack:31337:test',
          baseHeight: 0,
          scannedThroughHeight: 0,
          tipBlockHash: `0x${'11'.repeat(32)}`,
          eventHistoryRoot: `0x${'12'.repeat(32)}`,
          rangeHash: `0x${'13'.repeat(32)}`,
          headers: [],
          blocks: [],
          signature: `0x${'14'.repeat(65)}`,
        }]]),
      },
      {
        entityId,
        signerId,
        leaderTimeoutVote: {
          entityId,
          targetHeight: 3,
          previousFrameHash: `0x${'20'.repeat(32)}`,
          fromView: 0,
          toView: 1,
          previousLeaderId: signerId,
          nextLeaderId: signer('a5'),
          voterId: signerId,
          signature: `0x${'21'.repeat(65)}`,
        },
      },
    ];

    for (const continuation of continuations) {
      const runtimeInput: RuntimeInput = { runtimeTxs: [], entityInputs: [continuation, command] };
      const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
      expect(applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, 11)).toBe(1);
      expect(runtimeInput.entityInputs).toEqual([continuation]);
      expect(mempool.entityInputs).toEqual([command]);
    }
  });

  test('keeps adjacent same-from txs that merge into one Entity frame', () => {
    const env = createEmptyEnv('entity-height-same-from-merge');
    const entityId = entity('aa');
    const signerId = signer('a1');
    installLane(env, entityId, signerId, 0);
    const first = localCommand(entityId, signerId, 'one');
    const second = localCommand(entityId, signerId, 'two');
    expect(mergeEntityInputs([first, second])).toHaveLength(1);

    const runtimeInput: RuntimeInput = { runtimeTxs: [], entityInputs: [first, second] };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, 11)).toBe(0);
    expect(runtimeInput.entityInputs).toEqual([first, second]);
  });

  test('defers a conflicting scheduler snapshot without separating ordinary commands', () => {
    const env = createEmptyEnv('entity-height-scheduler-snapshot');
    const entityId = entity('ac');
    const signerId = signer('a2');
    installLane(env, entityId, signerId, 4);
    const wake = (dueAt: number): RoutedEntityInput => ({
      entityId,
      signerId,
      entityTxs: [{
        type: 'scheduledWake',
        data: {
          version: 1,
          proposerSignerId: signerId,
          dueAt,
          jobs: [{ kind: 'hook', id: `hook-${dueAt}`, dueAt }],
        },
      }],
    });
    const firstWake = wake(10);
    const command = localCommand(entityId, signerId, 'after-wake');
    const laterWake = wake(11);
    const runtimeInput: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [firstWake, command, laterWake],
    };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };

    expect(applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, 12)).toBe(1);
    expect(runtimeInput.entityInputs).toEqual([firstWake, command]);
    expect(mergeEntityInputs(runtimeInput.entityInputs)).toHaveLength(1);
    expect(mempool.entityInputs).toEqual([laterWake]);
  });

  test('caps same-frame importReplica + two unmerged entity txs before the replica exists', () => {
    const env = createEmptyEnv('entity-height-import-replica-batch');
    const entityId = entity('d1');
    const signerId = signer('55');
    const importReplica = {
      type: 'importReplica',
      entityId,
      signerId,
      data: {
        config: { mode: 'proposer-based', threshold: 1n, validators: [signerId] },
        isProposer: true,
        entitySeed: `0x${'ab'.repeat(64)}`,
      },
    } as RuntimeTx;
    const hubConfig = localCommand(entityId, signerId, 'H2');
    const loopback = localCommand(entityId, signerId, 'loopback-profile', runtimeId);
    expect(mergeEntityInputs([hubConfig, loopback])).toHaveLength(2);

    const runtimeInput: RuntimeInput = {
      runtimeTxs: [importReplica],
      entityInputs: [hubConfig, loopback],
    };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
    expect(applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, 11)).toBe(1);
    expect(runtimeInput.entityInputs).toEqual([hubConfig]);
    expect(mempool.entityInputs).toEqual([loopback]);
  });
});
