import { describe, expect, test } from 'bun:test';

import { applyEntityHeightDurabilityBarrier } from '../machine/entity-height-barrier';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, ProposedEntityFrame, RoutedEntityInput, RuntimeInput } from '../types';

const signer = (byte: string): string => `0x${byte.repeat(20)}`;
const entity = (byte: string): string => `0x${byte.repeat(32)}`;

const certifiedFrame = (height: number, byte: string): ProposedEntityFrame => ({
  height,
  parentFrameHash: height === 1 ? 'genesis' : `0x${'10'.repeat(32)}`,
  stateRoot: `0x${'20'.repeat(32)}`,
  authorityRoot: `0x${'30'.repeat(32)}`,
  timestamp: height,
  txs: [],
  hash: `0x${byte.repeat(32)}`,
  leader: { proposerSignerId: signer('11'), view: 0 },
  hashesToSign: [],
  collectedSigs: new Map(),
  hankos: ['0x01'],
});

const installLane = (env: ReturnType<typeof createEmptyEnv>, entityId: string, signerId: string, height: number): void => {
  env.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    state: { entityId, height },
  } as unknown as EntityReplica);
};

const input = (entityId: string, signerId: string, height: number, byte: string): RoutedEntityInput => ({
  entityId,
  signerId,
  proposedFrame: certifiedFrame(height, byte),
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
});
